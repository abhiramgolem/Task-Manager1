package io.smarttask.app;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// What another app shares to VoTask from its share sheet — a document from
// WhatsApp, a photo from the gallery, a reel's link from Instagram — handed to
// the web app (client/src/lib/shareTarget.ts), which asks which chat it goes
// to and puts it in that chat's composer.
//
// A shared content:// URI is only readable while the sharing app's grant
// lasts, so each file is copied into the app's cache first; the page reads the
// copy back through Capacitor's local server.
@CapacitorPlugin(name = "ShareTarget")
public class ShareTargetPlugin extends Plugin {

    // The chat's own limits (Chats.tsx MAX_FILE, MAX_STAGED).
    private static final long MAX_BYTES = 1024L * 1024 * 1024;
    private static final int MAX_FILES = 10;
    private static final String DIR = "shared";

    private static ShareTargetPlugin instance;
    // A share that landed before the plugin was loaded, waiting for the page.
    private static JSObject pending;
    private static final ExecutorService io = Executors.newSingleThreadExecutor();

    @Override
    public void load() { instance = this; }

    @Override
    protected void handleOnDestroy() { if (instance == this) instance = null; }

    static boolean isShare(Intent intent) {
        String a = intent == null ? null : intent.getAction();
        return Intent.ACTION_SEND.equals(a) || Intent.ACTION_SEND_MULTIPLE.equals(a);
    }

    /** Reads a share intent, copies its files off the main thread, and passes it on. */
    static void receive(Context ctx, Intent intent) {
        final Context app = ctx.getApplicationContext();
        final List<Uri> uris = streams(intent);
        final String text = text(intent);
        final CharSequence subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT);
        final String type = intent.getType();
        io.execute(() -> {
            JSObject share = new JSObject();
            JSArray files = new JSArray();
            int skipped = 0;
            File dir = freshDir(app);
            for (Uri uri : uris) {
                if (files.length() >= MAX_FILES) { skipped++; continue; }
                JSObject f = copy(app, uri, type, dir, files.length());
                if (f == null) skipped++;
                else files.put(f);
            }
            share.put("files", files);
            share.put("text", text == null ? "" : text);
            share.put("subject", subject == null ? "" : subject.toString());
            share.put("skipped", skipped);
            deliver(share);
        });
    }

    private static synchronized void deliver(JSObject share) {
        if (instance == null) { pending = share; return; }
        // Retained: a page still loading (a cold start) gets it when it listens.
        instance.notifyListeners("shareReceived", share, true);
    }

    @PluginMethod
    public void getPending(PluginCall call) {
        JSObject p;
        synchronized (ShareTargetPlugin.class) { p = pending; pending = null; }
        call.resolve(p != null ? p : new JSObject());
    }

    @SuppressWarnings("deprecation")
    private static List<Uri> streams(Intent intent) {
        List<Uri> out = new ArrayList<>();
        if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> many = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (many != null) for (Uri u : many) if (u != null) out.add(u);
        } else {
            Uri one = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (one != null) out.add(one);
        }
        // Some apps put the files only in the clip data.
        ClipData clip = intent.getClipData();
        if (out.isEmpty() && clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) out.add(u);
            }
        }
        return out;
    }

    private static String text(Intent intent) {
        CharSequence one = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (one != null) return one.toString();
        ArrayList<CharSequence> many = intent.getCharSequenceArrayListExtra(Intent.EXTRA_TEXT);
        if (many == null) return null;
        StringBuilder sb = new StringBuilder();
        for (CharSequence s : many) if (s != null) sb.append(sb.length() > 0 ? "\n" : "").append(s);
        return sb.toString();
    }

    // One folder per share; the previous share's copies have been sent by now.
    private static File freshDir(Context ctx) {
        File root = new File(ctx.getCacheDir(), DIR);
        File[] old = root.listFiles();
        if (old != null) for (File f : old) deleteTree(f);
        File dir = new File(root, String.valueOf(System.currentTimeMillis()));
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    private static void deleteTree(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static JSObject copy(Context ctx, Uri uri, String intentType, File dir, int index) {
        // content:// only. A file:// path could name the app's own private
        // files, as could a URI from its own provider, and sharing those into a
        // chat is not what the sending app should be able to make it do.
        if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) return null;
        String authority = uri.getAuthority();
        if (authority == null || authority.startsWith(ctx.getPackageName())) return null;
        ContentResolver cr = ctx.getContentResolver();
        String name = null;
        long size = -1;
        try (Cursor c = cr.query(uri, new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int s = c.getColumnIndex(OpenableColumns.SIZE);
                if (n >= 0 && !c.isNull(n)) name = c.getString(n);
                if (s >= 0 && !c.isNull(s)) size = c.getLong(s);
            }
        } catch (Exception ignored) {}
        if (size > MAX_BYTES) return null;
        String type = cr.getType(uri);
        if (type == null && intentType != null && !intentType.contains("*")) type = intentType;
        if (name == null || name.trim().isEmpty()) name = uri.getLastPathSegment();
        name = safeName(name, index);
        String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(type);
        if (!name.contains(".") && ext != null) name = name + "." + ext;
        if (type == null) {
            String byExt = MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(name.lastIndexOf('.') + 1).toLowerCase());
            type = byExt != null ? byExt : "application/octet-stream";
        }
        // Its own folder per file, so two shared files with one name both keep it.
        File slot = new File(dir, String.valueOf(index));
        //noinspection ResultOfMethodCallIgnored
        slot.mkdirs();
        File out = new File(slot, name);
        long total = 0;
        try (InputStream in = cr.openInputStream(uri); OutputStream os = new FileOutputStream(out)) {
            if (in == null) return null;
            byte[] buf = new byte[64 * 1024];
            int r;
            while ((r = in.read(buf)) != -1) {
                total += r;
                if (total > MAX_BYTES) throw new IllegalStateException("too big");
                os.write(buf, 0, r);
            }
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            out.delete();
            return null;
        }
        if (total == 0) { out.delete(); return null; }
        return new JSObject()
            .put("path", out.getAbsolutePath())
            .put("name", name)
            .put("type", type)
            .put("size", total);
    }

    private static String safeName(String raw, int index) {
        String n = raw == null ? "" : raw.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        while (n.startsWith(".")) n = n.substring(1);
        if (n.isEmpty()) n = "shared-" + (index + 1);
        return n.length() > 120 ? n.substring(n.length() - 120) : n;
    }
}
