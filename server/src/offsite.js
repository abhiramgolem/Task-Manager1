// The server's side of off-site backups: runs offsiteWorker.js as a separate,
// low-priority, memory-capped process and hands back its one-line JSON result.
// Never throws — a failure comes back as { error } for the caller to report.
//
// Configured by env (all four required, else off-site backup is simply off):
//   BACKUP_S3_ENDPOINT            e.g. https://<ref>.storage.supabase.co/storage/v1/s3
//   BACKUP_S3_REGION              e.g. ap-southeast-1
//   BACKUP_S3_BUCKET              e.g. votask-backups (a PRIVATE bucket)
//   BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY
//   BACKUP_S3_PREFIX              optional folder inside the bucket (default "db")
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'offsiteWorker.js')

export const offsiteEnabled = () => ['BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY']
  .every((k) => !!process.env[k])

let current = null
// A deploy stops the server mid-upload: take the worker down with it rather
// than leave it running on its own. The unfinished backup has no manifest, so
// it never counts, and the next run's prune clears it away.
process.on('exit', () => { try { current?.kill('SIGKILL') } catch {} })

// The worker shares the instance's memory with the server (~100 MB at its
// peak). If the server itself is already this big, starting it could push the
// instance over its limit and get everything restarted — so it waits instead.
const SERVER_RSS_LIMIT_MB = Number(process.env.OFFSITE_MAX_SERVER_RSS_MB || 330)

export function runOffsite(args, { timeoutMs = 45 * 60_000 } = {}) {
  const rssMb = Math.round(process.memoryUsage().rss / 1048576)
  if (rssMb > SERVER_RSS_LIMIT_MB) {
    return Promise.resolve({ error: `not started: the server is using ${rssMb} MB, too much to run the upload alongside it safely` })
  }
  return new Promise((resolve) => {
    let out = '', err = ''
    let child
    try {
      child = spawn(process.execPath, ['--max-old-space-size=160', WORKER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) { resolve({ error: e.message }); return }
    current = child
    // Lowest CPU priority: on a 0.5-CPU instance the compression must never
    // take time away from people using the app.
    try { os.setPriority(child.pid, 19) } catch {}
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err = (err + d).slice(-8000) })
    child.on('error', (e) => { clearTimeout(timer); current = null; resolve({ error: e.message }) })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      current = null
      if (code === 0) {
        try { resolve(JSON.parse(out.trim().split('\n').pop())) } catch { resolve({ error: 'unreadable worker output' }) }
        return
      }
      const last = err.trim().split('\n').filter(Boolean).pop()
      resolve({ error: last || `worker stopped (${signal || `exit ${code}`})` })
    })
  })
}
