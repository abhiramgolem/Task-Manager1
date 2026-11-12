// Voice assistant TOOL REGISTRY — the thing the router LLM chooses from.
//
// Each tool declares who may call it, what it needs, and how it behaves:
//   kind 'mutate'   -> changes data. TRUST TIERS (decided in routes/assistant.js +
//                      the client tool table): reversible mutations (status, assign,
//                      edit, comment) run IMMEDIATELY and carry an undo action;
//                      one-way doors (delete, remove/invite a person, message a
//                      human) still stop for a yes/no first.
//   kind 'navigate' -> moves the UI; runs immediately
//   kind 'read'     -> answers/report; runs immediately (numbers come from SQL)
//
// Adding a capability = one entry here + one case in the route's dispatcher. The
// old design hard-coded 8 intents in a prompt, so "edit this task", "yesterday's
// overview" and "start a meeting" simply had nowhere to land and got declined.
import { callOpenRouter, callClaude, callOpenAI, parseJson } from './voiceTask.js'
import { localDay } from '../clock.js'

const STATUSES = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Reopened']
const PRIORITIES = ['Critical', 'High', 'Medium', 'Low']
const PERIODS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'custom']
// Mirrors MEETING_TITLES in client/src/pages/Meetings.tsx — the presets in the
// recorder's title dropdown. Kept in step by hand (same as STATUSES/PRIORITIES);
// a title outside this list still works, it just lands in the "Other" field.
const MEETING_TITLES = ['Tech Meeting', 'Marketing Meeting', 'Sales Meeting', 'HR Meeting', 'Tech and Marketing Meeting']

const ALL = ['manager', 'admin', 'employee']
const MGR = ['manager', 'admin']

