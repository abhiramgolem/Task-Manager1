// Analyses a meeting WHILE it is being recorded, so that finishing it is quick.
//
// A meeting has no fixed end — they run three, four, five hours — and analysing
// one only once it was over meant reading all of it at the moment someone pressed
// Analyze: five hours is ~300k characters, which the long-meeting path in
// openrouter.js works through chunk after chunk and then reduces. Minutes, with a
// manager watching a spinner.
//
// So the recording is analysed as it grows. The recorder pushes its transcript to
// the server every few seconds (the draft in routes/meetings.js), and every ten
// minutes of recording the stretch heard since the last cut goes to the model
// together with a running memory of everything before it. What comes back —
// tasks, decisions, risks, an updated memory — is kept in meeting_live_chunks.
// When the meeting ends only the last few minutes are new: they are analysed the
// same way, and one short call writes the summary and finds the duplicates across
// stretches. That call reads notes and a task list, not the transcript, so it
// takes about as long after five hours as after one.
//
// The stretches are a cache, never the source of truth. Each is keyed by the exact
// text it analysed, and is used at the end only if that text is still in the
// transcript being submitted: the transcript is editable (names get fixed before
// analysing), and a stretch someone edited is simply analysed again. If anything
// here fails, extractor.js falls back to analysing the whole transcript as before.
//
// LLM tiers only. The rule engine needs no head start — it reads five hours in a
// fraction of a second — and the app must work with no keys at all, so with none
// set this stays off and nothing changes.
import { callOpenRouter, LANGUAGE_RULE, TASK_RULES, TASK_SHAPE, normalizeTask, attendeeBlock, keepAllowedLangs } from './openrouter.js'
import { claudeJson } from './claude.js'
import { openaiJson } from './openai.js'

const num = (v, fallback) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : fallback }
// Read per call rather than at import: these come from .env.
export const liveIntervalSeconds = () => num(process.env.MEETING_LIVE_CHUNK_SECONDS, 600)
// Below this much new speech a stretch waits for more, however long it has been:
// a model call over two lines of a quiet room buys nothing.
const MIN_CHARS = 400
// ~25 minutes of fast speech. A backlog bigger than this — the model was down for
// a while, or a long transcript arrived at once — is cut into stretches this size.
const MAX_CHARS = 24_000
const CALL_TIMEOUT_MS = 150_000

// Same order as analyzeMeetingTranscript, each tier tried only if its key is set.
const ENGINES = [
  ['openrouter', 'OPENROUTER_API_KEY', (s, u, o) => callOpenRouter(s, u, o)],
  ['claude', 'ANTHROPIC_API_KEY', (s, u, o) => claudeJson(s, u, { ...o, maxTokens: 8192 })],
  ['openai', 'OPENAI_API_KEY', (s, u, o) => openaiJson(s, u, o)],
]

export function liveAnalysisEnabled() {
  if (String(process.env.MEETING_LIVE_ANALYSIS || '').toLowerCase() === 'off') return false
  return ENGINES.some(([, env]) => !!process.env[env])
}

// onUsage({ engine, input, output }) — the texts sent and received, for the
// caller to bill against the org; this module has no idea whose meeting it is.
async function completeJson(system, user, { onUsage } = {}) {
  let lastErr = new Error('No AI engine configured')
  for (const [engine, env, call] of ENGINES) {
    if (!process.env[env]) continue
    try {
      const json = await call(system, user, { timeoutMs: CALL_TIMEOUT_MS })
      try { onUsage?.({ engine, input: system + user, output: JSON.stringify(json) }) } catch { /* billing must not fail the analysis */ }
      return { engine, json: json && typeof json === 'object' ? json : {} }
    } catch (err) {
      lastErr = err
      console.warn(`[live-analysis] ${engine} failed: ${err.message}`)
    }
  }
  throw lastErr
}

const STRETCH_SYSTEM = `You are an expert multilingual meeting analyst. The meeting is STILL IN PROGRESS: it is analysed a stretch at a time while it is being recorded, and you are given the NEWEST STRETCH.
${LANGUAGE_RULE}

You are also given a RUNNING MEMORY of the meeting before this stretch and the tasks already found in it. Use them for context — who is who, who owns what, deadlines already set — but extract ONLY work that is asked for or committed to IN THIS STRETCH. A task already found that is merely repeated, confirmed or discussed again is NOT output again; one whose owner, deadline or scope CHANGES in this stretch IS output again, with the new details.

${TASK_RULES}

Respond with ONLY a JSON object (no markdown):
{
  "detected_languages": ["en","hi","te"],
  "stretch_summary": "... (English, 2-4 sentences: what THIS stretch covered and concluded)",
  "key_decisions": ["... (English, decided in this stretch)"],
  "risks": ["... (English)"],
  "blockers": ["... (English)"],
  "follow_ups": ["... (English)"],
  "running_memory": "... (English, <=250 words: the running memory UPDATED through this stretch — topics, decisions, risks, blockers and who owns what. It replaces the previous memory and is all the next stretch will see of the past, so keep whatever still matters.)",
  ${TASK_SHAPE}
}`

