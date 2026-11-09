// Daily update cards: the numbers a person reports in a chat every day
// ("Sales 45k / 1.69L, reviews 0 / 100, junk leads 0"), set up once by that
// person and then only filled in. People were retyping these as free text,
// copying yesterday's message and editing it, which is how a November update
// came to say "October". Here the card keeps the labels and targets, adds
// up the month, and says how far along each number is.
//
// The card is an ordinary chat message (kind 'update', its numbers in meta),
// so it is delivered, notified, searched, replied to and deleted like any
// other. daily_update_posts indexes it by template and day, which is what
// "who has posted today" and "this month so far" read.
//
// Mounted at /api/chat ahead of chat.js, whose delivery it reuses. Auth is
// per route, not r.use: a router-wide check would also run for chat.js's own
// routes that take no session (the push buttons' notif-action, decline-push).
import { Router } from 'express'
import { db } from '../db.js'
import { authRequired } from '../auth.js'
import { id, now, notify } from '../util.js'
import { zonedNow } from '../taskMail.js'
import { member, canPost, ADMINS_ONLY, deliver, shapeMessage, receiptCtx, parseMeta, pushToConversation } from './chat.js'

const r = Router()

const MAX_METRICS = 12
const MODES = ['total', 'daily']

// ---- numbers as people write them ------------------------------------------
// "45k", "1.69L", "1.69 lakh", "2cr", "45,000", "₹45000". NaN for anything
// else, so a typo is refused rather than read as zero.
const MULT = {
  k: 1e3, thousand: 1e3, l: 1e5, lac: 1e5, lacs: 1e5, lakh: 1e5, lakhs: 1e5,
  cr: 1e7, crore: 1e7, crores: 1e7, m: 1e6, mn: 1e6, million: 1e6,
}
export function parseAmount(raw) {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN
  const s = String(raw).toLowerCase().replace(/,/g, '').replace(/₹|\brs\.?|\binr\b/g, '').trim()
  if (!s) return null
  const m = /^(-?\d+(?:\.\d+)?)\s*([a-z]+)?$/.exec(s)
  if (!m) return NaN
  const mult = m[2] ? MULT[m[2]] : 1
  if (!mult) return NaN
  return Math.round(Number(m[1]) * mult * 100) / 100
}

// The short Indian form the team already writes: 45k, 1.69L, 2.5Cr.
export function fmtAmount(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  const t = (x) => String(Number(x.toFixed(2)))
  if (a >= 1e7) return `${sign}${t(a / 1e7)}Cr`
  if (a >= 1e5) return `${sign}${t(a / 1e5)}L`
  if (a >= 1e3) return `${sign}${t(a / 1e3)}k`
  return sign + t(a)
}

// ---- the template ------------------------------------------------------------
function cleanMetrics(raw) {
  if (!Array.isArray(raw)) return { error: 'Add at least one thing to report' }
  const seen = new Set()
  const out = []
  for (const m of raw.slice(0, MAX_METRICS)) {
    const label = String(m?.label || '').trim().slice(0, 40)
    if (!label) continue
    let mid = String(m?.id || '').trim()
    if (!/^[a-z0-9_-]{1,24}$/i.test(mid) || seen.has(mid)) mid = id().slice(0, 10)
    seen.add(mid)
    // A target may be a range, as the team writes them: "6L-18L", "3 lakhs to
    // 6 lakhs". The low end is the target the bar measures; the high end, the
    // stretch, is shown beside it.
    let rawT = m?.target, rawS = m?.stretch
    const range = typeof rawT === 'string' && /^\s*(\S.*?)\s*(?:-|–|to)\s*(\S.*)$/i.exec(rawT)
    if (range && rawS == null) { rawT = range[1]; rawS = range[2] }
    const target = parseAmount(rawT)
    const stretch = parseAmount(rawS)
    if (Number.isNaN(target) || Number.isNaN(stretch)) return { error: `"${label}": the target should be a number or a range, like 1.69L, 100 or 6L-18L` }
    out.push({
      id: mid, label,
      target: target != null && target > 0 ? target : null,
      stretch: stretch != null && target != null && stretch > target ? stretch : null,
      unit: String(m?.unit || '').trim().slice(0, 10),
      mode: MODES.includes(m?.mode) ? m.mode : 'total',
    })
  }
  if (!out.length) return { error: 'Add at least one thing to report' }
  return { metrics: out }
}

const shapeTemplate = (t) => (!t ? null : {
  id: t.id, conversation_id: t.conversation_id, title: t.title,
  metrics: JSON.parse(t.metrics || '[]'),
  remind_at: t.remind_at || null,
  remind_days: String(t.remind_days ?? '').split(',').filter((d) => d !== '').map(Number),
  last_posted_date: t.last_posted_date || null,
})