export const TOOLS = [
  // ---- tasks: create & edit ------------------------------------------------
  { name: 'create_task', kind: 'mutate', roles: ALL,
    desc: 'Create a NEW task. This is what "assign a task to Ravi", "give Anjali a task", '
      + '"add a task for the deck review" and "create a task" ALL mean — the word "assign" does '
      + 'NOT imply an existing task. If the user names work that does not exist yet, it is this '
      + 'tool, and the assignee simply becomes assignee_name. Only reach for assign_task when '
      + 'they point at a task that already exists.',
    args: 'title (short, English), description, assignee_name|null, priority (' + PRIORITIES.join('|') + '), due_date_raw (deadline exactly as spoken, or null)' },

  { name: 'update_task', kind: 'mutate', roles: ALL,
    desc: "Edit an EXISTING task's details: rename it, change its description, due date, priority, or progress. Use this for 'edit', 'rename', 'change the due date', 'set progress to 50%'.",
    args: 'task_id, and any of: title, description, due_date_raw, priority, progress (0-100)' },

  { name: 'set_status', kind: 'mutate', roles: ALL,
    desc: "Change a task's status. 'mark done'/'complete' => Done.",
    args: 'task_id, status (' + STATUSES.join('|') + ')' },

  { name: 'assign_task', kind: 'mutate', roles: ALL,
    desc: 'Move an ALREADY-EXISTING task to a different person — "reassign the pricing deck to '
      + 'Anjali", "move the login bug to Pawan". Requires a real task_id you have seen in the '
      + 'snapshot or found via search_tasks. If no such task exists, the user is asking you to '
      + 'CREATE one: use create_task instead. Never ask "which task?" for work that was never created.',
    args: 'task_id, assignee_name' },

  { name: 'add_comment', kind: 'mutate', roles: ALL,
    desc: 'Add a comment/note to a task.',
    args: 'task_id, body' },

  { name: 'delete_task', kind: 'mutate', roles: MGR,
    desc: 'Delete a task permanently.',
    args: 'task_id' },

  // ---- chats (the Chats section — real 1:1 messages, NOT task comments) -----
  { name: 'send_message', kind: 'mutate', roles: ALL,
    desc: "Send a DIRECT CHAT MESSAGE to a teammate in the Chats section — this is real person-to-person messaging, NOT a task comment. Use whenever the user says 'message X', 'tell X in chat', 'send X a message', 'ping X', 'message him/her personally'. If they mention a task, weave it into the message text.",
    args: 'recipient_name, body (the message to send, phrased naturally in English)' },

  // ---- daily metrics card (a chat card of the user's own daily numbers) -----
  { name: 'post_daily_update', kind: 'mutate', roles: ALL,
    desc: "Post the user's DAILY METRICS (also called daily update): the card of numbers they report in a team chat every day "
      + "(sales, leads, reviews, junk leads…). Use for 'post my daily metrics', 'post my daily update', 'today's update: sales 12k, "
      + "2 reviews, no junk leads', 'update my numbers'. Put EVERY number they said into values, each "
      + "labelled with their own word for it. Write values in digits, keeping a spoken k / lakh / crore "
      + "('12k', '1.5 lakh', '0' for zero / none / nil). The app matches the labels to their card.",
    args: 'values: [{metric, value}], note (any remark that is not a number, else ""), chat_name (only if they named the group, else null)' },

  // ---- team / people (managers) --------------------------------------------
  { name: 'add_user', kind: 'mutate', roles: MGR,
    desc: "Invite a new teammate into the organization by email. Use for 'add an employee', 'create a new user', 'onboard someone', 'invite <email>'. "
      + 'They get an emailed link and choose their OWN name and password there, so NEVER ask for, invent, or repeat a password for them — the only password involved is the manager\'s own, which the app collects as a typed confirmation. '
      + 'The email address is the one thing you must have: if they have not said it, use "clarify" and ask for it — do not guess it from their name. '
      + "Infer the role from their words ('add an employee' → employee, 'add a manager' → manager) and default to employee; only ask about role if they said something ambiguous like 'add someone'.",
    args: 'email (required), role (employee|manager|admin, default employee)' },

  { name: 'remove_user', kind: 'mutate', roles: MGR,
    desc: "Permanently remove a teammate's account from the organization. Use for 'delete <name>', 'remove <name> from the team', 'fire <name>'. The app will require the manager's own password to confirm before it happens.",
    args: 'person_name' },

  // ---- views ---------------------------------------------------------------
  { name: 'navigate', kind: 'navigate', roles: ALL,
    desc: 'Open a screen or a filtered task list. Use for "show/open/go to". For a status or priority, set target=status/priority AND the matching field — e.g. "open the blocked tasks" is target=status, status=Blocked. '
      + 'For a PERSON, pick the right one: person = their TASK list; person_chat = their CHAT conversation. "open Ravi\'s chat / message thread / conversation" is person_chat, NOT person. Plain chats = the conversation list. '
      + 'Speech-to-text often hears "chat" as "chart" or "charts"; nobody asks for a person\'s chart, so "<name>\'s chart" means person_chat.',
    args: 'target (overdue|completed|active|all|my_tasks|dashboard|meetings|chats|leaderboard|person|person_chat|status|priority), person, status (' + STATUSES.join('|') + '), priority (' + PRIORITIES.join('|') + ')' },

  // ---- analytics (numbers computed in SQL, never by you) --------------------
  { name: 'get_overview', kind: 'read', roles: ALL,
    desc: "Metrics for a period: how many tasks were created/assigned/completed, and how many are overdue/blocked now. Use for 'yesterday's overview', 'how did we do this week', 'summary of today'.",
    args: 'period (' + PERIODS.join('|') + '), from/to (YYYY-MM-DD, only when period=custom)' },

  { name: 'get_workload', kind: 'read', roles: MGR,
    desc: "Open task counts per person. Use for 'who is overloaded', 'what is Sameer working on'.",
    args: 'assignee_name|null (null = whole team)' },

  { name: 'group_tasks', kind: 'read', roles: ALL,
    desc: "Group/bucket tasks and report the counts. Use for 'group the overdue tasks', 'break down tasks by priority'. Also opens the matching filtered list.",
    args: 'group_by (assignee|status|priority), overdue (true/false), status, priority, person' },

  { name: 'get_leaderboard', kind: 'read', roles: ALL,
    desc: "Performance leaderboard: who has the most points, or one person's rank and score. Use for 'who is top of the leaderboard', 'what's my score', 'how many points does Ravi have'.",
    args: "period (day|month|all, omit for the default window), person_name|null (null = the whole board; use the speaker's own name for 'my score/rank')" },

  { name: 'get_notifications', kind: 'read', roles: ALL,
    desc: "The user's own in-app notifications. Use for 'any notifications?', 'what did I miss?', 'anything new for me?'.",
    args: '(none)' },

  { name: 'get_unread_messages', kind: 'read', roles: ALL,
    desc: "Unread CHAT messages — how many, and from whom. Use for 'any new messages?', 'did anyone message me?', 'unread chats?'.",
    args: '(none)' },

  { name: 'mark_notifications_read', kind: 'mutate', roles: ALL,
    desc: "Mark ALL of the user's notifications as read. Use for 'clear my notifications', 'mark them all read'.",
    args: '(none)' },

  // ---- meetings (manager/admin only) ---------------------------------------
  { name: 'start_meeting', kind: 'navigate', roles: MGR,
    desc: "Begin recording a new live meeting. Use for 'start a meeting', 'record a meeting', 'begin the standup'. "
      + 'A meeting MUST be named before recording starts — an untitled recording is near-impossible to find again afterwards. '
      + 'If their words ALREADY name it, that IS the title — use it and start, do not ask a needless question: "start the marketing meeting" → title "Marketing Meeting", "record the standup" → title "Standup". '
      + 'Only when they named no meeting at all ("start a meeting", "begin recording") do you skip this tool and use "clarify" to ask which one, offering the presets. '
      + 'Presets: ' + MEETING_TITLES.join(', ') + '. Anything else they say is fine as a custom title.',
    args: 'title (required — the meeting name)' },

  { name: 'control_meeting', kind: 'navigate', roles: MGR,
    desc: "Control a meeting recording that is ALREADY RUNNING on screen. Use for 'pause the recording', 'resume', 'stop recording', 'finish the meeting', 'analyse it and pull out the tasks'. 'finish' stops the recording AND extracts the tasks — use it when they are done with the meeting entirely.",
    args: 'action (pause|resume|stop|finish)' },

  { name: 'open_meeting', kind: 'navigate', roles: MGR,
    desc: "Open a specific meeting's page. Use for 'open the marketing meeting', 'show me the last meeting'.",
    args: 'title, date (YYYY-MM-DD), latest (true for the most recent)' },

  { name: 'approve_suggestions', kind: 'mutate', roles: MGR,
    desc: "Assign ALL pending AI-suggested tasks from a meeting — turns every reviewed suggestion that has an owner into a real task and notifies the assignees. Use for 'approve the tasks from the marketing meeting', 'assign all the suggestions from the last meeting'.",
    args: 'title, date (YYYY-MM-DD), latest (true for the most recent meeting)' },

  { name: 'summarize_meeting', kind: 'read', roles: MGR,
    desc: "Recap what a meeting covered/decided. Use for 'summarize the last meeting', 'what happened in the marketing meeting'.",
    args: 'title, date (YYYY-MM-DD), latest (true for the most recent)' },

  { name: 'list_meetings', kind: 'read', roles: MGR,
    desc: "How many meetings there are and which is most recent. Use for 'what meetings do we have'.",
    args: '(none)' },

  // ---- knowledge -----------------------------------------------------------
  { name: 'ask', kind: 'read', roles: ALL,
    desc: 'Answer an open question about tasks, meetings, decisions, or chat history by searching the workspace. Use this when the user asks something that is not a direct command and no other tool fits.',
    args: 'question (the user\'s question, rephrased in full)' },

  { name: 'clarify', kind: 'read', roles: ALL,
    desc: 'You need more information (which task? who?). Ask one short question.',
    args: 'question' },
]