const FINISH_SYSTEM = `You are an expert meeting analyst writing the FINAL summary of a meeting that was analysed stretch by stretch while it was being recorded.
You are given, in order, each stretch's summary and notes, the running memory at the end of the meeting, and a NUMBERED list of every task found across the stretches.

Your job:
1. Write ONE cohesive summary of the whole meeting in ENGLISH. A decision, risk, blocker or follow-up that recurs across stretches becomes one point; drop any that a later stretch resolved or reversed.
2. Find duplicate tasks: numbers in the list that describe the SAME piece of work — a repeat, a confirmation, or a later change to its owner, deadline or scope. For each such set give the task numbers with the one to KEEP first (the most complete and most recent version). Never group different pieces of work, and never group two people's separate work. Most tasks have no duplicate; list only real ones.

Respond with ONLY a JSON object (no markdown):
{
  "summary": {
    "executive_summary":"... (English, covers the whole meeting's key concepts and outcomes)",
    "key_decisions":["..."],"risks":["..."],"blockers":["..."],"follow_ups":["..."]
  },
  "duplicates": [[7, 2], [15, 11, 9]]
}`

const NOTE_KEYS = [['key_decisions', 'Decisions'], ['risks', 'Risks'], ['blockers', 'Blockers'], ['follow_ups', 'Follow-ups']]
const str = (v) => (typeof v === 'string' ? v.trim() : '')
const list = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.trim() : str(x?.text))).filter(Boolean) : [])
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const parse = (json, fallback) => { try { return JSON.parse(json || '') ?? fallback } catch { return fallback } }

function taskLine(t) {
  const due = t.due_date_raw || t.due_date
  return `${t.title}${t.assignee_name_raw ? ` → ${t.assignee_name_raw}` : ' → (no owner yet)'}${due ? ` (due ${due})` : ''}`
}

// ---- One stretch -------------------------------------------------------------

/**
 * Analyse one stretch of a meeting. `memory` and `priorTasks` are what the
 * stretches before it found. Throws when no engine answers.
 * Returns { engine, memory, notes, tasks, languages }.
 */
export async function analyzeStretch(text, { memory = '', priorTasks = [], meetingDate, attendees, knownNames, onUsage } = {}) {
  // The most recent tasks are the ones most likely to be repeated next, and
  // the prompt should not grow without bound over a whole day of meetings.
  const recent = priorTasks.slice(-150)
  const user = `Meeting date: ${meetingDate || 'unknown'}
Meeting attendees (assign tasks ONLY to these people):
${attendeeBlock({ attendees, knownNames })}

RUNNING MEMORY (the meeting before this stretch):
${memory || '(this is the start of the meeting)'}

TASKS ALREADY FOUND EARLIER IN THE MEETING:
${recent.length ? recent.map((t) => `- ${taskLine(t)}`).join('\n') : '(none yet)'}

NEWEST STRETCH — extract from THIS text only:
${text}`
  const { engine, json } = await completeJson(STRETCH_SYSTEM, user, { onUsage })
  const notes = { summary: str(json.stretch_summary) }
  for (const [k] of NOTE_KEYS) notes[k] = list(json[k])
  return {
    engine,
    memory: str(json.running_memory) || memory,
    notes,
    tasks: (Array.isArray(json.tasks) ? json.tasks : []).filter((t) => t && str(t.title)).map(normalizeTask),
    languages: keepAllowedLangs(json.detected_languages),
  }
}

// How a stretch is stored (meeting_live_chunks) and read back.
export const stretchColumns = (r) => ({
  engine: r.engine, memory: r.memory || '',
  notes_json: JSON.stringify(r.notes || {}), tasks_json: JSON.stringify(r.tasks || []), languages: JSON.stringify(r.languages || []),
})
const fromRow = (row) => ({
  engine: row.engine, memory: row.memory || '',
  notes: parse(row.notes_json, {}), tasks: parse(row.tasks_json, []), languages: parse(row.languages, []),
})

// ---- Where the stored stretches sit in the transcript --------------------------

/**
 * The stored stretches (in the order they were analysed) still present, word
 * for word, in `transcript`, with where each now sits. A stretch that was edited
 * is no longer found and is dropped; text inserted before one just moves it.
 */
