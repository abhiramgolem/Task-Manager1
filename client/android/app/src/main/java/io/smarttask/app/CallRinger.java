package io.smarttask.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import java.util.concurrent.CopyOnWriteArraySet;
import org.json.JSONObject;

// The incoming-call ring, WhatsApp-style: one ongoing CallStyle notification per
// call that keeps ringing (FLAG_INSISTENT) until it is answered, declined,
// cancelled by the server or runs out, and that opens IncomingCallActivity over
// the lock screen when the phone is asleep.
//
// It is fed from two places with the same snake_case payload: the FCM data
// message (CallMessagingService, app closed or backgrounded) and the CallRing
// plugin (the web app heard the ring on its own socket while hidden). Both can
// fire for one call, so everything here is keyed and de-duplicated by call_id.
// The bookkeeping is in-process statics on purpose: the service, the receiver
// and both activities share one process, and after process death the only call
// that can still matter is one a fresh push brings back.
final class CallRinger {

    static final String CHANNEL_ID = "votask_calls_v1";
    static final String EXTRA_CALL = "votask_call";
    static final String ACTION_DECLINE = "io.smarttask.app.CALL_DECLINE";
    private static final String TAG = "CallRinger";
    private static final String PREFS = "votask_calls";

    // A ring shorter than this would end before anyone could reach the phone;
    // longer than the cap and a lost cancel would leave it ringing for ever.
    private static final long DEFAULT_RING_MS = 60_000;
    private static final long MAX_RING_MS = 90_000;
    // Phone clocks drift; a few seconds of skew must not swallow a real call.
    private static final long CLOCK_GRACE_MS = 15_000;

    interface Listener { void onCallGone(String callId); }

    private static final Set<String> showing = new HashSet<>();
    // Calls already answered, declined or cancelled. A ring that arrives after
    // its own cancel (FCM does not promise order) must stay silent.
    private static final Map<String, Long> handled = new LinkedHashMap<String, Long>() {
        @Override protected boolean removeEldestEntry(Map.Entry<String, Long> e) { return size() > 64; }
    };
    private static final Set<Listener> listeners = new CopyOnWriteArraySet<>();

    private CallRinger() {}

    static void addListener(Listener l) { listeners.add(l); }
    static void removeListener(Listener l) { listeners.remove(l); }

    static Bundle toBundle(Map<String, String> data) {
        Bundle b = new Bundle();
        for (Map.Entry<String, String> e : data.entrySet()) b.putString(e.getKey(), e.getValue());
        return b;
    }

    static synchronized boolean isHandled(String callId) {
        Long at = handled.get(callId);
        return at != null && System.currentTimeMillis() - at < 10 * 60_000;
    }

    private static synchronized void markHandled(String callId) {
        handled.put(callId, System.currentTimeMillis());
        showing.remove(callId);
    }

    /** Milliseconds this call may still ring for, or 0 if it is already over. */
    static long remainingMs(Bundle call) {
        long expires = parseIso(call.getString("expires_at"));
        if (expires < 0) return DEFAULT_RING_MS;
        long left = expires + CLOCK_GRACE_MS - System.currentTimeMillis();
        return left <= 0 ? 0 : Math.min(left, MAX_RING_MS);
    }

