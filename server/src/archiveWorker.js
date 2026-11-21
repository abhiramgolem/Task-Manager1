// Moves files into the archive bucket — runs as its OWN short-lived process
// (archiveFiles.js spawns it through offsite.js's runWorker), for the same
// reason as offsiteWorker.js: the S3 client and a 16 MB part buffer stay out of
// the server's 512 MB.
//
//   node src/archiveWorker.js put <jobs.json> <deadlineMs>
//     jobs: [{ abs, remote }]. Uploads each file as raw 16 MB parts, checks
//     every part's size with HEAD, prints { done: [...], failed: [...] }.
//     Starts no new file after deadlineMs.
//   node src/archiveWorker.js delete <remotes.json>
//     Deletes every object under each remote's folder. Prints { deleted, failed }.
// The file on disk is never touched here; the server deletes it only after it
// has recorded the archived copy.
import fs from 'node:fs'
import crypto from 'node:crypto'
import {
  S3Client, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { archiveS3Config, ARCHIVE_PART_BYTES, partKey, remotePrefix } from './archiveConfig.js'

const cfg = archiveS3Config()
const s3 = new S3Client({
  endpoint: cfg.endpoint,
  region: cfg.region,
  forcePathStyle: true,
  credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  maxAttempts: 5,
})
const Bucket = cfg.bucket

async function putFile({ abs, remote }, buf) {
  const fd = fs.openSync(abs, 'r')
  try {
    const bytes = fs.fstatSync(fd).size
    const whole = crypto.createHash('sha256')
    let parts = 0, pos = 0
    do {
      const n = fs.readSync(fd, buf, 0, ARCHIVE_PART_BYTES, pos)
      const body = buf.subarray(0, n)
      whole.update(body)
      await s3.send(new PutObjectCommand({ Bucket, Key: partKey(remote, parts), Body: body, ContentLength: n, ContentType: 'application/octet-stream' }))
      parts++; pos += n
    } while (pos < bytes)
    // Trust nothing until the bucket says each part is there at the right size.
    for (let i = 0; i < parts; i++) {
      const want = Math.min(ARCHIVE_PART_BYTES, bytes - i * ARCHIVE_PART_BYTES)
      const h = await s3.send(new HeadObjectCommand({ Bucket, Key: partKey(remote, i) }))
      if (Number(h.ContentLength) !== want) throw new Error(`part ${i + 1} is ${h.ContentLength} bytes, expected ${want}`)
    }
    return { abs, remote, bytes, parts, part_bytes: ARCHIVE_PART_BYTES, sha256: whole.digest('hex') }
  } finally {
    fs.closeSync(fd)
  }
}

async function put(jobsFile, deadline) {
  const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'))
  const buf = Buffer.allocUnsafe(ARCHIVE_PART_BYTES)
  const done = [], failed = []
  for (const job of jobs) {
    if (Date.now() > deadline) break
    try { done.push(await putFile(job, buf)) } catch (e) { failed.push({ abs: job.abs, error: e?.message || String(e) }) }
  }
  return { done, failed, peak_mb: Math.round(process.resourceUsage().maxRSS / 1024) }
}

async function del(remotesFile) {
  const remotes = JSON.parse(fs.readFileSync(remotesFile, 'utf8'))
  const deleted = [], failed = []
  for (const remote of remotes) {
    try {
      let token
      do {
        const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: remotePrefix(remote), ContinuationToken: token }))
        for (const o of r.Contents || []) await s3.send(new DeleteObjectCommand({ Bucket, Key: o.Key }))
        token = r.IsTruncated ? r.NextContinuationToken : undefined
      } while (token)
      deleted.push(remote)
    } catch (e) { failed.push({ remote, error: e?.message || String(e) }) }
  }
  return { deleted, failed }
}

const [cmd, a, b] = process.argv.slice(2)
const run = { put: () => put(a, Number(b) || Infinity), delete: () => del(a) }[cmd]
if (!run || !Bucket) { console.error(Bucket ? 'usage: put <jobs.json> <deadlineMs> | delete <remotes.json>' : 'FILES_S3_BUCKET is not set'); process.exit(2) }
run().then(
  (r) => { process.stdout.write(JSON.stringify(r) + '\n'); process.exit(0) },
  (e) => { process.stderr.write(`[archive-worker] ${cmd} failed: ${e?.message || e}\n`); process.exit(1) },
)
