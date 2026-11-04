package io.smarttask.app;

import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.play.core.appupdate.AppUpdateInfo;
import com.google.android.play.core.appupdate.AppUpdateManager;
import com.google.android.play.core.appupdate.AppUpdateManagerFactory;
import com.google.android.play.core.appupdate.AppUpdateOptions;
import com.google.android.play.core.install.model.AppUpdateType;
import com.google.android.play.core.install.model.UpdateAvailability;

// "A new version is available" (client/src/lib/appUpdate.ts), from Google
// Play's In-App Updates: Play says whether the store has a newer build for this
// install, and runs the update itself — its full-screen download, install and
// restart — when the user says yes. Play only answers for an app installed from
// Play; a sideloaded build is told nothing is available.
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    private AppUpdateManager manager;

    private AppUpdateManager manager() {
        if (manager == null) manager = AppUpdateManagerFactory.create(getContext());
        return manager;
    }

    @PluginMethod
    public void check(PluginCall call) {
        manager().getAppUpdateInfo()
            .addOnSuccessListener(info -> {
                Integer stale = info.clientVersionStalenessDays();
                call.resolve(new JSObject()
                    .put("available", info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE)
                    // An update the user started that was left mid-way (the app
                    // was closed during Play's screen): it should carry on.
                    .put("inProgress", info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS)
                    .put("versionCode", info.availableVersionCode())
                    .put("staleDays", stale == null ? 0 : stale)
                    .put("priority", info.updatePriority()));
            })
            .addOnFailureListener(e -> call.resolve(new JSObject().put("available", false).put("error", String.valueOf(e.getMessage()))));
    }

    /** Play's own update screen; failing that, the app's page in the Play Store. */
    @PluginMethod
    public void update(PluginCall call) {
        manager().getAppUpdateInfo()
            .addOnSuccessListener(info -> {
                int a = info.updateAvailability();
                boolean ready = a == UpdateAvailability.UPDATE_AVAILABLE || a == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS;
                if (ready && info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE) && getActivity() != null) {
                    start(call, info);
                } else {
                    openStore(call);
                }
            })
            .addOnFailureListener(e -> openStore(call));
    }

    private void start(PluginCall call, AppUpdateInfo info) {
        try {
            manager().startUpdateFlow(info, getActivity(), AppUpdateOptions.newBuilder(AppUpdateType.IMMEDIATE).build())
                // On success the app restarts into the new version and this
                // never resolves; a result here means it was cancelled or failed.
                .addOnSuccessListener(code -> call.resolve(new JSObject().put("started", true).put("result", code)))
                .addOnFailureListener(e -> openStore(call));
        } catch (Exception e) {
            openStore(call);
        }
    }

    private void openStore(PluginCall call) {
        String pkg = getContext().getPackageName();
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + pkg));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception e) {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=" + pkg));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try { getContext().startActivity(i); } catch (Exception ignored) {}
        }
        call.resolve(new JSObject().put("started", false).put("store", true));
    }
}
