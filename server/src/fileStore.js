import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { id } from './util.js'

// Big uploads (chat files, task attachments) in and out of the data disk. Chat
// grew this when its limit went to 1 GB; task attachments share it so the two
// cannot drift apart, and so both count against the one disk they share.

export const MB = 1024 * 1024
// The data disk: the database, chat files, task files and avatars all live on it.
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
// That disk also holds the SQLite database. A file that fills it does not just
// fail to save — every later write in the app fails with it — so a file is only
// let in if this much is still free once it lands.
const DISK_HEADROOM = 200 * MB
// Bytes promised to uploads still streaming in, so two big files that each fit
// on their own cannot both be let into room only one of them has. Module-wide on
// purpose: a chat file and a task attachment land on the same disk.
let reserved = 0

// multer's own diskStorage pipes the part into the file and stops there: a
// sender who drops out mid-file leaves the write stream open and the half-file
// on disk for good. For hundreds of MB over a phone connection that is the
// common case, not the rare one, so this does the same job and closes and
// removes the scrap when the request goes away unfinished.
export function streamingStorage(dir, prefix) {
  return {
    _handleFile(req, file, cb) {
      const filename = id(prefix) + path.extname(file.originalname || '').slice(0, 12)
      const abs = path.join(dir, filename)
      const out = fs.createWriteStream(abs)
      const abandon = () => { if (!req.complete) out.destroy(new Error('Upload abandoned')) }
      req.once('close', abandon)
      pipeline(file.stream, out, (err) => {
        req.off('close', abandon)
        if (err) { fs.unlink(abs, () => {}); return cb(err) }
        cb(null, { destination: dir, filename, path: abs, size: out.bytesWritten })
      })
    },
    _removeFile(req, file, cb) { fs.unlink(file.path, () => cb(null)) },
  }
}

const freeBytes = (dir) => {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize } catch { return Infinity }
}

// The whole data disk at a glance: { free, total, pct } (pct = share still free),
// or null where the platform can't say. Cached for 30 s — it is asked on every
// upload request (index.js) and statfs, though cheap, need not run per request.
let diskCache = { at: 0, v: null }
export function diskStatus(dir = DATA_DIR) {
  if (Date.now() - diskCache.at < 30_000) return diskCache.v
  let v = null
  try {
    const s = fs.statfsSync(dir)
    const free = s.bavail * s.bsize, total = s.blocks * s.bsize
    v = { free, total, pct: total ? free / total : 1 }
  } catch {}
  diskCache = { at: Date.now(), v }
  return v
}
// A full disk doesn't just refuse the file: SQLite then fails every write, and
// the whole app stops — no message can be sent, no task saved. Only the big
// upload routes checked for room; avatars, voice notes, call audio and meeting
// recordings went straight to disk. Anything multipart is now refused while the
// disk is below the headroom, so the database always keeps room to write.
export function uploadsBlocked() {
  const d = diskStatus()
  return !!d && d.free - reserved < DISK_HEADROOM
}

const NO_ROOM = 'The server is out of storage space for a file this size'

// Browsers send a file's name as UTF-8, but the busboy under multer 1.4.5 reads
// it as Latin-1, so "రిపోర్ట్.xlsx" or "Q3 — final.xlsx" arrived garbled. The
// Latin-1 string still holds the exact bytes, so re-reading them as UTF-8 gets
// the name back; a name that is not valid UTF-8 is left as it came, and so is
// one already holding characters past Latin-1 (a multer that decodes properly).
const utf8Name = (name) => {
  if (!name || !/[\x80-\xff]/.test(name) || /[^\x00-\xff]/.test(name)) return name
  const fixed = Buffer.from(name, 'latin1').toString('utf8')
  return fixed.includes('�') ? name : fixed
}

