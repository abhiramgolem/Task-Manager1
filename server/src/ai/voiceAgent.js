// The voice assistant's AGENTIC brain — Phase 2 of the voice-agent roadmap.
//
// The legacy router (voiceTools.routeCommand) is one shot: paste a 40-task
// snapshot into the prompt, hope the right task is in it, pick one tool. That
// shape caps out fast — an org with 500 tasks is mostly invisible, "his task"
// can't be resolved by looking anything up, and every request pays for the same
// snapshot whether it needs it or not.
//
// This module runs a LOOP instead: the model may call INVESTIGATION tools
// (search_tasks / search_people / get_task — plain RBAC-scoped SQL, executed
// here) as many rounds as it needs, then terminates with the SAME JSON contract
// the legacy router produces. The dispatcher in routes/assistant.js and the
// whole client are untouched — validateCall() is the shared gate for both brains.
//
// Model cascade: the loop starts on a FAST model (voice latency is the product),
// which can hand off via the `escalate` tool when a request is genuinely
// multi-step or ambiguous — so simple commands stay cheap and quick, and hard
// ones get real reasoning. One escalation per turn, max.
//
// Every failure path falls back to the legacy router, which itself falls back to
// Claude/OpenAI — the no-keys-at-all deployment still works.
import { db } from '../db.js'
import { localDay } from '../clock.js'
import { routeCommand, validateCall, toolsFor, snapshot, historyBlock, STATUSES, PRIORITIES } from './voiceTools.js'
import { resolveUser, resolveUserInfo } from './extractor.js'
import { parseJson } from './voiceTask.js'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 25000

// Fast model default follows the generic OPENROUTER_MODEL (tuned for latency);
// the smart tier is where multi-step/ambiguous requests land after `escalate`.
const fastModel = () => process.env.VOICE_MODEL_FAST || process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash'
const smartModel = () => process.env.VOICE_MODEL_SMART || 'google/gemini-2.5-pro'

// The prompt snapshot shrinks from 40 tasks to a hot list — search covers the
// rest. Big enough that "mark it done" right after creating a task needs no
// lookup, small enough that every turn stops paying for the whole backlog.
const HOT_TASKS = 15

const MAX_ROUNDS = 5           // LLM round-trips per turn (investigations + final)
const MAX_LOOKUPS = 6          // total investigation calls per turn

// ---- investigation tools (OpenAI function-calling schema) -------------------

const INVESTIGATE = [
  {
    type: 'function',
    function: {
      name: 'search_tasks',
      description: 'Search tasks by words from their title/description, and/or filter by status, priority, assignee, or overdue. Use whenever the task the user means is not in the TASKS snapshot — never guess a task_id. Returns up to `limit` best matches with their exact ids.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'words from the task title/description (any language as spoken)' },
          status: { type: 'string', enum: STATUSES },
          priority: { type: 'string', enum: PRIORITIES },
          assignee_name: { type: 'string', description: 'only tasks owned by this person' },
          overdue: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: 15 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_people',
      description: 'Find teammates by (partial or misheard) name. Use when a spoken name matches nobody in the TEAM list exactly — speech-to-text mangles names, so search before giving up or guessing.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'the name as heard' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_meetings',
      description: 'List recent meetings — optionally filtered by words from the title — with their dates and how many AI-suggested tasks are still pending on each. MANAGERS/ADMINS ONLY. Use before approve_suggestions / open_meeting / summarize_meeting whenever you are not sure which meeting the user means; copy the exact title from the results into your final call.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'words from the meeting title, if any were spoken' },
          limit: { type: 'integer', minimum: 1, maximum: 15 },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_task',
      description: 'Fetch one task\'s full details (description, dates, progress) by its exact id. Use when the user asks ABOUT a task ("what is the logo task about", "when is it due") and the snapshot row is not enough.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
    },
  },
]

const ESCALATE = {
  type: 'function',
  function: {
    name: 'escalate',
    description: 'Hand this request to a stronger reasoning model. Call this when the request needs a multi-step plan across several tasks/people, is deeply ambiguous, or you are not confident your answer is right. Do NOT call it for simple single commands.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
    },
  },
}

// ---- investigation implementations (RBAC-scoped SQL) -------------------------

const words = (s) => String(s || '').toLowerCase().match(/[a-z0-9ऀ-ॿఀ-౿]+/gi)?.filter((w) => w.length > 1) || []