    /** Ring for this call. Returns false if it was a duplicate, stale or unshowable. */
    static boolean show(Context ctx, Bundle call) {
        String callId = call.getString("call_id");
        if (callId == null || callId.isEmpty()) return false;
        long ringMs = remainingMs(call);
        synchronized (CallRinger.class) {
            if (isHandled(callId) || ringMs == 0) return false;
            // Re-posting the same notification would restart the ringtone.
            if (!showing.add(callId)) return true;
        }
        ensureChannel(ctx);

        String title = nonEmpty(call.getString("title"), nonEmpty(call.getString("from_name"), "VoTask"));
        Person caller = new Person.Builder().setName(title).setImportant(true).build();
        int id = notificationId(callId);

        Intent full = new Intent(ctx, IncomingCallActivity.class)
            .putExtra(EXTRA_CALL, call)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        PendingIntent fullPi = PendingIntent.getActivity(ctx, id, full, piFlags());
        // Answer goes straight to MainActivity: since Android 12 a notification
        // action may not bounce through a receiver or service to start an
        // activity (the "trampoline" ban), it would just silently do nothing.
        PendingIntent answerPi = PendingIntent.getActivity(ctx, id + 1, answerIntent(ctx, call), piFlags());
        Intent decline = new Intent(ctx, CallActionReceiver.class).setAction(ACTION_DECLINE).putExtra(EXTRA_CALL, call);
        PendingIntent declinePi = PendingIntent.getBroadcast(ctx, id + 2, decline, piFlags());

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle(title)
            .setContentText(subtitle(ctx, call))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(false)
            .setContentIntent(fullPi)
            // On a locked or sleeping phone this opens IncomingCallActivity; on a
            // phone in use Android shows the heads-up call card instead. Android
            // 14+ only honours it for apps granted USE_FULL_SCREEN_INTENT — without
            // it the call still rings as a heads-up, it just does not take the screen.
            .setFullScreenIntent(fullPi, true)
            .setTimeoutAfter(ringMs)
            .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, declinePi, answerPi));
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Pre-O has no channels: the ring and buzz live on the notification.
            b.setSound(Settings.System.DEFAULT_RINGTONE_URI, android.media.AudioManager.STREAM_RING)
                .setVibrate(VIBRATE);
        }
        Notification n = b.build();
        // Repeat the ringtone until the notification goes, as a phone call does,
        // instead of one chirp that is easy to miss across a room.
        n.flags |= Notification.FLAG_INSISTENT;
        try {
            NotificationManagerCompat.from(ctx).notify(id, n);
        } catch (SecurityException e) {
            // POST_NOTIFICATIONS refused (Android 13+). Nothing else can ring.
            Log.w(TAG, "notification permission missing", e);
            synchronized (CallRinger.class) { showing.remove(callId); }
            return false;
        }
        return true;
    }

    /** The call is over for this phone — answered elsewhere, declined, ended or missed. */
    static void cancel(Context ctx, String callId) {
        if (callId == null || callId.isEmpty()) return;
        markHandled(callId);
        NotificationManagerCompat.from(ctx).cancel(notificationId(callId));
        for (Listener l : listeners) l.onCallGone(callId);
    }

    /** Pick up: stop ringing and bring the app forward to join the call. */
    static void answer(Context ctx, Bundle call) {
        cancel(ctx, call.getString("call_id"));
        ctx.startActivity(answerIntent(ctx, call));
    }

    /** Turn it down: stop ringing at once, tell the server in the background. */
    static void decline(Context ctx, Bundle call, Runnable done) {
        String callId = call.getString("call_id");
        cancel(ctx, callId);
        String url = nonEmpty(call.getString("decline_url"), null);
        if (url == null) {
            String base = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("api_base", "");
            if (base == null || base.isEmpty() || callId == null) { if (done != null) done.run(); return; }
            url = base.replaceAll("/+$", "") + "/api/chat/call/" + callId + "/decline-push";
        }
        final String target = url;
        new Thread(() -> {
            HttpURLConnection c = null;
            try {
                JSONObject body = new JSONObject();
                body.put("uid", nonEmpty(call.getString("uid"), ""));
                body.put("sig", nonEmpty(call.getString("decline_sig"), ""));
                c = (HttpURLConnection) new URL(target).openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                c.setDoOutput(true);
                c.setRequestProperty("content-type", "application/json");
                try (OutputStream os = c.getOutputStream()) { os.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
                c.getResponseCode();
            } catch (Exception e) {
                // The caller's ring times out on the server regardless; a lost
                // decline only means they hear "no answer" instead of "declined".
                Log.w(TAG, "decline failed: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
                if (done != null) done.run();
            }
        }, "votask-decline").start();
    }

    /** The API base the web app last handed over (configure), or "". */
    static String apiBase(Context ctx) {
        String b = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("api_base", "");
        return b == null ? "" : b.replaceAll("/+$", "");
    }

    static void saveApiBase(Context ctx, String base) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("api_base", base == null ? "" : base).apply();
    }

    static Intent answerIntent(Context ctx, Bundle call) {
        return new Intent(ctx, MainActivity.class)
            .setAction(Intent.ACTION_VIEW)
            .putExtra(MainActivity.EXTRA_CALL_ACTION, "answer")
            .putExtra("call_id", nonEmpty(call.getString("call_id"), ""))
            .putExtra("conversation_id", nonEmpty(call.getString("conversation_id"), ""))
            .putExtra("kind", "video".equals(call.getString("kind")) ? "video" : "audio")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }

    static String subtitle(Context ctx, Bundle call) {
        boolean video = "video".equals(call.getString("kind"));
        String s = ctx.getString(video ? R.string.call_incoming_video : R.string.call_incoming_audio);
        String from = call.getString("from_name");
        if ("1".equals(call.getString("group")) && from != null && !from.isEmpty()) s += " · " + ctx.getString(R.string.call_from, from);
        return s;
    }

    static Bundle fromJson(JSONObject o) {
        Bundle b = new Bundle();
        for (Iterator<String> it = o.keys(); it.hasNext(); ) {
            String k = it.next();
            Object v = o.opt(k);
            if (v != null && v != JSONObject.NULL) b.putString(k, String.valueOf(v));
        }
        return b;
    }

    private static final long[] VIBRATE = { 0, 800, 600, 800, 600 };

    private static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        // A channel's sound and importance are frozen at creation (see push.ts on
        // smarttask → smarttask_v2), so this one is born with the RINGTONE, not
        // the notification tone, and a new id is the only way to ever change it.
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, ctx.getString(R.string.call_channel_name), NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription(ctx.getString(R.string.call_channel_desc));
        ch.setSound(Settings.System.DEFAULT_RINGTONE_URI, new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build());
        ch.enableVibration(true);
        ch.setVibrationPattern(VIBRATE);
        ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(ch);
    }

    private static int notificationId(String callId) {
        // Spaced by 4 so the three PendingIntent request codes of one call
        // (full screen, answer, decline) never collide with another call's.
        return (callId.hashCode() & 0x0fffffff) << 2;
    }

    private static int piFlags() {
        return PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    }

    // The server sends Date#toISOString(): always UTC with a Z. java.time would
    // need API 26 (minSdk is 24) or desugaring, which is a lot for one field.
    static long parseIso(String s) {
        if (s == null || s.length() < 19 || !s.endsWith("Z")) return -1;
        try {
            SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US);
            f.setTimeZone(TimeZone.getTimeZone("UTC"));
            return f.parse(s.substring(0, 19)).getTime();
        } catch (Exception e) {
            return -1;
        }
    }

    private static String nonEmpty(String s, String fallback) {
        return s == null || s.trim().isEmpty() ? fallback : s;
    }
}
