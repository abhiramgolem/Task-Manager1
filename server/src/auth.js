import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { db } from './db.js'
import { id, now, deviceLabel } from './util.js'

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'
// How long a login stays valid. Long-lived so users aren't logged out mid-use;
// override with JWT_EXPIRES_IN (e.g. '12h', '7d', '30d').
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d'

export const hashPassword = (pw) => bcrypt.hashSync(pw, 10)
// A Google-only account has no password hash; compareSync throws on that rather
// than answering "no", which turned a wrong login into a 500.
export const verifyPassword = (pw, hash) => !!hash && bcrypt.compareSync(String(pw), hash)
// The async forms hash in slices between turns of the event loop. bcryptjs is
// pure JavaScript, so the sync form holds the one server thread for ~100-250 ms
// per call — on the login path, which anyone can call, that froze everyone.
export const hashPasswordAsync = (pw) => bcrypt.hash(String(pw), 10)
export const verifyPasswordAsync = async (pw, hash) => !!hash && bcrypt.compare(String(pw), hash)

// Every login opens a session row, and its id rides in the token. That is what
// makes signing out mean something: the JWT is stateless and lives 30 days, so
// before this a token could not be taken back once issued — "log out this
// device" could not reach the phone that held it.
export function createSession(user, req) {
  const sid = id('ses')
  const ts = now()
  const ip = String(req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '').split(',')[0].trim() || null
  db.prepare('INSERT INTO sessions (id, user_id, device, ip, created_at, last_seen_at) VALUES (?,?,?,?,?,?)')
    .run(sid, user.id, deviceLabel(req?.get?.('user-agent')), ip, ts, ts)
  return sid
}

export function signToken(user, sessionId = null) {
  const payload = { sub: user.id, role: user.role, org_id: user.org_id, name: user.name }
  if (sessionId) payload.sid = sessionId
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN })
}

// A token is good only while its session is. Tokens issued before sessions
// existed carry no sid — those stay valid rather than logging everyone out on
// deploy; they simply can't be listed or revoked until their next sign-in.
export function sessionOk(payload) {
  if (!payload?.sid) return true
  const row = db.prepare('SELECT revoked_at FROM sessions WHERE id=?').get(payload.sid)
  return !!row && !row.revoked_at
}
// Cheap "last seen": only write when the stored value is over a minute old, so
// an active client doesn't cost a write per request.
function touchSession(sid) {
  if (!sid) return
  const row = db.prepare('SELECT last_seen_at FROM sessions WHERE id=?').get(sid)
  if (row && Date.now() - Date.parse(row.last_seen_at) > 60000) {
    db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(now(), sid)
  }
}

// Verify a raw JWT (e.g. from a WebSocket query string, where headers can't be
// set) and return the matching user row, or null if invalid/expired/unknown.
export function verifyToken(token) {
  if (!token) return null
  try {
    const payload = jwt.verify(token, SECRET)
    if (!sessionOk(payload)) return null   // a revoked device must not keep its socket either
    return db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub) || null
  } catch {
    return null
  }
}

// A signature over one specific thing ("decline call X as user Y"), for a
// caller that holds no session. A phone ringing from a push has no JWT in
// native code — handing the app's 30-day token to the native layer just so a
// Decline button can work would put a full credential somewhere it never had
// to be. This proves only the one action it was minted for.
export const signScoped = (value) => crypto.createHmac('sha256', SECRET).update(String(value)).digest('hex')
export function verifyScoped(value, sig) {
  const want = Buffer.from(signScoped(value), 'hex')
  const got = Buffer.from(String(sig || ''), 'hex')
  return got.length === want.length && crypto.timingSafeEqual(got, want)
}

// ---- API keys ---------------------------------------------------------------
// The non-browser way in. See the api_keys table in db.js for the model; the
// short version is that a key IS a user, with that user's role and org.