const templateOf = (userId, convId) =>
  db.prepare('SELECT * FROM daily_update_templates WHERE user_id=? AND conversation_id=?').get(userId, convId)

// The latest live card from this template this month, strictly before `day`
// when given: the base today's numbers are added to. A second post on the same
// day replaces the first in the month's arithmetic rather than adding twice.
function lastPost(templateId, day, { before = true } = {}) {
  const month = day.slice(0, 7)
  const row = db.prepare(`
    SELECT m.* FROM daily_update_posts p JOIN chat_messages m ON m.id = p.message_id
    WHERE p.template_id = ? AND p.day >= ? AND p.day ${before ? '<' : '<='} ? AND m.deleted_for_all = 0
    ORDER BY p.day DESC, p.created_at DESC LIMIT 1`).get(templateId, `${month}-01`, day)
  return row ? parseMeta(row) : null
}

// A conversation the caller is in and may post to, or an error to send back.
function postableConv(user, convId) {
  if (!member(convId, user.id)) return { status: 404, error: 'Conversation not found' }
  const conv = db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(convId)
  if (!conv) return { status: 404, error: 'Conversation not found' }
  if (!canPost(conv, user.id)) return { status: 403, error: ADMINS_ONLY }
  return { conv }
}

// Everyone in the chat sees the "posted today" line change.
const announce = (convId) => pushToConversation(convId, { type: 'updates-today', conversationId: convId })

// One card's rows from what was typed. `values`: { metricId: typed }. A metric
// left empty is "not reported": a running total carries over, a daily count
// adds 0. `totals`: { metricId: typed } for a daily count whose month is not
// what the app added up (a card started mid-month, a correction from the CRM).
function computeRows(metrics, prevTotal, values, totals) {
  return metrics.map((m) => {
    const v = parseAmount(values?.[m.id])
    if (Number.isNaN(v)) throw { status: 400, error: `"${m.label}" should be a number, like 45k or 12` }
    const fix = m.mode === 'daily' ? parseAmount(totals?.[m.id]) : null
    if (Number.isNaN(fix)) throw { status: 400, error: `"${m.label}" month so far should be a number, like 1.2L` }
    const before = prevTotal[m.id] ?? null
    const total = m.mode === 'daily' ? (fix ?? (before || 0) + (v || 0)) : (v ?? before)
    return { ...m, value: v, total }
  })
}
const totalsOf = (meta) => { const t = {}; for (const v of meta?.metrics || []) t[v.id] = v.total; return t }
const lineOf = (title, rows) => `${title}: ${rows.map((x) => `${x.label} ${fmtAmount(x.total)}${x.target ? '/' + fmtAmount(x.target) : ''}`).join(' · ')}`.slice(0, 600)

// ---- posting -----------------------------------------------------------------
// `values`: { metricId: what was typed (or a number) }. A metric left empty is
// "not reported today": a running total carries over, a daily count adds 0.
// Shared with the voice assistant (routes/assistant.js), which is why it takes
// the user and throws { status, error } rather than answering a request.
export function postDailyUpdate(user, convId, values = {}, note = '', totals = {}) {
  const got = postableConv(user, convId)
  if (got.error) throw got
  const tpl = templateOf(user.id, convId)
  if (!tpl) throw { status: 400, error: 'Set up your daily update card first' }
  const metrics = JSON.parse(tpl.metrics || '[]')
  const day = zonedNow().date
  const rows = computeRows(metrics, totalsOf(lastPost(tpl.id, day)), values, totals)
  if (rows.every((x) => x.value == null) && !String(note || '').trim()) throw { status: 400, error: 'Fill in at least one number' }

  const meta = { template_id: tpl.id, title: tpl.title, day, metrics: rows, note: String(note || '').trim().slice(0, 1000) }
  // The body is the card in one line: what the chat list, a push and search show.
  const body = lineOf(tpl.title, rows)
  const mid = id('msg')
  const ts = now()
  db.transaction(() => {
    db.prepare("INSERT INTO chat_messages (id, org_id, conversation_id, sender_id, recipient_id, body, kind, meta, read, created_at) VALUES (?,?,?,?,?,?,'update',?,0,?)")
      .run(mid, got.conv.org_id, convId, user.id, '', body, JSON.stringify(meta), ts)
    db.prepare('INSERT INTO daily_update_posts (message_id, template_id, user_id, conversation_id, day, created_at) VALUES (?,?,?,?,?,?)')
      .run(mid, tpl.id, user.id, convId, day, ts)
    db.prepare('UPDATE daily_update_templates SET last_posted_date=? WHERE id=?').run(day, tpl.id)
  })()
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(mid)
  deliver(got.conv, row, user)
  announce(convId)
  return shapeMessage(row, user.id, receiptCtx(convId, user.id))
}