// One upload route's way in: `receive` is the middleware, `refusal(bytes)` is
// the same verdict for an upload-room question asked before sending.
//
// Content-Length is the whole form, so a file that is over the limit, or that
// the disk has no room for, is turned away before a byte of it is written, and
// the connection closed so the rest is not sent for nothing. The sender's
// browser will not read that answer mid-upload — it sees a dropped connection —
// which is why the app asks the route's upload-room first. multer's own errors
// come back as a status, not the global 500.
//
// `kind` also lets the same route take a file sent in chunks (below): a JSON
// body naming a finished upload stands in for the multipart one, and the
// handler after it sees the same req.file either way. Multipart stays for small
// files, where one request beats three, and for app builds already installed.
export function bigFileUpload({ kind, dir, prefix, max, tooBig }) {
  // +1 because busboy counts reaching the limit as going over it, and a file of
  // exactly `max` is one the app says it takes.
  const upload = multer({ storage: streamingStorage(dir, prefix), limits: { fileSize: max + 1 } })
  // [status, message] if this many bytes cannot come in right now, else null.
  // The MB of slack is the multipart wrapping around the file itself.
  const refusal = (len) => (len > max + MB ? [413, tooBig]
    : len && freeBytes(dir) - reserved - len < DISK_HEADROOM ? [507, NO_ROOM] : null)
  if (kind) registerKind(kind, { dir, prefix, max, tooBig })
  function receive(req, res, next) {
    if (kind && req.is('application/json')) {
      if (!req.body?.uploadId) return next() // the handler answers "file required"
      const got = claimUpload(req.body.uploadId, req.user, kind)
      if (got.error) return res.status(got.status).json({ error: got.error })
      req.file = got.file
      return next()
    }
    const len = Number(req.headers['content-length']) || 0
    const refuse = (status, error) => { if (!res.headersSent) res.status(status).set('Connection', 'close').json({ error }) }
    const no = refusal(len)
    if (no) return refuse(...no)
    reserved += len
    let gone = false
    res.once('close', () => { reserved -= len; if (!res.writableFinished) gone = true })
    upload.single('file')(req, res, (err) => {
      if (!err) {
        if (req.file) req.file.originalname = utf8Name(req.file.originalname)
        return next()
      }
      if (gone) return // the sender left; storage has already removed the half-file
      if (err.code === 'LIMIT_FILE_SIZE') return refuse(413, tooBig)
      if (err.code === 'ENOSPC') return refuse(507, NO_ROOM)
      next(err)
    })
  }
  return { receive, refusal }
}

// ---- Chunked uploads ------------------------------------------------------
// A big file in one request is at the mercy of one connection. Over a phone
// link that drops for a moment at 80%, all of it is lost and sent again from
// zero; and one TCP stream on a lossy, high-latency path (India to the
// Singapore server) rarely fills the uplink it has. So a file over a few MB
// goes up as fixed-size chunks, several at once, each retried on its own, and
// the route it was meant for is then called with the upload's id instead of
// the file. A chunk is a raw body written at its offset. (It is not cheaper
// for the server than multipart — measured, both cost about the same CPU per
// GB; busboy is not the bottleneck. What it buys is a dropped connection
// costing one chunk, and several streams filling a link one stream cannot.)
//
// Sessions live in memory: there is one process, and a restart (a deploy)
// costs an upload in flight no more than it did before. What a lost session
// leaves on disk — its part file — is cleared when the kind registers at boot.
export const CHUNK_SIZE = 8 * MB
// Long enough for a chunk crawling up a 2G link, short enough that an upload
// abandoned with the app gives its disk reservation back the same hour.
const IDLE_MS = 60 * 60 * 1000
// Reservations are taken when an upload opens, before any byte arrives, so
// one account cannot open enough of them to claim the disk.
const MAX_OPEN_PER_USER = 8

const kinds = new Map()     // 'chat' | 'task' → where its files go and its limit
const sessions = new Map()  // upload id → session

function registerKind(kind, { dir, prefix, max, tooBig }) {
  // Part files sit in their own folder on the same disk: the rename into place
  // at the end is then atomic, and the boot sweep reads this folder alone, not
  // one holding every file ever sent.
  const partDir = path.join(dir, '.partial')
  fs.mkdirSync(partDir, { recursive: true })
  for (const f of fs.readdirSync(partDir)) fs.unlink(path.join(partDir, f), () => {})
  kinds.set(kind, { dir, partDir, prefix, max, tooBig })
}

function dropSession(s) {
  if (!sessions.delete(s.id)) return
  reserved -= s.size
  for (const w of s.writers) w.destroy()
  fs.unlink(s.abs, () => {})
}

