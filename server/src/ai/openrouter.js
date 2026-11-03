// OpenRouter-powered multilingual meeting analysis (summary + task extraction).
// Used as the PRIMARY engine when OPENROUTER_API_KEY is set; the orchestrator
// falls back to Claude / OpenAI / rules if it is missing or errors.
//
// OpenRouter exposes an OpenAI-compatible /chat/completions API, so any model on
// the platform works by swapping OPENROUTER_MODEL. Default: google/gemini-2.5-pro
// (1M-token context + strong Telugu/Hindi/English understanding) — ideal for the
// long (2h+) code-mixed meetings this app handles.
//
// LONG-MEETING STRATEGY ("good memory"):
//   - Short transcripts are analyzed in ONE pass (best global coherence).
//   - Long transcripts use map-reduce with a ROLLING MEMORY: the transcript is
//     split into overlapping chunks; each chunk is analyzed with a running
//     summary of everything seen so far (so names/decisions/ownership stay
//     consistent across the whole meeting), then a final reduce step merges +
//     de-duplicates the tasks and synthesizes one cohesive summary.
import { detectLanguages } from './rules.js'

// Only these languages are ever reported — Telugu, Hindi, English. Anything else
// the model emits (ml, ta, kn, …) is dropped so other languages never leak through.
import { CATEGORY_LABELS } from '../categories.js'
const ALLOWED_LANGS = new Set(['en', 'hi', 'te'])
export const keepAllowedLangs = (val) =>
  (Array.isArray(val) ? val : String(val || '').split('+'))
    .map((s) => s.trim().toLowerCase())
    .filter((l) => ALLOWED_LANGS.has(l))

// Read per call, so a base URL set in .env is honoured whenever this module was
// first imported. Overridable for an OpenAI-compatible gateway, or for the
// stand-in model eval/liveMeeting.mjs runs on localhost.
const apiUrl = () => (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '') + '/chat/completions'

// ~4 chars/token. Below SINGLE_SHOT_CHARS we send the whole transcript at once;
// above it we map-reduce. Both are env-tunable for different models/limits.
const SINGLE_SHOT_CHARS = Number(process.env.OPENROUTER_SINGLESHOT_CHARS) || 280_000 // ~70k tokens
const CHUNK_CHARS = Number(process.env.OPENROUTER_CHUNK_CHARS) || 60_000             // ~15k tokens/chunk
const OVERLAP_CHARS = Number(process.env.OPENROUTER_OVERLAP_CHARS) || 2_000          // context bleed between chunks

const clampScore = (v, fallback) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback
}

export const LANGUAGE_RULE = `The conversation may be in English, Hindi, Telugu, or any code-mixed combination (e.g. "Ravi, deployment documentation ready cheyyandi by tomorrow"). You MUST understand all of these, including regional accents, informal workplace phrasing, and mixed scripts.
ALWAYS write summaries, decisions, action items, and every task title/description in ENGLISH, translating as needed. The ONLY field that stays in the original spoken language is source_quote (cite the exact transcript line verbatim).
detected_languages MUST ONLY contain codes from this exact set: "en" (English), "hi" (Hindi), "te" (Telugu). Include a code only if that language is actually spoken in the transcript. NEVER output any other language code (no mr, pa, gu, bn, ml, etc.) — Hindi and Telugu are the only Indian languages to report; treat related Indian languages as Hindi.`

export const TASK_RULES = `Rules for task extraction:
- A task exists whenever someone is asked to do something OR commits to doing something, even across mixed languages.
- assignee_name = who must execute. assigned_by_name = who gave the task (usually the speaker).
- Each task has exactly ONE assignee. If one sentence assigns DIFFERENT work to DIFFERENT people, output a SEPARATE task per person. Never merge two people's work into one task.
- assignee_name MUST be chosen from the provided meeting attendees only. NEVER assign work to someone not in the attendee list unless they are explicitly named in the transcript. Use attendees' roles/departments as context to pick the best owner.
- If ownership is unclear, set ownership_confidence to "needs_confirmation" and leave assignee_name null.
- assignee_reasoning = a short English sentence explaining WHY this person was chosen.
- confidence = integer 0-100 (direct name mention => 85-95; inferred from role/context => 50-75; unclear => below 40).
- priority is one of Critical | High | Medium | Low (production issue/ASAP/today => higher; future/enhancement => Low).
- due_date_raw = the natural-language deadline phrase exactly as spoken ("by Friday", "repu", "kal", "before deployment"); null if none.
- due_date = absolute YYYY-MM-DD resolved relative to the meeting date when possible.
- source_quote = the exact transcript sentence (original language) that produced the task.
- category = which business unit / brand the task belongs to, chosen ONLY from: ${CATEGORY_LABELS.join(', ')}. Use the meeting's overall topic as context. If it clearly fits none, set null. NEVER invent a category outside this list.
- Ignore greetings, introductions, jokes, and casual side discussions. Extract ONLY actionable work items.`

