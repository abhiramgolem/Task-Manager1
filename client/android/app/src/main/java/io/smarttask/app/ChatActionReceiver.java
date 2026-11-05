package io.smarttask.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import androidx.core.app.RemoteInput;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

// The buttons under a chat's notification (ChatNotifier): Reply, Mark as read,
// Mute 1 hour. A receiver, like the ring's Decline, so none of them opens the
// app. Native code has no session; each push carries a signature for its one
// chat (chat.js notifActionFor), and that is what the server checks.
public class ChatActionReceiver extends BroadcastReceiver {

    static final String ACTION_REPLY = "io.smarttask.app.CHAT_REPLY";
    static final String ACTION_READ = "io.smarttask.app.CHAT_READ";
    static final String ACTION_MUTE = "io.smarttask.app.CHAT_MUTE";
    static final String EXTRA_CONV = "conversation_id";
    static final String KEY_TEXT = "reply_text";
    private static final String TAG = "ChatAction";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getAction();
        String cid = intent.getStringExtra(EXTRA_CONV);
        if (action == null || cid == null || cid.isEmpty()) return;
        Context app = ctx.getApplicationContext();

        String kind;
        String text = null;
        if (ACTION_REPLY.equals(action)) {
            Bundle in = RemoteInput.getResultsFromIntent(intent);
            CharSequence typed = in == null ? null : in.getCharSequence(KEY_TEXT);
            text = typed == null ? "" : typed.toString().trim();
            if (text.isEmpty()) return;
            kind = "reply";
        } else if (ACTION_READ.equals(action)) {
            kind = "read";
        } else if (ACTION_MUTE.equals(action)) {
            kind = "mute";
        } else {
            return;
        }

        // Read and Mute take the notification down at once, as Cliq does; a
        // reply waits for the server so a lost one can say so.
        if (!"reply".equals(kind)) ChatNotifier.clear(app, cid);

        String url = intent.getStringExtra("url");
        if (url == null || url.isEmpty()) {
            String base = CallRinger.apiBase(app);
            if (base.isEmpty()) { if ("reply".equals(kind)) ChatNotifier.replyFailed(app, cid); return; }
            url = base + "/api/chat/conversations/" + cid + "/notif-action";
        }
        final String target = url;
        final String body;
        try {
            JSONObject o = new JSONObject()
                .put("action", kind)
                .put("uid", nz(intent.getStringExtra("uid")))
                .put("exp", nz(intent.getStringExtra("exp")))
                .put("sig", nz(intent.getStringExtra("sig")));
            if (text != null) o.put("text", text);
            body = o.toString();
        } catch (Exception e) {
            return;
        }
        final boolean reply = "reply".equals(kind);
        PendingResult pending = goAsync();
        new Thread(() -> {
            boolean ok = false;
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(target).openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                c.setDoOutput(true);
                c.setRequestProperty("content-type", "application/json");
                try (OutputStream os = c.getOutputStream()) { os.write(body.getBytes(StandardCharsets.UTF_8)); }
                int code = c.getResponseCode();
                ok = code >= 200 && code < 300;
            } catch (Exception e) {
                Log.w(TAG, kind + " failed: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
                if (reply) {
                    if (ok) ChatNotifier.clear(app, cid);
                    else ChatNotifier.replyFailed(app, cid);
                }
                pending.finish();
            }
        }, "votask-chat-action").start();
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }
}
