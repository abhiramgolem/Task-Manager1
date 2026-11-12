import { Router } from 'express'
import { OAuth2Client } from 'google-auth-library'
import { db } from '../db.js'
import { signToken, verifyPassword, hashPassword, verifyPasswordAsync, authRequired, platformAdminEmails, createSession } from '../auth.js'
import { audit, id, now, genToken, appUrl, inDays, isCommonPassword } from '../util.js'
import { sendMail } from '../mailer.js'
import { sendVerificationEmail, confirmOwnEmail } from '../emailCodes.js'

const r = Router()

// Google Sign-In: the Web OAuth client id. The same id renders the button on the
// client (VITE_GOOGLE_CLIENT_ID) and is verified here (a token's `aud` must match).
// Empty until configured, in which case the /google route reports it's not set up.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
// Extra client ids accepted on the token's `aud` — needed for native mobile, where
// Google issues the id token under the platform (Android/iOS) client id rather than
// the web one. Comma-separated in GOOGLE_CLIENT_IDS_EXTRA.
const GOOGLE_AUDIENCES = [GOOGLE_CLIENT_ID, ...(process.env.GOOGLE_CLIENT_IDS_EXTRA || '')
  .split(',').map((s) => s.trim()).filter(Boolean)].filter(Boolean)
const googleClient = new OAuth2Client()

// Every new org starts with the same four departments the seed uses, so the
// product is immediately usable after signup.
const DEFAULT_DEPARTMENTS = ['IT', 'Marketing', 'Sales', 'Management']
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// SELF-SERVE SIGNUP: create a brand-new organization plus its first account (a
// "manager" — the de-facto org admin in this app) in one atomic step. This is what
// lets a new company onboard itself without anyone provisioning them by hand.
// Append the workspace type so the client can tailor the UI: a "personal" (solo)
// workspace hides team features; a company workspace keeps them. Reuses the same
// org-scoped data model — a solo user is simply an organization of one.
function userWithWorkspace(user) {
  const org = db.prepare('SELECT is_personal FROM organizations WHERE id = ?').get(user.org_id)
  return { ...publicUser(user), workspace_personal: org?.is_personal ? 1 : 0, platform_admin: user.platform_admin ? 1 : 0 }
}

