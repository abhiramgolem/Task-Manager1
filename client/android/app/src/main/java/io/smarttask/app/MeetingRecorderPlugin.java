package io.smarttask.app;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.webkit.WebView;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// The web recorder's handle on MeetingRecordingService
// (client/src/lib/backgroundRecording.ts). The page owns the recording; this
// only asks Android to let it carry on with the screen off.
@CapacitorPlugin(name = "MeetingRecorder")
public class MeetingRecorderPlugin extends Plugin {

    // How long start() waits for the service to actually go foreground. It
    // takes milliseconds when it works; when it does not, the page has to hear
    // "no" so it keeps the screen on instead.
    private static final long FOREGROUND_WAIT_MS = 2000;
    // After the activity stops, before telling the WebView it is still on
    // screen: its own "now hidden" has to have landed first, or ours is the one
    // that gets overwritten.
    private static final long REVEAL_DELAY_MS = 500;

    private final Handler main = new Handler(Looper.getMainLooper());
    // Between a successful start and stop: a meeting is being recorded.
    private volatile boolean recording;

    // The microphone service keeps the mic, but not the page. A WebView whose
    // window is hidden is throttled by Chromium, and about a minute after the
    // screen goes off the page stops altogether — timers, the audio graph that
    // feeds the transcriber, everything — while Android still reports the mic
    // as live. Observed on an Android 16 emulator: frames to the transcriber
    // stopped 60s after screen-off with the service running. So while a
    // meeting records, the WebView is told it is still visible, as Cordova's
    // background-mode plugin does. With the screen off nothing is drawn, so
    // this costs no rendering; it only keeps the recording's own code running.
    private final Runnable reveal = () -> {
        if (!recording || MainActivity.isVisible()) return;
        WebView wv = getBridge().getWebView();
        if (wv != null) wv.dispatchWindowVisibilityChanged(View.VISIBLE);
    };

    @PluginMethod
    public void start(PluginCall call) {
        Context ctx = getContext();
        // Android's own two conditions for a microphone service. Inside the
        // service they surface as an exception (on some versions a crash);
        // checked here they are a plain "no" the page can fall back from.
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            call.reject("Microphone permission not granted");
            return;
        }
        if (!MainActivity.isVisible()) {
            call.reject("The app is not on screen");
            return;
        }
        try {
            MeetingRecordingService.start(ctx, call.getString("title", ""),
                Boolean.TRUE.equals(call.getBoolean("paused", false)), elapsedMs(call));
        } catch (RuntimeException e) {
            call.reject("Could not keep recording in the background", e);
            return;
        }
        // Plugin calls run on their own thread, so waiting here blocks no UI.
        long until = SystemClock.uptimeMillis() + FOREGROUND_WAIT_MS;
        while (!MeetingRecordingService.isForeground() && SystemClock.uptimeMillis() < until) {
            SystemClock.sleep(20);
        }
        if (!MeetingRecordingService.isForeground()) {
            MeetingRecordingService.stop(ctx);
            call.reject("Android did not start the recording service");
            return;
        }
        recording = true;
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        MeetingRecordingService.update(getContext(), call.getString("title", ""),
            Boolean.TRUE.equals(call.getBoolean("paused", false)), elapsedMs(call));
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        release();
        call.resolve();
    }

    @Override
    protected void handleOnStop() {
        if (recording) main.postDelayed(reveal, REVEAL_DELAY_MS);
    }

    @Override
    protected void handleOnStart() {
        main.removeCallbacks(reveal);
    }

    // The activity, and with it the WebView that was recording, is going away;
    // the service must not outlive what it is keeping alive.
    @Override
    protected void handleOnDestroy() {
        release();
    }

    private void release() {
        boolean was = recording;
        recording = false;
        MeetingRecordingService.stop(getContext());
        main.post(() -> {
            main.removeCallbacks(reveal);
            // Stopped from the background (the page ended the meeting while the
            // screen was off): give the WebView back the hidden state it really
            // has, so it is throttled again like any backgrounded page.
            if (!was || MainActivity.isVisible()) return;
            WebView wv = getBridge().getWebView();
            if (wv != null) wv.dispatchWindowVisibilityChanged(View.GONE);
        });
    }

    private static long elapsedMs(PluginCall call) {
        Double s = call.getDouble("seconds");
        return s == null ? 0 : (long) (s * 1000);
    }
}
