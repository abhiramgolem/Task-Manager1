package io.smarttask.app;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

// Replaces Capacitor's own FCM service (removed in the manifest) so call pushes
// can ring while the app is closed. Android delivers MESSAGING_EVENT to ONE
// service only, so this has to be a subclass rather than a second service:
// everything that is not a call still goes through Capacitor untouched, and the
// task/chat notifications keep working exactly as before.
//
// Calls arrive as DATA-only messages on purpose. A message with a notification
// block is drawn by the system tray while the app is in the background and never
// reaches this code, which is the one thing a ringing phone cannot afford.
public class CallMessagingService extends MessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        String type = data.get("type");
        if ("call".equals(type)) {
            // In the foreground the web app's own overlay is already ringing off
            // its socket; a native ring on top of it would ring twice.
            if (!MainActivity.isInForeground()) CallRinger.show(this, CallRinger.toBundle(data));
            return;
        }
        if ("call-cancel".equals(type)) {
            CallRinger.cancel(this, data.get("call_id"));
            return;
        }
        // A chat line, sent as data so the app can draw it WhatsApp's way
        // (ChatNotifier). With the app on screen the thread shows it live, as
        // it always has, so the tray stays quiet.
        if (ChatNotifier.handles(data)) {
            if (!MainActivity.isInForeground()) ChatNotifier.show(this, data);
            return;
        }
        super.onMessageReceived(message);
    }

    @Override
    public void onNewToken(@NonNull String token) {
        // Capacitor hands new tokens to push.ts, which re-registers the device
        // with the server, but only while the app is running. Closed, the token
        // would go nowhere until the app was next opened, and every push in
        // between would go to the old one (PushSetupPlugin).
        super.onNewToken(token);
        PushSetupPlugin.sendNewToken(getApplicationContext(), token);
    }
}
