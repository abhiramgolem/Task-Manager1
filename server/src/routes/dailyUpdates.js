// Daily metrics cards: the message a person posts in a chat every day, kept as
// a template with blanks so they only type the numbers. People were copying
// yesterday's message and editing it by hand, which is how a November update
// came to say "October".
//
// A template is their own text. In it:
//   ___      (three or more underscores) a blank they fill in, short free text
//            ("0k", "1.05L", "359"), posted exactly as typed;
//   {month}  the current month's name, filled in by the app at post time;
//   {date}   a date they pick on the form (today by default), as "7 Nov".
// Nothing is added up or measured against a target: the card reads like the
// message they used to post.
//
// The card is an ordinary chat message (kind 'update', the text and values in
// meta), so it is delivered, notified, searched, replied to and deleted like
// any other. daily_update_posts indexes it by template and day, which is what
// "who has posted today" reads.
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

const DEFAULT_TITLE = 'Daily metrics'
const MAX_BODY = 2000
const MAX_BLANKS = 40
const MAX_VALUE = 30
const BLANK = /_{3,}/g
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MON = MONTHS.map((m) => m.slice(0, 3))

// ---- the template's text -----------------------------------------------------
export const blanksOf = (text) => (String(text || '').match(BLANK) || []).length
const hasDate = (text) => String(text || '').includes('{date}')
const monthOf = (day) => MONTHS[Number(day.slice(5, 7)) - 1]
const dateLabel = (ymd) => `${Number(ymd.slice(8, 10))} ${MON[Number(ymd.slice(5, 7)) - 1]}`
const isDay = (s) => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(s || ''))

// The message as it reads once filled in. An empty blank shows as "-", so a
// line never ends in a bare "=".
export function fillText(text, values, { month, date }) {
  let i = 0
  return String(text || '')
    .replace(BLANK, () => values[i++] || '-')
    .replace(/\{month\}/g, month || '')
    .replace(/\{date\}/g, date ? dateLabel(date) : '')
}

// What was typed into the blanks, in order: an array, or { "0": .., "1": .. }
// from the voice assistant. Each trimmed to one short line.
function cleanValues(raw, n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const v = Array.isArray(raw) ? raw[i] : raw?.[i]
    out.push(String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE))
  }
  return out
}

