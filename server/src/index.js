import './crashLog.js' // MUST be first — installs the crash handlers before any other module body runs
import 'dotenv/config'
import express from 'express'
import './asyncErrors.js' // before any request: async route errors reach the error middleware
import { rateLimit } from './rateLimit.js'
import { uploadsBlocked } from './fileStore.js'
import cors from 'cors'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import './restore.js' // MUST come before db.js — restores real data before the DB is opened
import { initSchema, db } from './db.js'
import { ensureSeed } from './seed.js'

import authRoutes from './routes/auth.js'
import inviteRoutes from './routes/invites.js'
import joinRoutes from './routes/join.js'
import userRoutes from './routes/users.js'
import meetingRoutes from './routes/meetings.js'
import taskRoutes from './routes/tasks.js'
import dashboardRoutes from './routes/dashboards.js'
import assistantRoutes from './routes/assistant.js'
import notificationRoutes from './routes/notifications.js'
import digestRoutes from './routes/digest.js'
import chatRoutes, { callLiveHooks } from './routes/chat.js'
import dailyUpdateRoutes from './routes/dailyUpdates.js'
import platformRoutes from './routes/platform.js'
import usageRoutes from './routes/usage.js'
import scoreRoutes from './routes/scores.js'
import feedbackRoutes from './routes/feedback.js'
import ttsRoutes from './routes/tts.js'
import apiKeyRoutes from './routes/apiKeys.js'
import departmentRoutes from './routes/departments.js'
import mcpRoutes from './routes/mcp.js'
import uploadRoutes from './routes/uploads.js'
import attendanceRoutes from './routes/attendance.js'
import { startScheduler } from './scheduler.js'
import { backfillChatTaskFiles } from './taskFromMessage.js'
import { seedUpdateCards } from './seedUpdateCards.js'
import { attachLiveTranscribe, attachAssistantLive, attachCallLive } from './ws/liveTranscribe.js'
import { attachChatHub } from './ws/chatHub.js'
import { hasEmbeddings, embedModel } from './ai/embeddings.js'
import { syncAll } from './ai/ragIndex.js'
import { warmRagSearch } from './ai/ragRetrieve.js'

initSchema()
ensureSeed()
try { backfillChatTaskFiles() } catch (e) { console.error('[task] chat file backfill failed:', e.message) }

const app = express()
// Render puts one proxy in front of us; without this every request comes from
// the proxy's address, so per-IP login limits would lock out the whole company.
app.set('trust proxy', 1)
// The Android app is cross-origin and sends an Authorization header, so every
// request it makes is preceded by a CORS preflight — which browsers cache for
// 5 s unless told otherwise. A file going up in chunks makes many requests to
// one URL over minutes; ten minutes means one preflight, not one per chunk.
app.use(cors({ maxAge: 600 }))
app.use(express.json({ limit: '5mb' }))

// Sign-in and sign-up are open to anyone, and each attempt costs a password hash
// (rateLimit.js). Per address it is generous — a whole office shares one public
// IP, and after a deploy everybody signs in at once — and per email it is tight,
// which is what slows down guessing one person's password.
const AUTH_OPEN = ['/api/auth/login', '/api/auth/signup', '/api/auth/google', '/api/auth/forgot-password',
  '/api/auth/reset-password', '/api/join/request', '/api/invites/accept']
app.use(AUTH_OPEN, rateLimit({ name: 'auth-ip', windowMs: 60_000, max: 60, key: (req) => req.ip }))
app.use(AUTH_OPEN, rateLimit({
  name: 'auth-email', windowMs: 60_000, max: 8,
  key: (req) => (req.body?.email ? String(req.body.email).toLowerCase().trim().slice(0, 200) : null),
  message: 'Too many attempts for this account. Please wait a minute and try again.',
}))

// No file onto a disk that is nearly full (fileStore.js uploadsBlocked): the
// database lives on the same disk, and when it can't write the whole app stops.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.is('multipart/form-data') && uploadsBlocked()) {
    console.warn('[disk] refused an upload: the data disk is nearly full')
    return res.status(507).json({ error: 'The server is out of storage space, so files cannot be uploaded right now. Please tell your admin.' })
  }
  next()
})

