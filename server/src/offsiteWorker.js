// Off-site backup worker — runs as its OWN short-lived process (offsite.js
// spawns it), never inside the server.
//
// Why a separate process: the server lives in 512 MB and already peaks near 80%
// of it. Compressing and uploading an ~850 MB database inside the server would
// add the S3 client, zlib buffers and a 32 MB part buffer on top of that, at the
// one moment the app can least afford it. Out here a failure or a memory spike
// takes down this worker, not the chat.
//
// Where: any S3-compatible bucket. Today that is Supabase Storage (project
// VoTask, Singapore), but nothing here is Supabase-specific, so moving to
// Cloudflare R2 or AWS later is a change of env vars only.
//
// Format: Supabase refuses any single object over 50 MB while the project's
// spend cap is on, and the database is far bigger. So a backup is gzipped and
// cut into ≤ 32 MB parts:
//   <prefix>/<name>/part-0001.gz … part-NNNN.gz   (concatenate, then gunzip)
//   <prefix>/<name>/manifest.json                 (written LAST)
// A backup without a manifest is incomplete and never counted as a copy. The
// manifest carries the sha256 of every part and of the original file, and
// `restore` checks all of them.
//
// Usage (env BACKUP_S3_* must be set — see offsite.js):
//   node src/offsiteWorker.js upload  <file.db> <name>
//   node src/offsiteWorker.js restore <name> <out.db>
//   node src/offsiteWorker.js list
//   node src/offsiteWorker.js prune   <keep>
// Prints one JSON line on success; exits non-zero with the error on stderr.
import fs from 'node:fs'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Writable, Readable, Transform } from 'node:stream'
import {
  S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand,
} from '@aws-sdk/client-s3'

const PART_BYTES = 32 * 1024 * 1024
const env = process.env
const BUCKET = env.BACKUP_S3_BUCKET
const PREFIX = (env.BACKUP_S3_PREFIX || 'db').replace(/^\/+|\/+$/g, '')

function client() {
  for (const k of ['BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY']) {
    if (!env[k]) throw new Error(`${k} is not set`)
  }
  return new S3Client({
    endpoint: env.BACKUP_S3_ENDPOINT,
    region: env.BACKUP_S3_REGION || 'us-east-1',
    forcePathStyle: true, // Supabase (and most non-AWS S3) need path-style URLs
    credentials: { accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID, secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY },
    maxAttempts: 5,
  })
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const keyFor = (name, file) => `${PREFIX}/${name}/${file}`

async function put(s3, Key, Body, ContentType = 'application/octet-stream') {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body, ContentType, ContentLength: Body.length }))
}

async function getBuffer(s3, Key) {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key }))
  return Buffer.from(await r.Body.transformToByteArray())
}

async function listAll(s3, Prefix) {
  const out = []
  let ContinuationToken
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix, ContinuationToken }))
    for (const o of r.Contents || []) out.push({ key: o.Key, size: o.Size, modified: o.LastModified })
    ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined
  } while (ContinuationToken)
  return out
}

// Backups grouped by name: { name, complete, bytes, keys[] }, newest name first.
async function backups(s3) {
  const by = new Map()
  for (const o of await listAll(s3, `${PREFIX}/`)) {
    const rest = o.key.slice(PREFIX.length + 1)
    const name = rest.split('/')[0]
    if (!name || name === rest) continue
    const b = by.get(name) || { name, complete: false, bytes: 0, keys: [], modified: o.modified }
    b.keys.push(o.key)
    b.bytes += o.size || 0
    if (rest.endsWith('/manifest.json')) b.complete = true
    if (o.modified > b.modified) b.modified = o.modified
    by.set(name, b)
  }
  return [...by.values()].sort((a, b) => (a.name < b.name ? 1 : -1))
}

