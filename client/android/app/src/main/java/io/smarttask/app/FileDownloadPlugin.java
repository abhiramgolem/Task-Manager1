package io.smarttask.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// Downloads, the way WhatsApp and Cliq do them: inside the app, into the
// phone's Downloads/VoTask folder, then opened in whatever app reads that kind
// of file. The WebView cannot save a file itself — a download link there was
// handed to the browser, which downloaded it a second time, outside the app.
// Used by client/src/lib/saveFile.ts.
@CapacitorPlugin(name = "FileDownload")
public class FileDownloadPlugin extends Plugin {

    private static final String FOLDER = "VoTask";
    private final ExecutorService io = Executors.newFixedThreadPool(2);

    /** { url | data (base64), name, mime?, open? } → { uri, opened } */
    @PluginMethod
    public void save(PluginCall call) {
        String url = call.getString("url");
        String data = call.getString("data");
        String name = safeName(call.getString("name", "file"));
        String mimeIn = call.getString("mime");
        boolean open = Boolean.TRUE.equals(call.getBoolean("open", true));
        String id = call.getString("id", "");
        if ((url == null || url.isEmpty()) && data == null) { call.reject("Nothing to save"); return; }
        // Only the app's own server and plain https: this is a file writer, and
        // the page asking is the app's own, but a link in a message is not.
        if (url != null && !url.isEmpty() && !(url.startsWith("https://") || url.startsWith("http://"))) { call.reject("Not a web address"); return; }
        io.execute(() -> {
            HttpURLConnection conn = null;
            String mime = mimeIn;
            try {
                InputStream in;
                long total = -1;
                if (data != null) {
                    in = new ByteArrayInputStream(Base64.decode(data, Base64.DEFAULT));
                } else {
                    conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setConnectTimeout(20000);
                    conn.setReadTimeout(60000);
                    conn.setInstanceFollowRedirects(true);
                    int code = conn.getResponseCode();
                    if (code < 200 || code >= 300) throw new IllegalStateException("The server answered " + code);
                    total = conn.getContentLengthLong();
                    if (mime == null || mime.isEmpty()) {
                        String ct = conn.getContentType();
                        if (ct != null) mime = ct.split(";")[0].trim();
                    }
                    in = conn.getInputStream();
                }
                if (mime == null || mime.isEmpty()) mime = guessMime(name);
                Uri uri = write(getContext(), name, mime, in, total, id);
                boolean opened = open && openUri(uri, mime);
                call.resolve(new JSObject().put("uri", uri.toString()).put("opened", opened).put("mime", mime));
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Download failed" : e.getMessage(), e);
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    /** { uri, mime } → { opened }: a file saved before, opened again. */
    @PluginMethod
    public void open(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null) { call.reject("No file"); return; }
        Uri u = Uri.parse(uri);
        // Gone (deleted from Downloads): the page downloads it afresh.
        try (InputStream probe = getContext().getContentResolver().openInputStream(u)) {
            if (probe == null) throw new IllegalStateException();
        } catch (Exception e) {
            call.resolve(new JSObject().put("opened", false).put("missing", true));
            return;
        }
        call.resolve(new JSObject().put("opened", openUri(u, call.getString("mime", guessMime(u.getLastPathSegment())))));
    }

    /**
     * { url?, name?, mime?, text? } → { shared }: Android's share sheet, so a
     * chat's photo, video, document or words go to WhatsApp, Gmail or any
     * other app as the thing itself, not as a link to it. A file is fetched
     * into the app's cache first (FileProvider's cache-path), under its own
     * name so the other app shows it; copies older than a day are cleared.
     */
    @PluginMethod
    public void share(PluginCall call) {
        String url = call.getString("url");
        String text = call.getString("text");
        String title = call.getString("title", "Share");
        Activity act = getActivity();
        if (act == null) { call.reject("No screen to share from"); return; }
        if (url == null || url.isEmpty()) {
            if (text == null || text.isEmpty()) { call.reject("Nothing to share"); return; }
            Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
            act.runOnUiThread(() -> {
                try {
                    act.startActivity(Intent.createChooser(send, title));
                    call.resolve(new JSObject().put("shared", true));
                } catch (Exception e) {
                    call.reject("No app to share with");
                }
            });
            return;
        }
        if (!(url.startsWith("https://") || url.startsWith("http://"))) { call.reject("Not a web address"); return; }
        String name = safeName(call.getString("name", "file"));
        String mimeIn = call.getString("mime");
        io.execute(() -> {
            HttpURLConnection conn = null;
            try {
                File root = new File(getContext().getCacheDir(), "shared");
                clearOld(root);
                File dir = new File(root, String.valueOf(System.currentTimeMillis()));
                if (!dir.mkdirs() && !dir.isDirectory()) throw new IllegalStateException("No room to prepare the file");
                File f = new File(dir, name);
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(60000);
                conn.setInstanceFollowRedirects(true);
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) throw new IllegalStateException("The server answered " + code);
                String mime = mimeIn;
                if (mime == null || mime.isEmpty() || mime.startsWith("application/octet-stream")) {
                    String ct = conn.getContentType();
                    if (ct != null && !ct.startsWith("application/octet-stream")) mime = ct.split(";")[0].trim();
                }
                if (mime == null || mime.isEmpty() || mime.startsWith("application/octet-stream")) mime = guessMime(name);
                try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(f)) {
                    byte[] buf = new byte[64 * 1024];
                    int r;
                    while ((r = in.read(buf)) != -1) out.write(buf, 0, r);
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
                Intent send = new Intent(Intent.ACTION_SEND)
                    .setType(mime)
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                // The grant reaches the app picked in the sheet only through ClipData.
                send.setClipData(ClipData.newRawUri(name, uri));
                if (text != null && !text.isEmpty()) send.putExtra(Intent.EXTRA_TEXT, text);
                Intent chooser = Intent.createChooser(send, title).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                act.runOnUiThread(() -> {
                    try {
                        act.startActivity(chooser);
                        call.resolve(new JSObject().put("shared", true));
                    } catch (Exception e) {
                        call.reject("No app to share with");
                    }
                });
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "Could not share" : e.getMessage(), e);
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }

    private static void clearOld(File root) {
        File[] dirs = root.listFiles();
        if (dirs == null) return;
        long cutoff = System.currentTimeMillis() - 24L * 3600 * 1000;
        for (File d : dirs) {
            if (d.lastModified() >= cutoff) continue;
            File[] files = d.listFiles();
            if (files != null) for (File f : files) //noinspection ResultOfMethodCallIgnored
                f.delete();
            //noinspection ResultOfMethodCallIgnored
            d.delete();
        }
    }

    private Uri write(Context ctx, String name, String mime, InputStream in, long total, String id) throws Exception {
        ContentResolver cr = ctx.getContentResolver();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // Downloads/VoTask through MediaStore: no storage permission, and the
            // file shows in the phone's Files app like any other download.
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new IllegalStateException("Could not create the file");
            try (OutputStream out = cr.openOutputStream(uri)) {
                copy(in, out, total, id);
            } catch (Exception e) {
                cr.delete(uri, null, null);
                throw e;
            }
            v.clear();
            v.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(uri, v, null, null);
            return uri;
        }
        // Android 7–9: the app's own Downloads folder, which needs no permission.
        File dir = new File(ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), FOLDER);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File f = unique(dir, name);
        try (OutputStream out = new FileOutputStream(f)) {
            copy(in, out, total, id);
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
            throw e;
        }
        return FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
    }

    private void copy(InputStream in, OutputStream out, long total, String id) throws Exception {
        try (InputStream src = in) {
            byte[] buf = new byte[64 * 1024];
            long done = 0;
            int lastPct = -1;
            int r;
            while ((r = src.read(buf)) != -1) {
                out.write(buf, 0, r);
                done += r;
                if (total > 0) {
                    int pct = (int) (done * 100 / total);
                    if (pct != lastPct && pct % 5 == 0) {
                        lastPct = pct;
                        notifyListeners("progress", new JSObject().put("id", id).put("pct", pct));
                    }
                }
            }
        }
    }

    private boolean openUri(Uri uri, String mime) {
        Intent i = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, mime)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
            return true;
        } catch (ActivityNotFoundException e) {
            return false;
        }
    }

    private static File unique(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int n = 1; ; n++) {
            File g = new File(dir, base + " (" + n + ")" + ext);
            if (!g.exists()) return g;
        }
    }

    private static String guessMime(String name) {
        if (name == null) return "application/octet-stream";
        int dot = name.lastIndexOf('.');
        String m = dot >= 0 ? MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase()) : null;
        return m != null ? m : "application/octet-stream";
    }

    private static String safeName(String raw) {
        String n = raw == null ? "" : raw.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        while (n.startsWith(".")) n = n.substring(1);
        if (n.isEmpty()) n = "file";
        return n.length() > 120 ? n.substring(n.length() - 120) : n;
    }
}
