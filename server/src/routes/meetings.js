import { Router } from 'express'
import multer from 'multer'
import { db } from '../db.js'
import { authRequired, requireRole } from '../auth.js'
import { id, now, audit, notify, dueDateForPriority } from '../util.js'
import { analyzeMeetingTranscript, analyzeMeetingTranscriptLive, resolveUser, resolveUserAmong } from '../ai/extractor.js'
import { liveAnalysisEnabled, liveIntervalSeconds, nextStretch, analyzeStretch, stretchColumns, liveProgress } from '../ai/liveAnalysis.js'
import { restateRuleSummary } from '../ai/rules.js'
import { resolveCategory, normalizeCategory } from '../categories.js'
import { transcribeAudio } from '../ai/transcribe.js'
import { indexMeeting, indexTask, removeMeetingEmbeddings } from '../ai/ragIndex.js'
import { recordUsage, estimateTokens } from '../ai/usage.js'

const r = Router()

// Rule-based summaries stored before the wording fix say "3 assigned" for
// suggestions nobody had approved. They are restated when read, here exactly as
// on the call's summary card in the chat, so the two never disagree; the stored
// rows stay as they were.
function readSummary(json) {
  let s = {}
  try { s = JSON.parse(json || '{}') || {} } catch { s = {} }
  if (typeof s.executive_summary === 'string') s.executive_summary = restateRuleSummary(s.executive_summary)
  return s
}
r.use(authRequired)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })

// Map an analysis engine name to the provider whose key it billed against.
const ENGINE_PROVIDER = { openrouter: 'openrouter', claude: 'anthropic', openai: 'openai' }
const STT_PROVIDER = (process.env.TRANSCRIPTION_PROVIDER || 'sarvam').toLowerCase()

// Record an estimated usage event for a meeting LLM analysis (token-exact data
// isn't available from the multi-call analyzer, so we approximate from text).
function recordAnalysisUsage(req, transcript, analysis) {
  const provider = ENGINE_PROVIDER[analysis?.engine]
  if (!provider) return // rule-based / offline — no API key was used
  recordUsage({
    orgId: req.user.org_id, userId: req.user.id, provider, feature: 'meeting_analysis',
    inputTokens: estimateTokens(transcript),
    outputTokens: estimateTokens(JSON.stringify(analysis || {})),
  })
}
// The live analysis bills each call as it is made, since one meeting is many
// small calls spread over hours rather than one at the end.
const liveUsage = (orgId, userId) => ({ engine, input, output }) => {
  const provider = ENGINE_PROVIDER[engine]
  if (provider) recordUsage({ orgId, userId, provider, feature: 'meeting_analysis', inputTokens: estimateTokens(input), outputTokens: estimateTokens(output) })
}

// The app is scoped to these three languages. Any other detected code (the AI
// sometimes over-guesses related Indian languages like mr/pa/gu/bn/ml) is dropped
// so the meeting's language tags stay clean. Order is preserved; defaults to en.
const ALLOWED_LANGUAGES = ['en', 'hi', 'te']
function filterLanguages(langs) {
  const out = [...new Set((langs || []).map((l) => String(l).toLowerCase()))].filter((l) => ALLOWED_LANGUAGES.includes(l))
  return out.length ? out : ['en']
}

// Derive display segments from raw transcript text when the AI engine doesn't
// emit its own (the OpenRouter engine skips per-line segments to save output
// tokens on long meetings). Splits on line breaks, else into sentence groups,
// so the Transcript tab stays readable. Capped to keep very long meetings sane.
function deriveSegments(transcript) {
  const text = String(transcript || '').trim()
  if (!text) return []
  let parts = text.split(/\r?\n+/).map((s) => s.trim()).filter(Boolean)
  if (parts.length <= 1) {
    // One big block — split into sentences, then group ~3 per segment.
    const sentences = text.match(/[^.!?।]+[.!?।]+|\S[^.!?।]*$/g) || [text]
    parts = []
    for (let i = 0; i < sentences.length; i += 3) parts.push(sentences.slice(i, i + 3).join(' ').trim())
  }
  return parts.slice(0, 2000).map((t, seq) => ({ seq, speaker: null, text: t, language: null }))
}

// Attendees (with role + department) the AI may assign work to. When no
// participants were selected, fall back to everyone in the org.
function attendeesFor(orgId, participantIds) {
  const base = `SELECT u.id, u.name, u.role, d.name AS department
    FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.org_id=?`
  if (participantIds && participantIds.length) {
    const ph = participantIds.map(() => '?').join(',')
    return db.prepare(`${base} AND u.id IN (${ph}) ORDER BY u.name`).all(orgId, ...participantIds)
  }
  return db.prepare(`${base} ORDER BY u.name`).all(orgId)
}

