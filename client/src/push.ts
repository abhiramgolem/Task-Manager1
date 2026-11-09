// Native push registration (Android, via FCM). Runs ONLY inside the Capacitor
// app — on the website `Capacitor.isNativePlatform()` is false and this no-ops
// (the browser uses its own notification mechanism, not wired here).
//
// Flow: ask permission → register with FCM → send the device token to our server
// (/notifications/register-device) so notify() can push to it. Tapping a push
// opens the relevant screen.
import { Capacitor, registerPlugin } from '@capacitor/core'
import { api, API_BASE } from './api'
import { nativeCallsAvailable, configureNativeCalls } from './lib/nativeCall'
import { notifTarget, replacesEntry } from './lib/notifTarget'
import { shareTargetAvailable } from './lib/shareTarget'
import { openUpdate } from './lib/appUpdate'

let started = false
let lastToken: string | null = null
let lastRegisteredAt = 0
let resumeListener: { remove: () => Promise<void> } | null = null
// How often an app that keeps running re-registers its token on coming back.
const REREGISTER_MS = 6 * 3600_000

// The native side of keeping pushes coming while the app is closed
// (PushSetupPlugin.java). Builds before 4.8 do not have it.
interface PushSetup {
  setTokenSync(o: { url: string; token: string; uid: string; sid: string; exp: string; sig: string }): Promise<void>
  clearTokenSync(): Promise<void>
}
const PushSetupNative = registerPlugin<PushSetup>('PushSetup')
const pushSetupAvailable = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('PushSetup')

// The app's router, once it is mounted (App sets it). A tap then moves inside
// the running app, as the bell does, instead of reloading all of it to get
// there — a reload also threw away whatever chat or form was open.
type Go = (to: string, opts: { replace: boolean }) => void
let go: Go | null = null
export function setPushNavigator(fn: Go | null) { go = fn }