export const toolByName = (n) => TOOLS.find((t) => t.name === n) || null
export const toolsFor = (role) => TOOLS.filter((t) => t.roles.includes(role))

// A specific, spoken reason for a role-restricted tool.
const DENIAL = {
  start_meeting: 'Only managers can start a meeting.',
  control_meeting: 'Only managers can control a meeting recording.',
  open_meeting: 'Only managers can open meetings.',
  summarize_meeting: 'Only managers can see meeting summaries.',
  list_meetings: 'Only managers can see the meeting list.',
  get_workload: "Only managers can see the team's workload — I can show you your own tasks.",
  delete_task: 'Only managers can delete tasks.',
  add_user: 'Only managers can add teammates.',
  remove_user: 'Only managers can remove teammates.',
}
const denialFor = (name) => DENIAL[name] || "You don't have access to that."

const today = () => localDay()

function systemPrompt(user) {
  const allowed = toolsFor(user.role)
  const denied = TOOLS.filter((t) => !t.roles.includes(user.role))
  const lines = allowed.map((t) => `- ${t.name}(${t.args})\n    ${t.desc}`).join('\n')
  // Name the forbidden tools explicitly so the model reports a precise reason
  // ("Only managers can start meetings") instead of a vague deflection.
  const deniedNote = denied.length
    ? `\nRESTRICTED — this user's role may NOT use these: ${denied.map((t) => t.name).join(', ')}.
If they ask for one, reply with {"tool":"denied","args":{"wanted":"<that tool name>"},"say":""} and nothing else.`
    : ''
  const scope = user.role === 'employee'
    ? 'This user is an EMPLOYEE: the snapshot lists ONLY their own tasks. Never reference other people\'s tasks.'
    : `This user is a ${user.role} and may act on any task or person in the organization.`

  return `You are "BTM", the voice controller inside SmartTask, a team task manager. Convert the user's latest utterance into EXACTLY ONE tool call.

The user may speak English, Hindi, Telugu, or a code-mixed blend. Always write task titles, descriptions and your "say" reply in clear ENGLISH.

${scope}
Today is ${today()}. The user is ${user.name} (${user.role}).

AVAILABLE TOOLS:
${lines}${deniedNote}

RULES:
- Pick the single best tool. Never invent a tool name.
- MULTI-STEP: if the request needs SEVERAL actions in one go (e.g. "message everyone who's overdue", "mark the logo task done and tell Pawan", "reassign all of Sameer's tasks to Pawan", "message Pawan and Chinmay to finish up"), respond with a PLAN instead of a single tool:
  {"tool":"plan","steps":[{"tool":"<name>","args":{...}}, ...],"say":"one natural sentence describing everything you'll do"}
  Fill exact task ids from the TASKS snapshot and names from the TEAM list. Expand "everyone overdue / all of X's tasks / both of them" into one step per person/task using the snapshot. Plan steps may ONLY use these mutation tools: create_task, update_task, set_status, assign_task, add_comment, delete_task, send_message. Max 10 steps. For a SINGLE action, use the normal one-tool form (do NOT wrap it in a plan).
- CHATS vs COMMENTS: "message / tell / ping / text someone (in chat / personally)" means a real chat message → use send_message. Only use add_comment when they explicitly say "comment on the task" or "add a note to the task".
- When a tool targets an existing task, copy its exact id from the snapshot into task_id. If several tasks plausibly match, use "clarify" and name the top options. If none match, use "clarify".
- NEVER compute or guess numbers/metrics yourself — call get_overview / get_workload / group_tasks and let the system count.
- If the request is a question rather than a command, use "ask".
- "say" is one short, natural spoken sentence. For mutate tools it should read like you are about to do it (the app adds a yes/no step). For read tools, leave "say" empty — the system supplies the real answer.
- EXCEPT "clarify": there is no computed answer behind it, so it MUST carry the actual question in args.question (and in "say"). A clarify with an empty question tells the user nothing and strands them repeating themselves. Name what you need — which task, or which person.

Respond with ONLY a JSON object, no markdown fences. Either a single tool:
{"tool":"<name>","args":{...},"say":"..."}
…or a multi-step plan:
{"tool":"plan","steps":[{"tool":"<name>","args":{...}}],"say":"..."}`
}

