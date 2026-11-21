// Nightly: move chat files older than a week off the Render disk into the
// archive bucket, and remove archived files whose messages are gone.
//
// Why a week: nearly every file anyone opens is recent, and those stay on the
// disk — fast, and no download from Supabase (whose included downloads are
// shared across the org, and with the spend cap on, running out of them would
// make the project read-only). Old files are rarely opened; when one is, it is
// streamed from the bucket (archive.js).
//
// Order of operations, so a crash at any point loses nothing:
//   1. the worker uploads a file and checks every part in the bucket,
//   2. the server records it in archived_files,
//   3. only then is the file deleted from the disk.
// A file that is on the disk AND recorded is served from the disk; the next
// run deletes the disk copy.
//
// Env: ARCHIVE_AFTER_DAYS (7), ARCHIVE_MIN_KB (256 — smaller files free little
// and are opened often), ARCHIVE_NIGHT_GB (4 — the most moved in one night).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from './db.js'
import { now } from './util.js'
import { runWorker } from './offsite.js'
import { archiveConfigured } from './archiveConfig.js'
import { opsAlert } from './opsAlerts.js'

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
const CHAT_DIR = path.join(DATA, 'chat_uploads')
const MB = 1024 * 1024
const AFTER_DAYS = Number(process.env.ARCHIVE_AFTER_DAYS || 7)
const MIN_BYTES = Number(process.env.ARCHIVE_MIN_KB || 256) * 1024
const NIGHT_BYTES = Number(process.env.ARCHIVE_NIGHT_GB || 4) * 1024 * MB
const BATCH = 40

let running = false
let lastRun = null
export const lastArchiveRun = () => lastRun
export const archiveRunning = () => running

function jobFile(data) {
  const f = path.join(os.tmpdir(), `votask-archive-${process.pid}-${Date.now()}.json`)
  fs.writeFileSync(f, JSON.stringify(data))
  return f
}

// Parts nobody points at any more go from the bucket; rows for deleted files
// whose parts are still shared with a live alias just go.
async function purge(problems) {
  db.prepare(`DELETE FROM archived_files WHERE deleted_at IS NOT NULL
    AND remote IN (SELECT remote FROM archived_files WHERE deleted_at IS NULL)`).run()
  const dead = db.prepare('SELECT DISTINCT remote FROM archived_files WHERE deleted_at IS NOT NULL').all().map((r) => r.remote)
  if (!dead.length) return 0
  const f = jobFile(dead)
  const r = await runWorker('archiveWorker.js', ['delete', f])
  fs.rmSync(f, { force: true })
  if (r.error) { problems.push(`removing deleted files from storage failed: ${r.error}`); return 0 }
  for (const remote of r.deleted) db.prepare('DELETE FROM archived_files WHERE remote=? AND deleted_at IS NOT NULL').run(remote)
  for (const x of r.failed) problems.push(`could not remove ${x.remote} from storage: ${x.error}`)
  return r.deleted.length
}

// Files recorded as archived that are still on the disk (a run that stopped
// between recording and deleting): the disk copy can go.
function dropArchivedLocals() {
  let n = 0
  for (const { key } of db.prepare("SELECT key FROM archived_files WHERE deleted_at IS NULL AND key LIKE 'chat_uploads/%'").all()) {
    const abs = path.join(DATA, key)
    try { fs.rmSync(abs); n++ } catch {}
  }
  return n
}

function candidates() {
  const cutoff = new Date(Date.now() - AFTER_DAYS * 86400000).toISOString()
  const rows = db.prepare(`SELECT file_stored FROM chat_messages
    WHERE file_stored IS NOT NULL AND deleted_for_all=0 AND created_at < ? AND COALESCE(file_size, 0) >= ?
      AND NOT EXISTS (SELECT 1 FROM archived_files a WHERE a.key = 'chat_uploads/' || chat_messages.file_stored)
    ORDER BY created_at LIMIT 20000`).all(cutoff, MIN_BYTES)
  const out = []
  let total = 0
  for (const { file_stored: name } of rows) {
    if (!name || name.includes('/') || name.includes('\\')) continue
    const abs = path.join(CHAT_DIR, name)
    let size
    try { size = fs.statSync(abs).size } catch { continue } // not on this disk: nothing to move
    if (size < MIN_BYTES) continue
    if (total + size > NIGHT_BYTES) break
    total += size
    out.push({ abs, remote: `chat_uploads/${name}`, size })
  }
  return out
}

function record(d) {
  const key = d.remote // a file is first archived under its own name
  db.prepare(`INSERT OR REPLACE INTO archived_files (key, remote, bytes, parts, part_bytes, sha256, archived_at)
    VALUES (?,?,?,?,?,?,?)`).run(key, d.remote, d.bytes, d.parts, d.part_bytes, d.sha256, now())
  // Deleted while it was uploading: mark it so the next run removes the parts.
  const name = key.slice('chat_uploads/'.length)
  if (!db.prepare('SELECT 1 FROM chat_messages WHERE file_stored=? AND deleted_for_all=0').get(name)) {
    db.prepare('UPDATE archived_files SET deleted_at=? WHERE key=?').run(now(), key)
  }
}

// `deadline`: no new file is started after this time (ms).
export async function runArchive({ deadline = Date.now() + 3 * 3600_000 } = {}) {
  if (!archiveConfigured()) return { skipped: 'FILES_S3_BUCKET is not set' }
  if (running) return { skipped: 'already running' }
  running = true
  const problems = []
  const summary = { started_at: now(), moved: 0, moved_mb: 0, purged: 0, left_for_later: 0 }
  try {
    summary.purged = await purge(problems)
    dropArchivedLocals()
    const todo = candidates()
    for (let i = 0; i < todo.length; i += BATCH) {
      if (Date.now() > deadline) { summary.left_for_later = todo.length - i; break }
      const batch = todo.slice(i, i + BATCH)
      const f = jobFile(batch.map(({ abs, remote }) => ({ abs, remote })))
      const r = await runWorker('archiveWorker.js', ['put', f, String(deadline)], { timeoutMs: 60 * 60_000 })
      fs.rmSync(f, { force: true })
      if (r.error) { problems.push(`moving files to storage failed: ${r.error}`); break }
      for (const d of r.done) {
        // Same file, same size as when it was read: otherwise leave it for another night.
        let size = -1
        try { size = fs.statSync(d.abs).size } catch {}
        if (size !== d.bytes) continue
        record(d)
        try { fs.rmSync(d.abs) } catch {}
        summary.moved++
        summary.moved_mb += d.bytes / MB
      }
      for (const x of r.failed) problems.push(`could not move ${path.basename(x.abs)}: ${x.error}`)
      if (r.failed.length > 5) break // something is wrong with storage; stop for tonight
    }
  } catch (e) {
    problems.push(`archive run failed: ${e.message}`)
  } finally {
    running = false
  }
  summary.moved_mb = Math.round(summary.moved_mb)
  summary.problems = problems.slice(0, 20)
  summary.finished_at = now()
  lastRun = summary
  console.log(`[archive] moved ${summary.moved} files (${summary.moved_mb} MB) to storage, removed ${summary.purged} deleted` +
    `${summary.left_for_later ? `, ${summary.left_for_later} left for the next night` : ''}${problems.length ? `, ${problems.length} problem(s)` : ''}`)
  if (problems.length) opsAlert('archive', 'Moving chat files to storage needs attention', problems.slice(0, 10).join('\n'), { everyMs: 20 * 3600_000 })
  return summary
}
