// Reading files that were moved off the Render disk into object storage.
//
// The Render disk is 10 GB and chat files grow ~0.3 GB a day. Each night
// (archiveFiles.js) files older than a week move to a private Supabase bucket;
// recent ones — which is nearly everything anyone opens — stay on the disk.
// When a request asks for a file that is no longer on the disk, it is streamed
// from the bucket through the server, with the same headers, Range support
// (video seeking, the PDF viewer) and access checks as before, so neither the
// web app nor the phone app can tell the difference.
//
// This side runs inside the server, so it deliberately does not load the AWS
// SDK (tens of MB on an instance that peaks near 80% of 512 MB): GET, HEAD and
// DELETE carry no body, and signing them (AWS Signature V4) is a few lines.
import crypto from 'node:crypto'
import path from 'node:path'
import { db } from './db.js'
import { now } from './util.js'
import { storedFileHeaders } from './fileStore.js'
import { archiveS3Config, archiveConfigured, partKey } from './archiveConfig.js'

export { archiveConfigured }

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest()
const EMPTY_SHA = sha('')
// RFC 3986 encoding, as S3 canonical requests require.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

// A signed request for one object. Exported for the tests.
export function signedRequest(method, objectKey, extra = {}) {
  const c = archiveS3Config()
  const u = new URL(c.endpoint)
  const pathname = `${u.pathname.replace(/\/+$/, '')}/${enc(c.bucket)}/${objectKey.split('/').map(enc).join('/')}`
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '')
  const day = amzDate.slice(0, 8)
  const signed = { host: u.host, 'x-amz-content-sha256': EMPTY_SHA, 'x-amz-date': amzDate }
  const names = Object.keys(signed).sort()
  const canonical = [method, pathname, '', names.map((h) => `${h}:${signed[h]}\n`).join(''), names.join(';'), EMPTY_SHA].join('\n')
  const scope = `${day}/${c.region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n')
  const key = hmac(hmac(hmac(hmac('AWS4' + c.secretAccessKey, day), c.region), 's3'), 'aws4_request')
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex')
  return {
    url: `${u.protocol}//${u.host}${pathname}`,
    headers: {
      'x-amz-content-sha256': EMPTY_SHA,
      'x-amz-date': amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
      ...extra,
    },
  }
}

// --- the record of what is where --------------------------------------------

export const archivedEntry = (key) =>
  db.prepare('SELECT * FROM archived_files WHERE key=? AND deleted_at IS NULL').get(key) || null

// The file under `fromKey` now also answers as `toKey` (a forward, a file
// attached to a task): the same parts in the bucket, kept once.
export function aliasArchived(fromKey, toKey) {
  return db.prepare(`INSERT OR REPLACE INTO archived_files (key, remote, bytes, parts, part_bytes, sha256, archived_at)
    SELECT ?, remote, bytes, parts, part_bytes, sha256, ? FROM archived_files WHERE key=? AND deleted_at IS NULL`)
    .run(toKey, now(), fromKey).changes > 0
}

// The message or attachment is gone. No network here: the nightly job deletes
// the parts once nothing else (an alias) still points at them.
export function forgetArchived(key) {
  if (key) db.prepare('UPDATE archived_files SET deleted_at=? WHERE key=? AND deleted_at IS NULL').run(now(), key)
}

// --- serving -----------------------------------------------------------------

// One "bytes=a-b" range (what browsers and media players send). Returns null
// for the whole file, 'bad' for an unsatisfiable one.
function parseRange(header, size) {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!m || (m[1] === '' && m[2] === '')) return null // multi-range or junk: send it all
  let start, end
  if (m[1] === '') {
    const n = Number(m[2])
    if (!n) return 'bad'
    start = Math.max(0, size - n); end = size - 1
  } else {
    start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  return start > end || start >= size ? 'bad' : { start, end }
}

const FILE_HEADERS = ['Content-Type', 'Content-Disposition', 'ETag', 'Accept-Ranges', 'Content-Security-Policy', 'Content-Range', 'Content-Length']

// Stream an archived file in answer to `req`, like sendStoredFile does for one
// on the disk.
export async function sendArchived(req, res, row, { name, type, maxAge }) {
  storedFileHeaders(req, res, row.key, { name, type, maxAge })
  if (!type || /^application\/octet-stream\b/i.test(type)) {
    const ext = path.extname(row.key)
    if (ext) res.type(ext)
  }
  const etag = row.sha256 ? `"${row.sha256.slice(0, 32)}"` : null
  res.setHeader('Accept-Ranges', 'bytes')
  if (etag) res.setHeader('ETag', etag)
  if (etag && req.headers['if-none-match'] === etag) return res.status(304).end()

  const size = row.bytes
  let range = parseRange(req.headers.range, size)
  if (range && req.headers['if-range'] && req.headers['if-range'] !== etag) range = null
  if (range === 'bad') {
    res.setHeader('Content-Range', `bytes */${size}`)
    return res.status(416).end()
  }
  const start = range ? range.start : 0
  const end = range ? range.end : size - 1
  res.status(range ? 206 : 200)
  if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
  res.setHeader('Content-Length', String(size ? end - start + 1 : 0))
  if (req.method === 'HEAD' || !size) return res.end()

  const ac = new AbortController()
  res.on('close', () => ac.abort()) // the viewer went away (a seeking <video> does, all the time)
  const waitDrain = () => new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve) })
  try {
    for (let i = Math.floor(start / row.part_bytes); i < row.parts && i * row.part_bytes <= end; i++) {
      const partStart = i * row.part_bytes
      const partLen = Math.min(row.part_bytes, size - partStart)
      const from = Math.max(start, partStart) - partStart
      const to = Math.min(end, partStart + partLen - 1) - partStart
      const whole = from === 0 && to === partLen - 1
      const { url, headers } = signedRequest('GET', partKey(row.remote, i), whole ? {} : { range: `bytes=${from}-${to}` })
      const r = await fetch(url, { headers, signal: ac.signal })
      if (!(r.status === 200 && whole) && r.status !== 206) throw new Error(`storage answered ${r.status}`)
      for await (const chunk of r.body) {
        if (ac.signal.aborted) return
        if (!res.write(chunk)) await waitDrain()
      }
    }
    res.end()
  } catch (e) {
    if (ac.signal.aborted) return
    console.error('[archive] could not serve', row.key, '-', e.message)
    if (!res.headersSent) {
      for (const h of FILE_HEADERS) res.removeHeader(h)
      res.setHeader('Cache-Control', 'no-store')
      res.status(502).json({ error: 'The file could not be fetched from storage. Please try again.' })
    } else {
      res.destroy()
    }
  }
}

// The whole file in memory — for the few callers that need the bytes (voice
// notes to transcribe), never for anything big.
export async function readArchived(row, max) {
  if (row.bytes > max) {
    const err = new Error(`This file is over ${Math.round(max / 1048576)} MB.`)
    err.code = 'TOO_LARGE'
    throw err
  }
  const bufs = []
  for (let i = 0; i < row.parts; i++) {
    const { url, headers } = signedRequest('GET', partKey(row.remote, i))
    const r = await fetch(url, { headers })
    if (r.status !== 200) throw new Error(`storage answered ${r.status}`)
    bufs.push(Buffer.from(await r.arrayBuffer()))
  }
  const buf = Buffer.concat(bufs)
  if (buf.length !== row.bytes || (row.sha256 && sha(buf) !== row.sha256)) throw new Error('archived file did not match its checksum')
  return buf
}
