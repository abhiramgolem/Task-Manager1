// Conversational AI assistant, strictly scoped to this Task Manager's data.
// Uses Claude (ANTHROPIC_API_KEY) first, then OpenAI (OPENAI_API_KEY).
// When no key is configured (or the call fails) the caller falls back to the
// rule-based answerQuery in ./assistant.js so the chat always works offline.
//
// RAG: when an embedding index exists, we additionally retrieve the most
// question-relevant chunks across meetings, transcripts, chat, AND tasks beyond
// the snapshot cap, and append them as a "RELEVANT CONTEXT" block. This is what
// lets TaskBot answer from meeting/chat content the plain snapshot never carries,
// and scale past the MAX_TASKS_IN_CONTEXT cap. Retrieval is RBAC-filtered, so it
// can only surface what the user could already see.
import { db } from '../db.js'
import { localDay } from '../clock.js'
import { retrieve } from './ragRetrieve.js'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

// Don't let a hung provider stall a voice turn (the caller is waiting to speak).
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 25000
const withTimeout = () => AbortSignal.timeout(TIMEOUT_MS)

const OPEN_STATUSES = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Reopened']
const today = () => localDay()
const isOverdue = (t) => t.due_date && t.due_date < today() && t.status !== 'Done'

export const hasLLM = () => !!(process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)

// Tasks the requesting user is allowed to see (employees: only their own).
function scopedTasks(user) {
  const rows = db.prepare(`
    SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date,
           t.progress, t.assignee_id, t.created_at, t.updated_at, t.completed_at,
           u.name AS assignee_name, b.name AS assigned_by_name,
           p.name AS project_name, d.name AS department_name,
           m.title AS meeting_title, m.meeting_date AS meeting_date
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN users b ON b.id = t.assigned_by_id
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN departments d ON d.id = t.department_id
    LEFT JOIN meetings m ON m.id = t.meeting_id
    WHERE t.org_id = ? AND t.parent_task_id IS NULL
    ORDER BY t.updated_at DESC
  `).all(user.org_id)
  return user.role === 'employee' ? rows.filter((t) => t.assignee_id === user.id) : rows
}

// Per-person open-task counts — only exposed to managers/admins.
function workloadRows(orgId) {
  return db.prepare(`
    SELECT u.name, u.role, d.name AS dept,
      (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id
         AND t.status IN ('To Do','In Progress','Blocked','In Review','Reopened')
         AND t.parent_task_id IS NULL) AS open_count
    FROM users u LEFT JOIN departments d ON d.id = u.department_id
    WHERE u.org_id = ? AND u.role != 'admin'
    ORDER BY open_count DESC
  `).all(orgId)
}

const MAX_TASKS_IN_CONTEXT = 200

// Build a compact, factual snapshot of everything the model is allowed to use.
function buildContext(user) {
  const tasks = scopedTasks(user)
  const t0 = today()
  const stats = {
    total: tasks.length,
    open: tasks.filter((t) => OPEN_STATUSES.includes(t.status)).length,
    done: tasks.filter((t) => t.status === 'Done').length,
    overdue: tasks.filter(isOverdue).length,
    due_today: tasks.filter((t) => t.due_date === t0 && t.status !== 'Done').length,
    blocked: tasks.filter((t) => t.status === 'Blocked').length,
  }

  const shown = tasks.slice(0, MAX_TASKS_IN_CONTEXT)
  const taskLines = shown.map((t) => {
    const bits = [
      `id=${t.id}`,
      `"${t.title}"`,
      `owner=${t.assignee_name || 'Unassigned'}`,
      `status=${t.status}`,
      `priority=${t.priority}`,
    ]
    if (t.due_date) bits.push(`due=${t.due_date}${isOverdue(t) ? ' OVERDUE' : ''}`)
    if (t.project_name) bits.push(`project=${t.project_name}`)
    if (t.department_name) bits.push(`dept=${t.department_name}`)
    if (typeof t.progress === 'number' && t.progress > 0) bits.push(`progress=${t.progress}%`)
    if (t.meeting_title) bits.push(`from_meeting="${t.meeting_title}"`)
    return '- ' + bits.join(' | ')
  })
  const truncated = tasks.length > shown.length
    ? `\n(...${tasks.length - shown.length} more tasks not listed; ask to narrow down.)` : ''

  let context = `STATS: ${JSON.stringify(stats)}\n\nTASKS (${shown.length} of ${tasks.length}):\n${taskLines.join('\n') || '(none)'}${truncated}`

  if (user.role !== 'employee') {
    const wl = workloadRows(user.org_id)
    if (wl.length) {
      context += `\n\nTEAM WORKLOAD (open tasks per person):\n` +
        wl.map((w) => `- ${w.name} (${w.role}${w.dept ? ', ' + w.dept : ''}): ${w.open_count} open`).join('\n')
    }
  }
  return { context, tasks }
}