export const TASK_SHAPE = `"tasks": [{
  "title":"... (English)","description":"... (English)","assignee_name":"...|null","assigned_by_name":"...|null",
  "assignee_reasoning":"... (English)","confidence":85,
  "due_date":"YYYY-MM-DD|null","due_date_raw":"...|null","priority":"High",
  "ownership_confidence":"high|low|needs_confirmation","category":"${CATEGORY_LABELS[0]}|null","source_quote":"... (original language)","language":"en+te"
}]`

// One-shot prompt: full transcript -> complete analysis.
const SINGLE_SYSTEM = `You are an expert multilingual meeting analyst for an enterprise task-management platform.
${LANGUAGE_RULE}

Your job: read a meeting transcript and extract structured data.

${TASK_RULES}
- Merge duplicate action items that describe the same work for the same person into ONE task.

Respond with ONLY a JSON object (no markdown) matching this shape:
{
  "detected_languages": ["en","hi","te"],
  "participants": ["..."],
  "summary": {
    "executive_summary":"... (English, covers the meeting's key concepts and outcomes)",
    "key_decisions":["... (English)"],
    "action_items":["... (English)"],
    "risks":["... (English)"],
    "blockers":["... (English)"],
    "follow_ups":["... (English)"],
    "assigned_tasks":["... (English)"],
    "unassigned_tasks":["... (English)"]
  },
  ${TASK_SHAPE}
}`

// Map prompt: ONE chunk of a longer meeting, with rolling memory for continuity.
const MAP_SYSTEM = `You are an expert multilingual meeting analyst. You are analyzing ONE CHUNK of a longer meeting.
${LANGUAGE_RULE}

You are given a RUNNING MEMORY summarizing earlier parts of the meeting (decisions made, who owns what, open threads). Use it for context so names, ownership, and deadlines stay consistent — but extract tasks ONLY from the CURRENT CHUNK below (do not re-extract tasks already covered by the running memory).

${TASK_RULES}

Respond with ONLY a JSON object (no markdown):
{
  "detected_languages": ["en","hi","te"],
  "running_memory":"... (English, <=200 words: an UPDATED running summary covering the meeting THROUGH this chunk — decisions, risks, blockers, and who owns what. This is fed into the next chunk, so be concise but complete.)",
  ${TASK_SHAPE}
}`

// Reduce prompt: merge all chunk outputs into one cohesive analysis.
const REDUCE_SYSTEM = `You are an expert meeting analyst performing the FINAL synthesis of a long meeting that was analyzed in chunks.
You are given (a) the running memories produced for each chunk and (b) the combined raw list of tasks extracted across all chunks.

Your job:
1. Produce ONE cohesive summary of the meeting's key concepts and outcomes, written in ENGLISH.
2. De-duplicate and merge the tasks: combine tasks that describe the same work for the same person into ONE; keep distinct work separate; preserve the best source_quote and the highest-confidence assignee for each.

Respond with ONLY a JSON object (no markdown) matching this shape:
{
  "detected_languages": ["en","hi","te"],
  "participants": ["..."],
  "summary": {
    "executive_summary":"... (English, covers the whole meeting's key concepts and outcomes)",
    "key_decisions":["..."],"action_items":["..."],"risks":["..."],"blockers":["..."],
    "follow_ups":["..."],"assigned_tasks":["..."],"unassigned_tasks":["..."]
  },
  ${TASK_SHAPE}
}`

// --- HTTP -------------------------------------------------------------------

