// Native push notifications via Firebase Cloud Messaging (FCM HTTP v1).
//
// Deliberately AVOIDS the heavy `firebase-admin` SDK: we mint a short-lived OAuth
// access token from the service account using `jsonwebtoken` (already a dep) and
// POST to the FCM v1 endpoint with plain fetch. This keeps the Render build small
// and fast.
//
// Credentials come from the FIREBASE_SERVICE_ACCOUNT env var (the full service-
// account JSON, set in the Render dashboard — never committed). Missing/invalid →
// every function here is a safe no-op, so the app runs fine without push.
import jwt from 'jsonwebtoken'
import { db } from './db.js'
import { sendWebPush } from './webPush.js'

let svc = null // parsed service account
let svcTried = false
let cachedToken = null // { access_token, exp(ms) }

function getServiceAccount() {
  if (svcTried) return svc
  svcTried = true
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!raw) { console.log('  Push: off (FIREBASE_SERVICE_ACCOUNT not set)'); return null }
  try {
    svc = JSON.parse(raw)
    if (!svc.client_email || !svc.private_key || !svc.project_id) throw new Error('missing client_email/private_key/project_id')
    console.log(`  Push: on (FCM project ${svc.project_id})`)
  } catch (e) {
    console.warn('  Push: FIREBASE_SERVICE_ACCOUNT invalid —', e.message)
    svc = null
  }
  return svc
}

// Exchange the service account for a Google OAuth access token (cached ~1h).
async function getAccessToken() {
  const sa = getServiceAccount()
  if (!sa) return null
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.access_token
  const nowSec = Math.floor(Date.now() / 1000)
  const key = sa.private_key.replace(/\\n/g, '\n') // tolerate double-escaped newlines
  const assertion = jwt.sign(
    {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    },
    key,
    { algorithm: 'RS256' },
  )
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.access_token) throw new Error(`oauth ${res.status}: ${JSON.stringify(data).slice(0, 200)}`)
  cachedToken = { access_token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 }
  return cachedToken.access_token
}

// Whether this server can send pushes at all (FIREBASE_SERVICE_ACCOUNT set).
export const pushEnabled = () => !!getServiceAccount()

// Persist a device's FCM token for a user (idempotent: one row per token).
export function saveDeviceToken(userId, token, platform = 'android', { callRing = false, chime = false, appBuild = null } = {}) {
  if (!userId || !token) return
  // A token can migrate between users (shared device / re-login) — keep it tied to
  // the latest user so pushes never leak to a previous account.
  db.prepare('DELETE FROM device_tokens WHERE token=?').run(token)
  db.prepare(
    `INSERT INTO device_tokens (id, user_id, token, platform, created_at, call_ring, chime, app_build) VALUES (?,?,?,?,?,?,?,?)`
  ).run(`dev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, userId, token, platform, new Date().toISOString(), callRing ? 1 : 0, chime ? 1 : 0, appBuild)
}

export function removeDeviceToken(token) {
  if (!token) return
  db.prepare('DELETE FROM device_tokens WHERE token=?').run(token)
}

// Fire-and-forget push to all of a user's devices. Never throws — failures are
// logged and dead tokens are pruned. FCM HTTP v1 sends one token per request.
//
// `tag`: a notification with the same tag replaces the one already in the
// tray rather than adding another — one notification per chat, not per line.
//
// A build that registered with chime=1 has VoTask's own sound in res/raw and a
// channel playing it ('votask_chime', push.ts); Android takes the sound from
// the channel. An older build has neither, so it keeps its default-tone one.
//
// `rich` ({ chat, sender, text, group }), for a chat line: a build from
// RICH_CHAT_FROM on gets it as data and draws the chat's notification itself,
// WhatsApp's way, every message listed under a pull-down (ChatNotifier.java).
// Older builds get the ordinary notification.
export async function sendPushToUser(userId, { title, body, data, tag, rich }) {
  if (!userId) return
  // The same notification to the browsers this person turned it on in.
  sendWebPush(userId, { title, body, tag, data }).catch(() => {})
  const rows = db.prepare('SELECT token, chime, app_build FROM device_tokens WHERE user_id=?').all(userId)
  await sendToDevices(rows, { title, body, data, tag, rich })
}

// The first versionCode with ChatNotifier.
const RICH_CHAT_FROM = 29

// "A new version is on the Play Store", to every phone whose app is older than
// belowBuild (its versionCode). Builds before 4.5 do not report their version
// (app_build is NULL), so they count as older. Returns how many phones it
// went to. Sent from the platform console once a release is live on Play.
export async function sendUpdatePush(belowBuild, { title, body }) {
  const rows = db.prepare('SELECT token, chime FROM device_tokens WHERE app_build IS NULL OR app_build < ?').all(belowBuild)
  const sent = await sendToDevices(rows, { title, body, data: { type: 'app_update' }, tag: 'app_update' })
  return { devices: rows.length, sent }
}

// One notification to each of these devices (rows of token, chime, and
// app_build where known). Returns how many FCM accepted.
async function sendToDevices(rows, { title, body, data, tag, rich }) {
  const sa = getServiceAccount()
  if (!sa || !rows.length) return 0

  let accessToken
  try { accessToken = await getAccessToken() } catch (e) { console.warn('  [push] auth failed:', e.message); return 0 }
  if (!accessToken) return 0

  const stringData = {}
  for (const [k, v] of Object.entries(data || {})) stringData[k] = v == null ? '' : String(v)

  const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`
  let sent = 0
  // Data only, no notification block: Android would draw that one itself and
  // the app's own conversation-style notification would never be built.
  const richData = rich && {
    ...stringData, rich: '1', chat: String(rich.chat || ''), sender: String(rich.sender || ''),
    text: String(rich.text || ''), group: rich.group ? '1' : '0',
    // The notification's Reply / Mark as read / Mute buttons (chat.js notifActionFor).
    ...(rich.act ? { act_uid: rich.act.uid, act_exp: rich.act.exp, act_sig: rich.act.sig, act_url: rich.act.url } : {}),
  }
  await Promise.all(rows.map(async ({ token: tok, chime, app_build: build }) => {
    try {
      const message = richData && build >= RICH_CHAT_FROM
        ? { token: tok, data: richData, android: { priority: 'high' } }
        : {
            token: tok,
            notification: { title, body },
            data: stringData,
            android: {
              priority: 'high',
              notification: chime
                ? { sound: 'votask_chime', channel_id: 'votask_chime', ...(tag ? { tag } : {}) }
                : { sound: 'default', channel_id: 'smarttask_v2', ...(tag ? { tag } : {}) },
            },
          }
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      })
      if (res.ok) { sent++; return }
      const err = await res.json().catch(() => ({}))
      const status = err?.error?.status || ''
      // Prune tokens FCM says are gone/invalid so they don't pile up. A bare
      // INVALID_ARGUMENT is also FCM's answer to a payload it will not take
      // (too big, a bad field), and pruning on that silently cut a phone off
      // until the app was next opened and registered again. Only a refusal
      // that names the token itself means the token is bad.
      const badToken = status === 'INVALID_ARGUMENT' && /registration token/i.test(err?.error?.message || '')
      if (res.status === 404 || status === 'NOT_FOUND' || status === 'UNREGISTERED' || badToken) {
        db.prepare('DELETE FROM device_tokens WHERE token=?').run(tok)
      } else {
        console.warn('  [push] send failed', res.status, JSON.stringify(err).slice(0, 150))
      }
    } catch (e) {
      console.warn('  [push] send error:', e.message)
    }
  }))
  return sent
}

