// The Befach HRMS link for Check in / Check out. Attendance lives in the HRMS
// (a separate Next.js app); VoTask only vouches for who the signed-in user is.
//
// The browser talks to the HRMS directly for punches, not through this server:
// the HRMS judges a punch by the employee's own internet address and browser
// (office network, phone vs laptop), and a relay would make every punch look
// like it came from Render. So this module does two small things: it signs a
// short-lived token naming the user, and it keeps a cached copy of the HRMS
// "who is checked in" board for the In chips next to people's names.
//
// Off when HRMS_BASE_URL or VOTASK_HRMS_SECRET is missing — every caller treats
// that as "no attendance feature", never as an error.
import crypto from 'node:crypto'

const TOKEN_TTL_SECONDS = 300
const BOARD_TTL_MS = 60_000

export function hrmsBaseUrl() {
  return String(process.env.HRMS_BASE_URL || '').trim().replace(/\/+$/, '')
}

export function hrmsEnabled() {
  return !!(hrmsBaseUrl() && process.env.VOTASK_HRMS_SECRET)
}

const b64url = (buf) => Buffer.from(buf).toString('base64url') // no padding

// The exact format the HRMS verifies: base64url(JSON payload) "." base64url(
// HMAC-SHA256 over that base64url string). The HRMS trusts the email in here
// completely, so callers must only ever pass req.user.email of a user whose
// address is verified — never anything from a request body.
export function signHrmsToken(email, aud) {
  const iat = Math.floor(Date.now() / 1000)
  const payload = { v: 1, email: String(email || '').trim().toLowerCase(), aud, iat, exp: iat + TOKEN_TTL_SECONDS }
  const body = b64url(JSON.stringify(payload))
  const sig = b64url(crypto.createHmac('sha256', process.env.VOTASK_HRMS_SECRET).update(body).digest())
  return { token: `${body}.${sig}`, expiresIn: TOKEN_TTL_SECONDS }
}

// "Sign in with VoTask" on the HRMS: a one-minute token for the same verified
// email, carrying the nonce the HRMS put in the browser's cookie before sending
// it here, so the HRMS only accepts it in that browser. Same caller rule as
// signHrmsToken: req.user.email of a verified user, never request input.
const LOGIN_TTL_SECONDS = 60
const NONCE = /^[A-Za-z0-9_-]{22,128}$/

export function validLoginNonce(nonce) {
  return typeof nonce === 'string' && NONCE.test(nonce)
}

export function signHrmsLoginToken(email, nonce) {
  const iat = Math.floor(Date.now() / 1000)
  const payload = { v: 1, email: String(email || '').trim().toLowerCase(), aud: 'login', nonce, iat, exp: iat + LOGIN_TTL_SECONDS }
  const body = b64url(JSON.stringify(payload))
  const sig = b64url(crypto.createHmac('sha256', process.env.VOTASK_HRMS_SECRET).update(body).digest())
  return `${body}.${sig}`
}

// The board, cached for a minute: every open VoTask tab polls it, and the HRMS
// should see one request a minute from us, not one per tab. On any failure the
// last good copy is served (or an empty board) — an HRMS outage must never
// break a chat screen, so nothing here throws.
let cache = { people: [], at: 0 }
let inflight = null

export function invalidateBoard() {
  cache = { ...cache, at: 0 }
}

export async function fetchBoard() {
  if (!hrmsEnabled()) return []
  if (Date.now() - cache.at < BOARD_TTL_MS) return cache.people
  // One request at a time: a burst of tabs at the top of the minute shares it.
  if (!inflight) {
    inflight = (async () => {
      try {
        const res = await fetch(`${hrmsBaseUrl()}/api/votask/board`, {
          signal: AbortSignal.timeout(8000),
          headers: { authorization: `Bearer ${signHrmsToken('votask-board@system', 'board').token}` },
        })
        const data = await res.json().catch(() => null)
        if (!res.ok || !data?.ok || !Array.isArray(data.people)) {
          console.warn(`[hrms] board ${res.status}: ${String(data?.error || '').slice(0, 120)}`)
          // Retry no sooner than a normal refresh would, so a down HRMS is not hammered.
          cache = { ...cache, at: Date.now() }
          return cache.people
        }
        const people = data.people
          .filter((p) => p && typeof p.email === 'string' && (p.state === 'IN' || p.state === 'PENDING'))
          .map((p) => ({ email: p.email.trim().toLowerCase(), state: p.state, since: typeof p.since === 'string' ? p.since : null }))
        cache = { people, at: Date.now() }
        return people
      } catch (e) {
        console.warn('[hrms] board failed:', e?.message || e)
        cache = { ...cache, at: Date.now() }
        return cache.people
      } finally {
        inflight = null
      }
    })()
  }
  return inflight
}