function searchTasks(user, args = {}) {
  // Employees only ever see their own tasks — same scope as the snapshot and the
  // dispatcher. The model literally cannot retrieve what the role may not see.
  const rows = db.prepare(`
    SELECT t.id, t.title, t.status, t.priority, t.due_date, t.progress, t.assignee_id,
           u.name AS assignee_name
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.org_id = ? AND t.parent_task_id IS NULL ${user.role === 'employee' ? 'AND t.assignee_id = ?' : ''}
    ORDER BY t.updated_at DESC
  `).all(...(user.role === 'employee' ? [user.org_id, user.id] : [user.org_id]))

  const t0 = localDay()
  const who = args.assignee_name ? resolveUser(user.org_id, args.assignee_name) : null
  let list = rows
  if (args.status && STATUSES.includes(args.status)) list = list.filter((t) => t.status === args.status)
  if (args.priority && PRIORITIES.includes(args.priority)) list = list.filter((t) => t.priority === args.priority)
  if (who) list = list.filter((t) => t.assignee_id === who.id)
  if (args.overdue === true) list = list.filter((t) => t.due_date && t.due_date < t0 && t.status !== 'Done')

  const q = words(args.query)
  if (q.length) {
    const scored = list.map((t) => {
      const hay = words(t.title)
      const exact = q.filter((w) => hay.includes(w)).length
      // Prefix credit so "deploy" still finds "deployment" — spoken queries are
      // rarely the exact word the title used.
      const prefix = q.filter((w) => hay.some((h) => h.startsWith(w) || w.startsWith(h))).length
      return { t, score: exact * 3 + prefix }
    }).filter((s) => s.score > 0)
    scored.sort((a, b) => b.score - a.score)
    list = scored.map((s) => s.t)
  }

  const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 15)
  return {
    matches: list.slice(0, limit).map((t) => ({
      id: t.id, title: t.title, owner: t.assignee_name || 'Unassigned',
      status: t.status, priority: t.priority, due_date: t.due_date || null,
    })),
    total_matching: list.length,
  }
}

function searchPeople(user, args = {}) {
  // Names and roles only — enough to address a task or a message, nothing more.
  //
  // `_lesson` is NOT for the model (the loop strips it before relaying results):
  // it records that a spoken name only resolved through fuzz, so the route can
  // stage it as an alias to learn. This is the only place the SPOKEN form still
  // exists — by the time the model emits its final call it has already copied the
  // canonical name from these results, and the mishear is gone from the args.
  const spoken = String(args.query || '').trim()
  const info = resolveUserInfo(user.org_id, spoken)
  if (info.user) {
    return {
      matches: [{ name: info.user.name, role: info.user.role }],
      _lesson: info.tier >= 4 ? { user_id: info.user.id, spoken } : null,
    }
  }
  const q = words(spoken)
  const rows = db.prepare("SELECT id, name, role, aliases FROM users WHERE org_id = ? AND role != 'admin'").all(user.org_id)
  const hits = rows.filter((u) => {
    const hay = words(u.name + ' ' + (u.aliases || ''))
    return q.some((w) => hay.some((h) => h.startsWith(w) || w.startsWith(h)))
  })
  return {
    matches: hits.slice(0, 6).map((u) => ({ name: u.name, role: u.role })),
    // A UNIQUE fuzzy hit is a confident correction; several hits is a guess, not a lesson.
    _lesson: hits.length === 1 ? { user_id: hits[0].id, spoken } : null,
  }
}

function searchMeetings(user, args = {}) {
  // Meetings are manager/admin territory — same wall the meeting routes enforce.
  if (user.role !== 'manager' && user.role !== 'admin') return { error: 'meetings are not visible to this role' }
  let rows = db.prepare(`
    SELECT m.id, m.title, m.meeting_date,
           (SELECT COUNT(*) FROM suggested_tasks s WHERE s.meeting_id = m.id AND s.status = 'pending') AS pending_suggestions
    FROM meetings m WHERE m.org_id = ?
    ORDER BY m.meeting_date DESC, m.created_at DESC LIMIT 25
  `).all(user.org_id)
  const q = words(args.query)
  if (q.length) {
    rows = rows.filter((m) => {
      const hay = words(m.title)
      return q.some((w) => hay.some((h) => h.startsWith(w) || w.startsWith(h)))
    })
  }
  const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 15)
  return { matches: rows.slice(0, limit).map((m) => ({ title: m.title, date: m.meeting_date, pending_suggestions: m.pending_suggestions })) }
}