r.post('/signup', (req, res) => {
  const personal = !!req.body?.personal
  const name = String(req.body?.name || '').trim()
  const email = String(req.body?.email || '').toLowerCase().trim()
  const password = String(req.body?.password || '')
  // SOLO accounts need no company name — auto-derive a workspace name from the
  // person's name. COMPANY signups still require one. Either way the user is the
  // manager of their own org (org-of-one for solo), so nothing about orgs changes.
  const company = personal
    ? `${(name.split(' ')[0] || name || 'My')}'s workspace`
    : String(req.body?.company || '').trim()

  if (!name || !email || !password || (!personal && !company)) {
    return res.status(400).json({ error: personal
      ? 'Name, email and password are all required.'
      : 'Company, name, email and password are all required.' })
  }
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' })
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' })
  if (isCommonPassword(password)) return res.status(400).json({ error: 'That password is too common — please choose a stronger one.' })

  // Email is globally unique (one login = one person). Friendly check up front so
  // we don't surface a raw SQLite constraint error.
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An account with this email already exists. Try logging in instead.' })
  }

  // Provision org + departments + first user atomically: if anything fails, nothing
  // is left half-created.
  // Every workspace starts open to any email domain. Company signups used to be
  // seeded with the founder's own domain, which locked a workspace to a rule
  // nobody chose — the first teammate on gmail or another company's address was
  // refused. Admins who do want a restriction set it under Administration.
  const provision = db.transaction(() => {
    const orgId = id('org')
    db.prepare('INSERT INTO organizations (id, name, is_personal, created_at) VALUES (?,?,?,?)')
      .run(orgId, company, personal ? 1 : 0, now())
    let mgmtDeptId = null
    for (const dept of DEFAULT_DEPARTMENTS) {
      const did = id('dep')
      db.prepare('INSERT INTO departments (id, org_id, name) VALUES (?,?,?)').run(did, orgId, dept)
      if (dept === 'Management') mgmtDeptId = did
    }
    const uid = id('usr')
    db.prepare(`INSERT INTO users
      (id, org_id, department_id, name, email, password_hash, role, aliases, preferred_language, avatar_color, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      uid, orgId, mgmtDeptId, name, email, hashPassword(password), 'manager', '', 'en', '#6366f1', now())
    return db.prepare('SELECT * FROM users WHERE id = ?').get(uid)
  })

  let user
  try { user = provision() }
  catch (err) {
    console.error('[auth] signup failed:', err.message)
    // Unique-constraint race (email taken between the check and the insert).
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'An account with this email already exists. Try logging in instead.' })
    }
    return res.status(500).json({ error: 'Could not create your account. Please try again.' })
  }

  audit(user.org_id, user.id, personal ? 'account.signup' : 'org.signup', 'organization', user.org_id, company)
  // Best effort and not awaited: the account exists either way, and the card in
  // the app can send another code if this one never arrives.
  sendVerificationEmail(user).then((out) => { if (out.error) console.warn('[auth] verification email failed:', out.error) })
  res.status(201).json({ token: signToken(user, createSession(user, req)), user: userWithWorkspace(user) })
})

r.post('/login', async (req, res) => {
  try {
  const { email, password } = req.body || {}
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password.' })
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase().trim())
  if (!user || !(await verifyPasswordAsync(password, user.password_hash))) {
    // Someone who joined by link and is still awaiting approval has no users row
    // yet, so the generic message above would have them re-typing a password that
    // is actually correct. Tell them what is really happening — but only if the
    // password matches the pending request, so this can never be used to probe
    // which addresses have asked to join.
    const jr = db.prepare("SELECT jr.*, o.name org_name FROM join_requests jr JOIN organizations o ON o.id = jr.org_id WHERE jr.email = ? AND jr.status = 'pending'")
      .get(String(email).toLowerCase().trim())
    if (jr && await verifyPasswordAsync(password, jr.password_hash)) {
      return res.status(403).json({ error: `Your request to join ${jr.org_name} is waiting for a manager to approve it.` })
    }
    return res.status(401).json({ error: 'That email and password do not match. Check them and try again.' })
  }
  // Sync platform-admin status from the env allowlist (grants or revokes on login).
  const isPlatform = platformAdminEmails().includes(String(user.email).toLowerCase()) ? 1 : 0
  if ((user.platform_admin ? 1 : 0) !== isPlatform) {
    db.prepare('UPDATE users SET platform_admin=? WHERE id=?').run(isPlatform, user.id)
    user.platform_admin = isPlatform
  }
  audit(user.org_id, user.id, 'auth.login', 'user', user.id)
  res.json({ token: signToken(user, createSession(user, req)), user: userWithWorkspace(user) })
  } catch (e) {
    console.error('[auth] login failed:', e.message)
    if (!res.headersSent) res.status(500).json({ error: 'Could not sign you in right now. Please try again.' })
  }
})

// GOOGLE SIGN-IN (login-only). The client obtains a Google ID token — from the
// Identity Services button on the web, or the native plugin on mobile — and posts
// it here. We verify the token with Google, then log in the EXISTING account whose
// email matches. We deliberately never create an org/account from Google: unknown
// emails are told to sign up or ask for an invite. On first Google login we stamp
// the user's google_id and mark their email verified (Google already vouched for it).
r.post('/google', async (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(501).json({ error: 'Google Sign-In is not configured on the server.' })
  }
  const credential = String(req.body?.credential || '')
  if (!credential) return res.status(400).json({ error: 'Missing Google credential.' })

  let payload
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_AUDIENCES })
    payload = ticket.getPayload()
  } catch (err) {
    console.warn('[auth] google token verify failed:', err.message)
    return res.status(401).json({ error: 'Could not verify your Google sign-in. Please try again.' })
  }

  // Google must have confirmed the address, or a malicious token could claim any email.
  const email = String(payload?.email || '').toLowerCase().trim()
  const emailOk = payload?.email_verified === true || payload?.email_verified === 'true'
  if (!email || !emailOk) {
    return res.status(401).json({ error: 'Your Google account has no verified email address.' })
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
  if (!user) {
    // Login-only: no account, no auto-provisioning.
    return res.status(404).json({ error: 'No account found for this Google email. Ask an admin for an invite, or sign up first.' })
  }

  // First-time link: stamp the Google id and trust Google's verified email.
  if (!user.google_id) {
    db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(payload.sub, user.id)
    user.google_id = payload.sub
  }
  if (!user.email_verified) {
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(user.id)
    user.email_verified = 1
  }
  // Sync platform-admin status from the env allowlist, exactly like /login does.
  const isPlatform = platformAdminEmails().includes(email) ? 1 : 0
  if ((user.platform_admin ? 1 : 0) !== isPlatform) {
    db.prepare('UPDATE users SET platform_admin=? WHERE id=?').run(isPlatform, user.id)
    user.platform_admin = isPlatform
  }

  audit(user.org_id, user.id, 'auth.login_google', 'user', user.id)
  res.json({ token: signToken(user, createSession(user, req)), user: userWithWorkspace(user) })
})

r.get('/me', authRequired, (req, res) => {
  res.json({ user: userWithWorkspace(req.user) })
})

// ---------------------------------------------------------------------------
// Email verification (non-blocking: users can still use the app while unverified;
// the client shows a gentle "verify your email" card). Confirmation is a
// six-digit code — see emailCodes.js for why it replaced the emailed link.
// ---------------------------------------------------------------------------

// Confirm a LEGACY email-verification link. Nothing mails these any more; the
// route stays so links already sitting in inboxes still work until they expire.
r.post('/verify-email', (req, res) => {
  const token = String(req.body?.token || '')
  const row = db.prepare('SELECT * FROM email_verifications WHERE token = ?').get(token)
  if (!row || row.used || row.expires_at < now()) {
    return res.status(400).json({ error: 'This verification link is invalid or has expired.' })
  }
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id)
    db.prepare('UPDATE email_verifications SET used = 1 WHERE token = ?').run(token)
  })
  tx()
  res.json({ ok: true })
})

// Confirm the signed-in user's own address with the code mailed to it.
r.post('/verify-email-code', authRequired, (req, res) => {
  if (req.user.email_verified) return res.json({ ok: true, already: true })
  const out = confirmOwnEmail(req.user, req.body?.code)
  if (out.error) return res.status(400).json({ error: out.error })
  audit(req.user.org_id, req.user.id, 'auth.email_verified', 'user', req.user.id, req.user.email)
  res.json({ ok: true })
})

// Mail the logged-in user a fresh code.
r.post('/resend-verification', authRequired, async (req, res) => {
  if (req.user.email_verified) return res.json({ ok: true, already: true })
  const out = await sendVerificationEmail(req.user)
  if (out.error) return res.status(out.status).json({ error: out.error })
  res.json({ ok: true, delivered: out.delivered })
})

// ---------------------------------------------------------------------------
// Password reset ("forgot password").
// ---------------------------------------------------------------------------

// Request a reset link. Always returns 200 so we never reveal whether an email
// is registered (prevents account enumeration).
r.post('/forgot-password', async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim()
  const user = email ? db.prepare('SELECT * FROM users WHERE email = ?').get(email) : null
  if (user) {
    const token = genToken()
    db.prepare('INSERT INTO password_resets (token, user_id, expires_at, used, created_at) VALUES (?,?,?,?,?)')
      .run(token, user.id, inDays(1), 0, now())
    const link = `${appUrl()}/reset-password?token=${token}`
    try {
      await sendMail({
        to: email,
        subject: 'Reset your SmartTask password',
        text: `Reset your password:\n${link}\n\nThis link expires in 24 hours. If you didn't request this, you can ignore this email.`,
        html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#c2410c">Reset your password</h2>
          <p><a href="${link}" style="display:inline-block;background:#c2410c;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600">Choose a new password</a></p>
          <p style="color:#666;font-size:13px">Or paste this link into your browser:<br>${link}</p>
          <p style="color:#999;font-size:12px">This link expires in 24 hours. If you didn't request this, ignore this email.</p></div>`,
      })
    } catch (e) { console.warn('[auth] reset email failed:', e.message) }
  }
  res.json({ ok: true })
})