// Correct a card already posted. Only the latest one of a card: every later
// post's month totals were added up from it, so changing an older one would
// leave them wrong. Its numbers are recomputed from the post before it, with
// the metrics it was posted with.
export function editDailyUpdate(user, messageId, values = {}, note = '', totals = {}) {
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(messageId)
  const post = db.prepare('SELECT * FROM daily_update_posts WHERE message_id=?').get(messageId)
  if (!m || !post || m.kind !== 'update' || m.deleted_for_all || m.sender_id !== user.id || !member(m.conversation_id, user.id)) {
    throw { status: 404, error: 'Update not found' }
  }
  const latest = db.prepare(`
    SELECT p.message_id FROM daily_update_posts p JOIN chat_messages c ON c.id = p.message_id
    WHERE p.template_id = ? AND c.deleted_for_all = 0 ORDER BY p.day DESC, p.created_at DESC LIMIT 1`).get(post.template_id)
  if (latest?.message_id !== messageId) throw { status: 409, error: 'Only your latest update can be edited' }
  const old = parseMeta(m)
  const defs = (old.metrics || []).map(({ value, total, ...def }) => def)
  const rows = computeRows(defs, totalsOf(lastPost(post.template_id, post.day)), values, totals)
  if (rows.every((x) => x.value == null) && !String(note || '').trim()) throw { status: 400, error: 'Fill in at least one number' }
  const meta = { ...old, metrics: rows, note: String(note || '').trim().slice(0, 1000) }
  const body = lineOf(old.title || 'Daily update', rows)
  const ts = now()
  db.prepare('UPDATE chat_messages SET body=?, meta=?, edited_at=? WHERE id=?').run(body, JSON.stringify(meta), ts, messageId)
  // The 'edit' every open chat already listens for, carrying the new card.
  pushToConversation(m.conversation_id, { type: 'edit', conversationId: m.conversation_id, id: messageId, body, edited_at: ts, update: meta })
  return { id: messageId, body, edited_at: ts, update: meta }
}

// My templates across chats, newest-used first, with each chat's name — for
// the voice assistant, which has to work out which card "my update" means.
export function templatesFor(userId) {
  return db.prepare(`
    SELECT t.*, c.name AS conv_name, c.type AS conv_type FROM daily_update_templates t
    JOIN chat_conversations c ON c.id = t.conversation_id
    JOIN chat_participants p ON p.conversation_id = t.conversation_id AND p.user_id = t.user_id
    WHERE t.user_id = ? ORDER BY COALESCE(t.last_posted_date, '') DESC, t.updated_at DESC`).all(userId)
}

// ---- routes ------------------------------------------------------------------
// Mine in this chat, and where the month stands: the form opens filled in.
r.get('/conversations/:id/update-template', authRequired, (req, res) => {
  if (!member(req.params.id, req.user.id)) return res.status(404).json({ error: 'Conversation not found' })
  const t = templateOf(req.user.id, req.params.id)
  const day = zonedNow().date
  // The latest post this month (the one that can be edited), and the month as
  // it stood before it: what a daily count's "month so far" is worked out from.
  const row = t && db.prepare(`
    SELECT p.message_id, p.day FROM daily_update_posts p JOIN chat_messages m ON m.id = p.message_id
    WHERE p.template_id = ? AND p.day >= ? AND m.deleted_for_all = 0 ORDER BY p.day DESC, p.created_at DESC LIMIT 1`).get(t.id, `${day.slice(0, 7)}-01`)
  const last = row ? parseMeta(db.prepare('SELECT * FROM chat_messages WHERE id=?').get(row.message_id)) : null
  const lastBase = row ? totalsOf(lastPost(t.id, row.day)) : {}
  res.json({ template: shapeTemplate(t), last, last_id: row?.message_id || null, last_base: lastBase, day })
})

