import { Router } from 'express'
import { db } from '../db.js'
import { authRequired } from '../auth.js'
import { audit } from '../util.js'
import { hrmsEnabled, hrmsBaseUrl, signHrmsToken, signHrmsLoginToken, validLoginNonce, fetchBoard, invalidateBoard } from '../hrms.js'
import { pushToUser, getOnlineUsers } from '../ws/chatHub.js'

// Check in / Check out, backed by the Befach HRMS (see hrms.js). The punch
// itself goes from the browser straight to the HRMS; these routes only hand the
// browser a token for that and keep everyone's In chips current.
const r = Router()
r.use(authRequired)

// The HRMS takes the token's email as the employee's identity, so a token is
// minted only for a verified address. An unverified one could be anybody's:
// self-joined accounts start unverified, and changing your email in Profile
// resets the flag. The email always comes from the signed-in user row, never
// from the request.
r.get('/session', (req, res) => {
  if (!hrmsEnabled()) return res.json({ enabled: false })
  if (!req.user.email_verified) return res.json({ enabled: true, hrmsUrl: hrmsBaseUrl(), needsVerification: true })
  const { token, expiresIn } = signHrmsToken(req.user.email, 'user')
  res.json({ enabled: true, hrmsUrl: hrmsBaseUrl(), token, expiresIn })
})

// "Sign in with VoTask" on the HRMS (client page /hrms-login). The browser
// arrives with the HRMS's nonce in ?state=; the token goes back to the HRMS
// address configured here, never to an address from the request. Audited, so
// "who signed in to the HRMS through VoTask" can be answered from this side too.
r.post('/login-token', (req, res) => {
  if (!hrmsEnabled()) return res.status(404).json({ error: 'HRMS sign-in is not set up.' })
  if (!req.user.email_verified) return res.status(403).json({ error: 'Verify your email first.', needsVerification: true })
  const nonce = req.body?.state
  if (!validLoginNonce(nonce)) return res.status(400).json({ error: 'This sign-in link is incomplete. Start again from the HRMS sign-in page.' })
  audit(req.user.org_id, req.user.id, 'hrms.login', 'user', req.user.id)
  res.json({ hrmsUrl: hrmsBaseUrl(), token: signHrmsLoginToken(req.user.email, nonce) })
})

// The HRMS board keyed by this org's user ids. One indexed lookup for the
// people on the board (users.email is UNIQUE, so it has an index; emails are
// stored lowercased) — never a walk over the org's users per request. Only
// verified addresses count, for the same reason /session needs one: an
// unverified account must not wear someone else's In chip.
// Prepared on first use, not at import: routers are imported before
// initSchema() runs, and on an older database email_verified only exists once
// its ensureColumn has.
let byEmails = null
function boardFor(orgId, people) {
  if (!people.length) return {}
  byEmails ||= db.prepare(
    `SELECT id, email FROM users WHERE email IN (SELECT value FROM json_each(?)) AND org_id = ? AND email_verified = 1`
  )
  const rows = byEmails.all(JSON.stringify(people.map((p) => p.email)), orgId)
  const idOf = new Map(rows.map((u) => [String(u.email).toLowerCase(), u.id]))
  const out = {}
  for (const p of people) {
    const uid = idOf.get(p.email)
    if (uid) out[uid] = { state: p.state, since: p.since }
  }
  return out
}

r.get('/board', async (req, res) => {
  if (!hrmsEnabled()) return res.json({})
  res.json(boardFor(req.user.org_id, await fetchBoard()))
})

// Called by the client right after a punch succeeds: refetch the board now
// rather than up to a minute later, and push it to everyone online in the org
// so their chips flip without waiting for their own poll. A double tap, or two
// tabs both reporting the same punch, costs one HRMS request, not several.
const lastChange = new Map() // userId -> ms
const CHANGE_GAP_MS = 5000
r.post('/changed', async (req, res) => {
  if (!hrmsEnabled()) return res.json({ ok: true, board: {} })
  const t = Date.now()
  const prev = lastChange.get(req.user.id) || 0
  if (t - prev < CHANGE_GAP_MS) return res.json({ ok: true, skipped: true })
  lastChange.set(req.user.id, t)
  // Bounded: drop entries old enough to no longer matter.
  if (lastChange.size > 500) for (const [k, v] of lastChange) if (t - v > CHANGE_GAP_MS) lastChange.delete(k)

  invalidateBoard()
  const board = boardFor(req.user.org_id, await fetchBoard())
  for (const uid of getOnlineUsers(req.user.org_id)) pushToUser(uid, { type: 'attendance', board })
  audit(req.user.org_id, req.user.id, 'attendance.punch', 'user', req.user.id, board[req.user.id]?.state || 'OUT')
  res.json({ ok: true, board })
})

export default r