// An incoming call, WhatsApp-style. Two shapes, because two generations of the
// app are installed:
//
// - An app that can ring natively (registered with call_ring=1) gets a DATA-ONLY
//   message. That is the whole trick: a message with a `notification` block is
//   drawn by Android itself while the app is in the background and never reaches
//   our code, so it could only ever be an ordinary one-line notification. Data
//   alone always wakes the app's messaging service, which puts up a full-screen
//   ringing call over the lock screen.
// - An older app would silently drop a data-only message, so it gets a normal
//   high-priority notification instead — at least the phone buzzes and says who
//   is calling. `tag` makes a second ring for the same call replace the first.
//
// TTL is the ring window: a push still queued after the call stopped ringing
// (a phone that was off, a network that came back late) must not ring at all.
export async function sendCallPush(userId, data, { ttlSec = 60, title = '', body = '' } = {}) {
  const sa = getServiceAccount()
  if (!sa || !userId) return
  const rows = db.prepare('SELECT token, call_ring FROM device_tokens WHERE user_id=?').all(userId)
  if (!rows.length) return
  let accessToken
  try { accessToken = await getAccessToken() } catch (e) { console.warn('  [push] auth failed:', e.message); return }
  if (!accessToken) return

  const stringData = {}
  for (const [k, v] of Object.entries(data || {})) stringData[k] = v == null ? '' : String(v)
  const cancel = stringData.type === 'call-cancel'
  const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`
  await Promise.all(rows.map(async ({ token: tok, call_ring: native }) => {
    // A cancel means nothing to an app that never put up a ringing screen.
    if (cancel && !native) return
    const message = native
      ? { token: tok, data: stringData, android: { priority: 'high', ttl: `${ttlSec}s` } }
      : {
          token: tok,
          notification: { title, body },
          data: stringData,
          android: { priority: 'high', ttl: `${ttlSec}s`, notification: { sound: 'default', channel_id: 'smarttask_v2', tag: `call_${stringData.call_id}` } },
        }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        const status = err?.error?.status || ''
        // Unlike sendPushToUser, INVALID_ARGUMENT does not prune here: it is
        // also what FCM answers to a malformed message, and a mistake in this
        // payload must not quietly delete every phone's token.
        if (res.status === 404 || status === 'NOT_FOUND' || status === 'UNREGISTERED') {
          db.prepare('DELETE FROM device_tokens WHERE token=?').run(tok)
        } else {
          console.warn('  [push] call push failed', res.status, JSON.stringify(err).slice(0, 150))
        }
      }
    } catch (e) {
      console.warn('  [push] call push error:', e.message)
    }
  }))
}