// timeoutMs: the meeting paths below have never had one and keep it that way;
// the live analysis (liveAnalysis.js) passes one, since a request that hangs
// there would stall every later stretch of the same meeting behind it.
export async function callOpenRouter(systemPrompt, userMsg, { timeoutMs } = {}) {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error('No OPENROUTER_API_KEY')
  // Deliberately NOT the generic OPENROUTER_MODEL: that var is tuned for voice
  // latency (flash-class), and meeting extraction is the opposite trade — the
  // hardest job in the app, run rarely, where quality is everything. It gets its
  // own var and a frontier default so a latency tweak can never quietly downgrade
  // every meeting analysis again.
  const model = process.env.OPENROUTER_MEETING_MODEL || 'google/gemini-2.5-pro'

  const res = await fetch(apiUrl(), {
    method: 'POST',
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      // Optional attribution headers recommended by OpenRouter.
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'SmartTask AI',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content || '{}'
  return parseJson(text)
}

// Robust JSON extraction: strip markdown fences, then slice the outermost braces.
function parseJson(text) {
  let t = String(text).trim()
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('OpenRouter returned no JSON object')
  return JSON.parse(t.slice(start, end + 1))
}

// Normalize a model task into the internal shape persistMeeting expects.
export function normalizeTask(t) {
  return {
    title: t.title,
    description: t.description || t.title,
    assignee_name_raw: t.assignee_name || null,
    assigned_by_name_raw: t.assigned_by_name || null,
    assignee_reasoning: t.assignee_reasoning || null,
    confidence: clampScore(t.confidence, t.assignee_name ? 80 : 30),
    due_date: t.due_date || null,
    due_date_raw: t.due_date_raw || null,
    priority: ['Critical', 'High', 'Medium', 'Low'].includes(t.priority) ? t.priority : 'Medium',
    ownership_confidence: t.ownership_confidence || (t.assignee_name ? 'high' : 'needs_confirmation'),
    category: t.category || null, // validated/normalised later by persistMeeting
    source_quote: t.source_quote || t.description || t.title,
    language: keepAllowedLangs(t.language).join('+') || detectLanguages(t.source_quote || t.title || '').join('+'),
  }
}

// --- Chunking ---------------------------------------------------------------

// Split text into ~CHUNK_CHARS pieces, breaking on a paragraph/sentence boundary
// near the limit so we don't cut mid-sentence, with a small overlap for context.
function chunkTranscript(text) {
  const chunks = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(i + CHUNK_CHARS, text.length)
    if (end < text.length) {
      const slice = text.slice(i, end)
      // Prefer a newline boundary, then a sentence end, within the last 25%.
      const win = Math.floor(CHUNK_CHARS * 0.25)
      const nl = slice.lastIndexOf('\n')
      const dot = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '))
      if (nl > CHUNK_CHARS - win) end = i + nl + 1
      else if (dot > CHUNK_CHARS - win) end = i + dot + 2
    }
    chunks.push(text.slice(i, end))
    if (end >= text.length) break
    i = Math.max(end - OVERLAP_CHARS, i + 1)
  }
  return chunks
}

export function attendeeBlock(opts) {
  const lines = (opts.attendees || []).length
    ? opts.attendees.map((a) => `- ${a.name}${a.role ? ` (${a.role}` : ''}${a.department ? `, ${a.department}` : ''}${a.role || a.department ? ')' : ''}`).join('\n')
    : (opts.knownNames || []).map((n) => `- ${n}`).join('\n') || 'none provided'
  return lines
}

// --- Public entry -----------------------------------------------------------

export async function analyzeWithOpenRouter(transcript, opts = {}) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('No OPENROUTER_API_KEY')
  const text = String(transcript || '')
  const attendees = attendeeBlock(opts)
  const meetingDate = opts.meetingDate || 'unknown'

  let parsed
  if (text.length <= SINGLE_SHOT_CHARS) {
    // --- One-shot path -------------------------------------------------------
    const userMsg = `Meeting date: ${meetingDate}
Meeting attendees (assign tasks ONLY to these people):
${attendees}

Write all summary fields and task text in ENGLISH. Keep source_quote in the original language.

TRANSCRIPT:
${text}`
    parsed = await callOpenRouter(SINGLE_SYSTEM, userMsg)
  } else {
    // --- Map-reduce path (long meeting) -------------------------------------
    const chunks = chunkTranscript(text)
    console.log(`[openrouter] long meeting: ${text.length} chars -> ${chunks.length} chunks (map-reduce)`)
    const allTasks = []
    const memories = []
    let rolling = '(start of meeting — no prior context yet)'

    for (let c = 0; c < chunks.length; c++) {
      const userMsg = `Meeting date: ${meetingDate}
Meeting attendees (assign tasks ONLY to these people):
${attendees}

RUNNING MEMORY (everything established in the meeting before this chunk):
${rolling}

CURRENT CHUNK (${c + 1} of ${chunks.length}) — extract tasks from THIS text only:
${chunks[c]}`
      let chunkResult
      try {
        chunkResult = await callOpenRouter(MAP_SYSTEM, userMsg)
      } catch (err) {
        console.warn(`[openrouter] chunk ${c + 1}/${chunks.length} failed: ${err.message}`)
        continue
      }
      for (const t of chunkResult.tasks || []) allTasks.push(t)
      if (chunkResult.running_memory) { rolling = chunkResult.running_memory; memories.push(rolling) }
      console.log(`[openrouter] chunk ${c + 1}/${chunks.length}: +${(chunkResult.tasks || []).length} task(s)`)
    }

    // Reduce: synthesize one summary + de-dupe tasks across all chunks.
    const reduceMsg = `Meeting date: ${meetingDate}
Meeting attendees (assign tasks ONLY to these people):
${attendees}

PER-CHUNK RUNNING MEMORIES (in order):
${memories.map((m, idx) => `[part ${idx + 1}] ${m}`).join('\n\n')}

ALL TASKS EXTRACTED ACROSS CHUNKS (raw, may contain duplicates):
${JSON.stringify(allTasks, null, 1)}`
    parsed = await callOpenRouter(REDUCE_SYSTEM, reduceMsg)
    // Safety net: if the reduce dropped tasks entirely, keep the raw union.
    if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) parsed.tasks = allTasks
  }

  parsed.tasks = (parsed.tasks || []).map(normalizeTask)
  parsed.engine = 'openrouter'
  // Whitelist to en/hi/te; fall back to script detection (also en/hi/te only).
  parsed.detected_languages = keepAllowedLangs(parsed.detected_languages)
  if (!parsed.detected_languages.length) parsed.detected_languages = detectLanguages(text)
  return parsed
}
