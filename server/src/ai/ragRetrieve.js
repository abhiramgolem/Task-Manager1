// RAG retrieval: given a question and the requesting user, embed the question,
// filter the embedding store down to ONLY what this user is allowed to see, then
// rank by cosine similarity and return the top chunks. RBAC is applied to the
// CANDIDATE SET before ranking — a retrieved chunk can never be one the user
// couldn't otherwise access (the #1 RAG data-leak pitfall).
//
// The filtering and ranking run in ragSearchWorker.js, on its own thread. Done
// here they read every vector the org has — the table is most of the database —
// and with one Node thread the whole server stood still meanwhile. Anything that
// goes wrong over there degrades to "no RAG", exactly as an embedding failure
// always has: the assistant answers from its snapshot instead.
import { Worker } from 'node:worker_threads'
import { db, DB_FILE } from '../db.js'
import { hasEmbeddings, embedQuery } from './embeddings.js'

const DEFAULT_TOP_K = 12
const MIN_SCORE = 0.2 // drop weak matches so unrelated chunks don't pad the prompt
// The first question after a deploy waits while the worker builds its copy of
// the index; past this, answer without RAG rather than keep the user waiting.
const SEARCH_TIMEOUT_MS = 20000
// After the worker dies, don't respawn it for this long: a worker that can't
// start would otherwise rebuild (re-reading the whole table) on every question.
const RESTART_BACKOFF_MS = 60000

let worker = null
let failedAt = 0
let seq = 0
const pending = new Map() // request id -> { resolve, reject, timer }

function failAll(err) {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err) }
  pending.clear()
}

function getWorker() {
  if (worker) return worker
  if (Date.now() - failedAt < RESTART_BACKOFF_MS) return null
  const w = new Worker(new URL('./ragSearchWorker.js', import.meta.url), { workerData: { dbFile: DB_FILE } })
  w.on('message', ({ id, result, error }) => {
    const p = pending.get(id)
    if (!p) return // already timed out
    pending.delete(id)
    clearTimeout(p.timer)
    if (error) p.reject(new Error(error))
    else p.resolve(result)
  })
  const down = (err) => {
    if (worker !== w) return
    worker = null
    failedAt = Date.now()
    console.warn('[rag] search worker stopped:', err.message)
    failAll(err)
  }
  w.on('error', down)
  w.on('exit', (code) => down(new Error(`exited with code ${code}`)))
  w.unref() // never what keeps the process alive
  worker = w
  return w
}

// Start the worker (and so its index build) ahead of the first question.
export function warmRagSearch() {
  if (hasEmbeddings()) getWorker()
}

function search(req) {
  const w = getWorker()
  if (!w) return Promise.reject(new Error('search worker is restarting'))
  return new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`no answer within ${SEARCH_TIMEOUT_MS / 1000}s`))
    }, SEARCH_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    w.postMessage({ id, ...req })
  })
}

// Returns { hits: [{source_type, source_id, text, score}], used } where `used`
// is true when RAG actually ran (provider configured AND an index exists).
export async function retrieve(query, user, { topK = DEFAULT_TOP_K, types } = {}) {
  if (!hasEmbeddings()) return { hits: [], used: false }

  // One index probe, so an org with nothing indexed doesn't pay for an embedding call.
  const any = db.prepare('SELECT 1 FROM embeddings WHERE org_id=? LIMIT 1').get(user.org_id)
  if (!any) return { hits: [], used: false } // nothing indexed yet — caller keeps its old path

  let qvec
  try { qvec = await embedQuery(query) } catch (e) {
    console.warn('[rag] query embed failed:', e.message)
    return { hits: [], used: false }
  }
  if (!qvec) return { hits: [], used: false }

  try {
    return await search({
      orgId: user.org_id,
      user: { id: user.id, role: user.role },
      qvec, topK, types, minScore: MIN_SCORE,
    })
  } catch (e) {
    console.warn('[rag] search failed, answering without it:', e.message)
    return { hits: [], used: false }
  }
}
