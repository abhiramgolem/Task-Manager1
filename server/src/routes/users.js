import { Router } from 'express'
import multer from 'multer'
import * as XLSX from 'xlsx'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../db.js'
import { authRequired, requireRole, hashPassword, hashPasswordAsync, verifyPassword, verifyToken } from '../auth.js'
import { id, now, audit, orgAllowedDomains, emailDomainAllowed } from '../util.js'
import { publicUser } from './auth.js'
import { sendVerificationEmail, clearEmailConfirmations, sendManagerCode, checkManagerCode, findProof, useProof } from '../emailCodes.js'
import { CATEGORIES, orgCategories, normalizeCategory } from '../categories.js'
import { createDepartment } from './departments.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AVATAR_DIR = path.join(__dirname, '..', '..', 'data', 'avatars')
fs.mkdirSync(AVATAR_DIR, { recursive: true })

const r = Router()

// Serve a user's profile photo (token via header OR ?token= so <img> can load it).
// Declared before authRequired because <img src> can't send an Authorization header.
r.get('/:id/avatar', (req, res) => {
  const u = (req.headers.authorization || '').startsWith('Bearer ')
    ? verifyToken(req.headers.authorization.slice(7)) : verifyToken(req.query.token)
  if (!u) return res.status(401).json({ error: 'Authentication required' })
  // Tenant isolation: only serve photos of users in the requester's own org, so a
  // token from one company can't fetch another company's avatars by guessing ids.
  const target = db.prepare('SELECT avatar_file FROM users WHERE id=? AND org_id=?').get(req.params.id, u.org_id)
  if (!target?.avatar_file) return res.status(404).json({ error: 'No avatar' })
  const abs = path.join(AVATAR_DIR, target.avatar_file)
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Missing' })
  const ext = path.extname(target.avatar_file); if (ext) res.type(ext)
  res.setHeader('Cache-Control', 'private, max-age=300')
  fs.createReadStream(abs).pipe(res)
})

r.use(authRequired)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } })

// Upload / replace my own profile photo (images only).
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, AVATAR_DIR),
    filename: (req, file, cb) => cb(null, id('av') + path.extname(file.originalname || '.png').slice(0, 8)),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, (file.mimetype || '').startsWith('image/')),
})
r.post('/me/avatar', avatarUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'An image file is required' })
  const old = db.prepare('SELECT avatar_file FROM users WHERE id=?').get(req.user.id)?.avatar_file
  db.prepare('UPDATE users SET avatar_file=? WHERE id=?').run(req.file.filename, req.user.id)
  if (old) try { fs.unlinkSync(path.join(AVATAR_DIR, old)) } catch {}
  res.json({ ok: true, avatar_file: req.file.filename })
})

