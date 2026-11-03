// Recording a meeting with the phone's screen off (Android app).
//
// Once the screen goes off a WebView cannot keep the microphone: since Android 9
// a backgrounded app is handed silence. The app's MeetingRecorder plugin
// (client/android/.../MeetingRecorderPlugin.java) runs a microphone foreground
// service — the "Recording meeting" notification — and while it is up the page
// simply carries on recording, the way a WhatsApp call does.
//
// Everything here is a no-op on the website, and every failure is a quiet
// `false`: the recorder then keeps the screen on instead, as it always did.
import { Capacitor, registerPlugin } from '@capacitor/core'

export interface RecordingState { title: string; paused: boolean; seconds: number }

interface MeetingRecorderPlugin {
  start(s: RecordingState): Promise<void>
  update(s: RecordingState): Promise<void>
  stop(): Promise<void>
}

const MeetingRecorder = registerPlugin<MeetingRecorderPlugin>('MeetingRecorder')

const available = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('MeetingRecorder')

/** True once Android has agreed to keep the recording alive with the screen off. */
export async function keepRecordingInBackground(s: RecordingState): Promise<boolean> {
  if (!available()) return false
  try { await MeetingRecorder.start(s); return true } catch { return false }
}

/** Refresh the notification (title, paused). Never starts anything. */
export function updateBackgroundRecording(s: RecordingState) {
  if (available()) MeetingRecorder.update(s).catch(() => {})
}

export function releaseBackgroundRecording() {
  if (available()) MeetingRecorder.stop().catch(() => {})
}
