// RAG search, off the main thread (started by ragRetrieve.js).
//
// Ranking a question used to load every embedding row of the org onto the main
// thread — at 59k rows of 6 KB vectors that was 350 MB and 1–2.5 s in which no
// other request ran, on a server with 512 MB. This worker keeps a compact copy
// of the index in memory instead and ranks in two stages:
//   1. every row is scored on the first DIM dimensions, quantised to int8 —
//      ~300 bytes a row instead of 6 KB. OpenAI's text-embedding-3 models are
//      trained so a prefix of the vector is itself a usable embedding;
//   2. the best CANDIDATES are re-read from the table and re-scored exactly on
//      the full vector, so the final order is what the old full scan produced.
// RBAC is applied in both stages, the second time against the row as it is now,
// so a stale cached copy can never surface something the user may not see.
//
// The copy follows the table without reading it again: rows written since the
// last look come from idx_emb_updated; deletions show up as a count mismatch and
// are found by rowid — all three answered from indexes, not from the vectors.
import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { fromBlob, cosineSim } from './embeddings.js'

const DIM = 256
const CANDIDATES = 300

const db = new Database(workerData.dbFile, { readonly: true, fileMustExist: true })
const allStmt = db.prepare(`SELECT rowid, org_id, source_type, source_id, ref_user_id, ref_convo_id, vector, updated_at
  FROM embeddings`)
const changedStmt = db.prepare(`SELECT rowid, org_id, source_type, source_id, ref_user_id, ref_convo_id, vector, updated_at
  FROM embeddings WHERE updated_at >= ? ORDER BY updated_at`)
const countStmt = db.prepare('SELECT COUNT(*) AS c FROM embeddings')
const rowidStmt = db.prepare('SELECT rowid FROM embeddings').pluck()

// Ids repeat across thousands of rows (one org, a few hundred people and chats);
// keeping one copy of each string is most of what keeps the copy small.
const strings = new Map()
const intern = (s) => {
  if (s == null) return null
  const hit = strings.get(s)
  if (hit !== undefined) return hit
  strings.set(s, s)
  return s
}

// Writes the int8 prefix of `buf` into out[off…off+DIM) and returns the factor
// that turns a dot product with a unit-length query prefix into a cosine.
function quantise(buf, out, off) {
  const v = fromBlob(buf)
  const n = Math.min(DIM, v.length)
  let norm = 0, max = 0
  for (let k = 0; k < n; k++) {
    norm += v[k] * v[k]
    const a = Math.abs(v[k])
    if (a > max) max = a
  }
  if (!norm || !max) { out.fill(0, off, off + DIM); return 0 }
  const step = max / 127
  for (let k = 0; k < DIM; k++) out[off + k] = k < n ? Math.round(v[k] / step) : 0
  return step / Math.sqrt(norm)
}

// One org's rows, in parallel arrays. A deleted row leaves a hole (type null)
// until enough holes pile up to be worth compacting.
class OrgIndex {
  constructor() {
    this.cap = 0
    this.n = 0
    this.dead = 0
    this.vec = new Int8Array(0)
    this.scale = new Float32Array(0)
    this.rowid = new Float64Array(0)
    this.type = []
    this.user = []
    this.convo = []
    this.src = []
    this.slot = new Map() // rowid -> position
  }

  grow() {
    const cap = Math.max(1024, this.cap * 2)
    const vec = new Int8Array(cap * DIM); vec.set(this.vec)
    const scale = new Float32Array(cap); scale.set(this.scale)
    const rowid = new Float64Array(cap); rowid.set(this.rowid)
    Object.assign(this, { cap, vec, scale, rowid })
  }

  put(r) {
    let i = this.slot.get(r.rowid)
    if (i === undefined) {
      if (this.n === this.cap) this.grow()
      i = this.n++
      this.slot.set(r.rowid, i)
    }
    this.rowid[i] = r.rowid
    this.type[i] = intern(r.source_type)
    this.user[i] = intern(r.ref_user_id)
    this.convo[i] = intern(r.ref_convo_id)
    // Only meetings and segments are checked by their own id (see canSee).
    this.src[i] = r.source_type === 'meeting' || r.source_type === 'segment' ? r.source_id : null
    this.scale[i] = quantise(r.vector, this.vec, i * DIM)
  }

  drop(rowid) {
    const i = this.slot.get(rowid)
    if (i === undefined) return
    this.slot.delete(rowid)
    this.type[i] = this.user[i] = this.convo[i] = this.src[i] = null
    this.dead++
    if (this.dead > 1000 && this.dead * 4 > this.n) this.compact()
  }

  compact() {
    let j = 0
    for (let i = 0; i < this.n; i++) {
      if (this.type[i] === null) continue
      if (i !== j) {
        this.vec.copyWithin(j * DIM, i * DIM, (i + 1) * DIM)
        this.scale[j] = this.scale[i]
        this.rowid[j] = this.rowid[i]
        this.type[j] = this.type[i]; this.user[j] = this.user[i]
        this.convo[j] = this.convo[i]; this.src[j] = this.src[i]
        this.slot.set(this.rowid[j], j)
      }
      j++
    }
    this.type.length = this.user.length = this.convo.length = this.src.length = j
    this.n = j
    this.dead = 0
  }
}

const orgs = new Map()  // org_id -> OrgIndex
const owner = new Map() // rowid -> OrgIndex holding it; its size is the live row count
let watermark = ''      // newest updated_at seen

function put(r) {
  let org = orgs.get(r.org_id)
  if (!org) orgs.set(r.org_id, (org = new OrgIndex()))
  const prev = owner.get(r.rowid)
  if (prev && prev !== org) prev.drop(r.rowid)
  org.put(r)
  owner.set(r.rowid, org)
  if (r.updated_at > watermark) watermark = r.updated_at
}