export function alignStretches(transcript, rows) {
  const found = []
  let cursor = 0
  for (const row of rows) {
    if (!row.text) continue
    const at = transcript.indexOf(row.text, cursor)
    if (at < 0) continue
    found.push({ row, start: at, end: at + row.text.length })
    cursor = at + row.text.length
  }
  return found
}

/**
 * The next stretch to analyse while recording — or, when it is not time yet,
 * `{ due: { seconds, length } }`: the recording clock or transcript length at
 * which it is worth looking again, so the caller need not re-read the
 * transcript on every push until then. Only whole lines are taken: the last
 * line can still grow (browser captions re-send a longer version of the same
 * sentence), so a stretch always ends at a newline.
 */
export function nextStretch(transcript, rows, seconds) {
  const found = alignStretches(transcript, rows)
  const last = found[found.length - 1]
  const from = last ? last.end : 0
  const pending = transcript.slice(from)
  let text = pending.slice(0, pending.lastIndexOf('\n') + 1)
  const since = last ? last.row.end_seconds || 0 : 0
  const timeUp = seconds - since >= liveIntervalSeconds()
  if (text.trim().length < MIN_CHARS) {
    return { due: { seconds: timeUp ? Infinity : since + liveIntervalSeconds(), length: transcript.length + MIN_CHARS - text.trim().length } }
  }
  if (!timeUp && text.length < MAX_CHARS) {
    return { due: { seconds: since + liveIntervalSeconds(), length: from + MAX_CHARS } }
  }
  let endSeconds = Math.max(since, seconds)
  if (text.length > MAX_CHARS) {
    const cut = text.lastIndexOf('\n', MAX_CHARS - 1) + 1
    if (cut > 0) {
      // Where the clock stood at the cut is not known, only where it stands now;
      // apportioned by length, which is what "analysed the first N min" needs.
      endSeconds = Math.round(since + (endSeconds - since) * (cut / pending.length))
      text = text.slice(0, cut)
    }
  }
  return {
    text, startSeconds: since, endSeconds,
    memory: last ? last.row.memory || '' : '',
    priorTasks: found.flatMap((f) => parse(f.row.tasks_json, [])),
  }
}