// Complete the reset with a valid token.
r.post('/reset-password', (req, res) => {
  const token = String(req.body?.token || '')
  const password = String(req.body?.password || '')
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' })
  if (isCommonPassword(password)) return res.status(400).json({ error: 'That password is too common — please choose a stronger one.' })
  const row = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(token)
  if (!row || row.used || row.expires_at < now()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired.' })
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id)
  if (!user) return res.status(400).json({ error: 'This reset link is invalid or has expired.' })
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id)
    db.prepare('UPDATE password_resets SET used = 1 WHERE token = ?').run(token)
    // Invalidate any other outstanding reset tokens for this user.
    db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0').run(user.id)
  })
  tx()
  audit(user.org_id, user.id, 'auth.password_reset', 'user', user.id)
  res.json({ ok: true })
})

// WHERE AM I SIGNED IN — one row per live login, newest activity first, with the
// device you are asking from marked so nobody signs themselves out by accident.
r.get('/sessions', authRequired, (req, res) => {
  const rows = db.prepare(
    `SELECT id, device, ip, created_at, last_seen_at FROM sessions
     WHERE user_id=? AND revoked_at IS NULL ORDER BY last_seen_at DESC`
  ).all(req.user.id)
  res.json(rows.map((r0) => ({ ...r0, current: r0.id === req.sessionId })))
})

