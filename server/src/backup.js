// Nightly database backup.
//
// The whole company's chat and tasks live in one SQLite file, and until now the
// only copy was Render's own disk snapshot — same provider, same account, and
// not something the app can see or restore from. This keeps the last KEEP
// nights as plain, openable .db files beside the database (data/backups/).
//
// better-sqlite3's backup() copies the live database page by page between turns
// of the event loop, so it never freezes requests the way reading the file in
// one go would, and the copy is consistent even while people keep writing.
// Files only; the chat_uploads / task_uploads folders are not copied — doubling
// every photo on a 10 GB disk would fill it. The database is what can't be
// re-created; a lost photo is a lost photo, a lost database is the company's
// whole history.
import fs from 'node:fs'
import path from 'node:path'
import { db, DB_FILE } from './db.js'
import { localDay } from './clock.js'
import { diskStatus } from './fileStore.js'

const KEEP = Number(process.env.BACKUP_KEEP || 7)
export const BACKUP_DIR = path.join(path.dirname(DB_FILE), 'backups')

let running = false

// Returns { file, bytes } or { skipped: reason }. Never throws.
export async function runBackup() {
  if (running) return { skipped: 'already running' }
  running = true
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    const size = fs.statSync(DB_FILE).size
    // Never fill the disk to make a backup: a full disk stops every write in the
    // app, which is worse than one missed night.
    const d = diskStatus()
    if (d && d.free < size * 2 + 300 * 1024 * 1024) {
      console.warn(`[backup] skipped: only ${Math.round(d.free / 1048576)} MB free for a ${Math.round(size / 1048576)} MB database`)
      return { skipped: 'disk' }
    }
    const file = path.join(BACKUP_DIR, `smarttask-${localDay()}.db`)
    const part = file + '.part'
    await db.backup(part)
    fs.renameSync(part, file)
    prune()
    const bytes = fs.statSync(file).size
    console.log(`[backup] ${path.basename(file)} — ${Math.round(bytes / 1048576)} MB`)
    return { file, bytes }
  } catch (e) {
    console.error('[backup] failed:', e.message)
    return { skipped: e.message }
  } finally {
    running = false
  }
}

// Newest KEEP backups stay; older ones and any half-written .part go.
function prune() {
  const files = fs.readdirSync(BACKUP_DIR)
  for (const f of files) if (f.endsWith('.part')) try { fs.rmSync(path.join(BACKUP_DIR, f)) } catch {}
  const dbs = files.filter((f) => /^smarttask-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse()
  for (const f of dbs.slice(KEEP)) try { fs.rmSync(path.join(BACKUP_DIR, f)) } catch {}
}