/** What the recorder shows while the meeting goes on. */
export function liveProgress(transcript, rows) {
  const found = alignStretches(transcript, rows)
  const seen = new Set()
  const tasks = []
  for (const f of found) {
    for (const t of parse(f.row.tasks_json, [])) {
      const key = `${String(t.title).toLowerCase().trim()}|${String(t.assignee_name_raw || '').toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      tasks.push({ title: t.title, assignee: t.assignee_name_raw || null })
    }
  }
  const last = found[found.length - 1]
  return {
    parts: found.length,
    analysed_seconds: last ? last.row.end_seconds || 0 : 0,
    analysed_chars: last ? last.end : 0,
    tasks,
  }
}

// ---- The end of the meeting ----------------------------------------------------

// A long gap (the live analysis was down for an hour) is analysed in stretches
// of the usual size, at line boundaries, rather than in one oversized call.
function splitLines(text) {
  const out = []
  let rest = text
  while (rest.length > MAX_CHARS) {
    const cut = rest.lastIndexOf('\n', MAX_CHARS - 1) + 1
    if (cut <= 0) break
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.trim()) out.push(rest)
  return out
}

async function inParallel(jobs, limit) {
  let next = 0
  const worker = async () => { while (next < jobs.length) await jobs[next++]() }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker))
}

// Each set is [keep, drop, drop…], by number. Indices out of range, repeated, or
// already claimed by an earlier set are ignored rather than trusted. Models do
// not always keep to the shape they were given, so "#7" and { keep, drop } are
// read too.
const toIndex = (v) => { const m = String(v).match(/^\s*#?(\d+)\s*$/); return m ? Number(m[1]) : NaN }
function dropDuplicates(tasks, groups) {
  const used = new Set(), drop = new Set()
  for (const g of Array.isArray(groups) ? groups : []) {
    const set = Array.isArray(g) ? g : g && typeof g === 'object' ? [g.keep, ...(Array.isArray(g.drop) ? g.drop : [])] : []
    const ids = set.map(toIndex)
      .filter((n, i, a) => Number.isInteger(n) && n >= 0 && n < tasks.length && !used.has(n) && a.indexOf(n) === i)
    if (ids.length < 2) continue
    ids.forEach((n) => used.add(n))
    ids.slice(1).forEach((n) => drop.add(n))
  }
  return tasks.filter((_, i) => !drop.has(i))
}

/**
 * Finish a meeting from the stretches analysed while it was recorded: analyse
 * whatever they do not cover (the last few minutes, and anything edited since),
 * then write one summary over all of it. Returns the same shape the engines do
 * (minus citations, which extractor.js adds), or null when no stored stretch is
 * still in the transcript and there is nothing to reuse. Throws if a stretch
 * cannot be analysed — the caller then analyses the whole transcript instead.
 */
export async function finishFromStretches(transcript, rows, opts = {}) {
  const found = alignStretches(transcript, rows)
  if (!found.length) return null

  // The meeting in order: what was analysed live, and the gaps around it.
  const pieces = []
  let at = 0
  const gap = (text) => { for (const t of splitLines(text)) pieces.push({ text: t }) }
  for (const f of found) {
    if (transcript.slice(at, f.start).trim()) gap(transcript.slice(at, f.start))
    // `pending`: the stretch still being analysed when the meeting was finished.
    pieces.push(f.row.pending ? { text: f.row.text, pending: f.row.pending } : { result: fromRow(f.row) })
    at = f.end
  }
  if (transcript.slice(at).trim()) gap(transcript.slice(at))

  // Gaps are independent of each other given the stretch before each, so they
  // run side by side, next to any stretch still in flight: the end of the
  // meeting is the moment someone is waiting.
  const jobs = []
  let memory = '', prior = []
  for (const p of pieces) {
    if (p.result) { memory = p.result.memory || memory; prior = prior.concat(p.result.tasks); continue }
    const ctx = { ...opts, memory, priorTasks: prior }
    jobs.push(async () => { p.result = (p.pending && await p.pending) || await analyzeStretch(p.text, ctx) })
  }
  await inParallel(jobs, 4)

  const results = pieces.map((p) => p.result)
  const tasks = [], stretchOf = []
  results.forEach((r, i) => { for (const t of r.tasks || []) { tasks.push(t); stretchOf.push(i + 1) } })
  const endMemory = results.map((r) => r.memory).filter(Boolean).pop() || ''

  const stretches = results.map((r, i) => {
    const n = r.notes || {}
    const lines = [`[Stretch ${i + 1}]`]
    if (n.summary) lines.push(`Summary: ${n.summary}`)
    for (const [k, label] of NOTE_KEYS) if (n[k]?.length) lines.push(`${label}:\n${n[k].map((x) => `- ${x}`).join('\n')}`)
    return lines.join('\n')
  })
  const user = `Meeting date: ${opts.meetingDate || 'unknown'}
Meeting attendees:
${attendeeBlock(opts)}

THE MEETING, STRETCH BY STRETCH:
${stretches.join('\n\n')}

RUNNING MEMORY AT THE END OF THE MEETING:
${endMemory || '(none)'}

EVERY TASK FOUND (numbered, in the order they came up):
${tasks.map((t, i) => `#${i} [stretch ${stretchOf[i]}] ${taskLine(t)}${t.source_quote ? ` — "${clip(String(t.source_quote), 140)}"` : ''}`).join('\n') || '(none)'}`

  // Without this call the meeting still gets a summary — the end-of-meeting
  // memory, which describes all of it — and every task, undeduplicated beyond
  // persistMeeting's exact-title check. Worse than the real thing, far better
  // than throwing away an hour of analysis over one failed request.
  let finish = null
  try { finish = await completeJson(FINISH_SYSTEM, user, { onUsage: opts.onUsage }) }
  catch (err) { console.warn('[live-analysis] final summary failed, using the stretch notes:', err.message) }

  const s = finish?.json?.summary || {}
  const merged = dropDuplicates(tasks, finish?.json?.duplicates)
  const collected = (k) => [...new Set(results.flatMap((r) => r.notes?.[k] || []))]
  const summary = {
    executive_summary: str(s.executive_summary) || endMemory || results.map((r) => r.notes?.summary).filter(Boolean).join(' '),
  }
  for (const [k] of NOTE_KEYS) summary[k] = finish ? list(s[k]) : collected(k)
  // Built from the tasks rather than asked for: they are the tasks, and on a long
  // meeting writing them out again is most of the output — the slow part.
  summary.action_items = merged.map((t) => t.title)
  summary.assigned_tasks = merged.filter((t) => t.assignee_name_raw).map((t) => `${t.title} → ${t.assignee_name_raw}`)
  summary.unassigned_tasks = merged.filter((t) => !t.assignee_name_raw).map((t) => t.title)

  return {
    engine: finish?.engine || results.map((r) => r.engine).filter(Boolean).pop(),
    detected_languages: [...new Set(results.flatMap((r) => r.languages || []))],
    summary,
    tasks: merged,
    live: {
      reused: found.length - pieces.filter((p) => p.pending).length,
      in_flight: pieces.filter((p) => p.pending).length,
      analysed_at_end: pieces.filter((p) => p.text && !p.pending).length,
    },
  }
}