// Turn an approved suggestion into a real, assigned task and (optionally) notify
// the assignee. Marks the suggestion approved and links the created task.
function createTaskFromSuggestion(s, { orgId, actorId, notifyAssignee = true }) {
  const tid = id('task')
  const priority = s.priority || 'Medium'
  // Auto-fill the due date from priority when the AI didn't capture a deadline.
  const dueDate = s.due_date || dueDateForPriority(priority)
  // The assigner is whoever ASKED for the work, not whoever pressed the button.
  // Falling back to actorId keeps hand-added suggestions sane — there the person
  // adding it really is the one assigning. So does a volunteer's own "I'll do
  // it": as their own assigner the task would read as one they raised for
  // themselves, which they may close or bin with no manager sign-off
  // (isOwnSelfCreated in tasks.js), and work that came out of a reviewed meeting
  // keeps the approval flow.
  const volunteered = !!s.suggested_assigner_id && s.suggested_assigner_id === s.suggested_assignee_id
  const assignerId = s.suggested_assigner_id && !volunteered ? s.suggested_assigner_id : actorId
  const assignerRaw = volunteered ? null : s.suggested_assigner_raw || null
  db.prepare(`INSERT INTO tasks
    (id, org_id, title, description, assignee_id, assignee_name_raw, assigned_by_id, assigned_by_name_raw,
     due_date, due_date_raw, priority, status, meeting_id, ownership_confidence, progress, approval_status, source_quote,
     category, assigned_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    tid, orgId, s.title, s.description || s.title, s.suggested_assignee_id || null, s.suggested_assignee_raw || null,
    assignerId, assignerRaw, dueDate, s.due_date_raw || null,
    priority, 'To Do', s.meeting_id, s.suggested_assignee_id ? 'high' : 'needs_confirmation', 0, 'none',
    s.source_quote || null, s.category || null, s.suggested_assignee_id ? now() : null, now(), now())
  db.prepare("UPDATE suggested_tasks SET status='approved', created_task_id=?, updated_at=? WHERE id=?").run(tid, now(), s.id)
  if (notifyAssignee && s.suggested_assignee_id) {
    notify(orgId, s.suggested_assignee_id, 'task_assigned', `You were assigned "${s.title}"`, tid)
  }
  indexTask(tid) // index the newly created task for RAG
  return tid
}

// Persist a meeting + participants + segments, and queue the AI's tasks as
// PENDING SUGGESTIONS for manager review (they are not assigned yet).
// opts.autoApprove (used by the seed) immediately assigns them so demo
// dashboards stay populated.
// conversationId / callId / callKind: the chat (and the call in it) a meeting
// was filed from, so that chat can list its meetings and show each call's
// summary. NULL for a meeting made on the Meetings page. Callers pass only links
// they have already checked against the user — this function trusts them.
function persistMeeting({ orgId, userId, title, description, meetingDate, transcript, sourceType, audioFilename, participantIds = [], conversationId = null, callId = null, callKind = null }, analysis, opts = {}) {
  const mid = id('mtg')
  db.prepare(`INSERT INTO meetings
    (id, org_id, title, description, meeting_date, uploaded_by, source_type, audio_filename, raw_transcript, detected_languages, status, summary_json, engine, conversation_id, call_id, call_kind, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    mid, orgId, title, description || '', meetingDate, userId, sourceType || 'transcript', audioFilename || null,
    transcript, JSON.stringify(filterLanguages(analysis.detected_languages)), 'processed',
    JSON.stringify(analysis.summary || {}), analysis.engine || 'rule-based', conversationId, callId, callKind, now())

  // Attendees — only these users can be suggested as task owners.
  const attendeeIds = []
  for (const uid of participantIds) {
    if (!uid || attendeeIds.includes(uid)) continue
    const u = db.prepare('SELECT id FROM users WHERE id=? AND org_id=?').get(uid, orgId)
    if (!u) continue
    attendeeIds.push(uid)
    db.prepare('INSERT OR IGNORE INTO meeting_participants (meeting_id, user_id) VALUES (?,?)').run(mid, uid)
  }

  const segments = (analysis.segments && analysis.segments.length) ? analysis.segments : deriveSegments(transcript)
  segments.forEach((s) => {
    db.prepare('INSERT INTO transcript_segments (id, meeting_id, seq, speaker, text, language) VALUES (?,?,?,?,?,?)')
      .run(id('seg'), mid, s.seq, s.speaker || null, s.text, s.language || null)
  })

  // AI Review Queue — de-duped by normalized title + assignee (prevent duplicates).
  const seen = new Set()
  let suggestionCount = 0
  for (const t of analysis.tasks || []) {
    const assignee = resolveUserAmong(orgId, t.assignee_name_raw, attendeeIds)
    // Deliberately resolved across the ORG, not just attendees: in a recorded
    // call the speaker labels come from the participants' own accounts, but a
    // pasted transcript can name a manager who was in the room and not in the
    // meeting record. Being wrong about who asked is less damaging than being
    // silent about it, and the UI shows the raw name when it cannot resolve.
    const assigner = t.assigned_by_name_raw ? resolveUser(orgId, t.assigned_by_name_raw) : null
    const key = (t.title || '').toLowerCase().trim() + '|' + (assignee?.id || '')
    if (seen.has(key)) continue
    seen.add(key)
    const conf = Number.isFinite(t.confidence) ? Math.max(0, Math.min(100, Math.round(t.confidence))) : (assignee ? 80 : 30)
    // Hybrid category: keyword match on the task text wins, else the AI's guess.
    const category = resolveCategory({ text: `${t.title} ${t.description || ''} ${t.source_quote || ''}`, aiSuggested: t.category, orgId })
    db.prepare(`INSERT INTO suggested_tasks
      (id, meeting_id, org_id, title, description, suggested_assignee_id, suggested_assignee_raw, assignee_reasoning,
       suggested_assigner_id, suggested_assigner_raw,
       confidence, priority, due_date, due_date_raw, source_quote, category, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id('sug'), mid, orgId, t.title, t.description || t.title, assignee?.id || null, t.assignee_name_raw || null,
      t.assignee_reasoning || null,
      assigner?.id || null, t.assigned_by_name_raw || null,
      conf, t.priority || 'Medium', t.due_date || null, t.due_date_raw || null,
      t.source_quote || null, category, 'pending', now(), now())
    suggestionCount++
  }

  // Demo/seed: approve everything that has a resolved owner into live tasks.
  let assignedCount = 0
  if (opts.autoApprove) {
    const rows = db.prepare("SELECT * FROM suggested_tasks WHERE meeting_id=? AND status='pending'").all(mid)
    for (const s of rows) {
      if (!s.suggested_assignee_id) continue
      createTaskFromSuggestion(s, { orgId, actorId: userId, notifyAssignee: false })
      assignedCount++
    }
  }

  audit(orgId, userId, 'meeting.process', 'meeting', mid, `${suggestionCount} suggestion(s), engine=${analysis.engine}`)
  indexMeeting(mid) // index the meeting summary + transcript segments for RAG
  return { mid, suggestionCount, assignedCount }
}

// LIST
r.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT m.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.meeting_id=m.id) AS task_count,
      (SELECT COUNT(*) FROM suggested_tasks s WHERE s.meeting_id=m.id AND s.status='pending') AS pending_count
    FROM meetings m WHERE m.org_id=? AND m.status<>'recording'
    ORDER BY m.meeting_date DESC, m.created_at DESC
  `).all(req.user.org_id)
  res.json(rows.map((m) => ({ ...m, detected_languages: JSON.parse(m.detected_languages || '[]'), summary: readSummary(m.summary_json) })))
})

// ---------------------------------------------------------------------------
// A recording in progress.
//
// Until this existed, a live meeting was held in one browser tab and nowhere
// else, so a refresh, a flat battery or a phone call could destroy the only
// record of a conversation that had already happened. The client still writes to
// localStorage first — that is instant and survives a lost network, which is the
// normal state of a meeting room — and pushes here every few seconds so the
// meeting also survives a wiped browser, a dead device, or being picked up on a
// different one.
//
// It reuses the meetings table with status='recording'. Those rows are filtered
// out of LIST above so a half-captured meeting can never be mistaken for a
// finished one.

// The caller's own recording, if they left one running.
r.get('/draft', (req, res) => {
  const m = db.prepare(`SELECT id, title, raw_transcript, draft_seconds, created_at
    FROM meetings WHERE org_id=? AND uploaded_by=? AND status='recording'
    ORDER BY created_at DESC LIMIT 1`).get(req.user.org_id, req.user.id)
  if (!m) return res.json(null)
  const participants = db.prepare('SELECT user_id FROM meeting_participants WHERE meeting_id=?').all(m.id).map((r) => r.user_id)
  res.json({ ...m, participant_ids: participants })
})

// Start one. Created the moment recording begins, so there is never a window in
// which spoken words exist only in a browser tab.
r.post('/draft', requireRole('manager', 'admin'), (req, res) => {
  const b = req.body || {}
  // One live recording per person: reuse theirs rather than accumulating rows if
  // a tab was closed and another opened.
  const open = db.prepare(`SELECT id FROM meetings WHERE org_id=? AND uploaded_by=? AND status='recording'`).get(req.user.org_id, req.user.id)
  if (open) return res.json({ id: open.id, resumed: true })
  const mid = id('mtg')
  db.prepare(`INSERT INTO meetings
    (id, org_id, title, description, meeting_date, uploaded_by, source_type, raw_transcript,
     detected_languages, status, summary_json, engine, draft_seconds, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    mid, req.user.org_id, (b.title || '').trim() || 'Live Meeting', '', (b.meeting_date || now()).slice(0, 10),
    req.user.id, 'transcript', '', '[]', 'recording', '{}', 'pending', 0, now())
  res.json({ id: mid, resumed: false })
})

// Push what has been heard so far. Called every few seconds, so it stays cheap:
// no audit row, no notification, no AI.
r.patch('/draft/:id', requireRole('manager', 'admin'), (req, res) => {
  const m = db.prepare(`SELECT id FROM meetings WHERE id=? AND org_id=? AND uploaded_by=? AND status='recording'`)
    .get(req.params.id, req.user.org_id, req.user.id)
  if (!m) return res.status(404).json({ error: 'No such recording' })
  const b = req.body || {}
  const sets = ['raw_transcript=?'], args = [String(b.transcript || '')]
  if ('title' in b) { sets.push('title=?'); args.push((b.title || '').trim() || 'Live Meeting') }
  if ('seconds' in b) { sets.push('draft_seconds=?'); args.push(Math.max(0, Math.round(Number(b.seconds) || 0))) }
  args.push(m.id)
  db.prepare(`UPDATE meetings SET ${sets.join(', ')} WHERE id=?`).run(...args)
  if (Array.isArray(b.participant_ids)) {
    db.prepare('DELETE FROM meeting_participants WHERE meeting_id=?').run(m.id)
    for (const uid of [...new Set(b.participant_ids)]) {
      const u = db.prepare('SELECT id FROM users WHERE id=? AND org_id=?').get(uid, req.user.org_id)
      if (u) db.prepare('INSERT OR IGNORE INTO meeting_participants (meeting_id, user_id) VALUES (?,?)').run(m.id, uid)
    }
  }
  res.json({ ok: true })
  nudgeLiveAnalysis(m.id, { seconds: Number(b.seconds) || 0, length: String(b.transcript || '').length })
})

// How far the AI has got with this recording, for the line under the recorder.
r.get('/draft/:id/live', requireRole('manager', 'admin'), (req, res) => {
  const m = db.prepare(`SELECT id, raw_transcript FROM meetings WHERE id=? AND org_id=? AND uploaded_by=? AND status='recording'`)
    .get(req.params.id, req.user.org_id, req.user.id)
  if (!m) return res.status(404).json({ error: 'No such recording' })
  if (!liveAnalysisEnabled()) return res.json({ enabled: false })
  const rows = db.prepare('SELECT text, end_seconds, tasks_json FROM meeting_live_chunks WHERE meeting_id=? ORDER BY seq').all(m.id)
  res.json({
    enabled: true,
    interval_seconds: liveIntervalSeconds(),
    ...liveProgress(m.raw_transcript || '', rows),
    running: !!liveJobs.get(m.id)?.current,
    // Not the provider's error text: it can carry account details, and all the
    // recorder needs to say is that this will be caught up at the end.
    behind: liveErrors.has(m.id),
  })
})

// Thrown away, or finished — the real meeting is created by POST /meetings, and
// this placeholder goes with it.
r.delete('/draft/:id', requireRole('manager', 'admin'), (req, res) => {
  const m = db.prepare(`SELECT id, raw_transcript FROM meetings WHERE id=? AND org_id=? AND uploaded_by=? AND status='recording'`)
    .get(req.params.id, req.user.org_id, req.user.id)
  if (!m) return res.json({ ok: true }) // already gone; deleting twice is not an error
  db.prepare('DELETE FROM meeting_participants WHERE meeting_id=?').run(m.id)
  db.prepare('DELETE FROM meetings WHERE id=?').run(m.id) // its live stretches cascade
  liveErrors.delete(m.id); liveDue.delete(m.id)
  // Audited, unlike the patches: this is the one draft operation that destroys
  // something a person cannot get back by talking again.
  audit(req.user.org_id, req.user.id, 'meeting.draft_discard', 'meeting', m.id, `${(m.raw_transcript || '').length} chars`)
  res.json({ ok: true })
})

// ---- Analysing the recording while it happens (ai/liveAnalysis.js) ----------
//
// Driven by the pushes above rather than a timer of its own: a recording that is
// not growing has nothing new to analyse, and one that is pushes every few
// seconds anyway. At most one stretch per meeting is in flight, since each needs
// the memory the one before it produced, and it runs after the response — the
// push itself stays as cheap as it always was.
const liveJobs = new Map()   // meeting id -> { current: { text, result } | null, again }
const liveErrors = new Map() // meeting id -> { retryAt } after a failed stretch
const liveDue = new Map()    // meeting id -> { seconds, length }: nothing to do before either

// `seconds` / `length`: the recording clock and transcript length just pushed.
function nudgeLiveAnalysis(meetingId, { seconds, length }) {
  if (!liveAnalysisEnabled()) return
  const job = liveJobs.get(meetingId)
  if (job) { job.again = true; return }
  // A push arrives every few seconds and a stretch is ten minutes long: until
  // one could be due, the transcript is not even read.
  const due = liveDue.get(meetingId)
  if (due && seconds < due.seconds && length < due.length) return
  const j = { current: null, again: true }
  liveJobs.set(meetingId, j)
  ;(async () => {
    try {
      while (j.again) {
        j.again = false
        // More than one stretch only when there is a backlog to work through.
        while (await analyseNextStretch(meetingId, j)) { /* next */ }
      }
    } catch (err) {
      console.error('[live-analysis]', err.message)
    } finally {
      liveJobs.delete(meetingId)
    }
  })()
}

// Analyse the next stretch of a recording if one is due. True when one was
// saved, so the caller looks again at once.
async function analyseNextStretch(meetingId, job) {
  // A model that just failed is not asked again on the next push, a few seconds
  // later. Whatever it misses is analysed when the meeting is finished.
  if (Date.now() < (liveErrors.get(meetingId)?.retryAt || 0)) return false
  const m = db.prepare(`SELECT id, org_id, uploaded_by, raw_transcript, draft_seconds, meeting_date
    FROM meetings WHERE id=? AND status='recording'`).get(meetingId)
  if (!m) return false
  const rows = db.prepare('SELECT * FROM meeting_live_chunks WHERE meeting_id=? ORDER BY seq').all(m.id)
  const next = nextStretch(m.raw_transcript || '', rows, m.draft_seconds || 0)
  if (next.due) { liveDue.set(m.id, next.due); return false }
  liveDue.delete(m.id)

  const participantIds = db.prepare('SELECT user_id FROM meeting_participants WHERE meeting_id=?').all(m.id).map((p) => p.user_id)
  const attendees = attendeesFor(m.org_id, participantIds)
  const work = analyzeStretch(next.text, {
    memory: next.memory, priorTasks: next.priorTasks, meetingDate: m.meeting_date,
    attendees, knownNames: attendees.map((a) => a.name), onUsage: liveUsage(m.org_id, m.uploaded_by),
  })
  // Finishing the meeting while this is in flight waits for it rather than
  // reading the same stretch again (see stretchesForFinish).
  job.current = { text: next.text, result: work.catch(() => null) }
  let result
  try { result = await work }
  catch (err) {
    liveErrors.set(m.id, { retryAt: Date.now() + 60_000 })
    console.warn(`[live-analysis] ${m.id}: stretch failed, will retry: ${err.message}`)
    return false
  } finally { job.current = null }
  liveErrors.delete(m.id)

  // Only onto a recording that is still a recording: finished or thrown away
  // while the model was working, there is nothing left to attach it to.
  const c = stretchColumns(result)
  const saved = db.prepare(`INSERT INTO meeting_live_chunks
    (id, meeting_id, seq, text, start_seconds, end_seconds, memory, notes_json, tasks_json, languages, engine, created_at)
    SELECT ?, m.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM meeting_live_chunks WHERE meeting_id=m.id), ?, ?, ?, ?, ?, ?, ?, ?, ?
    FROM meetings m WHERE m.id=? AND m.status='recording'`).run(
    id('lch'), next.text, next.startSeconds, next.endSeconds, c.memory, c.notes_json, c.tasks_json, c.languages, c.engine, now(), m.id)
  if (saved.changes) console.log(`[live-analysis] ${m.id}: analysed ${Math.round(next.startSeconds / 60)}–${Math.round(next.endSeconds / 60)} min (${next.text.length} chars, ${result.tasks.length} task(s))`)
  return saved.changes > 0
}

// The stretches a finished recording can reuse: the caller's own draft only.
// The one being analysed at this moment, if any, comes too, as a promise —
// waited on alongside the last few minutes instead of being read again.
function stretchesForFinish(draftId, user) {
  if (!draftId || !liveAnalysisEnabled()) return []
  const m = db.prepare(`SELECT id FROM meetings WHERE id=? AND org_id=? AND uploaded_by=? AND status='recording'`)
    .get(String(draftId), user.org_id, user.id)
  if (!m) return []
  const rows = db.prepare('SELECT * FROM meeting_live_chunks WHERE meeting_id=? ORDER BY seq').all(m.id)
  const cur = liveJobs.get(m.id)?.current
  if (cur) rows.push({ text: cur.text, pending: cur.result })
  return rows
}

// Meetings whose AI suggestions nobody has finished reviewing. Its own endpoint
// rather than a filter over LIST because that one selects `m.*`, which drags the
// entire raw transcript along — far too much to ship to a dashboard card that
// wants a title and a count. Declared before '/:id' or that route swallows it.
r.get('/pending-review', (req, res) => {
  const rows = db.prepare(`
    SELECT m.id, m.title, m.meeting_date, m.created_at, COUNT(s.id) AS pending_count
    FROM meetings m JOIN suggested_tasks s ON s.meeting_id=m.id AND s.status='pending'
    WHERE m.org_id=?
    GROUP BY m.id
    ORDER BY m.meeting_date DESC, m.created_at DESC
  `).all(req.user.org_id)
  res.json(rows)
})

// DETAIL
r.get('/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM meetings WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!m) return res.status(404).json({ error: 'Not found' })
  const segments = db.prepare('SELECT * FROM transcript_segments WHERE meeting_id=? ORDER BY seq').all(m.id)
  const tasks = db.prepare(`SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.meeting_id=? ORDER BY t.created_at`).all(m.id)
  const participants = db.prepare(`SELECT u.id, u.name, u.avatar_color, u.role, u.department_id
    FROM meeting_participants p JOIN users u ON u.id=p.user_id WHERE p.meeting_id=? ORDER BY u.name`).all(m.id)
  const suggestions = db.prepare(`SELECT s.*,
      u.name AS suggested_assignee_name, u.avatar_color AS suggested_assignee_color,
      a.name AS suggested_assigner_name, a.avatar_color AS suggested_assigner_color
    FROM suggested_tasks s
    LEFT JOIN users u ON u.id=s.suggested_assignee_id
    LEFT JOIN users a ON a.id=s.suggested_assigner_id
    WHERE s.meeting_id=? ORDER BY s.created_at`).all(m.id)
  res.json({
    ...m,
    detected_languages: JSON.parse(m.detected_languages || '[]'),
    summary: readSummary(m.summary_json),
    segments, tasks, participants, suggestions,
  })
})

// EDIT meeting metadata (title / date). Managers & admins only.
r.patch('/:id', requireRole('manager', 'admin'), (req, res) => {
  const m = db.prepare('SELECT * FROM meetings WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!m) return res.status(404).json({ error: 'Not found' })
  const b = req.body || {}
  const sets = [], args = []
  if ('title' in b) { sets.push('title=?'); args.push((b.title || '').trim() || 'Untitled Meeting') }
  if ('meeting_date' in b) { sets.push('meeting_date=?'); args.push((b.meeting_date || '').slice(0, 10)) }
  if (!sets.length) return res.json({ ok: true })
  args.push(m.id)
  db.prepare(`UPDATE meetings SET ${sets.join(', ')} WHERE id=?`).run(...args)
  audit(req.user.org_id, req.user.id, 'meeting.update', 'meeting', m.id, b)
  indexMeeting(m.id) // title change → re-index
  res.json({ ok: true })
})

// DELETE a meeting and everything derived from it (segments + extracted tasks). Managers & admins only.
r.delete('/:id', requireRole('manager', 'admin'), (req, res) => {
  const m = db.prepare('SELECT id FROM meetings WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!m) return res.status(404).json({ error: 'Not found' })
  removeMeetingEmbeddings(m.id) // drop RAG vectors before the source rows vanish
  const wipe = db.transaction(() => {
    db.prepare('DELETE FROM tasks WHERE meeting_id=?').run(m.id)            // cascades subtasks/comments/deps
    db.prepare('DELETE FROM transcript_segments WHERE meeting_id=?').run(m.id)
    db.prepare('DELETE FROM meetings WHERE id=?').run(m.id)
  })
  wipe()
  audit(req.user.org_id, req.user.id, 'meeting.delete', 'meeting', m.id)
  res.json({ ok: true })
})

// CREATE from transcript text + process (managers/admins upload meetings)
// draft_id: the live recording this transcript came from, whose stretches were
// analysed while it was recorded — only the rest is read now.
r.post('/', requireRole('manager', 'admin'), async (req, res) => {
  const { title, description, meeting_date, transcript, summary_language, participant_ids, draft_id } = req.body || {}
  if (!transcript || !transcript.trim()) return res.status(400).json({ error: 'transcript text required' })
  const meetingDate = (meeting_date || now()).slice(0, 10)
  const participantIds = Array.isArray(participant_ids) ? participant_ids.filter(Boolean) : []
  const attendees = attendeesFor(req.user.org_id, participantIds)
  try {
    const opts = { meetingDate, knownNames: attendees.map((a) => a.name), attendees, summaryLanguage: summary_language || 'en' }
    const started = Date.now()
    const stretches = stretchesForFinish(draft_id, req.user)
    const analysis = stretches.length
      ? await analyzeMeetingTranscriptLive(transcript, stretches, { ...opts, onUsage: liveUsage(req.user.org_id, req.user.id) })
      : await analyzeMeetingTranscript(transcript, opts)
    if (analysis.live) {
      const l = analysis.live
      console.log(`[meetings] analysed in ${Date.now() - started} ms — ${l.reused} stretch(es) done while recording, ${l.in_flight} in flight, ${l.analysed_at_end} read at the end`)
    } else {
      recordAnalysisUsage(req, transcript, analysis) // the live path billed each call as it went
    }
    const { mid, suggestionCount } = persistMeeting(
      { orgId: req.user.org_id, userId: req.user.id, title: title || 'Untitled Meeting', description, meetingDate, transcript, sourceType: 'transcript', participantIds },
      analysis)
    res.status(201).json({ id: mid, suggestion_count: suggestionCount, engine: analysis.engine, fallback_reason: analysis.fallback_reason || null, live: analysis.live || null })
  } catch (err) {
    console.error('[meetings] process error', err)
    res.status(500).json({ error: 'Processing failed: ' + err.message })
  }
})

// TRANSCRIBE a single audio chunk -> text (auto language detection).
// The live recorder streams short segments here; the client assembles the transcript.
r.post('/transcribe', requireRole('manager', 'admin'), upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file required (field "audio")' })
  try {
    const { text, language } = await transcribeAudio(req.file.buffer, req.file.originalname || 'chunk.webm', req.file.mimetype || 'audio/webm', { prompt: req.body.prompt })
    recordUsage({ orgId: req.user.org_id, userId: req.user.id, provider: STT_PROVIDER, feature: 'transcription' })
    res.json({ text, language })
  } catch (err) {
    console.error('[transcribe]', err.message)
    res.status(err.code === 'NO_PROVIDER' ? 400 : 502).json({ error: err.message, code: err.code || null })
  }
})

// Full AUDIO file upload -> transcription -> analysis -> tasks (one-shot, e.g. for an uploaded recording).
r.post('/audio', requireRole('manager', 'admin'), upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file required (field "audio")' })
  try {
    // Long uploaded files go to OpenAI Whisper (no duration cap) when a key is
    // present — Sarvam's instant endpoint rejects audio over 30s. Live recording
    // still uses the configured provider (Sarvam streaming).
    const uploadProvider = process.env.OPENAI_API_KEY ? 'openai' : undefined
    const { text } = await transcribeAudio(req.file.buffer, req.file.originalname || 'meeting.webm', req.file.mimetype || 'audio/webm', { provider: uploadProvider })
    recordUsage({ orgId: req.user.org_id, userId: req.user.id, provider: uploadProvider || STT_PROVIDER, feature: 'transcription' })
    if (!text.trim()) return res.status(422).json({ error: 'Transcription returned no text.' })
    const meetingDate = (req.body.meeting_date || now()).slice(0, 10)
    const participantIds = (() => {
      try { const p = JSON.parse(req.body.participant_ids || '[]'); return Array.isArray(p) ? p.filter(Boolean) : [] }
      catch { return [] }
    })()
    const attendees = attendeesFor(req.user.org_id, participantIds)
    const analysis = await analyzeMeetingTranscript(text, {
      meetingDate, knownNames: attendees.map((a) => a.name), attendees, summaryLanguage: req.body.summary_language || 'en',
    })
    recordAnalysisUsage(req, text, analysis)
    const { mid, suggestionCount } = persistMeeting(
      // source_type is passed through so a recording that came from a CALL is
      // labelled as one. Nothing branches on it — it is provenance, and a call
      // and an uploaded recording are otherwise processed identically.
      { orgId: req.user.org_id, userId: req.user.id, title: req.body.title || 'Recorded Meeting', description: req.body.description, meetingDate, transcript: text, sourceType: req.body.source_type === 'call' ? 'call' : 'audio', audioFilename: req.file.originalname, participantIds },
      analysis)
    res.status(201).json({ id: mid, suggestion_count: suggestionCount, engine: analysis.engine })
  } catch (err) {
    console.error('[audio]', err.message)
    res.status(err.code === 'NO_PROVIDER' ? 400 : 502).json({ error: err.message, code: err.code || null })
  }
})

// ---- AI Review Queue: manager review & assignment ---------------------------

// Fetch a suggestion scoped to the manager's org (via its meeting).
function getSuggestion(sid, orgId) {
  return db.prepare(`SELECT s.* FROM suggested_tasks s JOIN meetings m ON m.id=s.meeting_id
    WHERE s.id=? AND m.org_id=?`).get(sid, orgId)
}

// Who may review a meeting's suggested tasks and assign them: a manager, any
// meeting; anyone else, only a meeting they were in — the call they joined, the
// recording they filed (the same people who may read its transcript). A call
// no longer assigns its own tasks, and the people on it are the ones who know
// whether the AI heard it right; asking a manager who was not there to settle
// every call between two employees left those tasks waiting on nobody. It gives
// no new power: anyone may already assign a task to anyone, from Tasks or from
// a chat.
function canReviewMeeting(user, m) {
  if (!user || !m || m.org_id !== user.org_id) return false
  if (user.role === 'manager' || user.role === 'admin' || m.uploaded_by === user.id) return true
  return !!m.call_id && !!db.prepare('SELECT 1 FROM chat_call_participants WHERE call_id=? AND user_id=? AND joined_at IS NOT NULL').get(m.call_id, user.id)
}
const meetingOf = (s) => (s ? db.prepare('SELECT * FROM meetings WHERE id=?').get(s.meeting_id) : null)

// Told whenever a review changes which of a meeting's tasks are still pending
// (assigned, rejected, merged, restored). routes/chat.js listens, to keep the
// card a finished call put up in step with the review wherever it happened.
// A listener rather than an import, since chat.js already imports this file.
const reviewListeners = new Set()
export const onReviewChanged = (fn) => { reviewListeners.add(fn) }
const reviewChanged = (meetingId) => {
  for (const fn of reviewListeners) { try { fn(meetingId) } catch (e) { console.error('[meetings] review listener failed:', e.message) } }
}
// The gate on every review action, in place of a manager-only role check.
function reviewable(req, res, s) {
  if (!s) { res.status(404).json({ error: 'Not found' }); return false }
  if (!canReviewMeeting(req.user, meetingOf(s))) { res.status(403).json({ error: 'Only someone who was in this meeting, or a manager, can review its tasks' }); return false }
  return true
}

// EDIT a suggestion before assigning (assignee, title, priority, due, etc.).
r.patch('/suggestions/:sid', (req, res) => {
  const s = getSuggestion(req.params.sid, req.user.org_id)
  if (!reviewable(req, res, s)) return
  const b = req.body || {}
  const sets = [], args = []
  for (const f of ['title', 'description', 'priority', 'due_date', 'due_date_raw', 'assignee_reasoning']) {
    if (f in b) { sets.push(`${f}=?`); args.push(b[f]) }
  }
  if ('confidence' in b) { sets.push('confidence=?'); args.push(Math.max(0, Math.min(100, Math.round(Number(b.confidence) || 0)))) }
  if ('category' in b) { sets.push('category=?'); args.push(normalizeCategory(b.category, req.user.org_id)) }
  if ('suggested_assignee_id' in b) {
    const uid = b.suggested_assignee_id || null
    if (uid && !db.prepare('SELECT id FROM users WHERE id=? AND org_id=?').get(uid, req.user.org_id)) {
      return res.status(400).json({ error: 'invalid assignee' })
    }
    sets.push('suggested_assignee_id=?'); args.push(uid)
  }
  if (!sets.length) return res.json(s)
  sets.push('updated_at=?'); args.push(now())
  args.push(s.id)
  db.prepare(`UPDATE suggested_tasks SET ${sets.join(', ')} WHERE id=?`).run(...args)
  res.json(db.prepare('SELECT * FROM suggested_tasks WHERE id=?').get(s.id))
})

// REJECT a suggestion (won't be assigned).
r.post('/suggestions/:sid/reject', (req, res) => {
  const s = getSuggestion(req.params.sid, req.user.org_id)
  if (!reviewable(req, res, s)) return
  db.prepare("UPDATE suggested_tasks SET status='rejected', updated_at=? WHERE id=?").run(now(), s.id)
  reviewChanged(s.meeting_id)
  res.json({ ok: true })
})

// RESTORE a previously rejected (or merged) suggestion back to the pending queue,
// so the reviewer can edit it and assign it after all. Returns the refreshed row.
r.post('/suggestions/:sid/restore', (req, res) => {
  const s = getSuggestion(req.params.sid, req.user.org_id)
  if (!reviewable(req, res, s)) return
  db.prepare("UPDATE suggested_tasks SET status='pending', merged_into=NULL, updated_at=? WHERE id=?").run(now(), s.id)
  reviewChanged(s.meeting_id)
  res.json(db.prepare('SELECT * FROM suggested_tasks WHERE id=?').get(s.id))
})

// MERGE a duplicate suggestion into another (the duplicate is dropped).
r.post('/suggestions/:sid/merge', (req, res) => {
  const s = getSuggestion(req.params.sid, req.user.org_id)
  const target = getSuggestion(req.body?.into, req.user.org_id)
  if (!target) return res.status(404).json({ error: 'Not found' })
  // Both ends: merging into another meeting's task would edit that meeting.
  if (!reviewable(req, res, s) || !reviewable(req, res, target)) return
  if (s.id === target.id) return res.status(400).json({ error: 'cannot merge into itself' })
  db.prepare("UPDATE suggested_tasks SET status='merged', merged_into=?, updated_at=? WHERE id=?").run(target.id, now(), s.id)
  reviewChanged(s.meeting_id)
  res.json({ ok: true })
})

// ASSIGN — final step. Create real tasks from the chosen (or all pending)
// suggestions, notify the assignees, and mark the suggestions approved.
r.post('/:id/assign', (req, res) => {
  const m = db.prepare('SELECT * FROM meetings WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!m) return res.status(404).json({ error: 'Not found' })
  if (!canReviewMeeting(req.user, m)) return res.status(403).json({ error: 'Only someone who was in this meeting, or a manager, can assign its tasks' })
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null
  let rows = db.prepare("SELECT * FROM suggested_tasks WHERE meeting_id=? AND status='pending'").all(m.id)
  if (ids) rows = rows.filter((s) => ids.includes(s.id))
  let assigned = 0, skipped = 0
  const tx = db.transaction(() => {
    for (const s of rows) {
      if (!s.suggested_assignee_id) { skipped++; continue } // no owner — can't assign
      createTaskFromSuggestion(s, { orgId: m.org_id, actorId: req.user.id, notifyAssignee: true })
      assigned++
    }
  })
  tx()
  audit(req.user.org_id, req.user.id, 'meeting.assign', 'meeting', m.id, `assigned=${assigned}, skipped=${skipped}`)
  reviewChanged(m.id)
  res.json({ assigned, skipped })
})

export default r
export { persistMeeting, attendeesFor, createTaskFromSuggestion, canReviewMeeting }
