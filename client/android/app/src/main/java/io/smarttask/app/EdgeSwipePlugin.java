package io.smarttask.app;

import android.graphics.Rect;
import android.os.Build;
import android.view.View;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Collections;

/**
 * Keeps the middle of the screen's left and right edges for the app while a
 * photo viewer is open (lib/edgeSwipe.ts). With gesture navigation a sideways
 * swipe from the edge is the system Back, which closed the viewer when the
 * person meant to turn to the previous picture. Android honours at most 200dp
 * of exclusion per edge, so that band goes across the middle, where the picture
 * is; Back still works above and below it, and from the viewer's close button.
 */
@CapacitorPlugin(name = "EdgeSwipe")
public class EdgeSwipePlugin extends Plugin {

    // Re-applied when the WebView is laid out again (rotation, split screen):
    // the band is in view coordinates.
    private View.OnLayoutChangeListener relayout;

    @PluginMethod
    public void set(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                View web = getBridge().getWebView();
                if (relayout != null) {
                    web.removeOnLayoutChangeListener(relayout);
                    relayout = null;
                }
                if (on) {
                    relayout = (v, l, t, r, b, ol, ot, orr, ob) -> keepMiddle(v);
                    web.addOnLayoutChangeListener(relayout);
                    keepMiddle(web);
                } else {
                    web.setSystemGestureExclusionRects(Collections.emptyList());
                }
            }
            call.resolve();
        });
    }

    private static void keepMiddle(View v) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        int band = (int) Math.floor(200 * v.getResources().getDisplayMetrics().density);
        int h = v.getHeight();
        int top = Math.max(0, (h - band) / 2);
        v.setSystemGestureExclusionRects(Collections.singletonList(new Rect(0, top, v.getWidth(), Math.min(h, top + band))));
    }
}