export async function registerPush() {
  if (started || !Capacitor.isNativePlatform()) return
  started = true
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')

    // Android 8+ needs a channel for the heads-up alert the server sends.
    // IMPORTANT: a channel's sound/importance are FROZEN by Android the moment it's
    // first created — later createChannel calls with the same id are ignored. The
    // original 'smarttask' channel shipped silent on some installs, so we move to a
    // NEW id ('smarttask_v2') to force a fresh channel WITH the default sound, and
    // delete the stale one so it doesn't linger in the user's notification settings.
    try { await PushNotifications.deleteChannel({ id: 'smarttask' }) } catch {}
    try {
      // No `sound` field on purpose: omitting it makes the channel use the
      // device's DEFAULT notification tone. (Capacitor's `sound` expects a file in
      // res/raw without extension, so 'default' would resolve to nothing/silent.)
      await PushNotifications.createChannel({
        id: 'smarttask_v2',
        name: 'VoTask alerts',
        description: 'Task assignments and new messages',
        importance: 5,   // IMPORTANCE_HIGH → heads-up + default sound
        visibility: 1,
      })
    } catch {}
    // VoTask's own sound (res/raw/votask_chime.wav), as Cliq has its own.
    // It comes in the same build as the share target, so that plugin being
    // there says the sound is too; the server then sends this build's pushes
    // to this channel (register-device's chime flag, push.js).
    const chime = shareTargetAvailable()
    if (chime) {
      try {
        await PushNotifications.createChannel({
          id: 'votask_chime',
          name: 'VoTask notifications',
          description: 'Task updates, mentions and new messages',
          importance: 5,
          visibility: 1,
          sound: 'votask_chime',
          vibration: true,
        })
      } catch {}
    }

    let perm = await PushNotifications.checkPermissions()
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
      perm = await PushNotifications.requestPermissions()
    }
    if (perm.receive !== 'granted') { started = false; return }

    await PushNotifications.register()

    // call_ring: this build has the native ringing screen, so the server may
    // send calls to it as silent data pushes (see sendCallPush). An older build
    // registers without it and keeps getting an ordinary notification.
    const callRing = nativeCallsAvailable()
    // This build's versionCode, so an "update available" push skips phones
    // already on the new one (the server's sendUpdatePush).
    let appBuild: number | undefined
    try { const { App } = await import('@capacitor/app'); appBuild = parseInt((await App.getInfo()).build, 10) || undefined } catch {}
    if (callRing) configureNativeCalls(API_BASE || location.origin)
    const sendToken = async (value: string) => {
      lastRegisteredAt = Date.now()
      try {
        const res: any = await api.post('/notifications/register-device', { token: value, platform: 'android', call_ring: callRing, chime, app_build: appBuild })
        // Left with the native side, so a token Firebase rotates while the app
        // is closed still reaches the server (notifications.js refresh-device).
        const ref = res?.refresh
        if (ref?.sig && pushSetupAvailable()) {
          await PushSetupNative.setTokenSync({
            url: `${API_BASE || location.origin}/api/notifications/refresh-device`,
            token: value, uid: ref.uid, sid: ref.sid || '', exp: ref.exp, sig: ref.sig,
          })
        }
      } catch {}
    }
    PushNotifications.addListener('registration', async (token) => {
      lastToken = token.value
      await sendToken(token.value)
    })
    // Back in the app after a while: say again which token is ours. The app can
    // sit in the background for days without restarting, and if the server
    // dropped the token meanwhile, this is what brings the pushes back.
    try {
      const { App } = await import('@capacitor/app')
      resumeListener = await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive && lastToken && Date.now() - lastRegisteredAt > REREGISTER_MS) sendToken(lastToken)
      })
    } catch {}
    PushNotifications.addListener('registrationError', (e) => console.warn('[push] registration error', e))

    // Tap on a notification → open the matching screen.
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const data: any = action.notification?.data || {}
      // A call: stay put. Opening the app is the point — the call screen asks
      // what is ringing as it comes up, wherever the app is.
      if (data.type === 'call' || data.type === 'call-cancel') return
      // "VoTask update available": straight to Play's update screen.
      if (data.type === 'app_update') { openUpdate(); return }
      // FCM data is all strings; an absent id arrives as ''.
      const dest = notifTarget({ type: data.type, conversationId: data.conversationId, messageId: data.messageId, taskId: data.taskId, commentId: data.commentId }) || '/tasks'
      if (go) go(dest, { replace: replacesEntry(dest, location.pathname) })
      else if (location.pathname + location.search !== dest) location.assign(dest)
    })
  } catch (e) {
    started = false
    console.warn('[push] setup failed', e)
  }
}

// Opening a chat takes its notification out of the tray, as Cliq does: the
// messages it announced are on screen now. The server tags a chat's pushes
// `chat_<id>` (its reactions `react_<id>`), which is how they are found here.
export async function clearChatNotifications(conversationId: string) {
  if (!conversationId || !Capacitor.isNativePlatform()) return
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')
    const { notifications } = await PushNotifications.getDeliveredNotifications()
    const tags = [`chat_${conversationId}`, `react_${conversationId}`]
    const shown = notifications.filter((n) => n.tag && tags.includes(n.tag))
    if (shown.length) await PushNotifications.removeDeliveredNotifications({ notifications: shown })
  } catch {}
}

// On logout, stop this device receiving the current user's pushes.
export async function unregisterPush() {
  if (!Capacitor.isNativePlatform()) return
  try {
    if (lastToken) { try { await api.post('/notifications/unregister-device', { token: lastToken }) } catch {} }
    const { PushNotifications } = await import('@capacitor/push-notifications')
    await PushNotifications.removeAllListeners()
  } catch {}
  if (pushSetupAvailable()) { try { await PushSetupNative.clearTokenSync() } catch {} }
  if (resumeListener) { try { await resumeListener.remove() } catch {} resumeListener = null }
  lastToken = null
  started = false
}