// Render RAG hits into a labelled block the model can quote from. Task hits keep
// their id so the model can cite them in task_ids for clickable cards.
const RAG_LABELS = { task: 'task', meeting: 'meeting', segment: 'meeting transcript', chat: 'chat message' }
function ragBlock(hits) {
  if (!hits.length) return ''
  const lines = hits.map((h) => {
    const tag = h.source_type === 'task' ? `task id=${h.source_id}` : (RAG_LABELS[h.source_type] || h.source_type)
    return `- [${tag}] ${h.text}`
  })
  return `\n\nRELEVANT CONTEXT (semantic search over meetings, transcripts, chat, and tasks — use this to answer the question):\n${lines.join('\n')}`
}

function systemPrompt(user) {
  const scopeNote = user.role === 'employee'
    ? 'This user is an employee — the snapshot contains ONLY their own tasks. Never imply you can see other people\'s tasks.'
    : `This user is a ${user.role} — the snapshot covers the whole organization, including team workload.`
  return `You are "BTM", the built-in AI assistant and expert guide inside Befach Task Manager, a team task-management platform. You help managers and team members understand and act on their work — AND you know how every part of the app works.

THE APP'S SECTIONS (you know all of them — never say a feature doesn't exist if it's listed here):
- Dashboard — overview: task counts, team workload, recent activity.
- Tasks — create and track tasks (status, priority, owner, due dates, subtasks, comments, attachments).
- Chats — YES, there is a real chat section: 1:1 and group messaging between teammates. (Via voice, the user can say "message <name> …" and I send it.)
- Meetings — upload or record meetings; the app extracts action items and decisions (managers).
- Leaderboard — performance scores across the team.
- Administration — user management, roles, audit log, org settings (managers).
- The voice assistant — hands-free control that can create/edit/assign tasks, change status, comment, send chat messages, open any screen, and report metrics.

WHAT YOU DISCUSS:
- The user's tasks, deadlines, workload, meetings, team status, and chat history in this org (grounded in the DATA SNAPSHOT and RELEVANT CONTEXT).
- How to use any part of the app — if asked "is there a chat section?", "how do I message someone?", "where's the leaderboard?", answer helpfully and point them to the right section.

Decline ONLY things genuinely unrelated to this app or its data (world facts, coding help, math puzzles, weather, news, personal advice). Keep it to one short sentence, then steer back. NEVER decline a question about the app's own features or sections.

GROUNDING RULES:
- Answer ONLY from the DATA SNAPSHOT and the RELEVANT CONTEXT block. Never invent tasks, people, dates, numbers, or statuses.
- The RELEVANT CONTEXT block (when present) holds the most semantically relevant meeting, transcript, chat, and task excerpts for this question — prefer it for questions about what was said or decided.
- If neither section contains the answer, say so plainly (e.g. "I don't see anything matching that.").
- ${scopeNote}
- Today's date is ${today()}. The user is ${user.name}.
- Be concise and conversational — short sentences or compact bullet points suited to a chat bubble. No markdown headers or tables.
- When specific tasks are relevant to your answer, put their ids in "task_ids" (max 12) so the UI can show them as clickable cards. Use [] when none apply.
- Ids are for "task_ids" ONLY. NEVER write an internal id (task_xxx, mtg_xxx, usr_xxx) inside "answer" — the reply is SPOKEN ALOUD, and an id read out letter by letter is noise. Refer to things by their title or name.

Respond with ONLY a JSON object, no markdown fences:
{"answer": "your reply text", "task_ids": ["id1","id2"]}`
}

// Trim client-supplied history into clean alternating turns for the API.
function normalizeHistory(history) {
  if (!Array.isArray(history)) return []
  return history
    .filter((m) => m && typeof m.text === 'string' && m.text.trim() && (m.role === 'user' || m.role === 'ai'))
    .slice(-8)
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text.trim() }))
}

function parseModelJson(text) {
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    const obj = JSON.parse(text.slice(start, end + 1))
    return {
      answer: typeof obj.answer === 'string' ? obj.answer : '',
      task_ids: Array.isArray(obj.task_ids) ? obj.task_ids.map(String) : [],
    }
  } catch { return null }
}