r.put('/conversations/:id/update-template', authRequired, (req, res) => {
  const me = req.user
  const got = postableConv(me, req.params.id)
  if (got.error) return res.status(got.status).json({ error: got.error })
  const title = String(req.body?.title || '').trim().slice(0, 80) || 'Daily update'
  const cm = cleanMetrics(req.body?.metrics)
  if (cm.error) return res.status(400).json({ error: cm.error })
  const at = req.body?.remind_at ? String(req.body.remind_at) : null
  if (at && !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) return res.status(400).json({ error: 'Pick a reminder time' })
  const days = [...new Set((Array.isArray(req.body?.remind_days) ? req.body.remind_days : [1, 2, 3, 4, 5, 6])
    .map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort().join(',')
  const z = zonedNow()
  const hhmm = `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`
  // A reminder time already past today would fire the moment this is saved,
  // to someone who is filling the card in right now.
  const remindedToday = at && at <= hhmm ? z.date : null
  const ts = now()
  const old = templateOf(me.id, req.params.id)
  if (old) {
    db.prepare(`UPDATE daily_update_templates SET title=?, metrics=?, remind_at=?, remind_days=?, updated_at=?,
      last_reminded_date=COALESCE(?, last_reminded_date) WHERE id=?`)
      .run(title, JSON.stringify(cm.metrics), at, days, ts, remindedToday, old.id)
  } else {
    db.prepare(`INSERT INTO daily_update_templates (id, org_id, user_id, conversation_id, title, metrics, remind_at, remind_days, last_reminded_date, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id('dut'), me.org_id, me.id, req.params.id, title, JSON.stringify(cm.metrics), at, days, remindedToday, ts, ts)
    announce(req.params.id)
  }
  res.json({ template: shapeTemplate(templateOf(me.id, req.params.id)) })
})

// Stop reporting here: off the "who has posted" list, no more reminders. The
// cards already posted stay in the chat.
r.delete('/conversations/:id/update-template', authRequired, (req, res) => {
  const n = db.prepare('DELETE FROM daily_update_templates WHERE user_id=? AND conversation_id=?').run(req.user.id, req.params.id).changes
  if (n) announce(req.params.id)
  res.json({ ok: true })
})

r.post('/conversations/:id/update', authRequired, (req, res) => {
  try {
    res.status(201).json(postDailyUpdate(req.user, req.params.id, req.body?.values || {}, req.body?.note || '', req.body?.totals || {}))
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ error: e.error })
    throw e
  }
})

r.put('/message/:id/update', authRequired, (req, res) => {
  try {
    res.json(editDailyUpdate(req.user, req.params.id, req.body?.values || {}, req.body?.note || '', req.body?.totals || {}))
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ error: e.error })
    throw e
  }
})

// Who reports in this chat and who has today. "Reports in this chat" is
// everyone with a card here who is still a member.
r.get('/conversations/:id/updates/today', authRequired, (req, res) => {
  if (!member(req.params.id, req.user.id)) return res.status(404).json({ error: 'Conversation not found' })
  const day = zonedNow().date
  const people = db.prepare(`
    SELECT t.user_id, u.name, u.avatar_color, u.avatar_file,
      (SELECT p.message_id FROM daily_update_posts p JOIN chat_messages m ON m.id = p.message_id
        WHERE p.template_id = t.id AND p.day = ? AND m.deleted_for_all = 0 ORDER BY p.created_at DESC LIMIT 1) AS message_id,
      (SELECT p.created_at FROM daily_update_posts p JOIN chat_messages m ON m.id = p.message_id
        WHERE p.template_id = t.id AND p.day = ? AND m.deleted_for_all = 0 ORDER BY p.created_at DESC LIMIT 1) AS at
    FROM daily_update_templates t
    JOIN users u ON u.id = t.user_id
    JOIN chat_participants cp ON cp.conversation_id = t.conversation_id AND cp.user_id = t.user_id
    WHERE t.conversation_id = ?
    ORDER BY u.name`).all(day, day, req.params.id)
  res.json({
    day,
    people: people.map((p) => ({ ...p, posted: !!p.message_id })),
  })
})

// ---- the reminder --------------------------------------------------------------
// Run every minute by scheduler.js. "Past due and not yet today", not an exact
// minute match, like the task mail: a tick that drifts, or a server that was
// redeploying at 6 pm, still reminds — late, which beats never.
// last_reminded_date is set before the push goes, so a restart cannot repeat it.
export function runUpdateReminders() {
  const z = zonedNow()
  const hhmm = `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`
  const weekday = new Date(`${z.date}T00:00:00Z`).getUTCDay()
  const due = db.prepare(`
    SELECT t.*, c.name AS conv_name, c.type AS conv_type FROM daily_update_templates t
    JOIN chat_conversations c ON c.id = t.conversation_id
    WHERE t.remind_at IS NOT NULL AND t.remind_at <= ?
      AND COALESCE(t.last_posted_date, '') <> ? AND COALESCE(t.last_reminded_date, '') <> ?`).all(hhmm, z.date, z.date)
  for (const t of due) {
    db.prepare('UPDATE daily_update_templates SET last_reminded_date=? WHERE id=?').run(z.date, t.id)
    const days = String(t.remind_days ?? '').split(',').filter((d) => d !== '').map(Number)
    if (!days.includes(weekday) || !member(t.conversation_id, t.user_id)) continue
    const where = t.conv_type === 'group' ? ` in ${t.conv_name || 'your group'}` : ''
    notify(t.org_id, t.user_id, 'update_reminder', `Time for your ${t.title.toLowerCase() === 'daily update' ? 'daily update' : `"${t.title}"`}${where}. Tap to fill it in.`, null,
      { conversationId: t.conversation_id })
  }
}

export default r
