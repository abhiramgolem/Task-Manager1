// Live meeting analysis, end to end on localhost.
//
//   cd server && npm run eval:live                  # stand-in model, no key needed (~4 min)
//   cd server && npm run eval:live -- --hours 1     # a shorter meeting, quicker run
//   cd server && npm run eval:live -- --real        # your OPENROUTER_API_KEY from .env (costs money, slow)
//
// Starts its own server on a throwaway database in the OS temp folder — never
// server/data — and records a long multilingual meeting through the same draft
// API the recorder uses, in fast-forward: the transcript grows and the
// recording clock advances, and after every push it waits for any stretch the
// server started analysing, as a real meeting would give it ten minutes to.
// Then it times three things:
//
//   1. Finishing that meeting (POST /meetings with its draft_id): only the last
//      few minutes are read, plus one call that writes the summary.
//   2. The same transcript analysed the old way, whole, at the end.
//   3. The edge cases — a stretch edited after it was analysed (it must be read
//      again), Analyze pressed while a stretch is still in flight (it must be
//      waited on, not read twice), and, with the stand-in, the model failing at
//      the end (the meeting must still come out, from the notes or from the
//      offline engine).
//
// With the stand-in model (eval/mockModel.mjs) the times are simulated: a call
// takes as long as its tokens would on a frontier model, run MOCK_SPEED times
// faster. The ratio between 1 and 2 is the point, not the seconds.
import 'dotenv/config'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { startMockModel } from './mockModel.mjs'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, d) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : d }
const REAL = flag('real')
const HOURS = Number(opt('hours', 3))
const SPEED = Number(opt('speed', process.env.MOCK_SPEED || 10))
const INTERVAL = 600 // the production default: a stretch every ten minutes of recording

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

// ---- A meeting -----------------------------------------------------------------
// Deterministic, so two runs are comparable. ~8 lines a minute, English with
// Telugu and Hindi code-mixing, real assignments among the seeded users, status
// chatter that is not work, and earlier requests repeated later in the meeting —
// a model must report those once, not once per stretch.
function makeMeeting(hours) {
  let seed = 7
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const people = ['Munidhar', 'Ravi', 'Anjali', 'Karthik']
  const things = ['the vendor contract', 'the payment gateway logs', 'the Q3 sales report', 'the onboarding deck', 'the warehouse invoice',
    'the mobile release notes', 'the client demo script', 'the pricing sheet', 'the courier booking', 'the GST filing', 'the hiring plan',
    'the dashboard filters', 'the API rate limits', 'the store banner', 'the refund policy', 'the supplier list', 'the trade show booth',
    'the shipping labels', 'the sprint board', 'the login bug', 'the backup schedule', 'the training video', 'the price list for Hyderabad',
    'the Diwali campaign', 'the audit checklist', 'the server migration', 'the customer survey', 'the product photos', 'the stock count']
  const verbs = ['prepare', 'review', 'send', 'update', 'fix', 'share', 'finalise', 'check']
  const dues = ['by Friday', 'by tomorrow', 'by next Monday', 'by end of week', 'by Thursday']
  const asked = []
  const lines = []
  for (let t = 0; t < hours * 3600; t += 7) {
    const p = pick(people), thing = pick(things), verb = pick(verbs), due = pick(dues)
    const r = rnd()
    let line
    if (r < 0.10) { line = `Priya: ${p}, can you ${verb} ${thing} ${due}?`; asked.push(line) }
    else if (r < 0.14) line = `Priya: ${p}, ${thing} ${verb} cheyyandi ${due}.`
    else if (r < 0.17) line = `Priya: ${p}, ${thing} ${verb} kar do ${due}.`
    else if (r < 0.20) line = `${p}: I will ${verb} ${thing} ${due}.`
    else if (r < 0.23 && asked.length) line = pick(asked) // the same request, again
    else if (r < 0.26) line = `Priya: We decided to go with the second option for ${thing}.`
    else if (r < 0.29) line = `${p}: There is a risk that ${thing} might delay the launch.`
    else if (r < 0.31) line = `${p}: We are blocked on ${thing}, waiting on the vendor.`
    else if (r < 0.33) line = `${p}: ${thing} gurinchi ippudu discuss chestunnam, status bagundi.`
    else if (r < 0.35) line = `${p}: ${thing} ka kaam chal raha hai, thoda time lagega.`
    else line = pick([
      `${p}: ${thing} is about ${10 + Math.floor(rnd() * 80)} percent done.`,
      `Priya: Okay, sounds good, let us move on.`,
      `${p}: Customer feedback on ${thing} was mostly positive.`,
      `Priya: Any questions on ${thing}?`,
      `${p}: No questions from my side.`,
      `${p}: Last week we finished most of ${thing}.`,
    ])
    lines.push({ t, line })
  }
  return lines
}