// OpenRouter speaks the OpenAI chat API, so `messages` passes straight through.
// Preferred first: with google/gemini-2.5-flash this answers in ~1-2 s where
// Claude Opus took 6-9 s — a big deal when the reply is spoken aloud.
async function callOpenRouter(system, messages, onUsage) {
  const model = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash'
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    signal: withTimeout(),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'SmartTask AI',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, ...messages],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 1024,
    }),
  })
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  if (onUsage) onUsage({ provider: 'openrouter', model, inputTokens: data.usage?.prompt_tokens || 0, outputTokens: data.usage?.completion_tokens || 0 })
  return data.choices?.[0]?.message?.content || ''
}

async function callClaude(system, messages, onUsage) {
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8'
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    signal: withTimeout(),
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      messages,
    }),
  })
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  if (onUsage) onUsage({ provider: 'anthropic', model, inputTokens: data.usage?.input_tokens || 0, outputTokens: data.usage?.output_tokens || 0 })
  return (data.content || []).map((c) => c.text || '').join('')
}

async function callOpenAI(system, messages, onUsage) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    signal: withTimeout(),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, ...messages],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 1024,
    }),
  })
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  if (onUsage) onUsage({ provider: 'openai', model, inputTokens: data.usage?.prompt_tokens || 0, outputTokens: data.usage?.completion_tokens || 0 })
  return data.choices?.[0]?.message?.content || ''
}

// Display shape for a hydrated task card (matches what the rule-based path returns).
const toCard = (t) => ({
  id: t.id, title: t.title, status: t.status, priority: t.priority,
  due_date: t.due_date, assignee_name: t.assignee_name, project_name: t.project_name,
})

// Main entry: returns { answer, tasks, engine }. Throws if no LLM is configured
// or the provider call/parse fails — the route catches and falls back to rules.
export async function chatAnswer(query, user, history = [], onUsage) {
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY
  const hasClaude = !!process.env.ANTHROPIC_API_KEY
  const hasOpenAI = !!process.env.OPENAI_API_KEY
  if (!hasOpenRouter && !hasClaude && !hasOpenAI) throw new Error('No LLM configured')

  const { context, tasks } = buildContext(user)

  // RAG augmentation — append the most relevant meeting/chat/task excerpts.
  // No-ops cleanly (empty block) when nothing is indexed or no embedding key set.
  let ragText = ''
  try {
    const { hits } = await retrieve(query, user)
    ragText = ragBlock(hits)
  } catch (err) {
    console.warn('[assistant] RAG retrieve failed, continuing without it:', err.message)
  }

  const system = systemPrompt(user)
  const messages = [
    ...normalizeHistory(history),
    { role: 'user', content: `DATA SNAPSHOT:\n${context}${ragText}\n\nQUESTION: ${query}` },
  ]

  // Provider chain: OpenRouter (fast + cheap) → Claude → OpenAI, falling through
  // on error so one out-of-credit provider can't break the assistant.
  const chain = [
    hasOpenRouter && { name: 'openrouter', call: callOpenRouter },
    hasClaude && { name: 'claude', call: callClaude },
    hasOpenAI && { name: 'openai', call: callOpenAI },
  ].filter(Boolean)

  let raw, engine, lastErr
  for (const p of chain) {
    try { raw = await p.call(system, messages, onUsage); engine = p.name; if (raw) break }
    catch (err) { lastErr = err; console.warn(`[assistant] ${p.name} failed, trying next:`, err.message) }
  }
  if (raw === undefined) throw lastErr || new Error('All providers failed')

  const parsed = parseModelJson(raw)
  if (!parsed || !parsed.answer) throw new Error('Empty model response')

  // Hydrate only ids the user is actually allowed to see — never trust the model
  // to reveal a task outside scope.
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const cards = parsed.task_ids.map((id) => byId.get(id)).filter(Boolean).map(toCard)

  // Belt and braces on top of the prompt rule: the answer is read aloud by TTS,
  // and models still occasionally cite an internal id mid-sentence ("(task_una8…)").
  // Strip them — the surrounding sentence already names the thing.
  const spoken = parsed.answer
    .replace(/\s*\(\s*(?:task|mtg|usr|ntf|conv)_[a-z0-9]+\s*\)/gi, '')
    .replace(/\b(?:task|mtg|usr|ntf|conv)_[a-z0-9]+\b/gi, 'it')
    .replace(/\s{2,}/g, ' ')
    .trim()

  return { answer: spoken, tasks: cards, engine }
}
