import { Router } from 'express'
import { authRequired } from '../auth.js'
import { answerQuery } from '../ai/assistant.js'
import { chatAnswer, hasLLM } from '../ai/assistantChat.js'
import { STATUSES, PRIORITIES, MEETING_TITLES } from '../ai/voiceTools.js'
import { agentCommand } from '../ai/voiceAgent.js'
import { dateRange, overview, workload, groupTasks } from '../ai/voiceAnalytics.js'
import { listMeetings, resolveMeeting, meetingSummary, askWhichMeeting } from '../ai/voiceMeetings.js'
import { getLeaderboard } from '../performance.js'
// The voice router works with ANY configured provider (OpenRouter/Claude/OpenAI),
// unlike assistantChat's hasLLM which only knows about Claude/OpenAI.
import { hasLLM as hasVoiceLLM } from '../ai/voiceTask.js'
import { resolveUser, resolveUserInfo, findSpokenAlias } from '../ai/extractor.js'
import { parseDueDate } from '../ai/dates.js'
import { recordUsage } from '../ai/usage.js'
import { templatesFor, blankLabels, blanksOf } from './dailyUpdates.js'
import { db } from '../db.js'
import { localDay } from '../clock.js'
import { id, now, audit, emailDomainAllowed, orgAllowedDomains, BELL_SKIPPED_TYPES } from '../util.js'

// Same shape routes/users.js and routes/invites.js accept, so voice can't create
// an address the forms would have rejected.
const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const r = Router()
r.use(authRequired)

// ---- Chat history (server-side so threads sync across devices) -------------
const rowToConvo = (row) => ({
  id: row.id,
  title: row.title,
  msgs: JSON.parse(row.messages || '[]'),
  updated: Date.parse(row.updated_at) || Date.now(),
})

// All of my conversations, newest first.
r.get('/conversations', (req, res) => {
  const rows = db.prepare('SELECT * FROM conversations WHERE user_id=? ORDER BY updated_at DESC').all(req.user.id)
  res.json({ conversations: rows.map(rowToConvo) })
})

