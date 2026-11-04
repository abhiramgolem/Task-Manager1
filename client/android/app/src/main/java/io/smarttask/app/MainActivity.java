package io.smarttask.app;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;

public class MainActivity extends BridgeActivity {

    static final String EXTRA_CALL_ACTION = "call_action";

    // Read by CallMessagingService on its own thread: in the foreground the web
    // overlay rings, so the native ring stays quiet.
    private static volatile boolean foreground;

    static boolean isInForeground() { return foreground; }

    // Started, not resumed: what Android counts as "on screen" when it decides
    // whether a microphone service may start. A permission dialog over the app
    // pauses it while leaving it visible, and that is exactly when the recorder
    // asks (MeetingRecorderPlugin.start, right after the mic is granted).
    private static volatile boolean visible;

    static boolean isVisible() { return visible; }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Must be registered before the bridge is built in super.onCreate.
        registerPlugin(CallRingPlugin.class);
        registerPlugin(MeetingRecorderPlugin.class);
        registerPlugin(ShareTargetPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        super.onCreate(savedInstanceState);
        // A recreated activity (rotation, process restore) carries the original
        // launch intent again; answering it a second time would rejoin a call
        // that may long be over.
        if (savedInstanceState == null) {
            handleCall(getIntent(), true);
            handleShare(getIntent());
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleCall(intent, false);
        handleShare(intent);
    }

    @Override
    public void onStart() {
        super.onStart();
        visible = true;
    }

    @Override
    public void onStop() {
        visible = false;
        super.onStop();
    }

    @Override
    public void onResume() {
        super.onResume();
        foreground = true;
    }

    @Override
    public void onPause() {
        foreground = false;
        super.onPause();
    }

    private void handleCall(Intent intent, boolean coldStart) {
        if (intent == null || !"answer".equals(intent.getStringExtra(EXTRA_CALL_ACTION))) return;
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        String callId = intent.getStringExtra("call_id");
        // Answered from the notification's own button: that path never went
        // through CallRinger.answer, so the ring is still going.
        CallRinger.cancel(this, callId);
        // Picked up on a locked phone: the call has to come up over the lock
        // screen, as the ringing screen did, not behind a PIN prompt.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        JSObject action = new JSObject()
            .put("action", "answer")
            .put("call_id", callId)
            .put("conversation_id", intent.getStringExtra("conversation_id"))
            .put("kind", intent.getStringExtra("kind"));
        CallRingPlugin.deliverAnswer(action, coldStart);
        intent.removeExtra(EXTRA_CALL_ACTION);
    }

    // Something shared to VoTask from another app's share sheet (ShareTargetPlugin).
    private void handleShare(Intent intent) {
        if (!ShareTargetPlugin.isShare(intent)) return;
        // Reopened from Recents: Android hands back the share that first opened
        // the app, which was dealt with then.
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        ShareTargetPlugin.receive(this, intent);
    }

    /** The call is over: the app goes back behind the lock screen like any other. */
    void releaseLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(false);
            setTurnScreenOn(false);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
    }
}