export const API_KEY_PREFIX = 'votask_sk_'
export const isApiKey = (token) => typeof token === 'string' && token.startsWith(API_KEY_PREFIX)
// SHA-256 rather than bcrypt, deliberately. bcrypt's cost exists to slow down
// guessing a low-entropy human password; a key is 256 bits of CSPRNG output, so
// there is nothing to guess, and paying ~100ms of KDF on every single API request
// would be a real cost for no gain.
export const hashApiKey = (token) => crypto.createHash('sha256').update(token).digest('hex')

// Mint a new key. Returns the plaintext ONCE — the caller must hand it straight
// to the user, because nothing can recover it afterwards.
export function generateApiKey() {
  const token = API_KEY_PREFIX + crypto.randomBytes(32).toString('base64url')
  return { token, hash: hashApiKey(token), prefix: token.slice(0, API_KEY_PREFIX.length + 6) }
}

// Resolve a key to its user, or null. Null covers unknown, revoked, expired, and
// the case where the owner has since been deleted or moved to another org — a key
// must never outlive the access it was granted alongside.
export function userForApiKey(token, { allowScopes = ['full'] } = {}) {
  const row = db.prepare('SELECT * FROM api_keys WHERE token_hash = ?').get(hashApiKey(token))
  if (!row || row.revoked_at) return null
  if (row.expires_at && row.expires_at <= new Date().toISOString()) return null
  // Scope is the blast-radius control. A connector key rides inside a URL, which
  // is a place secrets leak from, so it is refused everywhere except /mcp — a
  // leaked connector URL must not also be a general REST credential.
  if (!allowScopes.includes(row.scope || 'full')) return null
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id)
  if (!user || user.org_id !== row.org_id) return null
  touchApiKey(row)
  return { user, key: row }
}

// "Last used" is for the human deciding whether a key is still needed, so
// minute-granularity is plenty — and a write on every request to a hot endpoint
// would be pure overhead.
function touchApiKey(row) {
  const iso = new Date().toISOString()
  if (row.last_used_at && Date.now() - Date.parse(row.last_used_at) < 60_000) return
  try { db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(iso, row.id) } catch { /* best-effort */ }
}

// Refuse an API key where only a real signed-in session will do.
//
// Minting keys is the one that matters: a stolen key that can mint replacements
// for itself cannot be revoked, because every revocation leaves behind the key it
// just issued. Anything that changes credentials belongs here for the same reason.
export function requireSession(req, res, next) {
  if (req.apiKey) {
    return res.status(403).json({ error: 'This action needs a signed-in session, not an API key.' })
  }
  next()
}

export function authRequired(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Authentication required' })
  if (isApiKey(token)) {
    // Only 'full' keys are REST credentials. A connector key presented here is a
    // sign its URL leaked, so it is rejected exactly like an unknown one.
    const hit = userForApiKey(token, { allowScopes: ['full'] })
    if (!hit) return res.status(401).json({ error: 'Invalid, expired or revoked API key' })
    req.user = hit.user
    req.apiKey = hit.key      // set ONLY on key auth — requireSession reads it
    return next()
  }
  try {
    const payload = jwt.verify(token, SECRET)
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub)
    if (!user) return res.status(401).json({ error: 'Invalid session' })
    if (!sessionOk(payload)) return res.status(401).json({ error: 'This device was signed out' })
    touchSession(payload.sid)
    req.user = user
    req.sessionId = payload.sid || null
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

// Role-gate. Usage: requireRole('admin') or requireRole('admin','manager')
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' })
    }
    next()
  }
}

// Platform-admin gate: only a flagged super-admin may access cross-org routes.
// This is the single, deliberate exception to per-org isolation.
export function requirePlatformAdmin(req, res, next) {
  if (!req.user || !req.user.platform_admin) {
    return res.status(403).json({ error: 'Platform admin access required' })
  }
  next()
}

// Emails designated as platform admins via env (comma-separated). The operator
// controls this on the server, so super-admins can't be self-granted in the app.
export function platformAdminEmails() {
  return (process.env.PLATFORM_ADMIN_EMAILS || '')
    .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)
}
