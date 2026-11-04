package io.smarttask.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

// A chat's notification drawn the way WhatsApp draws one: Android's
// conversation style, which a pull-down opens to show each message with who
// sent it, newest last. One per chat (tag chat_<id>, the tag push.ts clears
// when the chat is opened). The server sends these chats as data-only pushes
// to builds that have this (push.js sendToDevices); a pushed notification
// cannot be drawn this way, only a notification the app builds itself.
final class ChatNotifier {

    // The channel push.ts creates, with VoTask's chime. Created here too: a push
    // can arrive before the app has ever been opened to create it.
    static final String CHANNEL_ID = "votask_chime";
    private static final int NOTIFICATION_ID = 1;
    // Lines kept per chat: WhatsApp shows about this many before "+N more".
    private static final int KEEP = 8;
    private static final String PREFS = "chat_notifications";

    private ChatNotifier() {}

    static boolean handles(Map<String, String> d) {
        String type = d.get("type");
        return "1".equals(d.get("rich")) && ("chat_message".equals(type) || "chat_mention".equals(type))
            && d.get("conversationId") != null && !d.get("conversationId").isEmpty();
    }

    static synchronized void show(Context ctx, Map<String, String> d) {
        String cid = d.get("conversationId");
        String tag = "chat_" + cid;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        ensureChannel(ctx, nm);

        // The lines so far, while this chat's notification is still up. Once it
        // is gone (opened, swiped away, the chat read) the next starts afresh.
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONArray lines = new JSONArray();
        if (isShowing(nm, tag)) {
            try { lines = new JSONArray(sp.getString(cid, "[]")); } catch (Exception ignored) {}
        }
        long now = System.currentTimeMillis();
        try {
            lines.put(new JSONObject()
                .put("s", nz(d.get("sender"), "VoTask"))
                .put("t", nz(d.get("text"), ""))
                .put("at", now));
        } catch (Exception ignored) {}
        JSONArray kept = new JSONArray();
        for (int i = Math.max(0, lines.length() - KEEP); i < lines.length(); i++) kept.put(lines.opt(i));
        sp.edit().putString(cid, kept.toString()).apply();
        int total = sp.getInt(cid + ":n", 0);
        total = isShowing(nm, tag) ? total + 1 : 1;
        sp.edit().putInt(cid + ":n", total).apply();

        boolean group = "1".equals(d.get("group"));
        String chat = nz(d.get("chat"), "VoTask");
        Person me = new Person.Builder().setName("You").setKey("me").build();
        NotificationCompat.MessagingStyle style = new NotificationCompat.MessagingStyle(me);
        if (group) {
            style.setConversationTitle(total > 1 ? chat + " (" + total + " messages)" : chat);
            style.setGroupConversation(true);
        }
        for (int i = 0; i < kept.length(); i++) {
            JSONObject m = kept.optJSONObject(i);
            if (m == null) continue;
            String who = m.optString("s", "VoTask");
            style.addMessage(m.optString("t", ""), m.optLong("at", now), new Person.Builder().setName(who).setKey(who).build());
        }

        // A tap opens this chat at this message, through the push plugin's own
        // tap path (push.ts pushNotificationActionPerformed), which reads these
        // extras when the intent carries google.message_id.
        Intent open = new Intent(ctx, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("google.message_id", "chat_" + nz(d.get("messageId"), String.valueOf(now)))
            .putExtra("type", nz(d.get("type"), "chat_message"))
            .putExtra("conversationId", cid)
            .putExtra("messageId", nz(d.get("messageId"), ""));
        PendingIntent tap = PendingIntent.getActivity(ctx, cid.hashCode(), open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification n = new NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_chat)
            .setColor(0xFFEA580C)
            .setStyle(style)
            .setContentTitle(group ? chat : nz(d.get("sender"), chat))
            .setContentText(nz(d.get("text"), ""))
            .setNumber(total)
            .setWhen(now)
            .setShowWhen(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build();
        try {
            NotificationManagerCompat.from(ctx).notify(tag, NOTIFICATION_ID, n);
        } catch (SecurityException ignored) {
            // Notifications switched off for the app (Android 13+ permission).
        }
    }

    private static boolean isShowing(NotificationManager nm, String tag) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false;
        try {
            for (StatusBarNotification s : nm.getActiveNotifications()) {
                if (tag.equals(s.getTag())) return true;
            }
        } catch (Exception ignored) {}
        return false;
    }

    private static void ensureChannel(Context ctx, NotificationManager nm) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "VoTask notifications", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Task updates, mentions and new messages");
        ch.setSound(Uri.parse(ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + ctx.getPackageName() + "/raw/votask_chime"),
            new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        ch.enableVibration(true);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        nm.createNotificationChannel(ch);
    }

    private static String nz(String s, String fallback) {
        return s == null || s.isEmpty() ? fallback : s;
    }
}