// A screen in the app crashed (components/ErrorBoundary.tsx). Logged so it can be
// fixed; no sign-in needed — a crash can happen before or during sign-in — so
// it is rate-limited and only ever printed, never stored.
app.use('/api/client-error', rateLimit({ name: 'client-error', windowMs: 60_000, max: 10, key: (req) => req.ip }))
app.post('/api/client-error', (req, res) => {
  const b = req.body || {}
  const s = (v, n) => String(v || '').slice(0, n)
  console.error(`[client-error] ${s(b.version, 20)} ${s(b.url, 200)} — ${s(b.message, 500)}
${s(b.stack, 2000)}
${s(b.component, 1500)}`)
  res.status(204).end()
})

// API responses are per-user and must never be cached (prevents one account's
// data — e.g. notifications — from being served to another from cache).
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.set('Vary', 'Authorization')
  next()
})

// Render calls this every few seconds to decide whether the service is alive.
// It used to COUNT(*) the embeddings table — the biggest in the database — on
// every call; the count is only informational, so it is refreshed at most every
// ten minutes and the check itself is a trivial query.
let ragIndexed = { n: null, at: 0 }
const ragIndexedCount = () => {
  if (Date.now() - ragIndexed.at > 10 * 60_000) {
    try { ragIndexed = { n: db.prepare('SELECT COUNT(*) c FROM embeddings').get().c, at: Date.now() } } catch {}
  }
  return ragIndexed.n
}
app.get('/api/health', (req, res) => {
  try { db.prepare('SELECT 1').get() } catch { return res.status(503).json({ ok: false, error: 'database unavailable' }) }
  const ragOn = hasEmbeddings()
  res.json({
    ok: true,
    ai_engine: process.env.OPENROUTER_API_KEY
      ? `openrouter (voice: ${process.env.VOICE_MODEL_FAST || process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash'} → ${process.env.VOICE_MODEL_SMART || 'google/gemini-2.5-pro'}, meetings: ${process.env.OPENROUTER_MEETING_MODEL || 'google/gemini-2.5-pro'})`
      : (process.env.ANTHROPIC_API_KEY ? 'claude' : (process.env.OPENAI_API_KEY ? 'openai' : 'rule-based (offline)')),
    transcription: process.env.TRANSCRIPTION_PROVIDER || 'none',
    // Which build is actually serving. Render injects these into every deploy,
    // so this answers "did my merge reach production?" from a single curl —
    // the question that otherwise takes reading the JS bundle for a string that
    // ought to be in it. Nulls locally, where nothing sets them.
    build: {
      commit: (process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || null,
      branch: process.env.RENDER_GIT_BRANCH || null,
      deployed_at: process.env.RENDER_DEPLOY_TIME || null,
    },
    rag: {
      enabled: ragOn,
      model: ragOn ? embedModel() : null,
      indexed: ragIndexedCount(),
    },
  })
})

app.use('/api/auth', authRoutes)
app.use('/api/invites', inviteRoutes)
app.use('/api/join', joinRoutes)
app.use('/api/users', userRoutes)
app.use('/api/meetings', meetingRoutes)
app.use('/api/tasks', taskRoutes)
app.use('/api/dashboards', dashboardRoutes)
app.use('/api/assistant', assistantRoutes)
app.use('/api/notifications', notificationRoutes)
app.use('/api/digest', digestRoutes)
app.use('/api/chat', dailyUpdateRoutes) // daily update cards; per-route auth
app.use('/api/chat', chatRoutes)
app.use('/api/platform', platformRoutes)
app.use('/api/usage', usageRoutes)
app.use('/api/scores', scoreRoutes)
app.use('/api/feedback', feedbackRoutes)
app.use('/api/tts', ttsRoutes)
app.use('/api/keys', apiKeyRoutes)
app.use('/api/departments', departmentRoutes)
app.use('/api/uploads', uploadRoutes)
app.use('/api/attendance', attendanceRoutes) // HRMS check-in tokens + who-is-in board
// Outside /api on purpose: MCP carries its own credential in the path and speaks
// JSON-RPC, not REST, so none of the /api middleware applies to it.
app.use('/mcp', mcpRoutes)

// --- Serve the built web client (client/dist) from this SAME service ----------
// So one URL hosts BOTH the website (for people without the Android app) AND the
// API. On Render the client build sits at ../../client/dist relative to this file
// (server/src). Built by render.yaml's buildCommand. Skipped gracefully when the
// build isn't present (e.g. API-only local dev with the Vite dev server).
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const clientDist = path.resolve(__dirname, '../../client/dist')
if (fs.existsSync(path.join(clientDist, 'index.html'))) {
  // Vite names everything under /assets after a hash of its content, so a file
  // there never changes — cache it for a year instead of re-asking on every
  // page load (index.html itself keeps the default revalidation, which is what
  // picks up a new deploy).
  app.use(express.static(clientDist, {
    setHeaders: (res, file) => {
      if (file.includes(`${path.sep}assets${path.sep}`)) res.set('Cache-Control', 'public, max-age=31536000, immutable')
    },
  }))
  // SPA fallback: any non-/api GET returns index.html so client-side routes
  // (BrowserRouter) survive a refresh or deep link. Unknown /api/* paths are
  // excluded so they still get a proper JSON 404 instead of the HTML shell.
  // A missing /assets/ file is a hashed chunk from an older build — a tab left
  // open across a deploy asking for code that no longer exists. Answering with
  // index.html (as the fallback below would) makes the browser try to run HTML
  // as JavaScript and the page breaks with a cryptic error; a 404 lets the app's
  // chunk-load handling reload onto the new build instead.
  app.get(/^\/assets\//, (req, res) => res.status(404).end())
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')))
  console.log(`  Web client: serving ${clientDist}`)
} else {
  console.log('  Web client: not built (API-only). Build client/ to serve the website here.')
}

// Last stop for an error a route didn't answer. A client error keeps its status
// and message (a body that isn't JSON, a payload over the limit); anything else
// is ours, so the person sees a plain sentence and the details go to the log.
app.use((err, req, res, next) => {
  const status = Number(err.status || err.statusCode) || 500
  if (status >= 500) console.error('[error]', req.method, req.originalUrl, err)
  if (res.headersSent) return
  res.status(status).json({ error: status < 500 ? (err.expose === false ? 'Bad request' : err.message || 'Bad request') : 'Something went wrong on our side. Please try again.' })
})

const PORT = process.env.PORT || 4000
const server = app.listen(PORT, () => {
  console.log(`\n  SmartTask AI server → http://localhost:${PORT}`)
  console.log(`  AI engine: ${process.env.OPENROUTER_API_KEY
    ? `OpenRouter (voice: ${process.env.VOICE_MODEL_FAST || process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash'} → ${process.env.VOICE_MODEL_SMART || 'google/gemini-2.5-pro'}, meetings: ${process.env.OPENROUTER_MEETING_MODEL || 'google/gemini-2.5-pro'})`
    : (process.env.ANTHROPIC_API_KEY ? 'Claude (online)' : 'rule-based (offline fallback)')}`)
  const ragCount = db.prepare('SELECT COUNT(*) c FROM embeddings').get().c
  console.log(`  RAG: ${hasEmbeddings() ? `ON (${embedModel()}, ${ragCount} items indexed)` : 'OFF (no embedding key set)'}`)
  console.log(`  Users in DB: ${db.prepare('SELECT COUNT(*) c FROM users').get().c}`)
  // The 132cr team's daily update cards, until each one is made (seedUpdateCards.js).
  try { seedUpdateCards() } catch (e) { console.warn('  [update-cards] failed:', e.message) }
  startScheduler()
  console.log('')
})
// Node gives a whole request — body included — 5 minutes by default, and a chat
// file can be 1 GB: ~70 minutes on a 2 Mbps phone uplink. Render's own proxy
// cuts requests at 100 minutes, so that, not Node, is the limit that matters.
// A slow-headers attack is still cut off by headersTimeout (60 s).
server.requestTimeout = 100 * 60 * 1000

// RAG catch-up: on boot, index anything created while embeddings were off or the
// server was down. Runs in the background and is cheap on repeat — unchanged
// items are skipped, so it makes ~0 API calls when nothing's new. It walks every
// source table, so it does so a page at a time (see syncAll): done in one go it
// froze every request for ~15 s on the production server.
if (hasEmbeddings()) {
  // Build the search worker's copy of the index now, not on the first question.
  warmRagSearch()
  syncAll()
    .then(({ embedded, skipped, pruned }) => {
      if (embedded || pruned) console.log(`  [rag] startup sync: embedded ${embedded} new, pruned ${pruned} orphan(s), ${skipped} already indexed`)
    })
    .catch((e) => console.warn('  [rag] startup sync skipped:', e.message))

  // Live RAG: periodic sync so the index stays current with NO manual command and
  // NO server restart. The per-route incremental hooks (indexTask/Meeting/Chat and
  // removeEmbedding) are best-effort and silently no-op if OpenAI is slow / rate-
  // limits mid-meeting or a delete races; this timer re-runs the same hash-based
  // sync to embed anything they missed AND prune orphaned vectors. Idempotent and
  // cheap on repeat — unchanged items are skipped, so it makes ~0 API calls when
  // nothing's new. Override the cadence with RAG_SYNC_MINUTES (default 5).
  const syncMinutes = Number(process.env.RAG_SYNC_MINUTES) || 5
  const timer = setInterval(() => {
    syncAll()
      .then(({ embedded, pruned }) => {
        if (embedded || pruned) console.log(`  [rag] periodic sync: embedded ${embedded} new, pruned ${pruned} orphan(s)`)
      })
      .catch((e) => console.warn('  [rag] periodic sync skipped:', e.message))
  }, syncMinutes * 60 * 1000)
  timer.unref?.() // don't keep the process alive solely for this timer
  console.log(`  [rag] live sync on: embed + prune every ${syncMinutes} min`)
}

// Live meeting transcription stream (browser <-> Sarvam) shares the HTTP server.
attachLiveTranscribe(server)
// Assistant streaming STT (same relay, different path/policy): transcribes voice
// commands WHILE the user speaks, so a turn needs no upload+transcribe round-trip
// after they stop — the single biggest latency cut in the voice loop.
attachAssistantLive(server)
// A call's transcript: each participant's own microphone, streamed to Sarvam
// while they talk (same relay again; the call decides who may open one).
attachCallLive(server, callLiveHooks)
// Real-time internal chat push shares the same HTTP server (different path).
const chatWss = attachChatHub(server)

// Every socket path is claimed by a handler above; one nobody claims was left
// hanging open until the client gave up. Runs after them (listeners fire in
// order), so it only sees what they passed over.
const WS_PATHS = new Set(['/api/chat/ws', '/api/meetings/live', '/api/assistant/live', '/api/chat/call/live'])
const liveSockets = new Set()
server.on('upgrade', (req, socket) => {
  let pathname = ''
  try { pathname = new URL(req.url, 'http://localhost').pathname } catch {}
  if (!WS_PATHS.has(pathname)) { socket.destroy(); return }
  liveSockets.add(socket)
  socket.once('close', () => liveSockets.delete(socket))
})

// Shutting down (a deploy sends SIGTERM). server.close() alone waits for every
// open WebSocket and hour-long upload to finish — they never do, so Render
// killed the process mid-write after its grace period. Instead: stop taking new
// requests, tell chat clients to reconnect (1012 = service restart; the app
// reconnects and catches up), drop the remaining sockets, close the database
// cleanly so the WAL is checkpointed, and exit within 10 s whatever happens.
let stopping = false
const shutdown = (signal) => {
  if (stopping) return
  stopping = true
  console.log(`[shutdown] ${signal} — closing`)
  const done = () => { try { db.close() } catch {} ; process.exit(0) }
  setTimeout(done, 10_000).unref()
  server.close(done)
  try { for (const ws of chatWss?.clients || []) ws.close(1012, 'restarting') } catch {}
  setTimeout(() => {
    for (const s of liveSockets) { try { s.destroy() } catch {} }
    try { server.closeAllConnections?.() } catch {}
  }, 1500).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.once('SIGUSR2', () => server.close(() => process.kill(process.pid, 'SIGUSR2'))) // nodemon/watch restart
