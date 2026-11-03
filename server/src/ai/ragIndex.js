// RAG indexer: turns org data (tasks, meetings, transcript segments, chat
// messages) into embedding rows for semantic retrieval. Two ways in:
//   - backfillAll()    one-time / batch (also runnable: `npm run rag:index`)
//   - indexTask(id) etc. incremental hooks called when a row changes
// All incremental hooks are best-effort: they swallow errors and no-op when no
// embedding provider is configured, so they can be sprinkled into routes without
// risk of breaking the main request.
import { db } from '../db.js'
import { now } from '../util.js'
import { embedTexts, hasEmbeddings, hashText, toBlob, embedModel } from './embeddings.js'

const BATCH = 96 // inputs per embedding API call
// Rows per page when the periodic sync walks a whole source table. Small enough
// that one page is a few milliseconds of work, so a request never waits long
// behind the sync (see syncAll).
const PAGE = 250

// Hand the event loop back so queued requests run before the next page.
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve))

// The stored hash for one source row, answered from idx_emb_hash alone. Without
// INDEXED BY, SQLite picks the UNIQUE index and then reads the row itself — and
// every row of this table carries a 6 KB vector, so checking all of them read
// most of the database. This used to load EVERY hash into a Map to check even a
// single row, synchronously, on every chat message and task save.
let hashStmt = null
function storedHash(sourceType, sourceId) {
  hashStmt ||= db.prepare('SELECT content_hash FROM embeddings INDEXED BY idx_emb_hash WHERE source_type=? AND source_id=?')
  return hashStmt.get(sourceType, sourceId)?.content_hash
}

// --- chunk builders: the text we actually embed for each source type ----------

function taskChunk(t) {
  const bits = [t.title]
  if (t.description && t.description !== t.title) bits.push(t.description)
  const meta = []
  if (t.assignee_name) meta.push(`owner: ${t.assignee_name}`)
  if (t.status) meta.push(`status: ${t.status}`)
  if (t.priority) meta.push(`priority: ${t.priority}`)
  if (t.due_date) meta.push(`due: ${t.due_date}`)
  if (t.project_name) meta.push(`project: ${t.project_name}`)
  if (meta.length) bits.push(`(${meta.join(', ')})`)
  return bits.join('. ')
}

function meetingChunk(m) {
  let summary = ''
  try {
    const s = m.summary_json ? JSON.parse(m.summary_json) : null
    if (s?.executive_summary) summary = s.executive_summary
    else if (Array.isArray(s?.action_items)) summary = s.action_items.join('; ')
  } catch { /* ignore bad JSON */ }
  return [`Meeting: ${m.title} (${m.meeting_date})`, summary].filter(Boolean).join('. ')
}

// --- generic upsert -----------------------------------------------------------

// items: [{ source_type, source_id, org_id, ref_user_id?, ref_convo_id?, text }]
// Embeds only items whose text changed since last index; upserts all touched rows.
// Returns { embedded, skipped }.
export async function indexItems(items) {
  if (!hasEmbeddings() || !items.length) return { embedded: 0, skipped: 0 }

  const stale = items.filter((it) => {
    const text = (it.text || '').trim()
    if (!text) return false
    it.text = text
    it.hash = hashText(text)
    return storedHash(it.source_type, it.source_id) !== it.hash
  })
  if (!stale.length) return { embedded: 0, skipped: items.length }

  const model = embedModel()
  const upsert = db.prepare(`
    INSERT INTO embeddings (id, org_id, source_type, source_id, ref_user_id, ref_convo_id,
                            chunk_text, content_hash, dim, vector, model, updated_at)
    VALUES (@id, @org_id, @source_type, @source_id, @ref_user_id, @ref_convo_id,
            @chunk_text, @content_hash, @dim, @vector, @model, @updated_at)
    ON CONFLICT(source_type, source_id) DO UPDATE SET
      org_id=excluded.org_id, ref_user_id=excluded.ref_user_id, ref_convo_id=excluded.ref_convo_id,
      chunk_text=excluded.chunk_text, content_hash=excluded.content_hash, dim=excluded.dim,
      vector=excluded.vector, model=excluded.model, updated_at=excluded.updated_at
  `)

  let embedded = 0
  for (let i = 0; i < stale.length; i += BATCH) {
    const batch = stale.slice(i, i + BATCH)
    const vecs = await embedTexts(batch.map((b) => b.text))
    const write = db.transaction((rows) => {
      rows.forEach((it, j) => {
        const vec = vecs[j]
        if (!vec) return
        upsert.run({
          id: `emb_${it.source_type}_${it.source_id}`,
          org_id: it.org_id,
          source_type: it.source_type,
          source_id: it.source_id,
          ref_user_id: it.ref_user_id || null,
          ref_convo_id: it.ref_convo_id || null,
          chunk_text: it.text,
          content_hash: it.hash,
          dim: vec.length,
          vector: toBlob(vec),
          model,
          updated_at: now(),
        })
        embedded++
      })
    })
    write(batch)
  }
  return { embedded, skipped: items.length - stale.length }
}