function getTask(user, args = {}) {
  const t = db.prepare(`
    SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date, t.progress,
           t.created_at, t.updated_at, t.assignee_id, u.name AS assignee_name
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.id = ? AND t.org_id = ?
  `).get(String(args.task_id || ''), user.org_id)
  if (!t || (user.role === 'employee' && t.assignee_id !== user.id)) return { error: 'no such task' }
  return {
    id: t.id, title: t.title, description: t.description || '', owner: t.assignee_name || 'Unassigned',
    status: t.status, priority: t.priority, due_date: t.due_date || null,
    progress: t.progress ?? 0, created_at: t.created_at, updated_at: t.updated_at,
  }
}

function runLookup(name, user, args) {
  if (name === 'search_tasks') return searchTasks(user, args)
  if (name === 'search_people') return searchPeople(user, args)
  if (name === 'search_meetings') return searchMeetings(user, args)
  if (name === 'get_task') return getTask(user, args)
  // Models sometimes try to function-call an ACTION tool (delete_task, navigate…).
  // Those are never callable — they are the final JSON reply. Say exactly that,
  // echoing the args back, so the model recovers instead of apologizing.
  return { error: `${name} is not a lookup — it is an ACTION. Finish NOW with your final JSON reply: {"tool":"${name}","args":${JSON.stringify(args || {})},"say":"..."}` }
}

// ---- prompt ------------------------------------------------------------------

// STATIC per role, dynamic data lives in the user message — a stable prefix is
// what lets provider-side prompt caching actually hit across turns.
function agentSystem(role) {
  const allowed = toolsFor(role)
  const lines = allowed.map((t) => `- ${t.name}(${t.args})\n    ${t.desc}`).join('\n')
  return `You are "BTM", the voice agent inside SmartTask, a team task manager. Convert the user's latest utterance into ONE action, investigating first when needed.

The user may speak English, Hindi, Telugu, or a code-mixed blend, and speech-to-text OFTEN mishears words and names — read for INTENT, not letters. Always write task titles, descriptions and your "say" reply in clear ENGLISH.

INVESTIGATE, THEN ACT:
- You have lookup tools (search_tasks, search_people, search_meetings, get_task). Use them whenever the task, person, or meeting the user means is not plainly in front of you — NEVER guess or invent a task_id, never claim something doesn't exist without searching first, and never ask the user "which meeting?" before search_meetings has shown you what exists.
- If a search narrows to ONE plausible match, act on it. If several are plausible, finish with "clarify" naming the top options. If none match, finish with "clarify" saying what you looked for.
- Investigate at most a few times, then commit. Speed matters — this is a live voice conversation.

ACTION TOOLS (your FINAL reply picks exactly one — these are NEVER called as functions; only the lookup tools are callable functions):
${lines}

RULES:
- MULTI-STEP: if the request needs SEVERAL actions in one go (e.g. "message everyone who's overdue", "reassign all of Sameer's tasks to Pawan"), finish with a PLAN:
  {"tool":"plan","steps":[{"tool":"<name>","args":{...}}, ...],"say":"one natural sentence describing everything you'll do"}
  Use exact task ids from the snapshot or your search results. Plan steps may ONLY use: create_task, update_task, set_status, assign_task, add_comment, delete_task, send_message. Max 10 steps. A SINGLE action is never wrapped in a plan.
- CHATS vs COMMENTS: "message / tell / ping / text someone" means a real chat message → send_message. Only add_comment when they explicitly say to comment on / add a note to the task.
- "ASSIGN A TASK" MEANS CREATE ONE. "Assign a task to Ravi", "give Anjali a task", "put a task on Pawan" are create_task with assignee_name — not assign_task. assign_task is ONLY for a task that already exists and that you can name a real task_id for. If you were about to ask "which task?" about work the user never said existed, you wanted create_task.
- NEVER compute numbers/metrics yourself — get_overview / get_workload / group_tasks do the counting.
- If the request is a question about work content rather than a command, use "ask".
- "say" is one short, natural spoken sentence. For mutate tools it should read like you are about to do it (the app adds a yes/no step). For read tools, leave "say" empty — the system supplies the real answer. "clarify" MUST carry its actual question in args.question.
- If a tool is not in the list above, this user's role may not use it: finish with {"tool":"denied","args":{"wanted":"<tool name>"},"say":""}.

Your FINAL reply must be ONLY a JSON object, no markdown fences, no prose around it. Either:
{"tool":"<name>","args":{...},"say":"..."}
…or a multi-step plan:
{"tool":"plan","steps":[{"tool":"<name>","args":{...}}],"say":"..."}`
}

