// Nightly database backup.
//
// The whole company's chat and tasks live in one SQLite file. Each night this
// takes a consistent copy (better-sqlite3's backup() copies page by page between
// turns of the event loop, so requests never freeze) and, when off-site backup
// is configured (offsite.js), ships it to a private bucket in Supabase Storage.
//
// It used to keep the last 7 copies on the same Render disk as the database.
// That filled the 10 GB disk (7 x ~850 MB) and protected nothing against the
// disk itself failing. Worse, a backup was skipped when space ran short, and
// old copies were only deleted after a SUCCESSFUL backup — so once the disk got
// tight, nothing was ever deleted again and it only filled further.
//
// Now:
//   - The newest local copy is shipped off-site if the bucket doesn't have it.
//   - Local copies are deleted only when a copy at least as new is safely
//     off-site, keeping BACKUP_KEEP_LOCAL (default 1) on the disk.
//   - Without off-site backup it keeps BACKUP_KEEP (default 7) as before.
//   - If tonight's copy won't fit, the oldest local copies make room for it
//     (always leaving at least one), instead of the backup being skipped forever.
//   - Off-site, the newest BACKUP_KEEP_OFFSITE (default 14) are kept.
//   - Anything that goes wrong is emailed to the operators (opsAlerts.js).
// Files (chat_uploads etc.) are not part of this; the database is what can't
// be re-created.
import fs from 'node:fs'
import path from 'node:path'
import { db, DB_FILE } from './db.js'
import { localDay } from './clock.js'
import { diskStatus } from './fileStore.js'
import { offsiteEnabled, runOffsite } from './offsite.js'
import { opsAlert } from './opsAlerts.js'

const MB = 1024 * 1024
const KEEP = Number(process.env.BACKUP_KEEP || 7)
const KEEP_LOCAL = Math.max(1, Number(process.env.BACKUP_KEEP_LOCAL || 1))
const KEEP_OFFSITE = Math.max(1, Number(process.env.BACKUP_KEEP_OFFSITE || 14))
export const BACKUP_DIR = path.join(path.dirname(DB_FILE), 'backups')
// Which local copies are already in the bucket: { "smarttask-2026-11-18": iso }.
const SHIPPED = path.join(BACKUP_DIR, '.offsite.json')
const NAME_RE = /^smarttask-\d{4}-\d{2}-\d{2}$/

let running = false
let lastRun = null
export const lastBackupRun = () => lastRun
export const backupRunning = () => running

const localCopies = () => {
  try {
    return fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).map((f) => f.slice(0, -3))
      .filter((n) => NAME_RE.test(n)).sort().reverse() // newest first
  } catch { return [] }
}
const fileOf = (name) => path.join(BACKUP_DIR, `${name}.db`)
const readShipped = () => { try { return JSON.parse(fs.readFileSync(SHIPPED, 'utf8')) } catch { return {} } }
const markShipped = (name) => { const s = readShipped(); s[name] = new Date().toISOString(); fs.writeFileSync(SHIPPED, JSON.stringify(s)) }
const rm = (name, why) => { try { fs.rmSync(fileOf(name)); console.log(`[backup] removed local ${name} (${why})`) } catch {} }

async function ship(name, problems) {
  const r = await runOffsite(['upload', fileOf(name), name])
  if (r.error) { problems.push(`off-site upload of ${name} failed: ${r.error}`); return false }
  markShipped(name)
  console.log(`[backup] ${name} shipped off-site — ${r.parts} parts, ${Math.round(r.stored_bytes / MB)} MB stored, ${r.seconds}s, worker peak ${r.peak_mb} MB`)
  return true
}

function pruneLocal() {
  try { for (const f of fs.readdirSync(BACKUP_DIR)) if (f.endsWith('.part')) fs.rmSync(path.join(BACKUP_DIR, f)) } catch {}
  const copies = localCopies()
  if (!offsiteEnabled()) {
    for (const n of copies.slice(KEEP)) rm(n, `more than ${KEEP} kept`)
    return
  }
  // Only delete a local copy when one at least as new is already off-site.
  const shipped = Object.keys(readShipped()).filter((n) => NAME_RE.test(n)).sort().reverse()
  const newestShipped = shipped[0]
  if (!newestShipped) return
  for (const n of copies.slice(KEEP_LOCAL)) if (n <= newestShipped) rm(n, `off-site copy ${newestShipped} exists`)
  // Forget shipped names whose local file is gone, so the record stays small.
  const s = readShipped(), live = new Set(localCopies())
  for (const n of Object.keys(s)) if (!live.has(n) && n !== newestShipped) delete s[n]
  try { fs.writeFileSync(SHIPPED, JSON.stringify(s)) } catch {}
}

// Free space for one more copy of a `size`-byte database, plus headroom for the
// app itself. Deletes the oldest local copies if needed, never the last one.
function makeRoom(size) {
  const need = size + Math.max(300 * MB, size * 0.2)
  const copies = localCopies()
  let d = diskStatus()
  while (d && d.free < need && copies.length > 1) {
    rm(copies.pop(), 'making room for tonight’s copy')
    d = diskStatus(undefined, true)
  }
  return !d || d.free >= need
}

// Returns a summary; never throws.
export async function runBackup() {
  if (running) return { skipped: 'already running' }
  running = true
  const problems = []
  const summary = { started_at: new Date().toISOString(), offsite: offsiteEnabled(), made: null, shipped: [] }
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })

    // 1. Anything newer than what the bucket holds goes first — on the first
    //    run after this change that is the last copy made before the disk filled.
    if (offsiteEnabled()) {
      const newest = localCopies()[0]
      if (newest && !readShipped()[newest] && await ship(newest, problems)) summary.shipped.push(newest)
    }
    pruneLocal()

    // 2. Tonight's copy.
    const name = `smarttask-${localDay()}`
    if (!fs.existsSync(fileOf(name))) {
      const size = fs.statSync(DB_FILE).size
      if (!makeRoom(size)) {
        const d = diskStatus()
        problems.push(`no room for tonight's backup: ${Math.round((d?.free || 0) / MB)} MB free for a ${Math.round(size / MB)} MB database`)
      } else {
        const part = fileOf(name) + '.part'
        await db.backup(part)
        fs.renameSync(part, fileOf(name))
        summary.made = name
        console.log(`[backup] ${name} — ${Math.round(fs.statSync(fileOf(name)).size / MB)} MB`)
      }
    }

    // 3. Ship it, then trim both sides.
    if (offsiteEnabled() && fs.existsSync(fileOf(name)) && !readShipped()[name]) {
      if (await ship(name, problems)) summary.shipped.push(name)
    }
    pruneLocal()
    if (offsiteEnabled()) {
      const p = await runOffsite(['prune', String(KEEP_OFFSITE)])
      if (p.error) problems.push(`off-site prune failed: ${p.error}`)
    }
  } catch (e) {
    problems.push(`backup failed: ${e.message}`)
  } finally {
    running = false
  }
  if (!offsiteEnabled()) problems.push('off-site backup is not configured (BACKUP_S3_* env vars), so the only copies are on the same disk as the database')
  summary.local = localCopies()
  summary.problems = problems
  summary.finished_at = new Date().toISOString()
  lastRun = summary
  if (problems.length) {
    opsAlert('backup', 'Database backup needs attention', problems.join('\n'), { everyMs: 20 * 3600_000 })
  }
  return summary
}