function drop(rowid) {
  const org = owner.get(rowid)
  if (!org) return
  org.drop(rowid)
  owner.delete(rowid)
}

function loadAll() {
  orgs.clear(); owner.clear(); strings.clear(); watermark = ''
  for (const r of allStmt.iterate()) put(r)
}

// Bring the copy up to date. One read transaction, so the change list, the
// count and the rowids all describe the same moment.
const refresh = db.transaction(() => {
  // >= rather than >: a row written in the same millisecond as the newest one
  // already seen must not be skipped. Re-reading that one row is harmless.
  for (const r of changedStmt.iterate(watermark)) put(r)
  const count = countStmt.get().c
  if (count === owner.size) return
  if (count < owner.size) {
    const present = new Set(rowidStmt.all())
    for (const rowid of [...owner.keys()]) if (!present.has(rowid)) drop(rowid)
  }
  // Rows we can't account for (written with an older timestamp, a restored
  // file): start over rather than answer from a copy we know is wrong.
  if (count !== owner.size) loadAll()
})

// ---- RBAC — the same rules ragRetrieve.js has always applied ----------------

function visibility(user) {
  if (user.role !== 'employee') return { all: true }
  const convos = new Set(
    db.prepare('SELECT conversation_id FROM chat_participants WHERE user_id=?').pluck().all(user.id)
  )
  const meetings = new Set(
    db.prepare('SELECT meeting_id FROM meeting_participants WHERE user_id=?').pluck().all(user.id)
  )
  const segments = new Set(
    db.prepare(`SELECT s.id FROM transcript_segments s
                JOIN meeting_participants mp ON mp.meeting_id = s.meeting_id
                WHERE mp.user_id=?`).pluck().all(user.id)
  )
  return { all: false, convos, meetings, segments }
}

function canSee(type, sourceId, refUser, refConvo, user, vis) {
  if (vis.all) return true
  switch (type) {
    case 'task': return refUser === user.id
    case 'chat': return vis.convos.has(refConvo)
    case 'meeting': return vis.meetings.has(sourceId)
    case 'segment': return vis.segments.has(sourceId)
    default: return false
  }
}

// ---- search -----------------------------------------------------------------

// The `size` best (score, position) pairs seen, as a min-heap on score.
class TopN {
  constructor(size) { this.size = size; this.score = []; this.pos = [] }
  swap(a, b) {
    const s = this.score[a]; this.score[a] = this.score[b]; this.score[b] = s
    const p = this.pos[a]; this.pos[a] = this.pos[b]; this.pos[b] = p
  }
  push(score, pos) {
    const s = this.score
    if (s.length < this.size) {
      s.push(score)
      this.pos.push(pos)
      for (let i = s.length - 1; i > 0;) {
        const up = (i - 1) >> 1
        if (s[up] <= s[i]) break
        this.swap(up, i)
        i = up
      }
    } else if (score > s[0]) {
      s[0] = score
      this.pos[0] = pos
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < s.length && s[l] < s[m]) m = l
        if (r < s.length && s[r] < s[m]) m = r
        if (m === i) break
        this.swap(m, i)
        i = m
      }
    }
  }
}

function search({ orgId, user, qvec, topK, types, minScore }) {
  refresh()
  const org = orgs.get(orgId)
  if (!org || !org.slot.size) return { hits: [], used: false }

  const vis = visibility(user)
  const typeFilter = Array.isArray(types) && types.length ? new Set(types) : null

  // Stage 1: approximate score for every row this user may see.
  const q = new Float32Array(DIM)
  const n = Math.min(DIM, qvec.length)
  let norm = 0
  for (let k = 0; k < n; k++) norm += qvec[k] * qvec[k]
  norm = Math.sqrt(norm) || 1
  for (let k = 0; k < n; k++) q[k] = qvec[k] / norm
  const best = new TopN(CANDIDATES)
  const { vec, scale } = org
  for (let i = 0; i < org.n; i++) {
    const type = org.type[i]
    if (type === null) continue
    if (typeFilter && !typeFilter.has(type)) continue
    if (!canSee(type, org.src[i], org.user[i], org.convo[i], user, vis)) continue
    let dot = 0
    for (let k = 0, off = i * DIM; k < DIM; k++) dot += q[k] * vec[off + k]
    best.push(dot * scale[i], i)
  }
  if (!best.pos.length) return { hits: [], used: true }

  // Stage 2: exact cosine on the full vectors, rows read as they are now.
  const rowids = best.pos.map((i) => org.rowid[i])
  const rows = db.prepare(`SELECT org_id, source_type, source_id, ref_user_id, ref_convo_id, chunk_text, vector
    FROM embeddings WHERE rowid IN (${rowids.map(() => '?').join(',')})`).all(...rowids)
  const hits = []
  for (const r of rows) {
    if (r.org_id !== orgId) continue
    if (typeFilter && !typeFilter.has(r.source_type)) continue
    if (!canSee(r.source_type, r.source_id, r.ref_user_id, r.ref_convo_id, user, vis)) continue
    const score = cosineSim(qvec, fromBlob(r.vector))
    if (score < minScore) continue
    hits.push({ source_type: r.source_type, source_id: r.source_id, text: r.chunk_text, score })
  }
  hits.sort((a, b) => b.score - a.score)
  return { hits: hits.slice(0, topK), used: true }
}

// Build the copy before taking questions: messages queue until this returns.
db.transaction(loadAll)()

parentPort.on('message', (msg) => {
  try {
    parentPort.postMessage({ id: msg.id, result: search(msg) })
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: e.message })
  }
})
