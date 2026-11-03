package io.smarttask.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

// Keeps a live meeting recording going while the phone sleeps.
//
// The recording itself is web code (Meetings.tsx): getUserMedia in the WebView,
// streamed to the server. Since Android 9 an app with nothing on screen is
// handed SILENCE by the microphone — not an error, just zeros — so with the
// screen off the transcript quietly stopped growing, and the page paused itself
// rather than pretend otherwise. A foreground service of type microphone is the
// one sanctioned way out, and it is what WhatsApp calls and voice recorders use:
// while it runs the app keeps the mic and the network with the screen off, and
// the person sees "Recording meeting" in the shade for exactly as long as that
// is true.
//
// No wake lock of its own. While the mic is open the audio server already holds
// one on the app's behalf; a second would only matter when nothing is being
// recorded, which is exactly when the phone should be allowed to sleep.
public class MeetingRecordingService extends Service {

    static final String CHANNEL_ID = "votask_recording_v1";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_PAUSED = "paused";
    static final String EXTRA_ELAPSED_MS = "elapsed_ms";
    private static final int NOTIFICATION_ID = 4720;
    private static final String TAG = "MeetingRecording";

    // In foreground, i.e. startForeground succeeded and onDestroy has not run.
    private static volatile boolean foreground;
    // Stop asked for before the service got as far as startForeground. Stopping a
    // service started with startForegroundService before it goes foreground is
    // a crash on several Android versions, so it goes foreground first and then
    // leaves on its own.
    private static volatile boolean stopRequested;

    static void start(Context ctx, String title, boolean paused, long elapsedMs) {
        stopRequested = false;
        Intent i = new Intent(ctx, MeetingRecordingService.class)
            .putExtra(EXTRA_TITLE, title)
            .putExtra(EXTRA_PAUSED, paused)
            .putExtra(EXTRA_ELAPSED_MS, elapsedMs);
        ContextCompat.startForegroundService(ctx, i);
    }

    static void stop(Context ctx) {
        if (foreground) ctx.stopService(new Intent(ctx, MeetingRecordingService.class));
        else stopRequested = true;
    }

    /** Re-post the notification; never starts the service, so it is safe from the background. */
    static void update(Context ctx, String title, boolean paused, long elapsedMs) {
        if (!foreground) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTIFICATION_ID, build(ctx, title, paused, elapsedMs));
    }

    static boolean isForeground() { return foreground; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        boolean paused = intent != null && intent.getBooleanExtra(EXTRA_PAUSED, false);
        long elapsed = intent != null ? intent.getLongExtra(EXTRA_ELAPSED_MS, 0) : 0;
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, build(this, title, paused, elapsed),
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0);
            foreground = true;
        } catch (RuntimeException e) {
            // The plugin checks Android's conditions first (mic granted, app on
            // screen), so this is the gap between that check and now. The page
            // hears no rejection from here; it simply never sees the service
            // running and keeps the screen on instead, as it did before.
            Log.w(TAG, "could not go foreground", e);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (stopRequested) { stopRequested = false; stopSelf(); }
        // Not sticky: after the process dies the page that was recording is gone,
        // and a service brought back by itself would be recording nothing.
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Swiped out of Recents: the WebView doing the recording goes with the
        // task, so a notification still saying "Recording" would be a lie. What
        // was said so far is already on the server (the page syncs it every few
        // seconds) and comes back as "Your recording is back" on the next open.
        stopSelf();
    }

    @Override
    public void onDestroy() {
        foreground = false;
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private static Notification build(Context ctx, String title, boolean paused, long elapsedMs) {
        ensureChannel(ctx);
        // Back into the running app, not a fresh start: MainActivity is
        // singleTask, so this brings the existing task (and its WebView) forward.
        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(ctx, NOTIFICATION_ID, open,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_mic)
            .setContentTitle(title == null || title.trim().isEmpty() ? "Live meeting" : title)
            .setContentText(paused ? "Paused — tap to resume" : "Recording — keeps going with the screen off")
            .setContentIntent(tap)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            // Android 12 holds a new service's notification back for ten seconds;
            // a recording you cannot see is running is the one thing not to hide.
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        // The shade counts the time itself, so the page never has to wake up
        // just to move a clock nobody is looking at.
        if (paused) b.setShowWhen(false);
        else b.setShowWhen(true).setUsesChronometer(true).setWhen(System.currentTimeMillis() - Math.max(0, elapsedMs));
        return b.build();
    }

    private static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        // Low importance: present in the shade and the status bar, never a sound
        // or a heads-up in the middle of the meeting it is recording.
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Meeting recording", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Shown while a meeting is being recorded, so it keeps going with the screen off");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }
}