// --- collectors: pull rows -> item descriptors -------------------------------

function taskItems(where = '', params = []) {
  return db.prepare(`
    SELECT t.id, t.org_id, t.title, t.description, t.status, t.priority, t.due_date,
           t.assignee_id, u.name AS assignee_name, p.name AS project_name
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.parent_task_id IS NULL ${where}
  `).all(...params).map((t) => ({
    source_type: 'task', source_id: t.id, org_id: t.org_id,
    ref_user_id: t.assignee_id || null, text: taskChunk(t),
  }))
}

function meetingItems(where = '', params = []) {
  return db.prepare(`SELECT id, org_id, title, meeting_date, summary_json FROM meetings WHERE 1=1 ${where}`)
    .all(...params)
    .map((m) => ({ source_type: 'meeting', source_id: m.id, org_id: m.org_id, text: meetingChunk(m) }))
}

function segmentItems(where = '', params = []) {
  return db.prepare(`
    SELECT s.id, s.text, s.speaker, m.org_id, m.id AS meeting_id, m.title
    FROM transcript_segments s JOIN meetings m ON m.id = s.meeting_id
    WHERE length(s.text) > 0 ${where}
  `).all(...params).map((s) => ({
    source_type: 'segment', source_id: s.id, org_id: s.org_id,
    text: `${s.title}: ${s.speaker ? s.speaker + ': ' : ''}${s.text}`,
  }))
}

function chatItems(where = '', params = []) {
  return db.prepare(`
    SELECT id, org_id, conversation_id, body FROM chat_messages
    WHERE deleted_for_all = 0 AND body IS NOT NULL AND length(trim(body)) > 0 ${where}
  `).all(...params).map((c) => ({
    source_type: 'chat', source_id: c.id, org_id: c.org_id,
    ref_convo_id: c.conversation_id || null, text: c.body,
  }))
}

// --- public API ---------------------------------------------------------------

// Every collector, one page at a time in id order. The sync walks whole tables,
// and doing that in one go is what froze the server for ~15 s every 5 minutes in
// production: one Node thread, so every request queued behind it. A page is a
// few milliseconds; between pages the event loop is free.
const PAGED = [
  (after) => taskItems('AND t.id > ? ORDER BY t.id LIMIT ?', [after, PAGE]),
  (after) => meetingItems('AND id > ? ORDER BY id LIMIT ?', [after, PAGE]),
  (after) => segmentItems('AND s.id > ? ORDER BY s.id LIMIT ?', [after, PAGE]),
  (after) => chatItems('AND id > ? ORDER BY id LIMIT ?', [after, PAGE]),
]

export async function backfillAll() {
  let embedded = 0, skipped = 0
  for (const page of PAGED) {
    for (let after = ''; ;) {
      const items = page(after)
      if (!items.length) break
      after = items[items.length - 1].source_id
      const r = await indexItems(items)
      embedded += r.embedded
      skipped += r.skipped
      await yieldToLoop()
    }
  }
  return { embedded, skipped }
}

