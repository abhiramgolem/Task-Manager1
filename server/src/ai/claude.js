// Claude-powered multilingual meeting analysis.
// Used when ANTHROPIC_API_KEY is set; otherwise the orchestrator falls back to rules.js.
import { detectLanguages } from './rules.js'
import { CATEGORY_LABELS } from '../categories.js'

// Only Telugu, Hindi and English are ever reported; drop anything else the model emits.
const ALLOWED_LANGS = new Set(['en', 'hi', 'te'])
const keepAllowedLangs = (val) =>
  (Array.isArray(val) ? val : String(val || '').split('+'))
    .map((s) => s.trim().toLowerCase())
    .filter((l) => ALLOWED_LANGS.has(l))

const API_URL = 'https://api.anthropic.com/v1/messages'

// Coerce a model-provided confidence into a 0-100 integer, with a fallback.
const clampScore = (v, fallback) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback
}

const SYSTEM_PROMPT = `You are an expert multilingual meeting analyst for an enterprise task-management platform.
The conversation may be in English, Hindi, Telugu, or any code-mixed combination (e.g. "Ravi, deployment documentation ready cheyyandi by tomorrow").
You MUST understand all of these, including regional accents, informal workplace phrasing, and mixed scripts.

Your job: read a meeting transcript and extract structured data.

LANGUAGE RULE (very important): ALWAYS write the summary, key_decisions, action_items, risks, blockers, follow_ups, and every task title and description in ENGLISH, even when the meeting is spoken in Telugu, Hindi, or a mix. Translate as needed. The ONLY field that keeps the original spoken language is source_quote (cite the exact transcript line verbatim).

Rules for task extraction:
- A task exists whenever someone is asked to do something OR commits to doing something, even across mixed languages.
- assignee_name = who must execute. assigned_by_name = who gave the task (usually the speaker).
- Each task has exactly ONE assignee. If a single sentence assigns DIFFERENT work to DIFFERENT people (e.g. "assign task to Munidhar prepare doc, assign task to Reddeppa close the task"), output a SEPARATE task per person — one for Munidhar ("prepare doc") and one for Reddeppa ("close the task"). Never merge two people's work into one task.
- If ownership is unclear, set ownership_confidence to "needs_confirmation" and leave assignee_name null.
- priority is one of Critical | High | Medium | Low. Infer from urgency cues (production issue/ASAP/today=>higher; future/enhancement=>Low).
- due_date_raw = the natural-language deadline phrase exactly as spoken (e.g. "by Friday", "repu", "kal", "before deployment"); leave null if none.
- Also resolve due_date to an absolute YYYY-MM-DD relative to the meeting date when possible.
- source_quote = the exact transcript sentence (original language) that produced the task.
- assignee_name MUST be chosen from the provided meeting attendees only. NEVER assign work to someone who is not in the attendee list, unless they are explicitly named in the transcript. Use the attendees' roles/departments as context to pick the best owner.
- assignee_reasoning = a short sentence explaining WHY this person was chosen (e.g. "Directly addressed by name", "Owns the QA area and the task is testing").
- confidence = an integer 0-100 reflecting how sure you are about the assignee (direct name mention => 85-95; inferred from role/context => 50-75; unclear => below 40).
- category = which business unit / brand the task belongs to, chosen ONLY from: ${CATEGORY_LABELS.join(', ')}. Use the meeting's overall topic as context. Set null if it clearly fits none. NEVER invent a category outside this list.

Accuracy rules:
- Ignore greetings, introductions, jokes, and casual side discussions. Extract ONLY actionable work items.
- Merge duplicate action items that describe the same work for the same person into ONE task.

Respond with ONLY a JSON object, no markdown, matching this shape:
{
  "detected_languages": ["en","hi","te"],
  "participants": ["..."],
  "segments": [{"seq":0,"speaker":"...","text":"...","language":"en+te"}],
  "summary": {
    "executive_summary":"...",
    "key_decisions":["..."],
    "action_items":["..."],
    "risks":["..."],
    "blockers":["..."],
    "follow_ups":["..."],
    "assigned_tasks":["..."],
    "unassigned_tasks":["..."]
  },
  "tasks": [{
    "title":"...","description":"...","assignee_name":"...|null","assigned_by_name":"...|null",
    "assignee_reasoning":"...","confidence":85,
    "due_date":"YYYY-MM-DD|null","due_date_raw":"...|null","priority":"High",
    "ownership_confidence":"high|low|needs_confirmation","category":"${CATEGORY_LABELS[0]}|null","source_quote":"...","language":"en+te"
  }]
}`

// One system + user turn in, the JSON object in the reply out. Shared with the
// live analysis (liveAnalysis.js), which asks with its own prompts.
export async function claudeJson(system, userMsg, { maxTokens = 4096, timeoutMs } = {}) {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('No ANTHROPIC_API_KEY')
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8'
  const res = await fetch(API_URL, {
    method: 'POST',
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userMsg }],
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Claude API ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = await res.json()
  const text = (data.content || []).map((c) => c.text || '').join('')
  const jsonStr = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  return JSON.parse(jsonStr)
}

export async function analyzeWithClaude(transcript, opts = {}) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('No ANTHROPIC_API_KEY')

  // Attendees with role/department context; assignees must come from this list.
  const attendeeLines = (opts.attendees || []).length
    ? opts.attendees.map((a) => `- ${a.name}${a.role ? ` (${a.role}` : ''}${a.department ? `, ${a.department}` : ''}${a.role || a.department ? ')' : ''}`).join('\n')
    : (opts.knownNames || []).map((n) => `- ${n}`).join('\n') || 'none provided'

  const userMsg = `Meeting date: ${opts.meetingDate || 'unknown'}
Meeting attendees (assign tasks ONLY to these people):
${attendeeLines}
Summary language requested: ${opts.summaryLanguage || 'en'}

TRANSCRIPT:
${transcript}`

  const parsed = await claudeJson(SYSTEM_PROMPT, userMsg)

  // normalize to internal shape (assignee_name_raw / assigned_by_name_raw)
  parsed.tasks = (parsed.tasks || []).map((t) => ({
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
    category: t.category || null,
    source_quote: t.source_quote || t.description || t.title,
    language: keepAllowedLangs(t.language).join('+') || detectLanguages(t.source_quote || t.title).join('+'),
  }))
  parsed.engine = 'claude'
  parsed.detected_languages = keepAllowedLangs(parsed.detected_languages)
  if (!parsed.detected_languages.length) parsed.detected_languages = detectLanguages(transcript)
  return parsed
}
