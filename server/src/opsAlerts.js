// Tell a person when the server is in trouble, instead of only the log.
//
// Every warning that mattered — disk running out, a backup skipped, a crash —
// used to go to console only, and nobody reads Render's logs until something is
// already broken. These go by email to the operators:
//   ALERT_EMAILS            comma-separated; if unset, PLATFORM_ADMIN_EMAILS.
//
// Throttled per alert kind (default once every 6 h), and the throttle is kept on
// the data disk so a crash loop can't send one mail per restart.
//
// This only covers trouble the server can still report. A server that is down
// can't send mail: that needs an outside check on /api/health (Render's
// "service unhealthy" notification, or an uptime monitor).
import fs from 'node:fs'
import path from 'node:path'
import { DB_FILE } from './db.js'
import { sendMail } from './mailer.js'

const STATE = path.join(path.dirname(DB_FILE), '.ops-alerts.json')
const HOUR = 3600_000

const recipients = () => (process.env.ALERT_EMAILS || process.env.PLATFORM_ADMIN_EMAILS || '')
  .split(',').map((s) => s.trim()).filter(Boolean)

function readState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return {} } }
function writeState(s) { try { fs.writeFileSync(STATE, JSON.stringify(s)) } catch {} }

// Never throws, never blocks the caller for long.
export async function opsAlert(kind, subject, details, { everyMs = 6 * HOUR } = {}) {
  const state = readState()
  if (state[kind] && Date.now() - state[kind] < everyMs) return { throttled: true }
  console.error(`[alert] ${subject} — ${details}`)
  const to = recipients()
  if (!to.length) { console.warn('[alert] nobody to email: set ALERT_EMAILS'); return { sent: false } }
  state[kind] = Date.now()
  writeState(state)
  const build = (process.env.RENDER_GIT_COMMIT || '').slice(0, 7)
  const text = `${details}\n\nWhen: ${new Date().toISOString()}${build ? `\nBuild: ${build}` : ''}\n\n— VoTask server`
  try {
    await sendMail({ to: to.join(','), subject: `[VoTask alert] ${subject}`, text })
    return { sent: true }
  } catch (e) {
    console.error('[alert] email failed:', e.message)
    return { sent: false }
  }
}

// --- Crash detection --------------------------------------------------------
// A marker on the disk says "a server is running". A clean stop (a deploy's
// SIGTERM) removes it; a crash, an out-of-memory kill or a hung process that
// Render restarts leaves it behind — so finding it at boot means the last run
// died, and the operators hear about it.
const RUNNING = path.join(path.dirname(DB_FILE), '.server-running')

// A deploy can't be told apart by the marker alone: Render stops the service
// through `npm start`, which does not pass SIGTERM on to node, so the clean
// stop never runs and every deploy left the marker behind — two false crash
// alerts on 2026-11-20/21. So the marker carries the build: a different
// commit at the next boot is a deploy; the same commit is the same version
// starting again — a crash, an out-of-memory kill, a hang, or a manual
// restart. (A marker in the old plain-timestamp form counts as a deploy.)
export function markStarted() {
  let prev = null
  try { prev = fs.readFileSync(RUNNING, 'utf8') } catch {}
  const commit = (process.env.RENDER_GIT_COMMIT || '').slice(0, 12)
  try { fs.writeFileSync(RUNNING, JSON.stringify({ started_at: new Date().toISOString(), commit })) } catch {}
  if (prev === null) return
  let p
  try { p = JSON.parse(prev) } catch { p = { started_at: prev.trim() } }
  if (typeof p?.commit !== 'string' || p.commit !== commit) {
    console.log(`[startup] new version ${commit || '(local)'} replaced ${p?.commit || 'the previous build'}`)
    return
  }
  opsAlert('unclean-restart', 'VoTask restarted after an unexpected stop',
    `The server stopped without shutting down cleanly — a crash, running out of memory, a hang that Render restarted, ` +
    `or a manual restart of the same version. The previous run started at ${p.started_at || 'an unknown time'}. ` +
    `It is running again now. Check Render → smarttask-api → Logs around that time for "[fatal]" or an out-of-memory message.`,
    { everyMs: HOUR })
}

export function markStopped() {
  try { fs.rmSync(RUNNING, { force: true }) } catch {}
}