// Self-healing cleanup: delete embeddings whose source row no longer qualifies for
// indexing (row deleted, chat message unsent/soft-deleted, segment emptied). The
// per-route removeEmbedding hooks are best-effort and can silently miss; this makes
// the index converge to exactly what the collectors above would produce. Each check
// MIRRORS its collector's WHERE clause so we never prune a live vector; a source
// type with no check here is left alone, as the old single DELETE left it.
// Paged over the (source_type, source_id) index for the same reason as above —
// a single DELETE … NOT IN over every table can't hand the event loop back.
// Returns the number of orphan rows removed.
export async function pruneOrphans() {
  let pruned = 0
  try {
    const live = new Map([
      ['task', db.prepare('SELECT 1 FROM tasks WHERE id=? AND parent_task_id IS NULL')],
      ['meeting', db.prepare('SELECT 1 FROM meetings WHERE id=?')],
      ['segment', db.prepare('SELECT 1 FROM transcript_segments WHERE id=? AND length(text) > 0')],
      ['chat', db.prepare(`SELECT 1 FROM chat_messages
        WHERE id=? AND deleted_for_all = 0 AND body IS NOT NULL AND length(trim(body)) > 0`)],
    ])
    const page = db.prepare(`SELECT source_type, source_id FROM embeddings
      WHERE (source_type, source_id) > (?, ?) ORDER BY source_type, source_id LIMIT ?`)
    const del = db.prepare('DELETE FROM embeddings WHERE source_type=? AND source_id=?')
    for (let after = ['', '']; ;) {
      const rows = page.all(after[0], after[1], PAGE * 4)
      if (!rows.length) break
      const last = rows[rows.length - 1]
      after = [last.source_type, last.source_id]
      const gone = rows.filter((r) => live.has(r.source_type) && !live.get(r.source_type).get(r.source_id))
      if (gone.length) {
        db.transaction(() => { for (const r of gone) pruned += del.run(r.source_type, r.source_id).changes })()
      }
      await yieldToLoop()
    }
  } catch (e) { console.warn('[rag] prune failed:', e.message) }
  return pruned
}

// One call that makes the index fully current: embed new/changed rows AND remove
// orphans. This is what the server runs on boot and on a timer so RAG stays live
// with no manual command. Cheap on repeat — ~0 API calls when nothing changed.
// A sync now spans many event-loop turns, so a timer tick that lands while the
// previous sync is still running joins it instead of starting a second walk.
let running = null
export function syncAll() {
  running ||= (async () => {
    try {
      const { embedded, skipped } = await backfillAll()
      const pruned = await pruneOrphans()
      return { embedded, skipped, pruned }
    } finally {
      running = null
    }
  })()
  return running
}

// Incremental hooks (call after the row is created/updated). Best-effort.
async function safeIndex(items) {
  try { if (hasEmbeddings()) await indexItems(items) } catch (e) { console.warn('[rag] index failed:', e.message) }
}
export const indexTask = (taskId) => safeIndex(taskItems('AND t.id = ?', [taskId]))
export const indexMeeting = (meetingId) =>
  safeIndex([...meetingItems('AND id = ?', [meetingId]), ...segmentItems('AND m.id = ?', [meetingId])])
export const indexChatMessage = (msgId) => safeIndex(chatItems('AND id = ?', [msgId]))

// Remove an embedding when its source row is deleted.
export function removeEmbedding(sourceType, sourceId) {
  try { db.prepare('DELETE FROM embeddings WHERE source_type=? AND source_id=?').run(sourceType, sourceId) }
  catch { /* best-effort */ }
}

// Remove all embeddings derived from a meeting (the meeting, its transcript
// segments, and tasks it produced) — call BEFORE the rows are wiped.
export function removeMeetingEmbeddings(meetingId) {
  try {
    db.prepare(`DELETE FROM embeddings WHERE
      (source_type='meeting' AND source_id=?)
      OR (source_type='segment' AND source_id IN (SELECT id FROM transcript_segments WHERE meeting_id=?))
      OR (source_type='task' AND source_id IN (SELECT id FROM tasks WHERE meeting_id=?))`)
      .run(meetingId, meetingId, meetingId)
  } catch { /* best-effort */ }
}