setInterval(() => {
  const cutoff = Date.now() - IDLE_MS
  for (const s of sessions.values()) if (s.touched < cutoff && !s.writers.size) dropSession(s)
}, 5 * 60 * 1000).unref()

// POST /api/uploads — { kind, size, name, type } → { id, chunkSize, chunks }.
// The same limit and disk-room verdict as the multipart route, given before
// anything is sent, so this also answers what /upload-room used to be asked.
export function openUpload(user, { kind, size, name, type } = {}) {
  const k = kinds.get(kind)
  if (!k) return { status: 400, error: 'Unknown upload kind' }
  size = Number(size)
  if (!Number.isSafeInteger(size) || size <= 0) return { status: 400, error: 'size required' }
  if (size > k.max) return { status: 413, error: k.tooBig }
  if (freeBytes(k.dir) - reserved - size < DISK_HEADROOM) return { status: 507, error: NO_ROOM }
  let open = 0
  for (const s of sessions.values()) if (s.userId === user.id) open++
  if (open >= MAX_OPEN_PER_USER) return { status: 429, error: 'Too many files going up at once — wait for one to finish' }
  const uid = id('up')
  const abs = path.join(k.partDir, uid)
  fs.closeSync(fs.openSync(abs, 'w'))
  const chunks = Math.ceil(size / CHUNK_SIZE)
  const s = {
    id: uid, kind, userId: user.id, size, abs, chunks,
    // The name and type the browser gave the file, as multer would have had
    // them — but JSON is UTF-8 already, so no Latin-1 repair is needed.
    name: String(name || 'file').replace(/[\x00-\x1f\\/]/g, '_').slice(0, 255) || 'file',
    type: /^[\w.+-]+\/[\w.+-]+$/.test(String(type || '')) ? String(type).slice(0, 127) : 'application/octet-stream',
    got: new Uint8Array(chunks), left: chunks, writers: new Set(), touched: Date.now(),
  }
  sessions.set(uid, s)
  reserved += size
  return { upload: { id: uid, chunkSize: CHUNK_SIZE, chunks } }
}

// PUT /api/uploads/:id with X-Chunk-Index — one chunk, raw. The index rides in
// a header, not the path, so every chunk of a file shares one URL: a browser
// caches a CORS preflight per URL, and the Android app is cross-origin.
// Writing a chunk twice is harmless (a retry whose first answer was lost): the
// bytes are the same, at the same place.
export function receiveChunk(req, res) {
  const s = sessions.get(req.params.id)
  if (!s || s.userId !== req.user.id) return res.status(404).json({ error: 'Upload not found — send the file again' })
  const index = Number(req.get('x-chunk-index'))
  if (!Number.isInteger(index) || index < 0 || index >= s.chunks) return res.status(400).json({ error: 'Bad chunk index' })
  const start = index * CHUNK_SIZE
  const expect = Math.min(CHUNK_SIZE, s.size - start)
  // Content-Length is what node's parser holds the body to, so checking it
  // here means a chunk of the wrong size never reaches the disk.
  if (Number(req.headers['content-length']) !== expect) return res.status(400).json({ error: `Chunk ${index} must be ${expect} bytes` })
  s.touched = Date.now()
  const out = fs.createWriteStream(s.abs, { flags: 'r+', start })
  s.writers.add(out)
  pipeline(req, out, (err) => {
    s.writers.delete(out)
    // A sender who went away mid-chunk is retrying it, or has given up; the
    // bytes it left at this offset are overwritten or deleted with the part.
    if (err) { if (!res.headersSent && !req.destroyed) res.status(500).json({ error: 'Could not save the chunk' }); return }
    if (!sessions.has(s.id)) return res.status(404).json({ error: 'Upload not found — send the file again' })
    if (out.bytesWritten !== expect) return res.status(400).json({ error: 'Chunk incomplete' })
    if (!s.got[index]) { s.got[index] = 1; s.left-- }
    s.touched = Date.now()
    res.json({ ok: true, left: s.left })
  })
}

// DELETE /api/uploads/:id — the sender gave up; free its room now rather than
// in an hour.
export function cancelUpload(user, uploadId) {
  const s = sessions.get(uploadId)
  if (s && s.userId === user.id) dropSession(s)
}