function userMessage(transcript, { user, tasks, users, history }) {
  const scope = user.role === 'employee'
    ? 'You are talking to an EMPLOYEE: the snapshot and every search cover ONLY their own tasks. Never reference other people\'s tasks.'
    : `You are talking to a ${user.role} who may act on any task or person in the organization.`
  return `Today is ${localDay()}. The user is ${user.name} (${user.role}). ${scope}

${snapshot(tasks, users, user, transcript, HOT_TASKS)}${historyBlock(history)}

USER JUST SAID: ${transcript}`
}

// ---- the loop ------------------------------------------------------------------

async function callModel(model, messages, tools, onUsage) {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'SmartTask AI',
    },
    // No response_format here: several models refuse to emit tool calls in JSON
    // mode. The terminal contract is enforced by instruction + parse + validateCall.
    body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature: 0.2 }),
  })
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  if (onUsage) onUsage({ provider: 'openrouter', model, inputTokens: data.usage?.prompt_tokens || 0, outputTokens: data.usage?.completion_tokens || 0 })
  const msg = data.choices?.[0]?.message
  if (!msg) throw new Error('OpenRouter returned no message')
  return msg
}

// Route one utterance through the agentic loop. Same signature and return shape
// as voiceTools.routeCommand; falls back to it on ANY failure, so the caller
// never has to care which brain answered.
export async function agentCommand(transcript, opts = {}) {
  if (!process.env.OPENROUTER_API_KEY) return routeCommand(transcript, opts)

  const { user, tasks = [], users = [], history = [], onUsage } = opts
  const t0 = Date.now()
  try {
    const messages = [
      { role: 'system', content: agentSystem(user.role) },
      { role: 'user', content: userMessage(transcript, { user, tasks, users, history }) },
    ]
    let model = fastModel()
    let lookups = 0
    let escalated = false
    let aliasLesson = null   // staged by search_people when a name resolved via fuzz

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const canEscalate = !escalated && smartModel() !== model
      const tools = canEscalate ? [...INVESTIGATE, ESCALATE] : INVESTIGATE
      const msg = await callModel(model, messages, tools, onUsage)

      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls })
        for (const tc of msg.tool_calls) {
          const name = tc.function?.name
          let args = {}
          try { args = JSON.parse(tc.function?.arguments || '{}') } catch {}
          let result
          if (name === 'escalate') {
            // Same conversation, stronger model — the investigation so far carries over.
            escalated = true
            model = smartModel()
            result = { ok: `escalated to ${model} — continue and produce the final JSON` }
            console.log(`[voiceAgent] escalated: ${String(args.reason || '').slice(0, 120)}`)
          } else if (lookups >= MAX_LOOKUPS) {
            result = { error: 'lookup budget exhausted — commit to your best final answer now' }
          } else {
            lookups++
            result = runLookup(name, user, args)
            // Lessons travel out-of-band — the model gets clean results, the
            // route gets the learning candidate.
            if (result && result._lesson !== undefined) {
              if (result._lesson) aliasLesson = result._lesson
              delete result._lesson
            }
          }
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) })
        }
        continue
      }

      const obj = parseJson(msg.content || '')
      if (obj && obj.tool) {
        console.log(`[voiceAgent] ${obj.tool} via ${model} (${lookups} lookup${lookups === 1 ? '' : 's'}, ${round + 1} round${round ? 's' : ''}, ${Date.now() - t0}ms)`)
        const call = validateCall(obj, user)
        // Routing telemetry for the voice_turns learning log — how this decision
        // was reached, not just what it was.
        call.meta = { engine: model, lookups, rounds: round + 1, ms: Date.now() - t0, aliasLesson }
        return call
      }
      // Not the contract. One nudge, then give up to the fallback.
      if (round === MAX_ROUNDS - 1) break
      messages.push({ role: 'assistant', content: msg.content || '' })
      messages.push({ role: 'user', content: 'That was not the required format. Reply with ONLY the final JSON object ({"tool":...,"args":{...},"say":"..."}), nothing else.' })
    }
    throw new Error('agent loop produced no valid tool call')
  } catch (err) {
    console.warn('[voiceAgent] falling back to one-shot router:', err.message)
    return routeCommand(transcript, opts)
  }
}
