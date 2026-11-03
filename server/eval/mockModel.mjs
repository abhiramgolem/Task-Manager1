// A stand-in meeting model, for trying the meeting analysis on localhost
// without an API key.
//
//   cd server && npm run mock:model          # listens on http://localhost:4199/v1
//
// then in server/.env:
//
//   OPENROUTER_API_KEY=mock
//   OPENROUTER_BASE_URL=http://localhost:4199/v1
//   MEETING_LIVE_CHUNK_SECONDS=60            # a stretch a minute, not every ten
//
// It speaks the OpenAI-compatible /chat/completions that ai/openrouter.js calls,
// recognises each of the app's meeting prompts, and answers with what the
// offline rule engine (ai/rules.js) finds in the text it was given — so the
// tasks are real ones from what was said, not canned. What it cannot do is
// think: summaries are stitched together, and duplicates are only exact ones.
//
// It also takes as long as a model would. A frontier model's time goes mostly on
// the tokens it WRITES, so a call waits BASE + input/PREFILL + output/DECODE
// seconds. That is the cost that made long meetings slow to finish, and the one
// the live analysis exists to move off the end of the meeting. MOCK_SPEED=10
// runs ten times faster with the same proportions (eval/liveMeeting.mjs does).
//
// It keys off phrases in the prompts in ai/openrouter.js and ai/liveAnalysis.js;
// a reworded prompt it no longer recognises is answered as a whole transcript.
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { analyzeTranscript } from '../src/ai/rules.js'

const BASE_S = 1.5
const PREFILL_TOK_PER_S = 6000
const DECODE_TOK_PER_S = 80
const tokens = (s) => Math.ceil(String(s).length / 4)

const after = (text, marker) => { const i = text.indexOf(marker); return i < 0 ? '' : text.slice(i + marker.length) }
const between = (text, a, b) => { const s = after(text, a); const j = s.indexOf(b); return j < 0 ? s : s.slice(0, j) }
const key = (title, owner) => `${String(title || '').toLowerCase().trim()}|${String(owner || '').toLowerCase().trim()}`