async function upload(file, name) {
  if (!/^[\w.-]+$/.test(name || '')) throw new Error('bad backup name')
  const s3 = client()
  const started = Date.now()
  const whole = crypto.createHash('sha256')
  let originalBytes = 0
  const parts = []
  let chunks = [], held = 0

  const flush = async () => {
    if (!held) return
    const body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, held)
    chunks = []; held = 0
    const n = String(parts.length + 1).padStart(4, '0')
    const key = keyFor(name, `part-${n}.gz`)
    await put(s3, key, body)
    parts.push({ key, bytes: body.length, sha256: sha256(body) })
  }

  await pipeline(
    fs.createReadStream(file, { highWaterMark: 1024 * 1024 }),
    // Tap the raw bytes for the whole-file hash before they are compressed.
    new Transform({ transform(b, _e, done) { whole.update(b); originalBytes += b.length; done(null, b) } }),
    zlib.createGzip({ level: 6 }),
    new Writable({
      async write(chunk, _enc, done) {
        try {
          let off = 0
          while (off < chunk.length) {
            const take = Math.min(PART_BYTES - held, chunk.length - off)
            chunks.push(chunk.subarray(off, off + take)); held += take; off += take
            if (held >= PART_BYTES) await flush()
          }
          done()
        } catch (e) { done(e) }
      },
      async final(done) { try { await flush(); done() } catch (e) { done(e) } },
    }),
  )

  const manifest = {
    name, format: 'gzip-parts-v1', created_at: new Date().toISOString(),
    original_bytes: originalBytes, original_sha256: whole.digest('hex'), part_bytes: PART_BYTES, parts,
  }
  await put(s3, keyFor(name, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json')
  return { name, parts: parts.length, original_bytes: originalBytes, stored_bytes: parts.reduce((s, p) => s + p.bytes, 0), seconds: Math.round((Date.now() - started) / 1000) }
}

async function restore(name, out) {
  const s3 = client()
  const manifest = JSON.parse((await getBuffer(s3, keyFor(name, 'manifest.json'))).toString('utf8'))
  const tmp = out + '.part'
  const whole = crypto.createHash('sha256')
  let bytes = 0
  // Parts are fetched one at a time and fed to a single gunzip stream, so
  // memory stays at one part however large the database is.
  async function* gz() {
    for (const p of manifest.parts) {
      const buf = await getBuffer(s3, p.key)
      if (sha256(buf) !== p.sha256) throw new Error(`checksum mismatch in ${p.key}`)
      yield buf
    }
  }
  const gunzip = zlib.createGunzip()
  gunzip.on('data', (b) => { whole.update(b); bytes += b.length })
  await pipeline(Readable.from(gz()), gunzip, fs.createWriteStream(tmp))
  const got = whole.digest('hex')
  if (got !== manifest.original_sha256 || bytes !== manifest.original_bytes) {
    fs.rmSync(tmp, { force: true })
    throw new Error('restored file does not match the manifest checksum')
  }
  fs.renameSync(tmp, out)
  return { name, out, bytes, verified: true }
}

// Keep the newest `keep` complete backups. Older ones go, and so does any
// incomplete one (no manifest) more than a day old — a crashed upload.
async function prune(keep) {
  const s3 = client()
  const all = await backups(s3)
  const complete = all.filter((b) => b.complete)
  const dayAgo = Date.now() - 86400000
  const doomed = [
    ...complete.slice(keep),
    ...all.filter((b) => !b.complete && new Date(b.modified).getTime() < dayAgo),
  ]
  for (const b of doomed) for (const Key of b.keys) await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key }))
  return { kept: complete.slice(0, keep).map((b) => b.name), deleted: doomed.map((b) => b.name) }
}

async function list() {
  const all = await backups(client())
  return all.map(({ name, complete, bytes }) => ({ name, complete, bytes }))
}

const [cmd, a, b] = process.argv.slice(2)
const run = { upload: () => upload(a, b), restore: () => restore(a, b), list, prune: () => prune(Math.max(1, Number(a) || 14)) }[cmd]
if (!run) { console.error('usage: upload <file> <name> | restore <name> <out> | list | prune <keep>'); process.exit(2) }
run().then(
  (r) => { process.stdout.write(JSON.stringify(r) + '\n'); process.exit(0) },
  (e) => { process.stderr.write(`[offsite] ${cmd} failed: ${e?.message || e}\n`); process.exit(1) },
)
