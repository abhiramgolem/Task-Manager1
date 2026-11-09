// Browser notifications on the website (Web Push). The phone app has its own
// (push.ts, FCM); this is the website's: a new message or task reaches the
// computer while VoTask's tab is in the background, or closed while the
// browser runs. The server sends the same notification to both
// (server/src/webPush.js); public/sw.js shows it and opens what it is about.
import { Capacitor } from '@capacitor/core'
import { api } from '../api'

// Turned off here on purpose: don't quietly subscribe again on the next load.
const OFF_KEY = 'votask_webpush_off'
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string | null) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch {} },
}

// The browser's endpoint once known, so signing out can drop it without
// waiting on anything (the session is cleared straight after).
let endpoint: string | null = null

export const webPushSupported = () =>
  !Capacitor.isNativePlatform() && typeof window !== 'undefined' && window.isSecureContext
  && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

// An iPhone or iPad in Safari, not opened from the Home Screen. Apple gives
// a website notifications only once it has been added to the Home Screen and
// is opened from there (iOS 16.4 and later); in a Safari tab there is no Push
// API at all. So there the answer is "add it to the Home Screen first".
export const isIOS = () => typeof navigator !== 'undefined'
  && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true
export const needsHomeScreen = () => !Capacitor.isNativePlatform() && isIOS() && !standalone()

export type WebPushState = 'on' | 'off' | 'blocked' | 'unsupported'
export function webPushState(): WebPushState {
  if (!webPushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  if (Notification.permission === 'granted' && store.get(OFF_KEY) !== '1') return 'on'
  return 'off'
}

const toBytes = (b64: string) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}
const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => {
  if (!a) return false
  const x = new Uint8Array(a)
  return x.length === b.length && x.every((v, i) => v === b[i])
}

let listening = false
function listen() {
  if (listening) return
  listening = true
  // A click on a notification while VoTask is open: move there inside the app.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'votask-open' && typeof e.data.url === 'string') {
      window.dispatchEvent(new CustomEvent('votask-open', { detail: e.data.url }))
    }
  })
}

async function subscribe() {
  const reg = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  listen()
  const { key } = await api.get('/notifications/web-push-key')
  const want = toBytes(key)
  let sub = await reg.pushManager.getSubscription()
  // Made with another server key (the server's keys changed): it can never
  // receive anything again, so it is replaced.
  if (sub && !sameKey(sub.options?.applicationServerKey, want)) { await sub.unsubscribe().catch(() => {}); sub = null }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want })
  endpoint = sub.endpoint
  await api.post('/notifications/web-subscribe', { subscription: sub.toJSON() })
}

// From a click (the browser only asks for permission inside one).
export async function enableWebPush(): Promise<WebPushState | 'error'> {
  if (!webPushSupported()) return 'unsupported'
  const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  if (perm === 'denied') return 'blocked'
  if (perm !== 'granted') return 'off'
  store.set(OFF_KEY, null)
  try { await subscribe(); return 'on' } catch { return 'error' }
}

// Turned off on this browser by its user: the server forgets it and the
// browser's subscription goes too.
export async function turnOffWebPush() {
  store.set(OFF_KEY, '1')
  await dropWebPush()
  try { const reg = await navigator.serviceWorker.getRegistration(); const sub = await reg?.pushManager.getSubscription(); await sub?.unsubscribe() } catch {}
}

// On every sign-in and page load: if this browser has notifications on, tell
// the server again which person it belongs to now. Never asks for permission.
export async function syncWebPush() {
  if (webPushState() !== 'on') return
  try { await subscribe() } catch {}
}

// Signing out: this browser stops getting the person's notifications. The
// request goes out before the session is cleared, so it is made synchronously.
export function dropWebPush(): Promise<void> {
  const ep = endpoint
  endpoint = null
  if (!ep) return Promise.resolve()
  return api.post('/notifications/web-unsubscribe', { endpoint: ep }).then(() => {}, () => {})
}