// SELF-SERVICE: any signed-in user can update their OWN profile — name, preferred
// language, and password. Changing the password requires the current one. This is
// separate from the admin-only PATCH /:id below, and must be declared before it so
// "/me" isn't captured as an :id.
r.patch('/me', async (req, res) => {
  const b = req.body || {}
  const sets = [], args = []
  let addressToVerify = null
  if ('name' in b) {
    const name = String(b.name || '').trim()
    if (!name) return res.status(400).json({ error: 'Name cannot be empty.' })
    sets.push('name=?'); args.push(name)
  }
  if ('preferred_language' in b) { sets.push('preferred_language=?'); args.push(b.preferred_language || 'en') }
  // Kept as typed apart from length — numbers arrive with +, spaces and dashes
  // and there is no one right shape for them across countries.
  if ('phone' in b) { sets.push('phone=?'); args.push(String(b.phone || '').trim().slice(0, 32)) }
  // Notification switches. Stored as an object of known categories only, so a
  // stray key can't grow the shape; an explicit false is the only "off".
  if ('notif_prefs' in b) {
    const want = b.notif_prefs && typeof b.notif_prefs === 'object' ? b.notif_prefs : {}
    const prefs = {}
    for (const k of ['tasks', 'approvals', 'comments', 'chat', 'deadlines']) prefs[k] = want[k] !== false
    sets.push('notif_prefs=?'); args.push(JSON.stringify(prefs))
  }

  // Changing your own email moves where you log in and where a password reset
  // lands, so it is gated on the current password exactly as a password change
  // is — otherwise a borrowed session could walk an account over to an inbox its
  // owner does not control. The new address lands UNVERIFIED with a fresh
  // confirmation on its way: the point of the address is that mail reaches it,
  // and nothing has proved that yet. The same domain and uniqueness rules the
  // manager-side route applies are applied here, so self-service can't be used
  // to get around a restriction an admin set.
  if ('email' in b) {
    const email = String(b.email || '').toLowerCase().trim()
    if (!VALID_EMAIL.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' })
    if (email !== String(req.user.email || '').toLowerCase().trim()) {
      const me = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id)
      if (!verifyPassword(String(b.current_password || ''), me.password_hash)) {
        return res.status(400).json({ error: 'Enter your current password to change your email address.' })
      }
      const domErr = domainError(req.user.org_id, email)
      if (domErr) return res.status(400).json({ error: domErr })
      if (db.prepare('SELECT id FROM users WHERE email=? AND id!=?').get(email, req.user.id)) {
        return res.status(409).json({ error: 'Someone else already uses that email address.' })
      }
      sets.push('email=?'); args.push(email)
      sets.push('email_verified=?'); args.push(0)
      clearEmailConfirmations(req.user.id)
      addressToVerify = email
    }
  }
  if (b.new_password) {
    if (String(b.new_password).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' })
    const me = db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id)
    if (!verifyPassword(String(b.current_password || ''), me.password_hash)) {
      return res.status(400).json({ error: 'Your current password is incorrect.' })
    }
    sets.push('password_hash=?'); args.push(hashPassword(b.new_password))
  }
  if (!sets.length) return res.json(publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)))
  args.push(req.user.id)
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id=?`).run(...args)
  const changed = Object.keys(b).filter((k) => k !== 'current_password' && k !== 'new_password')
  if (b.new_password) changed.push('password')
  audit(req.user.org_id, req.user.id, 'user.self_update', 'user', req.user.id, changed.join(', '))
  // Best effort: the address has already changed and the client shows a "verify
  // your email" card that can send another code, so a mail failure here must not
  // fail the request and strand the user between two addresses.
  if (addressToVerify) {
    const out = await sendVerificationEmail({ ...req.user, email: addressToVerify })
    if (out.error) console.warn('[users] verification mail failed:', out.error)
  }
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)))
})

// Email must be a valid format; the ALLOWED DOMAIN is now per-org (configurable),
// not hardcoded — so every organization enforces its own domains.
const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const onlyDigits = (s) => String(s || '').replace(/\D/g, '')
// Returns an error string if the email's domain isn't allowed for the org, else null.
function domainError(orgId, email) {
  if (emailDomainAllowed(orgId, email)) return null
  const allowed = orgAllowedDomains(orgId)
  return `Email domain not allowed. This organization permits: ${allowed.join(', ')}`
}

// Everyone can list org users (needed for assignment dropdowns) — minimal fields.
r.get('/', (req, res) => {
  const rows = db.prepare('SELECT id, name, email, role, phone, department_id, avatar_color, avatar_file, aliases, preferred_language, email_verified FROM users WHERE org_id=? ORDER BY name').all(req.user.org_id)
  res.json(rows)
})

// Confirm an address from the add / edit user form, before the account is
// saved. Optional — a user saved without it gets a code of their own to enter
// after they sign in. `user_id` is the account being edited, so its own current
// address isn't reported as taken.
r.post('/email-code', requireRole('manager', 'admin'), async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim()
  if (!VALID_EMAIL.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' })
  const domErr = domainError(req.user.org_id, email)
  if (domErr) return res.status(400).json({ error: domErr })
  const taken = db.prepare('SELECT id FROM users WHERE email=?').get(email)
  if (taken && taken.id !== req.body?.user_id) return res.status(409).json({ error: 'Someone already uses that email address.' })
  const out = await sendManagerCode(req.user, email)
  if (out.error) return res.status(out.status).json({ error: out.error })
  res.json({ ok: true, delivered: out.delivered })
})
r.post('/email-code/verify', requireRole('manager', 'admin'), (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim()
  const out = checkManagerCode(req.user, email, req.body?.code)
  if (out.error) return res.status(400).json({ error: out.error })
  res.json({ proof: out.proof })
})
// A proof that was sent but no longer works (expired, or for another address)
// is refused rather than quietly saving the account unverified: the manager
// was told the address is confirmed, and saving it otherwise would be a lie.
const STALE_PROOF = 'The email confirmation has expired. Send a new code, or save without confirming.'

// Create user (admins, and managers for non-admin accounts). With `email_proof`
// from /email-code/verify the address lands confirmed; without it, the new user
// is mailed a code to enter themselves.
r.post('/', requireRole('manager', 'admin'), async (req, res) => {
  const { name, email, password, role, department_id, aliases, preferred_language, phone, email_proof } = req.body || {}
  if (!name || !email || !password || !role) return res.status(400).json({ error: 'name, email, password, role required' })
  if (!['admin', 'manager', 'employee'].includes(role)) return res.status(400).json({ error: 'invalid role' })
  if (req.user.role === 'manager' && role === 'admin') return res.status(403).json({ error: 'Managers cannot create admin accounts' })
  const emailNorm = String(email).toLowerCase().trim()
  if (!VALID_EMAIL.test(emailNorm)) return res.status(400).json({ error: 'Please enter a valid email address.' })
  const domErr = domainError(req.user.org_id, emailNorm)
  if (domErr) return res.status(400).json({ error: domErr })
  const phoneDigits = onlyDigits(phone)
  if (phoneDigits.length !== 10) return res.status(400).json({ error: 'Phone must be exactly 10 digits' })
  const exists = db.prepare('SELECT id FROM users WHERE email=?').get(emailNorm)
  if (exists) return res.status(409).json({ error: 'email already exists' })
  const proofId = email_proof ? findProof(req.user, emailNorm, email_proof) : null
  if (email_proof && !proofId) return res.status(400).json({ error: STALE_PROOF })
  const uid = id('usr')
  const colors = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4']
  db.transaction(() => {
    db.prepare(`INSERT INTO users (id, org_id, department_id, name, email, password_hash, role, phone, aliases, preferred_language, avatar_color, email_verified, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      uid, req.user.org_id, department_id || null, name, emailNorm, hashPassword(password), role,
      phoneDigits, aliases || '', preferred_language || 'en', colors[Math.floor(Math.random() * colors.length)], proofId ? 1 : 0, now())
    if (proofId) useProof(proofId)
  })()
  audit(req.user.org_id, req.user.id, 'user.create', 'user', uid, email)
  const saved = db.prepare('SELECT * FROM users WHERE id=?').get(uid)
  // Best effort, as on signup: the account exists either way, and the new user
  // can ask for another code from inside the app.
  let codeSent = false
  if (!proofId) {
    const out = await sendVerificationEmail(saved, { addedBy: req.user })
    if (out.error) console.warn('[users] verification mail failed:', out.error)
    codeSent = !out.error
  }
  res.status(201).json({ ...publicUser(saved), code_sent: codeSent })
})

