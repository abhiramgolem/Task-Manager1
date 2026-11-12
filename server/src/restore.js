// One-time data restore.
//
// The live DB lives on the Render persistent disk (server/data/smarttask.db).
// That disk was created empty and only ever got the demo seed, so the real org
// data (users/meetings/tasks created locally) wasn't there. This module copies a
// committed snapshot (server/restore/smarttask.db — OUTSIDE the disk mount, so it
// ships with the git checkout) onto the disk the FIRST time this version boots.
//
// It MUST run before db.js opens the database, so index.js imports this module
// before './db.js'. A marker file ON THE DISK makes it run exactly once — so a
// later redeploy/restart never clobbers data created on the live site afterwards.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(__dirname, '..', 'data')
const liveDb = path.join(dataDir, 'smarttask.db')
const snapshot = path.join(__dirname, '..', 'restore', 'smarttask.db')
const marker = path.join(dataDir, '.imported-v1')

// The marker alone used to decide, and the import DELETED whatever database was
// there first. A disk that lost the marker file (a cleanup, a remount) would have
// had the whole company's live chat and tasks replaced by the old October
// snapshot. Now the snapshot is only ever copied onto a disk that has no
// database at all — the one case it exists for. An existing database is never
// removed; at most the marker is written so the question isn't asked again.
const hasData = (f) => { try { return fs.statSync(f).size > 0 } catch { return false } }

try {
  fs.mkdirSync(dataDir, { recursive: true })
  if (fs.existsSync(snapshot) && !fs.existsSync(marker)) {
    if (hasData(liveDb)) {
      fs.writeFileSync(marker, `skipped ${new Date().toISOString()} — a database was already here`)
      console.log('  [restore] snapshot NOT imported: a live database already exists (left untouched)')
    } else {
      // No database: clear any orphan journal so SQLite can't replay it onto the copy.
      for (const f of [`${liveDb}-wal`, `${liveDb}-shm`]) {
        try { fs.rmSync(f, { force: true }) } catch {}
      }
      fs.copyFileSync(snapshot, liveDb)
      fs.writeFileSync(marker, new Date().toISOString())
      console.log('  [restore] one-time import of org data from snapshot onto an empty disk — done')
    }
  }
} catch (e) {
  // Never block startup on a restore problem; the app still boots on existing data.
  console.warn('  [restore] skipped:', e.message)
}
