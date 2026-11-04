import { Router } from 'express'
import { db } from '../db.js'
import { authRequired } from '../auth.js'
import { saveDeviceToken, removeDeviceToken } from '../push.js'
import { BELL_SKIPPED_TYPES } from '../util.js'

const r = Router()
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