// Update user (admins, and managers for non-admin accounts). Moving someone to a
// new address un-confirms it unless `email_proof` shows the manager confirmed
// the new one; otherwise the new address is mailed a code.
r.patch('/:id', requireRole('manager', 'admin'), async (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!u) return res.status(404).json({ error: 'Not found' })
  const b = req.body || {}
  if (req.user.role === 'manager' && (u.role === 'admin' || b.role === 'admin')) {
    return res.status(403).json({ error: 'Managers cannot modify admin accounts' })
  }
  if ('email' in b && b.email) {
    const e = String(b.email).toLowerCase().trim()
    if (!VALID_EMAIL.test(e)) return res.status(400).json({ error: 'Please enter a valid email address.' })
    const domErr = domainError(req.user.org_id, e)
    if (domErr) return res.status(400).json({ error: domErr })
  }
  if ('phone' in b) {
    b.phone = onlyDigits(b.phone)
    if (b.phone.length !== 10) return res.status(400).json({ error: 'Phone must be exactly 10 digits' })
  }
  const fields = ['name', 'role', 'department_id', 'aliases', 'preferred_language', 'phone']
  const sets = [], args = []
  for (const f of fields) if (f in b) { sets.push(`${f}=?`); args.push(b[f]) }
  let newAddress = null, proofId = null
  if ('email' in b && b.email) {
    const email = b.email.toLowerCase().trim()
    const clash = db.prepare('SELECT id FROM users WHERE email=? AND id!=?').get(email, u.id)
    if (clash) return res.status(409).json({ error: 'email already in use' })
    if (email !== String(u.email || '').toLowerCase()) {
      if (b.email_proof) {
        proofId = findProof(req.user, email, b.email_proof)
        if (!proofId) return res.status(400).json({ error: STALE_PROOF })
      }
      sets.push('email=?'); args.push(email)
      sets.push('email_verified=?'); args.push(proofId ? 1 : 0)
      newAddress = email
    }
  }
  if (b.password) { sets.push('password_hash=?'); args.push(hashPassword(b.password)) }
  if (!sets.length) return res.json(publicUser(u))
  args.push(u.id)
  db.transaction(() => {
    if (newAddress) clearEmailConfirmations(u.id)
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id=?`).run(...args)
    if (proofId) useProof(proofId)
  })()
  const { email_proof, password, ...logged } = b
  audit(req.user.org_id, req.user.id, 'user.update', 'user', u.id, logged)
  const saved = db.prepare('SELECT * FROM users WHERE id=?').get(u.id)
  let codeSent = false
  if (newAddress && !proofId) {
    const out = await sendVerificationEmail(saved, { addedBy: req.user })
    if (out.error) console.warn('[users] verification mail failed:', out.error)
    codeSent = !out.error
  }
  res.json({ ...publicUser(saved), code_sent: codeSent })
})

// DELETE a user (managers/admins). Detaches references so the row can be removed
// cleanly, then deletes. A manager cannot delete their own account or an admin.
r.delete('/:id', requireRole('manager', 'admin'), (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!u) return res.status(404).json({ error: 'Not found' })
  if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot remove your own account' })
  if (req.user.role === 'manager' && u.role === 'admin') return res.status(403).json({ error: 'Managers cannot remove admin accounts' })
  const remove = db.transaction(() => {
    db.prepare('UPDATE tasks SET assignee_id=NULL WHERE assignee_id=?').run(u.id)   // unassign their tasks
    db.prepare('UPDATE suggested_tasks SET suggested_assignee_id=NULL WHERE suggested_assignee_id=?').run(u.id) // detach from AI review queue
    db.prepare('DELETE FROM task_comments WHERE user_id=?').run(u.id)               // their comments
    db.prepare('DELETE FROM users WHERE id=?').run(u.id)                            // notifications cascade
  })
  remove()
  audit(req.user.org_id, req.user.id, 'user.delete', 'user', u.id, u.email)
  res.json({ ok: true })
})

// BULK IMPORT users from an Excel/CSV file (admin). Upserts by email.
// Expected columns (case-insensitive): name, email, role, department, aliases, language, password
r.post('/import', requireRole('manager', 'admin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required (field "file")' })
  let rows
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
  } catch (e) {
    return res.status(400).json({ error: 'Could not parse file: ' + e.message })
  }

  const org = req.user.org_id
  const depts = db.prepare('SELECT id, name FROM departments WHERE org_id=?').all(org)
  const deptByName = (nm) => depts.find((d) => d.name.toLowerCase() === String(nm || '').toLowerCase())?.id || null
  const colors = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4']
  // case-insensitive field getter
  const pick = (row, ...keys) => {
    for (const k of Object.keys(row)) if (keys.includes(k.toLowerCase().trim())) return row[k]
    return ''
  }

  let created = 0, updated = 0
  const errors = []
  // Hash every row's password BEFORE the transaction, asynchronously: done in
  // the loop below with hashSync, 100 rows held the one server thread for ~20 s
  // and the whole company's chat froze while an admin imported a sheet.
  const hashes = []
  try {
    for (const row of rows) {
      const pw = String(pick(row, 'password') || '').trim()
      hashes.push(pw ? await hashPasswordAsync(pw) : null)
    }
    var defaultHash = await hashPasswordAsync('password123')
  } catch (e) { return res.status(500).json({ error: 'Could not prepare the passwords: ' + e.message }) }
  const apply = db.transaction(() => {
    rows.forEach((row, i) => {
      const name = String(pick(row, 'name', 'full name') || '').trim()
      const email = String(pick(row, 'email', 'email id', 'mail', 'mail id') || '').toLowerCase().trim()
      if (!name || !email) { errors.push(`Row ${i + 2}: missing name or email`); return }
      if (!VALID_EMAIL.test(email)) { errors.push(`Row ${i + 2}: invalid email ${email}`); return }
      if (!emailDomainAllowed(req.user.org_id, email)) { errors.push(`Row ${i + 2}: domain not allowed for ${email}`); return }
      let role = String(pick(row, 'role') || 'employee').toLowerCase().trim()
      if (!['admin', 'manager', 'employee'].includes(role)) role = 'employee'
      if (req.user.role === 'manager' && role === 'admin') role = 'employee' // managers can't grant admin
      const aliases = String(pick(row, 'aliases', 'alias') || '').trim()
      const lang = String(pick(row, 'language', 'preferred_language', 'lang') || 'en').trim() || 'en'
      const phone = String(pick(row, 'phone', 'phone number', 'mobile', 'contact') || '').trim()
      const deptId = deptByName(pick(row, 'department', 'dept'))
      const password = String(pick(row, 'password') || '').trim()

      const existing = db.prepare('SELECT id, role FROM users WHERE email=?').get(email)
      if (existing && req.user.role === 'manager' && existing.role === 'admin') {
        errors.push(`Row ${i + 2}: skipped admin account ${email}`); return // managers can't edit admins
      }
      if (existing) {
        const sets = ['name=?', 'role=?', 'aliases=?', 'preferred_language=?', 'department_id=?', 'phone=?']
        const args = [name, role, aliases, lang, deptId, phone]
        if (password) { sets.push('password_hash=?'); args.push(hashes[i]) }
        args.push(existing.id)
        db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id=?`).run(...args)
        updated++
      } else {
        db.prepare(`INSERT INTO users (id, org_id, department_id, name, email, password_hash, role, phone, aliases, preferred_language, avatar_color, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          id('usr'), org, deptId, name, email, hashes[i] || defaultHash, role, phone, aliases, lang,
          colors[Math.floor(Math.random() * colors.length)], now())
        created++
      }
    })
  })
  try { apply() } catch (e) { return res.status(500).json({ error: e.message }) }
  audit(org, req.user.id, 'user.import', 'user', null, `created=${created}, updated=${updated}`)
  res.json({ created, updated, errors, rows: rows.length })
})

// Departments & projects (read for dropdowns; managers can also add a department)
r.get('/meta/departments', (req, res) => {
  res.json(db.prepare('SELECT * FROM departments WHERE org_id=? ORDER BY name').all(req.user.org_id))
})
// Managers add departments from wherever they pick one — the user form and the
// invite dialog — as well as on the Departments tab of Administration. Only
// manager/admin: the picker hides the option from anyone else, and this is
// what makes that real. One rulebook for both doors, in routes/departments.js.
r.post('/meta/departments', requireRole('manager', 'admin'), (req, res) => {
  const out = createDepartment(req.user.org_id, req.user.id, req.body?.name)
  if (out.error) return res.status(out.status).json({ error: out.error })
  res.status(out.status).json(out.body)
})
// Task categories: the built-in brands (categories.js, with keyword detection)
// plus whatever this org added from the task form. One list for every picker,
// so a category added while creating a task is already there in the drawer.
// `id` is the name on purpose: the name is what a task's category column holds.
r.get('/meta/categories', (req, res) => {
  const builtin = CATEGORIES.map((c) => ({ id: c.label, name: c.label, color: null, builtin: true }))
  const custom = orgCategories(req.user.org_id).map((c) => ({ id: c.name, name: c.name, color: c.color, builtin: false }))
  res.json([...builtin, ...custom])
})
// Colours for custom categories, handed out in order so two additions never
// share one until the palette is exhausted. Chosen away from the built-ins'
// blue / violet / green / amber / red so a new brand is told apart at a glance.
const CATEGORY_COLORS = ['#0ea5e9', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16', '#a855f7', '#06b6d4', '#eab308', '#64748b']
r.post('/meta/categories', requireRole('manager', 'admin'), (req, res) => {
  const name = String(req.body?.name || '').replace(/\s+/g, ' ').trim()
  if (!name) return res.status(400).json({ error: 'Category name is required.' })
  if (name.length > 40) return res.status(400).json({ error: 'Category name must be 40 characters or fewer.' })
  // Same name again, any case, built-in or not: hand back the one that exists.
  const existing = normalizeCategory(name, req.user.org_id)
  if (existing) {
    const own = orgCategories(req.user.org_id).find((c) => c.name === existing)
    return res.json({ id: existing, name: existing, color: own?.color || null, builtin: !own, existed: true })
  }
  const own = orgCategories(req.user.org_id)
  const used = new Set(own.map((c) => c.color))
  const color = CATEGORY_COLORS.find((c) => !used.has(c)) || CATEGORY_COLORS[own.length % CATEGORY_COLORS.length]
  const cid = id('cat')
  db.prepare('INSERT INTO task_categories (id, org_id, name, color, created_at) VALUES (?,?,?,?,?)').run(cid, req.user.org_id, name, color, now())
  audit(req.user.org_id, req.user.id, 'category.create', 'task_category', cid, name)
  res.status(201).json({ id: name, name, color, builtin: false })
})
r.get('/meta/projects', (req, res) => {
  res.json(db.prepare('SELECT * FROM projects WHERE org_id=? ORDER BY name').all(req.user.org_id))
})

// Org settings — allowed email domains. GET for anyone in the org; PATCH for admins.
r.get('/meta/org', (req, res) => {
  const org = db.prepare('SELECT id, name, is_personal FROM organizations WHERE id=?').get(req.user.org_id)
  res.json({ ...org, allowed_domains: orgAllowedDomains(req.user.org_id) })
})
r.patch('/meta/org', requireRole('manager', 'admin'), (req, res) => {
  const list = Array.isArray(req.body?.allowed_domains) ? req.body.allowed_domains : []
  // Keep valid, unique, lowercase domains (e.g. befach.com). Empty list = no restriction.
  const clean = [...new Set(list.map((d) => String(d).trim().toLowerCase().replace(/^@/, '')).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))]
  db.prepare('UPDATE organizations SET allowed_domains=? WHERE id=?').run(clean.join(',') || null, req.user.org_id)
  audit(req.user.org_id, req.user.id, 'org.domains_update', 'organization', req.user.org_id, clean.join(', '))
  res.json({ allowed_domains: clean })
})

export default r