// Sign one device out. Revoking is a flag, not a delete: the row is the record
// that the device was signed in at all.
r.delete('/sessions/:id', authRequired, (req, res) => {
  const row = db.prepare('SELECT id FROM sessions WHERE id=? AND user_id=? AND revoked_at IS NULL').get(req.params.id, req.user.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  db.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(now(), row.id)
  audit(req.user.org_id, req.user.id, 'auth.session_revoke', 'user', req.user.id, row.id === req.sessionId ? 'this device' : 'another device')
  res.json({ ok: true, was_current: row.id === req.sessionId })
})

// Sign out everywhere EXCEPT here — the "I lost a phone" button. Deliberately
// spares the caller: locking yourself out while securing the account is not the
// outcome anyone wants.
r.post('/sessions/revoke-others', authRequired, (req, res) => {
  const info = req.sessionId
    ? db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND id<>?').run(now(), req.user.id, req.sessionId)
    : db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now(), req.user.id)
  audit(req.user.org_id, req.user.id, 'auth.session_revoke_others', 'user', req.user.id, String(info.changes))
  res.json({ ok: true, revoked: info.changes })
})

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, org_id: u.org_id, phone: u.phone,
    department_id: u.department_id, preferred_language: u.preferred_language, avatar_color: u.avatar_color,
    avatar_file: u.avatar_file || null, email_verified: u.email_verified ? 1 : 0,
    notif_prefs: (() => { try { return u.notif_prefs ? JSON.parse(u.notif_prefs) : null } catch { return null } })() }
}

// Re-confirm the CURRENT user's password. Used to gate sensitive voice actions
// (e.g. removing a teammate) behind the manager's own password.
r.post('/verify-password', authRequired, async (req, res) => {
  const { password } = req.body || {}
  const u = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id)
  if (!u || !password || !(await verifyPasswordAsync(String(password), u.password_hash).catch(() => false))) {
    return res.status(401).json({ error: 'Incorrect password' })
  }
  res.json({ ok: true })
})

export default r
export { publicUser }