// "- Priya (manager, IT)" lines -> names the rule engine can resolve speakers to.
const attendees = (user) => [...between(user, 'Meeting attendees', '\n\n').matchAll(/^- ([^(\n]+?)(?: \(|$)/gm)].map((m) => m[1].trim())

function rules(text, user) {
  const meetingDate = (user.match(/Meeting date: (\d{4}-\d{2}-\d{2})/) || [])[1]
  return analyzeTranscript(text, { knownNames: attendees(user), meetingDate })
}

// A meeting repeats itself; a model reports each piece of work once, latest wording last.
function onePerTask(tasks) {
  const byKey = new Map()
  for (const t of tasks) { byKey.delete(key(t.title, t.assignee_name_raw)); byKey.set(key(t.title, t.assignee_name_raw), t) }
  return [...byKey.values()]
}

const modelTask = (t) => ({
  title: t.title, description: t.description, assignee_name: t.assignee_name_raw || null,
  assigned_by_name: t.assigned_by_name_raw || null, assignee_reasoning: t.assignee_reasoning,
  confidence: t.confidence, due_date: t.due_date, due_date_raw: t.due_date_raw, priority: t.priority,
  ownership_confidence: t.ownership_confidence, category: null, source_quote: t.source_quote, language: t.language,
})

function summaryOf(r) {
  const s = r.summary
  return {
    executive_summary: `(stand-in model) ${s.executive_summary}`,
    key_decisions: s.key_decisions, action_items: s.action_items, risks: s.risks, blockers: s.blockers,
    follow_ups: s.follow_ups, assigned_tasks: s.assigned_tasks, unassigned_tasks: s.unassigned_tasks,
  }
}

const uniq = (a) => [...new Set(a)]

function answer(system, user) {
  // ---- liveAnalysis.js: one stretch of a meeting still being recorded
  if (system.includes('STILL IN PROGRESS')) {
    const text = after(user, 'NEWEST STRETCH — extract from THIS text only:\n')
    const r = rules(text, user)
    const known = new Set([...between(user, 'TASKS ALREADY FOUND EARLIER IN THE MEETING:\n', '\n\nNEWEST STRETCH').matchAll(/^- (.+?) → (.+?)(?: \(due .*\))?$/gm)]
      .map((m) => key(m[1], m[2] === '(no owner yet)' ? '' : m[2])))
    const fresh = onePerTask(r.tasks).filter((t) => !known.has(key(t.title, t.assignee_name_raw)))
    const prev = between(user, 'RUNNING MEMORY (the meeting before this stretch):\n', '\n\n')
    const lines = text.split('\n').filter(Boolean).length
    return {
      kind: 'live stretch',
      json: {
        detected_languages: r.detected_languages,
        stretch_summary: `${lines} lines; ${fresh.length} new task(s).`,
        key_decisions: uniq(r.summary.key_decisions), risks: uniq(r.summary.risks),
        blockers: uniq(r.summary.blockers), follow_ups: uniq(r.summary.follow_ups),
        running_memory: `${prev.startsWith('(this is the start') ? '' : prev + ' '}Then: ${fresh.slice(0, 3).map((t) => t.title).join('; ') || 'discussion'}.`.slice(-1200),
        tasks: fresh.map(modelTask),
      },
    }
  }
  // ---- liveAnalysis.js: the final summary over all the stretches
  if (system.includes('FINAL summary of a meeting that was analysed stretch by stretch')) {
    const groups = new Map()
    for (const m of after(user, 'EVERY TASK FOUND (numbered, in the order they came up):\n').matchAll(/^#(\d+) \[stretch \d+\] (.+?) → (.+?)(?: \(due [^)]*\))?(?: — ".*")?$/gm)) {
      const k = key(m[2], m[3])
      groups.set(k, [Number(m[1]), ...(groups.get(k) || [])]) // latest first: it is the one kept
    }
    const listed = (label) => uniq([...user.matchAll(new RegExp(`^${label}:\\n((?:- .*\\n?)+)`, 'gm'))]
      .flatMap((m) => m[1].split('\n').filter(Boolean).map((l) => l.slice(2))))
    const stretches = (user.match(/^\[Stretch \d+\]$/gm) || []).length
    return {
      kind: 'final summary',
      json: {
        summary: {
          executive_summary: `(stand-in model) Meeting analysed in ${stretches} stretches. ${between(user, 'RUNNING MEMORY AT THE END OF THE MEETING:\n', '\n\n').slice(0, 600)}`,
          key_decisions: listed('Decisions'), risks: listed('Risks'), blockers: listed('Blockers'), follow_ups: listed('Follow-ups'),
        },
        duplicates: [...groups.values()].filter((g) => g.length > 1),
      },
    }
  }
  // ---- openrouter.js long-meeting path: one chunk (map) ...
  if (system.includes('ONE CHUNK of a longer meeting')) {
    const r = rules(user.split(/CURRENT CHUNK \(\d+ of \d+\) — extract tasks from THIS text only:\n/)[1] || '', user)
    return { kind: 'map chunk', json: { detected_languages: r.detected_languages, running_memory: 'Earlier: ' + onePerTask(r.tasks).slice(0, 5).map((t) => t.title).join('; '), tasks: onePerTask(r.tasks).map(modelTask) } }
  }
  // ---- ... and the reduce, which writes every task out again
  if (system.includes('FINAL synthesis')) {
    let all = []
    try { all = JSON.parse(after(user, 'ALL TASKS EXTRACTED ACROSS CHUNKS (raw, may contain duplicates):\n')) } catch {}
    const byKey = new Map()
    for (const t of all) byKey.set(key(t.title, t.assignee_name), t)
    return {
      kind: 'reduce',
      json: {
        detected_languages: ['en', 'hi', 'te'],
        summary: { executive_summary: '(stand-in model) Long meeting, reduced from chunks.', key_decisions: [], action_items: [...byKey.values()].map((t) => t.title), risks: [], blockers: [], follow_ups: [], assigned_tasks: [], unassigned_tasks: [] },
        tasks: [...byKey.values()],
      },
    }
  }
  // ---- openrouter.js single pass over a whole transcript
  const r = rules(after(user, 'TRANSCRIPT:\n') || user, user)
  return { kind: 'whole transcript', json: { detected_languages: r.detected_languages, summary: summaryOf(r), tasks: onePerTask(r.tasks).map(modelTask) } }
}

// `fail`: kinds of call ('live stretch', 'final summary', 'whole transcript', …)
// to answer with a 500, for testing what happens when the model is down.
export function startMockModel({ port = 4199, speed = Number(process.env.MOCK_SPEED) || 1, log = true } = {}) {
  const calls = []
  const fail = new Set()
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      try {
        const msgs = JSON.parse(body || '{}').messages || []
        const system = msgs.find((m) => m.role === 'system')?.content || ''
        const user = msgs.find((m) => m.role === 'user')?.content || ''
        const { kind, json } = answer(system, user)
        if (fail.has(kind)) {
          calls.push({ kind, failed: true })
          res.writeHead(500, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: { message: `stand-in model told to fail: ${kind}` } }))
        }
        const content = JSON.stringify(json)
        const inTok = tokens(system + user), outTok = tokens(content)
        const ms = Math.round(((BASE_S + inTok / PREFILL_TOK_PER_S + outTok / DECODE_TOK_PER_S) * 1000) / speed)
        await new Promise((r) => setTimeout(r, ms))
        calls.push({ kind, inTok, outTok, ms })
        if (log) console.log(`[mock-model] ${kind}: ${inTok} tokens in, ${outTok} out — ${(ms / 1000).toFixed(1)} s`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: err.message } }))
      }
    })
  })
  return new Promise((resolve) => server.listen(port, () => resolve({ server, port: server.address().port, calls, fail })))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port } = await startMockModel({ port: Number(process.env.MOCK_PORT) || 4199 })
  console.log(`Stand-in meeting model on http://localhost:${port}/v1 — point OPENROUTER_BASE_URL at it.`)
}