// A finished upload, moved into place and shaped like the req.file multer
// gives, for the route the file was meant for. Its kind must match the route,
// so a file sent for a task (500 MB cap) cannot be posted into a chat and the
// other way round.
function claimUpload(uploadId, user, kind) {
  const s = sessions.get(String(uploadId))
  if (!s || s.userId !== user?.id || s.kind !== kind) return { status: 404, error: 'Upload not found — send the file again' }
  if (s.left) return { status: 409, error: `Upload incomplete: ${s.left} of ${s.chunks} parts still to come` }
  const k = kinds.get(kind)
  sessions.delete(s.id)
  reserved -= s.size
  // Only duplicates of chunks already in can still be writing; stop them.
  for (const w of s.writers) w.destroy()
  const filename = id(k.prefix) + path.extname(s.name).slice(0, 12)
  const abs = path.join(k.dir, filename)
  try {
    fs.renameSync(s.abs, abs)
    if (fs.statSync(abs).size !== s.size) throw new Error('size mismatch')
  } catch {
    fs.unlink(abs, () => {}); fs.unlink(s.abs, () => {})
    return { status: 500, error: 'The file could not be put together — send it again' }
  }
  return { file: { originalname: s.name, filename, path: abs, destination: k.dir, mimetype: s.type, size: s.size } }
}

// Sent with res.sendFile rather than piped, because a media player needs more
// than a byte stream: Range requests (206) are how a <video> seeks — and iOS
// WebKit will not play a video at all from a server that ignores them —
// Content-Length lets a player show how far along it is, and ETag /
// Last-Modified let an image grid revalidate instead of downloading again.
// Cached privately only: the URL carries the viewer's token.
//
// An upload is served from the app's own origin, so an HTML or SVG file opened
// inline would run its scripts with the viewer's session. Those get a sandbox
// CSP, which renders them script-less in an opaque origin; images, video, audio,
// PDFs and office files never match and are untouched by it.
const ACTIVE_TYPE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/(x-)?javascript)\b/i
const ACTIVE_EXT = /\.(html?|xht|xhtml|svgz?|xml|xsl|js|mjs)$/i

// RFC 6266: an ASCII name every browser reads, plus the real one for those that
// read filename* — so "Q3 sales — final.xlsx" saves under that name, not with
// %20s in it.
const disposition = (kind, name) => {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export function sendStoredFile(req, res, abs, { name, type, maxAge }) {
  const filename = name || 'file'
  // The declared type wins (send never overrides a Content-Type that is
  // already set), except the generic octet-stream: then send names the type
  // from the stored extension, so a photo picked as "a file" still displays
  // and a clip still plays.
  if (type && !/^application\/octet-stream\b/i.test(type)) res.type(type)
  res.setHeader('Content-Disposition', disposition(req.query.download === '1' ? 'attachment' : 'inline', filename))
  res.setHeader('Cache-Control', `private, max-age=${maxAge}`)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  if (ACTIVE_TYPE.test(type || '') || ACTIVE_EXT.test(abs) || ACTIVE_EXT.test(filename)) {
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'")
  }
  // Dotfiles allowed because the path is ours, not the requester's; the cache
  // header is the one set above, not send's public default.
  res.sendFile(abs, { cacheControl: false, dotfiles: 'allow' }, (err) => {
    // Nothing to fix once the headers are out, or when the viewer went away
    // mid-transfer — which a seeking <video> does all the time.
    if (!err || res.headersSent || err.code === 'ECONNABORTED') return
    // send had already set the file's headers when it hit the error, and none
    // of them describe what goes out instead.
    for (const h of ['Content-Type', 'Content-Disposition', 'ETag', 'Last-Modified', 'Accept-Ranges', 'Content-Security-Policy']) res.removeHeader(h)
    res.setHeader('Cache-Control', 'no-store')
    // A range past the end of the file, or a failed If-Match: answer with the
    // status send chose (it has already set Content-Range for a 416).
    const status = err.status || err.statusCode
    if (status === 416 || status === 412) return res.status(status).end()
    res.status(404).json({ error: 'File missing' })
  })
}