// A name for each blank, from the words before it on its line ("Junk leads =
// ___" gives "Junk leads"), for the voice assistant to match spoken labels to.
// The second blank of "= ___/___" is "<name> (second)". A line with only a
// bullet before its blank ("• Yesterday: ___") is named with the heading
// above it when the same words were already used ("Month-to-Date (MTD)").
export function blankLabels(text) {
  const out = []
  let heading = ''
  for (const line of String(text || '').split('\n')) {
    const parts = line.split(BLANK)
    if (parts.length === 1) {
      const h = line.replace(/\{(month|date)\}/g, '').replace(/[^\p{L}\p{N}()&.,'\- ]/gu, '').trim()
      if (h) heading = h
      continue
    }
    let base = ''
    for (let k = 0; k < parts.length - 1; k++) {
      const before = parts[k].replace(/\{(month|date)\}/g, '').replace(/[^\p{L}\p{N}()&.,'#+\- ]/gu, ' ')
        .replace(/^[\s\d.#-]+(?=\p{L})/u, '').replace(/[\s(]+$/, '').replace(/\s+/g, ' ').trim()
      if (k === 0) {
        base = before || heading || 'Number'
        if (out.includes(base) && heading) base = `${heading} ${base}`
        out.push(base)
      } else {
        out.push(/\p{L}/u.test(before) ? before : `${base} (second)`)
      }
    }
  }
  return out
}

const shapeTemplate = (t) => (!t ? null : {
  id: t.id, conversation_id: t.conversation_id, title: t.title, body: t.body || '',
  remind_at: t.remind_at || null,
  remind_days: String(t.remind_days ?? '').split(',').filter((d) => d !== '').map(Number),
  last_posted_date: t.last_posted_date || null,
})

const templateOf = (userId, convId) =>
  db.prepare('SELECT * FROM daily_update_templates WHERE user_id=? AND conversation_id=?').get(userId, convId)

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

// The card's meta and its message body from what was typed.
function buildPost({ templateId, title, text, day, month, values, date, note }) {
  const vals = cleanValues(values, blanksOf(text))
  const cleanNote = String(note || '').trim().slice(0, 1000)
  if (vals.every((v) => !v) && !cleanNote) throw { status: 400, error: 'Fill in at least one number' }
  let d = null
  if (hasDate(text)) {
    if (date && !isDay(date)) throw { status: 400, error: 'Pick a date' }
    d = date || day
  }
  const meta = { template_id: templateId, title, day, text, values: vals, month, date: d, note: cleanNote }
  // The body is the message as filled in: what the chat list, a push and
  // search show, and what it would have said posted by hand.
  const body = fillText(text, vals, { month, date: d }) + (cleanNote ? `\n\n${cleanNote}` : '')
  return { meta, body }
}

// ---- posting -----------------------------------------------------------------
// `values`: what was typed into each blank, in order. `date`: "YYYY-MM-DD" for
// a card with {date}, today when left out. Shared with the voice assistant
// (routes/assistant.js), which is why it takes the user and throws
// { status, error } rather than answering a request.
export function postDailyUpdate(user, convId, values = [], note = '', date = null) {
  const got = postableConv(user, convId)
  if (got.error) throw got
  const tpl = templateOf(user.id, convId)
  if (!tpl || !tpl.body) throw { status: 400, error: 'Set up your daily metrics card first' }
  const day = zonedNow().date
  const { meta, body } = buildPost({ templateId: tpl.id, title: tpl.title, text: tpl.body, day, month: monthOf(day), values, date, note })
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

// One of my posted cards, for editing: { m, meta }, or { status, error }.
function ownPost(user, messageId) {
  const m = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(messageId)
  if (!m || m.kind !== 'update' || m.deleted_for_all || m.sender_id !== user.id || !member(m.conversation_id, user.id)) {
    return { status: 404, error: 'Update not found' }
  }
  const meta = parseMeta(m)
  // Cards posted before the change to text templates hold a list of numbers.
  if (typeof meta.text !== 'string') return { status: 409, error: 'This older card cannot be edited' }
  return { m, meta }
}

// Correct a card already posted: the same text, new values. Any of mine, since
// nothing is worked out from earlier posts. The month stays the one it was
// posted in.
export function editDailyUpdate(user, messageId, values = [], note = '', date = null) {
  const got = ownPost(user, messageId)
  if (got.error) throw got
  const old = got.meta
  const { meta, body } = buildPost({
    templateId: old.template_id, title: old.title, text: old.text, day: old.day, month: old.month,
    values, date: date || old.date, note,
  })
  const ts = now()
  db.prepare('UPDATE chat_messages SET body=?, meta=?, edited_at=? WHERE id=?').run(body, JSON.stringify(meta), ts, messageId)
  // The 'edit' every open chat already listens for, carrying the new card.
  pushToConversation(got.m.conversation_id, { type: 'edit', conversationId: got.m.conversation_id, id: messageId, body, edited_at: ts, update: meta })
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
// Mine in this chat, my latest post (its values are the hints on the form),
// and, with ?edit=<message id>, that post to correct.
r.get('/conversations/:id/update-template', authRequired, (req, res) => {
  if (!member(req.params.id, req.user.id)) return res.status(404).json({ error: 'Conversation not found' })
  const t = templateOf(req.user.id, req.params.id)
  const day = zonedNow().date
  const row = t && db.prepare(`
    SELECT p.message_id, p.day FROM daily_update_posts p JOIN chat_messages m ON m.id = p.message_id
    WHERE p.template_id = ? AND m.deleted_for_all = 0 ORDER BY p.day DESC, p.created_at DESC LIMIT 1`).get(t.id)
  const last = row ? parseMeta(db.prepare('SELECT * FROM chat_messages WHERE id=?').get(row.message_id)) : null
  let edit = null
  if (req.query.edit) {
    const got = ownPost(req.user, String(req.query.edit))
    if (got.error) return res.status(got.status).json({ error: got.error })
    edit = { id: got.m.id, ...got.meta }
  }
  res.json({ template: shapeTemplate(t), last, last_id: row?.message_id || null, posted_today: row?.day === day, day, month: monthOf(day), edit })
})

r.put('/conversations/:id/update-template', authRequired, (req, res) => {
  const me = req.user
  const got = postableConv(me, req.params.id)
  if (got.error) return res.status(got.status).json({ error: got.error })
  const title = String(req.body?.title || '').trim().slice(0, 80) || DEFAULT_TITLE
  const body = String(req.body?.body || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  if (!body.trim()) return res.status(400).json({ error: 'Write the message you post every day' })
  if (body.length > MAX_BODY) return res.status(400).json({ error: `Keep the message under ${MAX_BODY} characters` })
  const n = blanksOf(body)
  if (!n) return res.status(400).json({ error: 'Put ___ where you type a number each day' })
  if (n > MAX_BLANKS) return res.status(400).json({ error: `At most ${MAX_BLANKS} blanks` })
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
    db.prepare(`UPDATE daily_update_templates SET title=?, body=?, remind_at=?, remind_days=?, updated_at=?,
      last_reminded_date=COALESCE(?, last_reminded_date) WHERE id=?`)
      .run(title, body, at, days, ts, remindedToday, old.id)
  } else {
    db.prepare(`INSERT INTO daily_update_templates (id, org_id, user_id, conversation_id, title, metrics, body, remind_at, remind_days, last_reminded_date, created_at, updated_at)
      VALUES (?,?,?,?,?,'[]',?,?,?,?,?,?)`)
      .run(id('dut'), me.org_id, me.id, req.params.id, title, body, at, days, remindedToday, ts, ts)
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

const sendErr = (res, e) => { if (e?.status) return res.status(e.status).json({ error: e.error }); throw e }

r.post('/conversations/:id/update', authRequired, (req, res) => {
  try { res.status(201).json(postDailyUpdate(req.user, req.params.id, req.body?.values || [], req.body?.note || '', req.body?.date || null)) }
  catch (e) { sendErr(res, e) }
})

r.put('/message/:id/update', authRequired, (req, res) => {
  try { res.json(editDailyUpdate(req.user, req.params.id, req.body?.values || [], req.body?.note || '', req.body?.date || null)) }
  catch (e) { sendErr(res, e) }
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
    const plain = ['daily metrics', 'daily update'].includes(t.title.toLowerCase())
    notify(t.org_id, t.user_id, 'update_reminder', `Time for your ${plain ? 'daily metrics' : `"${t.title}"`}${where}. Tap to fill it in.`, null,
      { conversationId: t.conversation_id })
  }
}

export default r
