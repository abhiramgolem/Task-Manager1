import { useEffect } from 'react'
import { Capacitor, registerPlugin } from '@capacitor/core'

// With Android's gesture navigation, a sideways swipe that starts at the
// screen's edge is the system Back. In a photo viewer that is exactly where a
// swipe to the previous picture starts, so it closed the viewer instead of
// turning the picture. While a viewer is open, the app keeps a band across the
// middle of both edges for itself (EdgeSwipePlugin.java; Android allows 200dp
// per edge). Back still works from the rest of the edge, and from the viewer's
// own close button. A browser has no such gesture to take back: nothing to do.

interface EdgeSwipePlugin { set(opts: { on: boolean }): Promise<void> }
const EdgeSwipe = registerPlugin<EdgeSwipePlugin>('EdgeSwipe')

// Counted, so a viewer opened over another one can't hand the edge back early.
let open = 0

function apply() {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('EdgeSwipe')) return
  EdgeSwipe.set({ on: open > 0 }).catch(() => { /* an older app: Back keeps the edge */ })
}

export function useEdgeSwipe() {
  useEffect(() => {
    open++
    apply()
    return () => { open = Math.max(0, open - 1); apply() }
  }, [])
}
