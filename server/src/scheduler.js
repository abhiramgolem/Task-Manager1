// Lightweight daily scheduler (no external cron dependency). Checks every minute;
// at the target hour it runs the digest once per day, guarded by app_meta so a
// restart can't double-send.
import { db } from './db.js'
import { runBackup } from './backup.js'
import { diskStatus } from './fileStore.js'
import { sendDailyDigests } from './digest.js'
import { runChatDue } from './routes/chat.js'
import { runUpdateReminders } from './routes/dailyUpdates.js'
import { purgeDeletedTask } from './routes/tasks.js'
import {
  sendDailyTaskMail, sendCriticalDigest, sendNewCriticalAlerts, sendDeadlineWarnings,
  seedAlertBaseline, zonedNow, slotDue, dailyAt, criticalAt, deadlineHour, tz,
  toOwnersEnabled, testRecipient,
} from './taskMail.js'

const SEND_HOUR = Number(process.env.DIGEST_HOUR || 8) // local server time, 0-23

function getMeta(key) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)
  return row ? row.value : null
}
function setMeta(key, value) {
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value)
}

// Empty the recycle bin of anything past its recovery window. Guarded per-day the
// same way the digest is, because the work is pure deletion — running it twice is
// harmless but pointless, and running it on every tick would scan the table 1440
// times a day to find nothing.
function purgeExpiredTasks() {
  const due = db.prepare('SELECT * FROM deleted_tasks WHERE purge_after <= ?').all(new Date().toISOString())
  for (const row of due) {
    try { purgeDeletedTask(row) } catch (e) { console.error('[scheduler] purge failed for', row.id, e.message) }
  }
  if (due.length) console.log(`[scheduler] purged ${due.length} task(s) past the recovery window`)
}

async function tick() {
  const now = new Date()
  const todayStr = now.toISOString().slice(0, 10)
  if (now.getHours() === SEND_HOUR && getMeta('digest_last_sent') !== todayStr) {
    setMeta('digest_last_sent', todayStr) // mark first so a crash mid-send won't loop
    try { await sendDailyDigests() } catch (e) { console.error('[scheduler] digest failed:', e.message) }
    // Leaderboard points need no scheduled work: performance.js counts them live
    // from tasks / task_comments / audit_logs on every read.
  }
  if (getMeta('trash_last_purged') !== todayStr) {
    setMeta('trash_last_purged', todayStr)
    try { purgeExpiredTasks() } catch (e) { console.error('[scheduler] purge sweep failed:', e.message) }
  }

  // --- Per-owner task mail (src/taskMail.js) ---------------------------------
  // Its own clock: these hours are read in TASK_MAIL_TZ, not the server's local
  // time, so "10 am" means 10 am to the people receiving the mail. Its own marker
  // row too, so it neither waits on the digest above nor re-sends when that throws.
  // Whether any of this reaches real owners is decided inside taskMail.js by
  // TASK_MAIL_TO_OWNERS — never here.
  // Both daily slots fire on "the time has come round and today's hasn't gone
  // yet", not on an exact minute match. The tick drifts, so an equality test can
  // step straight over a minute and lose the day; past-due also means a service
  // that was redeploying or asleep at 13:30 still sends when it wakes — late,
  // which beats never. The marker row is what stops it repeating.
  const z = zonedNow(now)
  if (slotDue(z, dailyAt()) && getMeta('task_mail_last_sent') !== z.date) {
    setMeta('task_mail_last_sent', z.date)
    try { await sendDailyTaskMail() } catch (e) { console.error('[scheduler] daily task mail failed:', e.message) }
  }

  // The 13:30 pass: critical work only, to the people who own some.
  if (slotDue(z, criticalAt()) && getMeta('task_mail_critical_last_sent') !== z.date) {
    setMeta('task_mail_critical_last_sent', z.date)
    try { await sendCriticalDigest() } catch (e) { console.error('[scheduler] critical digest failed:', e.message) }
  }

  // Event-driven alerts, checked every minute rather than on the hour: "as soon
  // as a critical task is set" means within a minute of it happening. Both
  // de-duplicate against critical_alerts_sent, so a tick that finds nothing new
  // is two cheap indexed reads.
  try { await sendNewCriticalAlerts() } catch (e) { console.error('[scheduler] critical alert failed:', e.message) }
  try { await sendDeadlineWarnings() } catch (e) { console.error('[scheduler] deadline warning failed:', e.message) }

  // Chat reminders falling due and scheduled messages going out. Same minute
  // granularity as everything else here — "remind me at 4pm" means within the
  // minute, which is what people actually expect of a reminder.
  try { runChatDue() } catch (e) { console.error('[scheduler] chat due work failed:', e.message) }
  // Daily update cards whose owner's reminder time has come and who has not
  // posted today (routes/dailyUpdates.js). One indexed read when nothing is due.
  try { runUpdateReminders() } catch (e) { console.error('[scheduler] update reminders failed:', e.message) }

  // Nightly database backup (backup.js), in the quiet hours on the team's clock.
  // Not awaited inside the tick's marker logic: the marker goes first, so a
  // backup that crashes the night's tick isn't retried every minute.
  if (z.hour >= 2 && z.hour < 6 && getMeta('db_backup_last') !== z.date) {
    setMeta('db_backup_last', z.date)
    await runBackup()
  }

  // Say so in the log, once an hour, while the disk is running low — before it
  // fills and every write in the app starts failing.
  if (z.minute === 0) {
    const d = diskStatus()
    if (d && d.pct < 0.2) console.warn(`[disk] LOW: ${Math.round(d.free / 1048576)} MB free of ${Math.round(d.total / 1048576)} MB (${Math.round(d.pct * 100)}%) — raise the Render disk size`)
  }
}

// One tick at a time. setInterval doesn't wait for an async tick, so a slow SMTP
// send or backup let the next minute's tick start alongside it and send the
// same alert twice.
let ticking = false
async function safeTick() {
  if (ticking) return
  ticking = true
  try { await tick() } catch (e) { console.error('[scheduler] tick failed:', e.message) } finally { ticking = false }
}

export function startScheduler() {
  console.log(`  Daily task digest scheduled for ${String(SEND_HOUR).padStart(2, '0')}:00 (local time)`)
  seedAlertBaseline()
  const target = toOwnersEnabled()
    ? 'LIVE → individual owners'
    : `TEST ONLY → ${testRecipient() || 'nobody (TASK_MAIL_TEST_TO unset)'}`
  const hhmm = (at) => `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`
  console.log(`  Per-owner task mail (${tz()}): summary ${hhmm(dailyAt())}, critical-only ${hhmm(criticalAt())}, ` +
    `critical-assigned within a minute, deadline warning at ${String((deadlineHour() + 23) % 24).padStart(2, '0')}:00 — ${target}`)
  setInterval(safeTick, 60 * 1000) // check every minute
}