// ---- Plumbing --------------------------------------------------------------------
let base, H
async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: H, body: body ? JSON.stringify(body) : undefined })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${data.error || ''}`)
  return data
}

// Record `lines` up to `untilSeconds`, pushing every simulated minute the way the
// recorder pushes every few seconds, and let any stretch the server starts finish
// before moving on. Returns the draft id and the transcript as pushed.
async function record(lines, untilSeconds, participantIds, { quiet = false } = {}) {
  const { id } = await call('POST', '/api/meetings/draft', { title: 'Eval meeting' })
  let transcript = '', parts = 0
  for (let minute = 1; minute * 60 <= untilSeconds; minute++) {
    transcript = lines.filter((l) => l.t < minute * 60).map((l) => l.line).join('\n') + '\n'
    await call('PATCH', `/api/meetings/draft/${id}`, { transcript, seconds: minute * 60, participant_ids: participantIds })
    let live = await call('GET', `/api/meetings/draft/${id}/live`)
    while (live.running) { await sleep(100); live = await call('GET', `/api/meetings/draft/${id}/live`) }
    if (live.parts > parts && !quiet) console.log(`  ${mmss(minute * 60)}  stretch ${live.parts} analysed while recording — first ${mmss(live.analysed_seconds)} done, ${live.tasks.length} task(s) so far`)
    parts = live.parts
  }
  return { id, transcript, parts }
}

async function finish(id, transcript, participantIds) {
  const t0 = Date.now()
  const r = await call('POST', '/api/meetings', { title: 'Eval meeting (live)', transcript, participant_ids: participantIds, draft_id: id })
  const ms = Date.now() - t0
  await call('DELETE', `/api/meetings/draft/${id}`)
  return { ms, ...r }
}

async function meetingStats(id) {
  const m = await call('GET', `/api/meetings/${id}`)
  const points = ['key_decisions', 'risks', 'blockers', 'follow_ups', 'action_items'].flatMap((k) => m.summary[k] || [])
  return {
    tasks: new Set(m.suggestions.map((s) => `${s.title.toLowerCase()}|${s.suggested_assignee_id || ''}`)),
    suggestions: m.suggestions.length,
    summary: (m.summary.executive_summary || '').length > 0,
    points: points.length,
    cited: points.filter((p) => p && p.evidence).length,
  }
}

// ---- Run ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'votask-live-eval-'))
let child, mock
const results = []
const check = (ok, what) => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`) }
try {
  if (REAL && !process.env.OPENROUTER_API_KEY) throw new Error('--real needs OPENROUTER_API_KEY in server/.env')
  const env = {
    ...process.env, DB_PATH: path.join(tmp, 'eval.db'), PORT: String(await freePort()), MEETING_LIVE_CHUNK_SECONDS: String(INTERVAL),
    MEETING_LIVE_ANALYSIS: 'on',
    // Nothing from this throwaway org may leave the machine.
    CLIQ_WEBHOOK_URL: '', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', TASK_MAIL_TO_OWNERS: 'false', TASK_MAIL_TEST_TO: '', FIREBASE_SERVICE_ACCOUNT: '',
  }
  if (!REAL) {
    mock = await startMockModel({ port: 0, speed: SPEED, log: false })
    Object.assign(env, {
      OPENROUTER_API_KEY: 'mock', OPENROUTER_BASE_URL: `http://127.0.0.1:${mock.port}/v1`,
      ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', VOYAGE_API_KEY: '',
    })
  }
  console.log(`Model: ${REAL ? `OpenRouter (${process.env.OPENROUTER_MEETING_MODEL || 'google/gemini-2.5-pro'})` : `stand-in, ${SPEED}× faster than a frontier model would be`}`)
  console.log(`Server: throwaway database in ${tmp}`)
  child = spawn(process.execPath, ['src/index.js'], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let serverLog = ''
  child.stdout.on('data', (d) => { serverLog += d })
  child.stderr.on('data', (d) => { serverLog += d })
  base = `http://127.0.0.1:${env.PORT}`
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + '/api/health')).ok) break } catch {}
    if (i > 100) throw new Error('server did not start:\n' + serverLog)
    await sleep(200)
  }
  const login = await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'priya@demo.io', password: 'password123' }) })).json()
  H = { 'content-type': 'application/json', authorization: 'Bearer ' + login.token }
  const people = (await call('GET', '/api/users')).map((u) => u.id)

  // 1 + 2: a long meeting, finished live and the old way.
  const length = Math.round(HOURS * 3600 + 6 * 60) // stops six minutes past a stretch boundary
  const lines = makeMeeting(length / 3600)
  console.log(`\nRecording a ${mmss(length)} meeting in fast-forward (${lines.length} lines):`)
  const rec = await record(lines, length, people)
  console.log(`  ${mmss(length)}  Stop. ${rec.transcript.length.toLocaleString()} characters; ${rec.parts} stretches already analysed.`)

  console.log('\nAnalyze pressed:')
  if (mock) mock.calls.length = 0
  const live = await finish(rec.id, rec.transcript, people)
  const liveCalls = mock ? mock.calls.map((c) => c.kind).join(', ') : ''
  console.log(`  with live analysis:   ${secs(live.ms)}  (${live.live?.reused} stretches reused, ${live.live?.analysed_at_end} read at the end${liveCalls ? `; model calls: ${liveCalls}` : ''})`)
  if (mock) mock.calls.length = 0
  const t0 = Date.now()
  const whole = await call('POST', '/api/meetings', { title: 'Eval meeting (whole)', transcript: rec.transcript, participant_ids: people })
  const wholeMs = Date.now() - t0
  const wholeCalls = mock ? `${mock.calls.length} model call(s)` : ''
  console.log(`  whole transcript:     ${secs(wholeMs)}  (the old path${wholeCalls ? `; ${wholeCalls}` : ''})`)
  console.log(`  → ${(wholeMs / live.ms).toFixed(1)}× faster to finish`)

  const a = await meetingStats(live.id), b = await meetingStats(whole.id)
  const shared = [...a.tasks].filter((k) => b.tasks.has(k)).length
  console.log(`\nResult: ${a.suggestions} suggested tasks live vs ${b.suggestions} whole; ${shared} identical (title + owner). Summary points cited: ${a.cited}/${a.points}.`)
  console.log('\nChecks:')
  check(rec.parts >= Math.floor(HOURS * 3600 / INTERVAL) - 1, `a stretch analysed about every ten minutes of recording (${rec.parts})`)
  check(live.live && live.live.reused === rec.parts && live.live.analysed_at_end === 1, 'finishing read only the last few minutes')
  check(live.ms < wholeMs, 'finishing live was faster than reading the whole transcript')
  check(a.summary && a.suggestions > 0 && a.cited === a.points, 'the meeting has a summary, suggested tasks, and every summary point cited')
  if (!REAL) check(shared / Math.max(a.tasks.size, b.tasks.size) > 0.8, 'live and whole found substantially the same tasks (same stand-in model)')

  // 3a: a stretch edited after it was analysed is read again.
  const short = makeMeeting(0.75)
  const edited = await record(short, 36 * 60, people, { quiet: true })
  const fixed = edited.transcript.replace('Munidhar', 'Munidhar Reddy') // fix a name in the first stretch
  const e = await finish(edited.id, fixed, people)
  check(fixed !== edited.transcript && e.live && e.live.reused === edited.parts - 1 && e.live.analysed_at_end === 2,
    `a name fixed in an analysed stretch: that stretch read again, the others reused (${e.live?.reused} reused, ${e.live?.analysed_at_end} read)`)

  // 3b: Analyze pressed while a stretch is in flight waits for it.
  const busy = await record(short, 25 * 60, people, { quiet: true })
  const more = short.filter((l) => l.t < 31 * 60).map((l) => l.line).join('\n') + '\n'
  await call('PATCH', `/api/meetings/draft/${busy.id}`, { transcript: more, seconds: 31 * 60, participant_ids: people })
  const running = (await call('GET', `/api/meetings/draft/${busy.id}/live`)).running
  const f = await finish(busy.id, more, people)
  check(running && f.live && f.live.in_flight === 1 && f.live.reused === busy.parts,
    `Analyze during a stretch in flight: waited on it, not read twice (in flight ${f.live?.in_flight}, reused ${f.live?.reused})`)

  // 3c, 3d: the model failing must never cost the meeting.
  if (mock) {
    const s1 = await record(short, 36 * 60, people, { quiet: true })
    mock.fail.add('final summary')
    const g = await finish(s1.id, s1.transcript, people)
    mock.fail.clear()
    const gm = await meetingStats(g.id)
    check(g.live && gm.summary && gm.suggestions > 0, `final summary call fails: the meeting still gets a summary (from the stretch notes) and its ${gm.suggestions} tasks`)

    const s2 = await record(short, 36 * 60, people, { quiet: true })
    for (const k of ['live stretch', 'final summary', 'whole transcript', 'map chunk', 'reduce']) mock.fail.add(k)
    const d = await finish(s2.id, s2.transcript, people)
    mock.fail.clear()
    const dm = await meetingStats(d.id)
    check(!d.live && d.engine === 'rule-based' && dm.suggestions > 0, `model down at the end: falls back to the whole transcript and the offline engine (${d.engine}, ${dm.suggestions} tasks)`)
  }

  // The recording drafts are gone, and their stretches with them.
  const left = await call('GET', '/api/meetings/draft')
  check(left === null, 'no recording left behind')

  console.log(results.every(Boolean) ? '\nAll checks passed.' : '\nSome checks FAILED.')
  process.exitCode = results.every(Boolean) ? 0 : 1
} catch (err) {
  console.error('\nEval failed:', err.message)
  process.exitCode = 1
} finally {
  child?.kill()
  mock?.server.close()
  await sleep(300)
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}
