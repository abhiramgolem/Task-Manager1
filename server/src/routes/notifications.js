import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, signScoped, verifyScoped, sessionOk } from '../auth.js'
import { saveDeviceToken, removeDeviceToken } from '../push.js'
import { webPushKey, saveWebSub, removeWebSub } from '../webPush.js'
import { BELL_SKIPPED_TYPES } from '../util.js'

const r = Router()

// A credential for one device's push token, kept by the app's native side
// (PushSetupPlugin). Firebase can rotate a token while the app is closed; the
// web page that registers tokens is not running then, so the phone sends the
// new one itself with this. It is tied to the token it was issued for and to
// the sign-in: once that session is signed out it is worth nothing.
const REFRESH_DAYS = 60
const refreshScope = (uid, sid, token, exp) => `devtok:${uid}:${sid || ''}:${token}:${exp}`
function deviceRefreshFor(uid, sid, token) {
  const exp = Date.now() + REFRESH_DAYS * 86400000
  return { uid, sid: sid || '', exp: String(exp), sig: signScoped(refreshScope(uid, sid, token, exp)) }
}

// No session here: the caller is the phone's push service, with the app closed.
r.post('/refresh-device', (req, res) => {
  const { uid, sid, exp, sig, old, token } = req.body || {}
  const str = (v) => typeof v === 'string' && v.length > 0 && v.length <= 4096
  const expN = Number(exp) || 0
  if (!str(uid) || !str(old) || !str(token) || typeof sig !== 'string' || expN < Date.now()
    || !verifyScoped(refreshScope(uid, sid, old, expN), sig)) return res.status(403).json({ error: 'Forbidden' })
  if (sid && !sessionOk({ sid })) return res.status(403).json({ error: 'Signed out' })
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(uid)) return res.status(403).json({ error: 'Forbidden' })
  const prev = db.prepare('SELECT user_id, platform, call_ring, chime, app_build FROM device_tokens WHERE token=?').get(old)
  // Another account has signed in on this phone since: its pushes are theirs.
  if (prev && prev.user_id !== uid) return res.status(403).json({ error: 'Forbidden' })
  // The old row may already be gone, pruned when FCM refused the old token.
  // Its flags then come from this user's newest device row, else the defaults.
  const like = prev || db.prepare('SELECT platform, call_ring, chime, app_build FROM device_tokens WHERE user_id=? ORDER BY created_at DESC LIMIT 1').get(uid) || {}
  if (prev) removeDeviceToken(old)
  saveDeviceToken(uid, token, like.platform || 'android', { callRing: !!like.call_ring, chime: !!like.chime, appBuild: like.app_build ?? null })
  res.json({ ok: true, refresh: deviceRefreshFor(uid, sid, token) })
})

r.use(authRequired)

// Register this device's FCM token so the user gets native push. Called by the
// app after it obtains a token (and on every login, in case the token rotated).
r.post('/register-device', (req, res) => {
  const { token, platform, call_ring: callRing, chime, app_build: appBuild } = req.body || {}
  if (!token) return res.status(400).json({ error: 'token required' })
  // call_ring: this build can put up a full-screen incoming call (see sendCallPush).
  // chime: it has VoTask's own notification sound (see sendPushToUser).
  // app_build: its versionCode (see sendUpdatePush).
  const build = Number.isInteger(appBuild) && appBuild > 0 && appBuild < 1e7 ? appBuild : null
  saveDeviceToken(req.user.id, token, platform || 'android', { callRing: !!callRing, chime: !!chime, appBuild: build })
  res.json({ ok: true, refresh: deviceRefreshFor(req.user.id, req.sessionId, token) })
})

// Browser notifications (webPush.js): the key a browser subscribes with, and
// its subscription in and out. Out on sign-out, so a shared computer stops
// showing this person's messages.
r.get('/web-push-key', (req, res) => {
  try { res.json({ key: webPushKey() }) } catch (e) { res.status(503).json({ error: 'Browser notifications are not available' }) }
})
r.post('/web-subscribe', (req, res) => {
  if (!saveWebSub(req.user.id, req.body?.subscription, req.headers['user-agent'])) return res.status(400).json({ error: 'Invalid subscription' })
  res.json({ ok: true })
})
r.post('/web-unsubscribe', (req, res) => {
  removeWebSub(req.body?.endpoint, req.user.id)
  res.json({ ok: true })
})

// Unregister on logout so a shared device stops receiving this user's pushes.
r.post('/unregister-device', (req, res) => {
  const { token } = req.body || {}
  removeDeviceToken(token)
  res.json({ ok: true })
})

// My notifications, newest first — tasks and mentions; the rest of chat lives in Chats.
r.get('/', (req, res) => {
  const rows = db.prepare(`SELECT * FROM notifications WHERE user_id=? AND type NOT IN (${BELL_SKIPPED_TYPES.map(() => '?').join(',')})
    ORDER BY created_at DESC LIMIT 50`).all(req.user.id, ...BELL_SKIPPED_TYPES)
  const unread = rows.filter((n) => !n.read).length
  res.json({ items: rows, unread })
})

// Mark all my notifications read.
r.post('/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET read=1 WHERE user_id=? AND read=0').run(req.user.id)
  res.json({ ok: true })
})

// Mark a single notification read.
r.post('/:id/read', (req, res) => {
  db.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=?').run(req.params.id, req.user.id)
  res.json({ ok: true })
})

export default r
