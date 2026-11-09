package io.smarttask.app;

import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

// What keeps chat pushes reaching a phone while VoTask is closed (push.ts).
//
// A token refresh: Firebase can hand the app a new push token at any time.
// Capacitor passes it to the web page only if the page is running, so with the
// app closed the new token went nowhere and the server kept sending to the old
// one, which FCM drops, until the app was next opened. The server gives the
// page a credential for this one device (notifications.js refresh-device), the
// page leaves it here, and CallMessagingService.onNewToken sends the new token
// with it, no session needed.
//
// The battery: a phone that puts VoTask to sleep, or force-stops it when it is
// swiped away (common on Xiaomi, Vivo, Oppo, Realme, OnePlus), gets no pushes
// at all until VoTask is opened again. Only the person can change that, in the
// app's settings; this says whether to ask and opens the screen.
@CapacitorPlugin(name = "PushSetup")
public class PushSetupPlugin extends Plugin {

    private static final String PREFS = "push_token_sync";
    private static final String TAG = "PushSetup";

    @PluginMethod
    public void setTokenSync(PluginCall call) {
        String url = call.getString("url", "");
        String token = call.getString("token", "");
        if (url.isEmpty() || token.isEmpty()) { call.resolve(); return; }
        prefs(getContext()).edit()
            .putString("url", url)
            .putString("token", token)
            .putString("uid", call.getString("uid", ""))
            .putString("sid", call.getString("sid", ""))
            .putString("exp", call.getString("exp", ""))
            .putString("sig", call.getString("sig", ""))
            .apply();
        call.resolve();
    }

    /** Signed out: a new token must not go on reaching this account. */
    @PluginMethod
    public void clearTokenSync(PluginCall call) {
        prefs(getContext()).edit().clear().apply();
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        Context ctx = getContext();
        boolean unrestricted = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            unrestricted = pm == null || pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        }
        // "Restricted" in the app's battery settings: no background work at all.
        boolean restricted = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            restricted = am != null && am.isBackgroundRestricted();
        }
        call.resolve(new JSObject()
            .put("batteryUnrestricted", unrestricted && !restricted)
            .put("backgroundRestricted", restricted)
            .put("notificationsEnabled", NotificationManagerCompat.from(ctx).areNotificationsEnabled())
            .put("manufacturer", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER));
    }

    // The app's own info screen, where Battery is one tap away. Asking for the
    // exemption directly (ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS) needs a
    // permission Play allows only for apps that cannot use FCM, which VoTask does.
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open settings", e);
        }
    }

    /**
     * Called from CallMessagingService.onNewToken, on Firebase's worker thread,
     * so the request is made right here. Quiet on any failure: the next time
     * the app opens it registers its token the ordinary way.
     */
    static void sendNewToken(Context ctx, String newToken) {
        SharedPreferences sp = prefs(ctx);
        String url = sp.getString("url", "");
        String old = sp.getString("token", "");
        if (url.isEmpty() || newToken == null || newToken.isEmpty() || newToken.equals(old)) return;
        HttpURLConnection c = null;
        try {
            String body = new JSONObject()
                .put("uid", sp.getString("uid", ""))
                .put("sid", sp.getString("sid", ""))
                .put("exp", sp.getString("exp", ""))
                .put("sig", sp.getString("sig", ""))
                .put("old", old)
                .put("token", newToken)
                .toString();
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setDoOutput(true);
            c.setRequestProperty("content-type", "application/json");
            try (OutputStream os = c.getOutputStream()) { os.write(body.getBytes(StandardCharsets.UTF_8)); }
            int code = c.getResponseCode();
            if (code < 200 || code >= 300) {
                Log.w(TAG, "token refresh refused: " + code);
                // Signed out, or the phone now belongs to someone else.
                if (code == 403) sp.edit().clear().apply();
                return;
            }
            // The answer carries this device's next credential, for the new token.
            JSONObject next = new JSONObject(read(c.getInputStream())).optJSONObject("refresh");
            SharedPreferences.Editor e = sp.edit().putString("token", newToken);
            if (next != null) {
                e.putString("uid", next.optString("uid", ""))
                    .putString("sid", next.optString("sid", ""))
                    .putString("exp", next.optString("exp", ""))
                    .putString("sig", next.optString("sig", ""));
                String nextUrl = next.optString("url", "");
                if (!nextUrl.isEmpty()) e.putString("url", nextUrl);
            }
            e.apply();
        } catch (Exception e) {
            Log.w(TAG, "token refresh failed: " + e.getMessage());
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String read(InputStream in) throws Exception {
        try (InputStream s = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = s.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