// Beyond this many tasks the prompt is ranked down to the ones that could
// plausibly be referenced — a big org would otherwise pay for (and be slowed by)
// hundreds of irrelevant rows in every single utterance.
const MAX_SNAPSHOT_TASKS = 40

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'and', 'my', 'me', 'is', 'it', 'that', 'this', 'task', 'tasks', 'please'])
const words = (s) => String(s || '').toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 2 && !STOP.has(w)) || []

// Rank by how well a task's title matches what was said, then by recency
// (`tasks` arrives newest-first), keeping overdue work visible.
function rankTasks(tasks, transcript, max = MAX_SNAPSHOT_TASKS) {
  if (tasks.length <= max) return tasks
  const q = new Set(words(transcript))
  const t0 = today()
  const scored = tasks.map((t, i) => {
    const overlap = words(t.title).filter((w) => q.has(w)).length
    const recency = 1 - i / tasks.length              // 0..1, newest highest
    const overdue = t.due_date && t.due_date < t0 && t.status !== 'Done' ? 0.5 : 0
    return { t, score: overlap * 5 + recency + overdue }
  })
  scored.sort((a, b) => b.score - a.score)
  const kept = scored.slice(0, max).map((s) => s.t)
  console.log(`[voiceTools] snapshot trimmed ${tasks.length} -> ${kept.length} tasks by relevance`)
  return kept
}