// Create a new conversation thread.
r.post('/conversations', (req, res) => {
  const { title, msgs } = req.body || {}
  const ts = now()
  const cid = id('conv')
  db.prepare('INSERT INTO conversations (id, org_id, user_id, title, messages, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(cid, req.user.org_id, req.user.id, (title || 'New chat').slice(0, 80), JSON.stringify(msgs || []), ts, ts)
  res.json(rowToConvo(db.prepare('SELECT * FROM conversations WHERE id=?').get(cid)))
})

// Upsert a conversation's title + messages (ownership enforced).
r.put('/conversations/:id', (req, res) => {
  const { title, msgs } = req.body || {}
  const existing = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(req.params.id, req.user.id)
  const ts = now()
  if (!existing) {
    db.prepare('INSERT INTO conversations (id, org_id, user_id, title, messages, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(req.params.id, req.user.org_id, req.user.id, (title || 'New chat').slice(0, 80), JSON.stringify(msgs || []), ts, ts)
  } else {
    db.prepare('UPDATE conversations SET title=?, messages=?, updated_at=? WHERE id=? AND user_id=?')
      .run((title || existing.title).slice(0, 80), JSON.stringify(msgs || []), ts, req.params.id, req.user.id)
  }
  res.json(rowToConvo(db.prepare('SELECT * FROM conversations WHERE id=?').get(req.params.id)))
})

// Delete a conversation.
r.delete('/conversations/:id', (req, res) => {
  db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').run(req.params.id, req.user.id)
  res.json({ ok: true })
})

const hydrate = (tasks) => (tasks || []).map((t) => ({
  id: t.id, title: t.title, status: t.status, priority: t.priority,
  due_date: t.due_date, assignee_name: t.assignee_name, project_name: t.project_name,
}))

// Conversational AI assistant. Uses an LLM (Claude/OpenAI) when configured so the
// manager can ask anything about their tasks in plain language; falls back to the
// offline rule-based engine when no key is set or the provider call fails.
r.post('/query', async (req, res, next) => {
  const { query, history } = req.body || {}
  if (!query) return res.status(400).json({ error: 'query required' })

  if (hasLLM()) {
    try {
      const result = await chatAnswer(query, req.user, history,
        (u) => recordUsage({ orgId: req.user.org_id, userId: req.user.id, feature: 'assistant', ...u }))
      return res.json({ ...result, tasks: hydrate(result.tasks) })
    } catch (err) {
      console.warn('[assistant] LLM failed, falling back to rules:', err.message)
    }
  }

  const result = answerQuery(query, req.user)
  res.json({ ...result, tasks: hydrate(result.tasks), engine: 'rule-based' })
})

// ---------------------------------------------------------------------------
// VOICE COMMAND — the brain behind hands-free control ("hey btm").
// Takes a transcribed utterance + the running conversation, returns ONE resolved
// action the client executes against the existing task endpoints (so all the
// usual permission checks & notifications still apply), a navigation target, a
// spoken answer, or a clarifying question. Mutations come back as mode:"confirm"
// so the client can get a quick yes/no before committing.
// ---------------------------------------------------------------------------

// Tasks the caller may see/act on (employees: only their own top-level tasks).
function commandScopedTasks(user) {
  const rows = db.prepare(`
    SELECT t.id, t.title, t.status, t.priority, t.due_date, t.assignee_id,
           u.name AS assignee_name
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.org_id = ? AND t.parent_task_id IS NULL
    ORDER BY t.updated_at DESC
  `).all(user.org_id)
  return user.role === 'employee' ? rows.filter((t) => t.assignee_id === user.id) : rows
}

// Map a navigate target to a URL, or signal a denial.
// "Open the blocked tasks" used to dead-end in a clarify. The model answers that
// with target:"blocked" — naming the status directly — rather than the documented
// target:"status" + status:"Blocked", and both readings are perfectly reasonable
// English. The old switch had no case for it and fell through to null, so the
// assistant said "Opening the blocked tasks list for you" and then did nothing:
// the worst possible outcome, because it reports success.
//
// So normalise first. A target that names a STATUS or a PRIORITY is treated as
// one, whatever shape the model picked. Trailing "tasks" is stripped because
// "blocked tasks" is the natural phrasing.
function normalizeTarget(a) {
  const raw = String(a.target || '').trim().toLowerCase().replace(/[\s_-]+/g, ' ').replace(/ tasks?$/, '')
  if (!raw) return a
  const status = STATUSES.find((s) => s.toLowerCase() === raw)
  if (status) return { ...a, target: 'status', status }
  const priority = PRIORITIES.find((p) => p.toLowerCase() === raw)
  if (priority) return { ...a, target: 'priority', priority }
  // Also accept a bare status/priority passed alongside a target the switch
  // doesn't know, e.g. target:"tasks" + status:"Blocked".
  if (STATUSES.includes(a.status)) return { ...a, target: 'status' }
  if (PRIORITIES.includes(a.priority)) return { ...a, target: 'priority' }
  return { ...a, target: raw.replace(/ /g, '_') }
}

// Last resort when the model picks `navigate` but supplies NO arguments at all —
// which it does routinely for "can you open the blocked task?", returning
// {"tool":"navigate","args":{}}. There is nothing to normalise in that case, and
// the user's own words are right there, so read the destination out of them.
//
// This only ever runs after the model has already decided the user wants to open
// something, so matching a bare status word here cannot hijack ordinary speech.
function inferNavFromText(text) {
  const t = ` ${String(text || '').toLowerCase()} `
  const has = (w) => new RegExp(`\\b${w}\\b`).test(t)
  if (has('overdue') || has('late')) return { url: '/tasks?view=overdue' }
  for (const s of STATUSES) if (has(s.toLowerCase())) return { url: `/tasks?status=${encodeURIComponent(s)}` }
  for (const p of PRIORITIES) if (has(p.toLowerCase())) return { url: `/tasks?priority=${encodeURIComponent(p)}&view=active` }
  if (has('completed') || has('finished')) return { url: '/tasks?view=completed' }
  if (has('dashboard') || has('overview')) return { url: '/' }
  if (has('meeting') || has('meetings')) return { url: '/meetings' }
  if (has('chat') || has('chats') || has('message') || has('messages')) return { url: '/chats' }
  if (has('leaderboard') || has('score') || has('scores')) return { url: '/leaderboard' }
  if (has('task') || has('tasks')) return { url: '/tasks' }
  return null
}

function navUrl(rawArgs, user, transcript = '') {
  const a = normalizeTarget(rawArgs)
  if (!a.target) {
    const guess = inferNavFromText(transcript)
    if (guess) return guess
  }
  switch (a.target) {
    case 'overdue': return { url: '/tasks?view=overdue' }
    case 'completed': return { url: '/tasks?view=completed' }
    case 'active': return { url: '/tasks?view=active' }
    case 'all': case 'my_tasks': return { url: '/tasks' }
    case 'dashboard': return { url: '/' }
    case 'meetings': return user.role === 'employee' ? { deny: 'Only managers can open meetings.' } : { url: '/meetings' }
    case 'chats': return { url: '/chats' }
    case 'leaderboard': return { url: '/leaderboard' }
    case 'status': return a.status ? { url: `/tasks?status=${encodeURIComponent(a.status)}` } : null
    case 'priority': return a.priority ? { url: `/tasks?priority=${encodeURIComponent(a.priority)}&view=active` } : null
    case 'person': {
      if (user.role === 'employee') return { deny: 'You can only see your own tasks.' }
      const u = a.person ? resolveUser(user.org_id, a.person) : null
      // Say what this actually opens. The model narrates `say` freely and has been
      // caught calling this "X's profile" while it lands on X's task list — the
      // assistant contradicting itself is worse than it being terse.
      return u ? { url: `/tasks?assignee=${u.id}`, say: `Opening ${u.name}'s tasks.` } : null
    }
    // Someone's actual conversation, not the chat list. Chats reads `?with=` and
    // opens (or creates) the direct thread — the same path send_message drives.
    case 'person_chat': {
      const u = a.person ? resolveUser(user.org_id, a.person) : null
      if (a.person && !u) return null
      return u ? { url: `/chats?with=${u.id}`, say: `Opening your chat with ${u.name}.` } : { url: '/chats' }
    }
    default: return null
  }
}

// The default here is the LAST resort, and it must not blame the microphone: by
// the time we're in the dispatcher the transcript arrived fine, so "I didn't
// catch that" sends the user off to repeat themselves louder and get the exact
// same reply. Say what actually went wrong — we heard them, we couldn't work out
// which task or person they meant.
const clarify = (say) => ({
  mode: 'clarify',
  say: say || "I heard you, but I'm not sure which task or person you meant — could you name it?",
})
const answer = (say, extra = {}) => ({ mode: 'answer', say, ...extra })
const confirm = (say, action) => ({ mode: 'confirm', say, action })
// Undo-first: a reversible mutation runs IMMEDIATELY — no yes/no — and carries its
// inverse, computed HERE from the row's current state (the one moment the "before"
// values are still readable). The client keeps the inverse and replays it through
// the same action path when the user says "undo". One-way doors (delete, remove a
// person, message a human) never come through here; they keep `confirm`.
const perform = (say, action, undo = null) => ({ mode: 'do', say, action, undo })

// Express 4 does not catch rejections from async handlers, so an unexpected throw
// here would take the whole process down. Wrap the dispatcher and degrade to a
// spoken apology instead.
r.post('/command', (req, res) => {
  handleCommand(req, res).catch((err) => {
    console.error('[assistant] voice command crashed:', err)
    if (!res.headersSent) res.json(clarify('Something went wrong on my side — please try again.'))
  })
})

async function handleCommand(req, res) {
  const transcript = String(req.body?.transcript || '').trim()
  const history = Array.isArray(req.body?.history) ? req.body.history : []
  if (!transcript) return res.status(400).json({ error: 'transcript required' })
  if (!hasVoiceLLM()) return res.json(answer('Voice control needs an AI engine configured on the server.'))

  const user = req.user
  const tasks = commandScopedTasks(user)
  const users = db.prepare("SELECT id, name, role, aliases FROM users WHERE org_id=? AND role != 'admin'").all(user.org_id)

  // The agentic loop (voiceAgent.js): investigates via search tools, then returns
  // the same contract the legacy one-shot router produced — and falls back to that
  // router internally on any failure, so this call site never needs to know.
  let call
  try {
    call = await agentCommand(transcript, {
      user, tasks, users, history,
      onUsage: (u) => recordUsage({ orgId: user.org_id, userId: user.id, feature: 'voice_command', ...u }),
    })
  } catch (err) {
    console.warn('[assistant] voice route failed:', err.message)
    return res.json(clarify("I couldn't process that just now — please try again."))
  }

  // ---- learning log ---------------------------------------------------------
  // Every routed turn is recorded, and the response carries its turn_id so the
  // client can report what BECAME of it (executed / cancelled / undone / failed)
  // — that outcome is the label that turns this log into training data. Wrapping
  // res.json here catches every exit path of the dispatcher without threading a
  // logger through thirty return statements.
  const turnLearn = {}   // side-lessons (e.g. a fuzzy name match) — applied on outcome=executed
  const tStart = Date.now()
  const sendJson = res.json.bind(res)
  res.json = (payload) => {
    try {
      const tid = id('vtn')
      db.prepare(`INSERT INTO voice_turns
        (id, org_id, user_id, transcript, tool, args, mode, say, engine, lookups, rounds, latency_ms, learn, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(tid, user.org_id, user.id, transcript, call.tool || null,
          JSON.stringify(payload.action || call.args || null), payload.mode || null,
          (payload.say || '').slice(0, 500), call.meta?.engine || null,
          call.meta?.lookups ?? null, call.meta?.rounds ?? null,
          call.meta?.ms ?? Date.now() - tStart,
          Object.keys(turnLearn).length ? JSON.stringify(turnLearn) : null, now())
      return sendJson({ ...payload, turn_id: tid })
    } catch (err) {
      console.warn('[assistant] turn log failed:', err.message)
      return sendJson(payload)
    }
  }

  const a = call.args || {}

  // A lesson staged by the agent's search_people lookup (the model corrects a
  // misheard name itself and passes the CANONICAL form on, so the spoken form
  // only survives inside the lookup). Accept it only if the final action really
  // targets that person — a search that informed nothing teaches nothing.
  if (call.meta?.aliasLesson) {
    const named = a.assignee_name || a.recipient_name || a.person_name || a.person
    const resolved = named ? resolveUser(user.org_id, named) : null
    if (resolved && resolved.id === call.meta.aliasLesson.user_id) turnLearn.alias = call.meta.aliasLesson
  }

  const findTask = (id) => tasks.find((t) => t.id === id) || null
  const t0 = localDay()
  const dueFrom = (raw) => (raw ? parseDueDate(raw, t0).date || null : null)
  // A mutation the LLM aimed at a task we can't see -> ask instead of failing.
  const needTask = (verb) => {
    const t = findTask(a.task_id)
    return t || clarify(call.say || `Which task should I ${verb}?`)
  }

  // Resolve ONE mutation step (used by the multi-step planner) into a concrete,
  // client-executable action, or an error phrase describing what couldn't be done.
  const isMgr = user.role === 'manager' || user.role === 'admin'
  const resolveMutation = (tool, s) => {
    switch (tool) {
      case 'create_task': {
        if (!s.title) return { error: 'create a task with no title' }
        const m = s.assignee_name ? resolveUser(user.org_id, s.assignee_name) : null
        const priority = PRIORITIES.includes(s.priority) ? s.priority : 'Medium'
        return { action: { kind: 'create_task', summary: `create "${s.title}"${m ? ` for ${m.name}` : ''}`, body: { title: s.title, description: s.description || '', assignee_id: m?.id || null, priority, due_date: dueFrom(s.due_date_raw) } } }
      }
      case 'update_task': {
        const t = findTask(s.task_id); if (!t) return { error: "edit a task I couldn't find" }
        const body = {}, bits = []
        if (s.title) { body.title = String(s.title).trim(); bits.push(`rename to "${body.title}"`) }
        if (s.description) { body.description = String(s.description).trim(); bits.push('update the description') }
        if (PRIORITIES.includes(s.priority)) { body.priority = s.priority; bits.push(`set priority ${s.priority}`) }
        if (s.progress != null && !Number.isNaN(Number(s.progress))) { body.progress = Math.max(0, Math.min(100, Math.round(Number(s.progress)))); bits.push(`set progress ${body.progress}%`) }
        if (s.due_date_raw) { const d = dueFrom(s.due_date_raw); if (d) { body.due_date = d; body.due_date_raw = null; bits.push(`due ${d}`) } }
        if (!bits.length) return { error: `find nothing to change on "${t.title}"` }
        return { action: { kind: 'update_task', task_id: t.id, summary: `update "${t.title}" (${bits.join(', ')})`, body } }
      }
      case 'set_status': {
        const t = findTask(s.task_id); if (!t) return { error: "set the status of a task I couldn't find" }
        if (!STATUSES.includes(s.status)) return { error: `set an unknown status on "${t.title}"` }
        return { action: { kind: 'set_status', task_id: t.id, summary: `mark "${t.title}" ${s.status}`, body: { status: s.status } } }
      }
      case 'assign_task': {
        const t = findTask(s.task_id); if (!t) return { error: "reassign a task I couldn't find" }
        const m = s.assignee_name ? resolveUser(user.org_id, s.assignee_name) : null
        if (!m) return { error: `assign "${t.title}" to someone I couldn't find` }
        return { action: { kind: 'assign_task', task_id: t.id, summary: `assign "${t.title}" to ${m.name}`, body: { assignee_id: m.id } } }
      }
      case 'add_comment': {
        const t = findTask(s.task_id); if (!t) return { error: "comment on a task I couldn't find" }
        const body = String(s.body || '').trim(); if (!body) return { error: `add an empty comment to "${t.title}"` }
        return { action: { kind: 'add_comment', task_id: t.id, summary: `comment on "${t.title}"`, body: { body } } }
      }
      case 'delete_task': {
        if (!isMgr) return { error: 'delete a task (managers only)' }
        const t = findTask(s.task_id); if (!t) return { error: "delete a task I couldn't find" }
        return { action: { kind: 'delete_task', task_id: t.id, summary: `delete "${t.title}"`, body: {} } }
      }
      case 'send_message': {
        const m = s.recipient_name ? resolveUser(user.org_id, s.recipient_name) : null
        if (!m) return { error: "message someone I couldn't find" }
        if (m.id === user.id) return { error: 'message yourself' }
        const body = String(s.body || '').trim(); if (!body) return { error: `send an empty message to ${m.name}` }
        return { action: { kind: 'send_message', to_user_id: m.id, to_name: m.name, text: body, summary: `message ${m.name}` } }
      }
      default: return { error: `run an unsupported step (${tool})` }
    }
  }

  switch (call.tool) {
    case 'denied':
      return res.json(answer(call.say))

    // ---- multi-step plan: resolve every step, confirm the batch at once ------
    case 'plan': {
      const steps = Array.isArray(a.steps) ? a.steps.slice(0, 10) : []
      const actions = [], summaries = [], skipped = []
      for (const s of steps) {
        const r = resolveMutation(s?.tool, s?.args || {})
        if (r.error) skipped.push(r.error)
        else { actions.push(r.action); summaries.push(r.action.summary) }
      }
      if (!actions.length) return res.json(clarify(call.say || "I couldn't work out those steps — could you say it another way?"))
      const list = summaries.map((s, i) => `${i + 1}. ${s.charAt(0).toUpperCase() + s.slice(1)}`).join('\n')
      const spoken = call.say
        || (actions.length === 1 ? `I'll ${summaries[0]}. Confirm?` : `I'll do ${actions.length} things. Confirm?`)
      const note = skipped.length ? `\n(Skipping ${skipped.length}: couldn't ${skipped[0]}.)` : ''
      return res.json(confirm(spoken, { kind: 'plan', summary: list + note, steps: actions, count: actions.length }))
    }

    case 'create_task': {
      if (!a.title) return res.json(clarify('What should the task be?'))
      const info = a.assignee_name ? resolveUserInfo(user.org_id, a.assignee_name) : { user: null, tier: 0 }
      const match = info.user
      if (match && info.tier >= 4) turnLearn.alias = { user_id: match.id, spoken: a.assignee_name }
      else if (match) { const near = findSpokenAlias(transcript, match); if (near) turnLearn.alias = { user_id: match.id, spoken: near } }
      const priority = PRIORITIES.includes(a.priority) ? a.priority : 'Medium'
      const due = dueFrom(a.due_date_raw)
      const who = match ? ` for ${match.name}` : (a.assignee_name ? ` for ${a.assignee_name} (not found — leaving it unassigned)` : '')
      // No undo action: employees can't delete tasks, so a create can't be inverted
      // uniformly. It doesn't need one — the create runs through the real New Task
      // form on screen, field by field, which IS the review step.
      return res.json(perform(
        `Creating a ${priority.toLowerCase()} priority task "${a.title}"${who}${due ? ` due ${due}` : ''}.`,
        { kind: 'create_task', summary: `Create "${a.title}"`, body: { title: a.title, description: a.description || '', assignee_id: match?.id || null, priority, due_date: due } },
      ))
    }

    case 'update_task': {
      const t = needTask('edit'); if (t.mode) return res.json(t)
      const body = {}, bits = []
      if (a.title) { body.title = String(a.title).trim(); bits.push(`rename to "${body.title}"`) }
      if (a.description) { body.description = String(a.description).trim(); bits.push('update the description') }
      if (PRIORITIES.includes(a.priority)) { body.priority = a.priority; bits.push(`set priority ${a.priority}`) }
      if (a.progress != null && !Number.isNaN(Number(a.progress))) {
        body.progress = Math.max(0, Math.min(100, Math.round(Number(a.progress)))); bits.push(`set progress ${body.progress}%`)
      }
      if (a.due_date_raw) {
        const due = dueFrom(a.due_date_raw)
        if (!due) return res.json(clarify(`When should "${t.title}" be due?`))
        body.due_date = due; body.due_date_raw = null; bits.push(`due ${due}`)
      }
      if (!bits.length) return res.json(clarify(`What should I change about "${t.title}"?`))
      // The "before" values of exactly the fields being changed become the undo.
      // The scoped snapshot row doesn't carry description/progress, so read the
      // full row while it still holds the old values.
      const full = db.prepare('SELECT title, description, priority, progress, due_date, due_date_raw FROM tasks WHERE id=? AND org_id=?').get(t.id, user.org_id)
      const undoBody = {}
      for (const f of ['title', 'description', 'priority', 'progress']) if (f in body) undoBody[f] = full[f]
      if ('due_date' in body) { undoBody.due_date = full.due_date; undoBody.due_date_raw = full.due_date_raw }
      return res.json(perform(`Updating "${t.title}": ${bits.join(', ')}.`,
        { kind: 'update_task', task_id: t.id, summary: `"${t.title}" — ${bits.join(', ')}`, body },
        { kind: 'update_task', task_id: t.id, summary: `put "${t.title}" back as it was`, body: undoBody }))
    }

    case 'set_status': {
      const t = needTask('update'); if (t.mode) return res.json(t)
      if (!STATUSES.includes(a.status)) return res.json(clarify(`What status should "${t.title}" be?`))
      return res.json(perform(`Marking "${t.title}" as ${a.status}.`,
        { kind: 'set_status', task_id: t.id, summary: `"${t.title}" → ${a.status}`, body: { status: a.status } },
        t.status !== a.status
          ? { kind: 'set_status', task_id: t.id, summary: `put "${t.title}" back to ${t.status}`, body: { status: t.status } }
          : null))
    }

    case 'assign_task': {
      const t = needTask('reassign'); if (t.mode) return res.json(t)
      const info = a.assignee_name ? resolveUserInfo(user.org_id, a.assignee_name) : { user: null, tier: 0 }
      const match = info.user
      if (!match) return res.json(clarify(a.assignee_name ? `I couldn't find "${a.assignee_name}" — who should I assign it to?` : 'Who should I assign it to?'))
      // Tier 4-5 = the name only matched through fuzz ("Rabi Kumar" → Ravi Kumar).
      // Stage it as an alias lesson; it's saved only if the assignment stands.
      // Tier ≤3 can still hide a mishear: the agent normalizes names silently from
      // its team list, so also check what the TRANSCRIPT actually called them.
      if (info.tier >= 4) turnLearn.alias = { user_id: match.id, spoken: a.assignee_name }
      else { const near = findSpokenAlias(transcript, match); if (near) turnLearn.alias = { user_id: match.id, spoken: near } }
      return res.json(perform(`Assigning "${t.title}" to ${match.name}.`,
        { kind: 'assign_task', task_id: t.id, summary: `"${t.title}" → ${match.name}`, body: { assignee_id: match.id } },
        match.id !== t.assignee_id
          // Undo summaries all start with "put …" so the client can speak them
          // after "I've" and get a sentence ("Okay — I've put X back with Ravi.").
          ? { kind: 'assign_task', task_id: t.id, summary: `put "${t.title}" back ${t.assignee_name ? `with ${t.assignee_name}` : 'to Unassigned'}`, body: { assignee_id: t.assignee_id || null } }
          : null))
    }

    case 'add_comment': {
      const t = needTask('comment on'); if (t.mode) return res.json(t)
      const body = String(a.body || '').trim()
      if (!body) return res.json(clarify(`What should the comment on "${t.title}" say?`))
      return res.json(perform(`Adding your comment to "${t.title}": "${body}".`,
        { kind: 'add_comment', task_id: t.id, summary: `Comment on "${t.title}"`, body: { body } },
        // The comment's id doesn't exist yet, so the inverse is "delete my most
        // recent comment on this task" — which is exactly what was just posted.
        { kind: 'delete_own_comment', task_id: t.id, summary: `removed your comment from "${t.title}"` }))
    }

    case 'delete_task': {
      const t = needTask('delete'); if (t.mode) return res.json(t)
      return res.json(confirm(`Delete "${t.title}" permanently. Are you sure?`,
        { kind: 'delete_task', task_id: t.id, summary: `Delete "${t.title}"`, body: {} }))
    }

    // ---- chats: send a real direct message in the Chats section -------------
    case 'send_message': {
      const info = a.recipient_name ? resolveUserInfo(user.org_id, a.recipient_name) : { user: null, tier: 0 }
      const match = info.user
      if (!match) return res.json(clarify(a.recipient_name ? `I couldn't find "${a.recipient_name}" — who should I message?` : 'Who should I message?'))
      if (info.tier >= 4) turnLearn.alias = { user_id: match.id, spoken: a.recipient_name }
      else { const near = findSpokenAlias(transcript, match); if (near) turnLearn.alias = { user_id: match.id, spoken: near } }
      if (match.id === user.id) return res.json(clarify("That's you — who did you want to message?"))
      const body = String(a.body || '').trim()
      if (!body) return res.json(clarify(`What should I tell ${match.name}?`))
      return res.json(confirm(`Message ${match.name} in chat: "${body}". Send it?`,
        { kind: 'send_message', to_user_id: match.id, to_name: match.name, text: body, summary: `Messaged ${match.name}` }))
    }

    // ---- daily metrics card ----------------------------------------------------
    // Posts to a team chat, so it stops for a yes like send_message. The card
    // is the person's own message with blanks; their words are matched to the
    // words before each blank ("junk leads 0" fills "Junk leads = ___").
    case 'post_daily_update': {
      const cards = templatesFor(user.id).filter((c) => c.body)
      if (!cards.length) return res.json(answer("You haven't set up a daily metrics card yet. Open your team's chat, tap the clip, then Daily metrics."))
      const plain = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
      let card = cards[0]
      if (a.chat_name) {
        const q = plain(a.chat_name)
        card = cards.find((c) => { const n = plain(c.conv_name); return n && (n.includes(q) || q.includes(n)) }) || null
        if (!card) return res.json(clarify(`I couldn't find your daily metrics in "${a.chat_name}". You post it in ${cards.map((c) => c.conv_name || 'a direct chat').join(', ')}.`))
      }
      const labels = blankLabels(card.body)
      const stem = (w) => w.replace(/(es|s)$/, '')
      const wordsOf = (s) => plain(s).split(' ').filter((w) => w.length > 1).map(stem)
      const matchBlank = (spoken, taken) => {
        const q = new Set(wordsOf(spoken))
        let best = -1, score = 0
        labels.forEach((l, i) => {
          if (taken.has(i)) return
          const w = wordsOf(l)
          const hit = plain(l) === plain(spoken) ? 100 : w.filter((x) => q.has(x)).length / Math.max(1, w.length)
          if (hit > score) { best = i; score = hit }
        })
        return best
      }
      const values = new Array(blanksOf(card.body)).fill('')
      const taken = new Set()
      const missed = []
      for (const v of Array.isArray(a.values) ? a.values : []) {
        const i = matchBlank(v?.metric, taken)
        const raw = /^(zero|none|nil|no|nothing)$/i.test(String(v?.value ?? '').trim()) ? '0' : String(v?.value ?? '').trim()
        if (i < 0 || !raw) { if (v?.metric) missed.push(String(v.metric)); continue }
        values[i] = raw.slice(0, 30)
        taken.add(i)
      }
      const note = String(a.note || '').trim()
      if (!taken.size) return res.json(clarify(`Which numbers? Your ${card.title} has ${labels.join(', ')}.`))
      const said = [...taken].sort((x, y) => x - y).map((i) => `${labels[i]} ${values[i]}`).join(', ')
      const where = card.conv_type === 'group' ? ` in ${card.conv_name || 'your group'}` : ''
      const skip = missed.length ? ` I couldn't match ${missed.join(', ')} to your card.` : ''
      return res.json(confirm(`Post your ${card.title}${where}: ${said}${note ? `, with the note "${note}"` : ''}.${skip} Post it?`,
        { kind: 'post_update', conversation_id: card.conversation_id, values, note, summary: `posted your ${card.title}` }))
    }

    // ---- team / people (managers) ------------------------------------------
    // Invite rather than create outright: the invitee sets their own name and
    // password on the emailed link, so nothing secret has to travel by voice.
    // Speaking a password would put it in the transcript on screen AND read it
    // back through TTS, which is not a trade worth making for convenience.
    case 'add_user': {
      const email = String(a.email || '').trim().toLowerCase()
      if (!email) return res.json(clarify("What's their email address?"))
      if (!VALID_EMAIL.test(email)) {
        return res.json(clarify(`I heard "${email}", which isn't a valid email address — could you spell it out?`))
      }
      const role = ['employee', 'manager', 'admin'].includes(a.role) ? a.role : 'employee'
      // Mirrors the server's own rule in routes/users.js so the refusal arrives
      // before the password prompt, not after it.
      if (user.role === 'manager' && role === 'admin') {
        return res.json(answer('Only an admin can invite another admin.'))
      }
      if (!emailDomainAllowed(user.org_id, email)) {
        return res.json(answer(`${email} isn't on this organization's allowed domains: ${orgAllowedDomains(user.org_id).join(', ')}.`))
      }
      if (db.prepare('SELECT id FROM users WHERE org_id=? AND lower(email)=?').get(user.org_id, email)) {
        return res.json(answer(`${email} is already on the team.`))
      }
      // "a manager" but "an employee" / "an admin" — the article follows the word.
      return res.json(confirm(`Invite ${email} as ${role === 'manager' ? 'a manager' : `an ${role}`}. Enter your password to confirm.`,
        { kind: 'invite_user', email, role, needsPassword: true, summary: `Invited ${email} as ${role}` }))
    }

    case 'remove_user': {
      const match = a.person_name ? resolveUser(user.org_id, a.person_name) : null
      if (!match) return res.json(clarify(a.person_name ? `I couldn't find "${a.person_name}" on the team.` : 'Who should I remove?'))
      if (match.id === user.id) return res.json(answer("You can't remove your own account."))
      // needsPassword tells the client to require the manager's password before it runs.
      return res.json(confirm(`Remove ${match.name}'s account permanently. Enter your password to confirm.`,
        { kind: 'remove_user', to_user_id: match.id, to_name: match.name, needsPassword: true, summary: `Removed ${match.name}` }))
    }

    case 'navigate': {
      const nav = navUrl(a, user, transcript)
      if (nav?.deny) return res.json(answer(nav.deny))
      // Never echo the model's own sentence here. It was written on the assumption
      // the navigation would happen ("Opening the blocked tasks list for you"), so
      // reusing it on the failure path makes the assistant announce success and
      // then do nothing — which reads as the app being broken rather than as a
      // question. Ask a real question instead.
      if (!nav?.url) return res.json(clarify("I'm not sure which screen you meant — could you say it another way?"))
      // nav.say wins where we resolved a specific person: the model's sentence is
      // a guess written before the destination was known, and a wrong one ("...'s
      // profile") teaches the user the app is broken.
      return res.json({ mode: 'navigate', say: nav.say || call.say || 'Opening that now.', navigate: { url: nav.url } })
    }

    // ---- read tools: the numbers come from SQL, not the model ---------------
    // Each returns a typed `data` block so the client can render the figures as a
    // card instead of only speaking them.
    case 'get_overview': {
      const range = dateRange(a.period, a.from, a.to)
      const { say, stats } = overview(user, range)
      return res.json(answer(say, { data: { type: 'overview', label: range.label, range, stats } }))
    }

    case 'get_workload': {
      const who = a.assignee_name ? resolveUser(user.org_id, a.assignee_name) : null
      if (a.assignee_name && !who) return res.json(clarify(`I couldn't find "${a.assignee_name}".`))
      const { say, rows } = workload(user, who?.id || null)
      return res.json(answer(say, { data: { type: 'workload', rows } }))
    }

    case 'group_tasks': {
      const who = a.person ? resolveUser(user.org_id, a.person) : null
      const opts = {
        group_by: ['assignee', 'status', 'priority'].includes(a.group_by) ? a.group_by : 'assignee',
        overdue: a.overdue === true || a.overdue === 'true',
        status: STATUSES.includes(a.status) ? a.status : null,
        priority: PRIORITIES.includes(a.priority) ? a.priority : null,
        assignee_id: who?.id || null,
      }
      const { say, rows, total } = groupTasks(user, opts)
      // Also open the matching list so they can see what was counted.
      const url = opts.overdue ? '/tasks?view=overdue'
        : opts.status ? `/tasks?status=${encodeURIComponent(opts.status)}`
        : opts.priority ? `/tasks?priority=${encodeURIComponent(opts.priority)}`
        : who ? `/tasks?assignee=${who.id}` : '/tasks'
      const what = opts.overdue ? 'Overdue tasks' : opts.status ? `${opts.status} tasks`
        : opts.priority ? `${opts.priority} priority tasks` : 'Tasks'
      return res.json(answer(say, { navigate: { url }, data: { type: 'group', title: `${what} by ${opts.group_by}`, rows, total } }))
    }

    // ---- leaderboard & notifications -----------------------------------------
    case 'get_leaderboard': {
      // Same period resolution as routes/scores.js: an org-wide custom window (when
      // a manager set one) is the default everyone lands on, else calendar month.
      const o = db.prepare('SELECT leaderboard_from AS f, leaderboard_to AS t FROM organizations WHERE id=?').get(user.org_id)
      const range = o?.f && o?.t ? { from: o.f, to: o.t } : null
      const period = ['day', 'month', 'all'].includes(a.period) ? a.period : (range ? 'custom' : 'month')
      const board = getLeaderboard(user.org_id, { period, from: range?.from, to: range?.to })
      const label = { day: 'today', month: 'this month', all: 'all time', custom: 'in the current window' }[period]

      if (a.person_name) {
        const who = resolveUser(user.org_id, a.person_name)
        if (!who) return res.json(clarify(`I couldn't find "${a.person_name}" on the team.`))
        const row = board.ranked.find((r) => r.id === who.id)
        const self = who.id === user.id
        const name = self ? 'You' : who.name
        const say = !row || !row.score
          ? `${name} ${self ? "haven't" : "hasn't"} scored any points ${label} yet.`
          : `${name} ${self ? 'are' : 'is'} ranked #${row.rank} ${label} with ${row.score} points.`
        return res.json(answer(say, { navigate: { url: '/leaderboard' } }))
      }

      const top = board.ranked.filter((r) => r.score > 0).slice(0, 3)
      const say = top.length
        ? `${label[0].toUpperCase()}${label.slice(1)}: ${top.map((r, i) => `#${i + 1} ${r.name} with ${r.score} points`).join(', ')}.`
        : `Nobody has scored any points ${label} yet.`
      return res.json(answer(say, {
        navigate: { url: '/leaderboard' },
        data: { type: 'group', title: `Leaderboard (${label})`, rows: top.map((r) => ({ name: r.name, c: r.score })), total: board.total_points },
      }))
    }

    case 'get_unread_messages': {
      // Same unread definition as the chat list itself: messages from others,
      // newer than my last-read mark, not deleted, not hidden for me.
      const rows = db.prepare(`
        SELECT u.name, COUNT(*) c FROM chat_messages msg
        JOIN chat_participants me ON me.conversation_id = msg.conversation_id AND me.user_id = ?
        JOIN users u ON u.id = msg.sender_id
        WHERE msg.sender_id != ? AND msg.deleted_for_all = 0
          AND msg.created_at > COALESCE(me.last_read_at, '')
          AND msg.id NOT IN (SELECT message_id FROM chat_message_hidden WHERE user_id = ?)
        GROUP BY msg.sender_id ORDER BY c DESC
      `).all(user.id, user.id, user.id)
      const total = rows.reduce((s, r) => s + r.c, 0)
      if (!total) return res.json(answer('No new messages — your chats are all caught up.'))
      const from = rows.slice(0, 3).map((r) => `${r.c} from ${r.name}`).join(', ')
      return res.json(answer(
        `You have ${total} unread message${total === 1 ? '' : 's'} — ${from}${rows.length > 3 ? ', and more' : ''}.`,
        { navigate: { url: '/chats' } },
      ))
    }

    case 'approve_suggestions': {
      const m = resolveMeeting(user, { title: a.title, date: a.date, latest: a.latest === true || a.latest === 'true' })
      if (m.none) return res.json(clarify("I couldn't find that meeting."))
      if (m.candidates) return res.json(clarify(askWhichMeeting(m.candidates)))
      const counts = db.prepare(`
        SELECT COUNT(*) AS pending,
               SUM(CASE WHEN suggested_assignee_id IS NOT NULL THEN 1 ELSE 0 END) AS owned
        FROM suggested_tasks WHERE meeting_id = ? AND status = 'pending'
      `).get(m.meeting.id)
      if (!counts.pending) return res.json(answer(`"${m.meeting.title}" has no pending suggestions — they've all been handled.`, { navigate: { url: `/meetings/${m.meeting.id}` } }))
      if (!counts.owned) return res.json(answer(`"${m.meeting.title}" has ${counts.pending} pending suggestion${counts.pending === 1 ? '' : 's'}, but none has an owner yet — open the meeting to pick who does what.`, { navigate: { url: `/meetings/${m.meeting.id}` } }))
      const skipped = counts.pending - counts.owned
      // Confirm tier, not undo-first: this creates real tasks and notifies every
      // assignee — outward-facing, so it stops for a yes like send_message does.
      return res.json(confirm(
        `Assign ${counts.owned} suggested task${counts.owned === 1 ? '' : 's'} from "${m.meeting.title}" to their owners${skipped ? ` (${skipped} without an owner will stay pending)` : ''}. Go ahead?`,
        { kind: 'approve_suggestions', meeting_id: m.meeting.id, summary: `Assigned ${counts.owned} suggested task${counts.owned === 1 ? '' : 's'} from "${m.meeting.title}"` },
      ))
    }

    case 'get_notifications': {
      // The bell's own list: tasks and mentions, not other chat (see BELL_SKIPPED_TYPES).
      const rows = db.prepare(`SELECT * FROM notifications WHERE user_id=? AND type NOT IN (${BELL_SKIPPED_TYPES.map(() => '?').join(',')})
        ORDER BY created_at DESC LIMIT 50`).all(user.id, ...BELL_SKIPPED_TYPES)
      const unread = rows.filter((n) => !n.read)
      if (!unread.length) return res.json(answer("You're all caught up — no unread notifications."))
      const preview = unread.slice(0, 3).map((n) => n.message).filter(Boolean).join('. ')
      return res.json(answer(
        `You have ${unread.length} unread notification${unread.length === 1 ? '' : 's'}. ${preview ? `Most recent: ${preview}.` : ''}`.trim(),
      ))
    }

    case 'mark_notifications_read':
      return res.json(perform('Marking all your notifications as read.',
        { kind: 'read_notifications', summary: 'Mark all notifications read' }))

    // ---- meetings -----------------------------------------------------------
    case 'start_meeting': {
      // Never start an untitled recording. Starting is the one meeting action that
      // can't be corrected after the fact — the room is already talking, and a
      // meeting saved with no name is near-impossible to find later. The prompt
      // asks the model to gather the title first; this is the belt-and-braces so a
      // model that skips the question still can't skip the title.
      const title = typeof a.title === 'string' ? a.title.trim().slice(0, 120) : ''
      if (!title) {
        return res.json(clarify(
          `What kind of meeting is this — ${MEETING_TITLES.slice(0, -1).join(', ')} or ${MEETING_TITLES.at(-1)}? Or tell me your own title.`,
        ))
      }
      // The Meetings page opens its live recorder when it sees ?live=1. `meeting`
      // tells the client to go further and actually press Record — opening the
      // recorder alone left the assistant claiming to have started a meeting while
      // nothing was capturing, which is worse than not offering the command.
      return res.json({
        mode: 'navigate',
        say: call.say || `Starting the ${title} recording. Everyone's included — change that on screen if you need to.`,
        navigate: { url: '/meetings?live=1' },
        meeting: { action: 'start', title },
      })
    }

    // Controlling a recording that is already on screen. Deliberately NO url: the
    // recorder lives inside the Meetings page, so navigating would unmount it and
    // destroy the very session being controlled.
    case 'control_meeting': {
      const action = ['pause', 'resume', 'stop', 'finish'].includes(a.action) ? a.action : null
      if (!action) return res.json(clarify('Do you want me to pause, resume, stop, or finish and analyse the recording?'))
      return res.json({ mode: 'navigate', say: call.say || '', meeting: { action } })
    }

    case 'list_meetings':
      return res.json(answer(listMeetings(user).say, { navigate: { url: '/meetings' } }))

    case 'open_meeting': {
      const m = resolveMeeting(user, { title: a.title, date: a.date, latest: a.latest === true || a.latest === 'true' })
      if (m.none) return res.json(clarify("I couldn't find that meeting."))
      if (m.candidates) return res.json(clarify(askWhichMeeting(m.candidates)))
      return res.json({ mode: 'navigate', say: `Opening "${m.meeting.title}" from ${m.meeting.meeting_date}.`, navigate: { url: `/meetings/${m.meeting.id}` } })
    }

    case 'summarize_meeting': {
      const m = resolveMeeting(user, { title: a.title, date: a.date, latest: a.latest === true || a.latest === 'true' })
      if (m.none) return res.json(clarify("I couldn't find that meeting."))
      if (m.candidates) return res.json(clarify(askWhichMeeting(m.candidates)))
      return res.json(answer(meetingSummary(m.meeting).say, { navigate: { url: `/meetings/${m.meeting.id}` } }))
    }

    case 'ask': {
      const question = String(a.question || transcript).trim()
      try {
        const result = await chatAnswer(question, user, history.map((m) => ({ role: m.role, text: m.text })),
          (u) => recordUsage({ orgId: user.org_id, userId: user.id, feature: 'voice_ask', ...u }))
        return res.json(answer(result.answer, { tasks: hydrate(result.tasks) }))
      } catch (err) {
        console.warn('[assistant] voice ask (RAG) failed, falling back to rules:', err.message)
        const result = answerQuery(question, user)
        return res.json(answer(result.answer, { tasks: hydrate(result.tasks) }))
      }
    }

    case 'clarify':
    default:
      return res.json(clarify(a.question || call.say))
  }
}

// ---------------------------------------------------------------------------
// LEARNING LOOP — outcome reports and the lessons they unlock.
// ---------------------------------------------------------------------------

// Apply a turn's staged lesson. Today that is alias learning: a spoken name that
// only matched through fuzz gets saved as a proper alias, so the same mishear
// resolves exactly (tier 2) forever after — the agent stops re-guessing what it
// has already been proven right about once.
function applyTurnLessons(turn) {
  let lesson
  try { lesson = JSON.parse(turn.learn || 'null') } catch { return }
  if (!lesson?.alias) return
  const alias = String(lesson.alias.spoken || '').toLowerCase().trim()
  const target = db.prepare('SELECT * FROM users WHERE id=? AND org_id=?').get(lesson.alias.user_id, turn.org_id)
  if (!target || alias.length < 3) return
  const norm = (s) => String(s || '').toLowerCase().trim()
  // Never learn an alias that collides with someone's actual identity — "kumar"
  // must not silently become a shortcut to one Kumar when the org has two.
  for (const u of db.prepare('SELECT id, name, aliases FROM users WHERE org_id=?').all(turn.org_id)) {
    if (norm(u.name) === alias) return
    if (u.id !== target.id && norm(u.name).split(/\s+/)[0] === alias) return
    if ((u.aliases || '').split(',').map(norm).includes(alias)) return   // already known
  }
  const list = (target.aliases || '').split(',').map(norm).filter(Boolean)
  if (list.length >= 12) return   // cap — an unbounded alias list degrades matching
  list.push(alias)
  db.prepare('UPDATE users SET aliases=? WHERE id=?').run(list.join(','), target.id)
  audit(turn.org_id, turn.user_id, 'voice.alias_learned', 'user', target.id, `"${alias}" → ${target.name}`)
  console.log(`[voice-learn] alias "${alias}" → ${target.name}`)
}

// The client reports what became of a turn: executed (it ran), cancelled (user
// declined the confirmation), undone (user reversed it), failed (a step broke).
// This label is what turns voice_turns into a training set — and it gates the
// lessons: a guess is only learned once the outcome proves it right.
const OUTCOMES = new Set(['executed', 'cancelled', 'undone', 'failed'])
r.post('/turns/:id/outcome', (req, res) => {
  const outcome = String(req.body?.outcome || '')
  if (!OUTCOMES.has(outcome)) return res.status(400).json({ error: 'invalid outcome' })
  const turn = db.prepare('SELECT * FROM voice_turns WHERE id=? AND user_id=?').get(req.params.id, req.user.id)
  if (!turn) return res.status(404).json({ error: 'Not found' })
  db.prepare('UPDATE voice_turns SET outcome=?, outcome_at=? WHERE id=?').run(outcome, now(), turn.id)
  // First report only — an "undone" arriving after "executed" updates the label
  // but must not re-apply (or un-apply) a lesson already acted on.
  if (outcome === 'executed' && turn.learn && !turn.outcome) applyTurnLessons(turn)
  res.json({ ok: true })
})

// Suggested prompts for the UI
r.get('/suggestions', (req, res) => {
  const base = [
    'What needs my attention today?',
    'Show overdue tasks',
    'Summarize my high priority work',
    'What came out of the last meeting?',
  ]
  if (req.user.role !== 'employee') {
    base.push('How is the team\'s workload looking?', 'Give me a weekly progress report', 'Who is overloaded right now?')
  }
  res.json({ suggestions: base })
})

export default r