export function snapshot(tasks, users, user, transcript, max = MAX_SNAPSHOT_TASKS) {
  const t0 = today()
  const shown = rankTasks(tasks, transcript, max)
  const taskLines = shown.map((t) => {
    const bits = [`id=${t.id}`, `"${t.title}"`, `owner=${t.assignee_name || 'Unassigned'}`, `status=${t.status}`, `priority=${t.priority}`]
    if (t.due_date) bits.push(`due=${t.due_date}${t.due_date < t0 && t.status !== 'Done' ? ' OVERDUE' : ''}`)
    return '- ' + bits.join(' | ')
  })
  const omitted = tasks.length > shown.length
    ? `\n(${tasks.length - shown.length} less-relevant tasks not listed — ask the user to name one if unsure.)` : ''
  const people = user.role === 'employee' ? ''
    : '\n\nTEAM:\n' + users.map((u) => `- ${u.name}${u.role ? ` (${u.role})` : ''}`).join('\n')
  return `TASKS (${taskLines.length} of ${tasks.length}):\n${taskLines.join('\n') || '(none)'}${omitted}${people}`
}

export function historyBlock(history) {
  if (!Array.isArray(history) || !history.length) return ''
  const turns = history
    .filter((m) => m && typeof m.text === 'string' && m.text.trim() && (m.role === 'user' || m.role === 'ai'))
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'BTM'}: ${m.text.trim()}`)
  return turns.length ? `\n\nCONVERSATION SO FAR:\n${turns.join('\n')}` : ''
}

// Route one utterance to a tool. Returns { tool, args, say }. Falls back to a
// clarify tool if the model picks something unknown or forbidden.
export async function routeCommand(transcript, { user, tasks = [], users = [], history = [], onUsage } = {}) {
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY
  const hasClaude = !!process.env.ANTHROPIC_API_KEY
  const hasOpenAI = !!process.env.OPENAI_API_KEY
  if (!hasOpenRouter && !hasClaude && !hasOpenAI) throw new Error('No LLM configured')

  const system = systemPrompt(user)
  const userMsg = `${snapshot(tasks, users, user, transcript)}${historyBlock(history)}\n\nUSER JUST SAID: ${transcript}`

  const providers = [
    hasOpenRouter && { name: 'OpenRouter', call: callOpenRouter },
    hasClaude && { name: 'Claude', call: callClaude },
    hasOpenAI && { name: 'OpenAI', call: callOpenAI },
  ].filter(Boolean)
  let raw, lastErr
  for (const p of providers) {
    try { raw = await p.call(system, userMsg, onUsage); if (raw) break }
    catch (err) { lastErr = err; console.warn(`[voiceTools] ${p.name} failed, trying next:`, err.message) }
  }
  if (raw === undefined) throw lastErr || new Error('All providers failed')

  return validateCall(parseJson(raw) || {}, user)
}

// Validate a model-produced tool call against the registry and the caller's role.
// Shared by the legacy one-shot router above and the agentic loop (voiceAgent.js),
// so however the JSON was produced, exactly one gate decides what may execute.
export function validateCall(obj, user) {
  // Explicit refusal the model was told to emit for a restricted tool.
  if (obj.tool === 'denied') return { tool: 'denied', args: {}, say: denialFor(obj.args?.wanted) }

  // Multi-step plan: a list of mutation steps to confirm & run as a batch. The
  // dispatcher resolves each step; role checks are applied there and per-step.
  if (obj.tool === 'plan' && Array.isArray(obj.steps)) {
    return { tool: 'plan', kind: 'plan', args: { steps: obj.steps.slice(0, 10) }, say: typeof obj.say === 'string' ? obj.say.trim() : '' }
  }

  const spec = toolByName(obj.tool)
  // Unknown tool, or one this role may not use -> degrade gracefully.
  if (!spec) return { tool: 'clarify', args: { question: obj.say || '' }, say: obj.say || '' }
  // Belt and braces: never execute a tool the role can't use, even if asked to.
  if (!spec.roles.includes(user.role)) return { tool: 'denied', args: {}, say: denialFor(spec.name) }
  return { tool: spec.name, kind: spec.kind, args: obj.args || {}, say: typeof obj.say === 'string' ? obj.say.trim() : '' }
}

export { STATUSES, PRIORITIES, PERIODS, MEETING_TITLES }
