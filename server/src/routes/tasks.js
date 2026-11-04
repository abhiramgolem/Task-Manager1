import { Router } from 'express'
import multer from 'multer'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../db.js'
import { authRequired, verifyToken } from '../auth.js'
import { id, now, audit, notify, notifyManagers, dueDateForPriority } from '../util.js'
import { resolveUser } from '../ai/extractor.js'
import { indexTask, removeEmbedding } from '../ai/ragIndex.js'
import { parseSpokenTask, hasLLM } from '../ai/voiceTask.js'
import { interpretVoiceSearch } from '../ai/voiceSearch.js'
import { resolveCategory, normalizeCategory } from '../categories.js'
import { recordUsage } from '../ai/usage.js'
import { MB, bigFileUpload, sendStoredFile } from '../fileStore.js'

// The configured speech-to-text provider, for usage attribution.
const STT_PROVIDER = (process.env.TRANSCRIPTION_PROVIDER || 'sarvam').toLowerCase()
import { parseDueDate } from '../ai/dates.js'
import { transcribeAudio } from '../ai/transcribe.js'

const r = Router()

// --- Task attachments (any file, up to 500 MB) -------------------------------
// Files live on disk in data/task_uploads; the DB row carries the metadata. We
// follow the chat-file model: an authenticated streaming route (below) serves
// them, so nothing under data/ is ever exposed via static middleware.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ATTACH_DIR = path.join(__dirname, '..', '..', 'data', 'task_uploads')
fs.mkdirSync(ATTACH_DIR, { recursive: true })

// How long a deleted task stays recoverable. A month is long enough that "we
// deleted the wrong thing" surfaces at the next planning meeting rather than
// after the evidence is gone.
export const RECOVERY_DAYS = Number(process.env.TASK_RECOVERY_DAYS || 30)

// The real, irreversible delete. Reached two ways: someone empties an entry from
// the bin on purpose, or the scheduler reaps one whose month is up. The attachment
// files are unlinked HERE and nowhere else — up to this moment the task is
// genuinely restorable, files included.
export function purgeDeletedTask(row) {
  try {
    for (const a of JSON.parse(row.payload).attachments || []) {
      if (a.stored_name) try { fs.unlinkSync(path.join(ATTACH_DIR, a.stored_name)) } catch {}
    }
  } catch { /* a malformed payload must not block the purge */ }
  db.prepare('DELETE FROM deleted_tasks WHERE id=?').run(row.id)
}
// Any kind of file, up to 500 MB. It used to be images, PDFs and videos under
// 50 MB, which turned away the spreadsheets and the phone-camera videos people
// actually hand work over with. A file streams straight to disk, so the size
// costs disk and never memory; fileStore.js removes half-sent files and refuses
// one the disk has no room for, on the same budget as chat files.
const ATTACH_MAX = Number(process.env.TASK_ATTACH_MAX_MB || 500) * MB
const taskFiles = bigFileUpload({
  kind: 'task', dir: ATTACH_DIR, prefix: 'att', max: ATTACH_MAX, tooBig: `File too large (max ${ATTACH_MAX / MB} MB)`,
})

// SERVE / DOWNLOAD an attachment. Declared BEFORE authRequired so <img>/<video>
// tags (which can't send an Authorization header) can authenticate via ?token=.
// Enforces that the viewer is in the SAME org as the task the file belongs to.
// sendStoredFile answers Range requests (a 500 MB video seeks instead of
// downloading whole) and sandboxes HTML/SVG, which any-file-type now lets in.
r.get('/attachments/:attId/file', (req, res) => {
  const user = (req.headers.authorization || '').startsWith('Bearer ')
    ? verifyToken(req.headers.authorization.slice(7))
    : verifyToken(req.query.token)
  if (!user) return res.status(401).json({ error: 'Authentication required' })
  const a = db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.attId)
  if (!a || !a.stored_name) return res.status(404).json({ error: 'Not found' })
  // Org check (org_id was backfilled onto newer rows; fall back to the task's org).
  const taskOrg = a.org_id || db.prepare('SELECT org_id FROM tasks WHERE id=?').get(a.task_id)?.org_id
  if (taskOrg && taskOrg !== user.org_id) return res.status(403).json({ error: 'Out of organization' })
  const abs = path.join(ATTACH_DIR, a.stored_name)
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'File missing' })
  sendStoredFile(req, res, abs, { name: a.filename, type: a.file_type, maxAge: 300 })
})

r.use(authRequired)

// Asked before a big attachment is sent: would it be let in right now? The
// upload route checks the same thing, but a browser reads no answer until it
// has sent the whole body, so a refusal there arrives as "connection lost".
// Declared ahead of GET /:id, which would otherwise take "upload-room" for a
// task id.
r.get('/upload-room', (req, res) => {
  const no = taskFiles.refusal(Number(req.query.size) || 0)
  if (no) return res.status(no[0]).json({ error: no[1] })
  res.json({ ok: true })
})

// Voice dictation for the "Speak" button records ONE short audio clip (≤ ~30s)
// per task, so a 10 MB cap is plenty and keeps abuse small.
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

const VALID_STATUS = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Reopened']

const userBrief = (uid) => (uid ? db.prepare('SELECT id,name,avatar_color FROM users WHERE id=?').get(uid) : null)

// How this task came to its current owner, so the UI can label it:
//   split       — it is one part of a task somebody divided up
//   reassigned  — it was moved off a previous owner
//   assigned    — somebody else handed it over directly
//   self        — the owner created it for themselves (no hand-off to show)
function taskOrigin(t) {
  if (t.parent_task_id) return 'split'
  if (t.reassigned_at) return 'reassigned'
  if (t.assigned_by_id && t.assignee_id && t.assigned_by_id !== t.assignee_id) return 'assigned'
  return 'self'
}

// A task the user raised for themselves: they own both ends of it, so finishing
// or binning it is their call alone — no manager sign-off. Deliberately stricter
// than taskOrigin()'s 'self', which also covers unassigned tasks and would hand
// an employee rights over work nobody owns yet. Split parts and tasks reassigned
// onto someone come out of another person's plan, so they keep the approval flow
// even when the ids happen to line up.
function isOwnSelfCreated(t, userId) {
  return !!userId && !t.parent_task_id && !t.reassigned_at &&
    !!t.assignee_id && t.assignee_id === userId && t.assigned_by_id === userId
}

function hydrate(t) {
  if (!t) return t
  const assignee = t.assignee_id ? db.prepare('SELECT id,name,avatar_color,role FROM users WHERE id=?').get(t.assignee_id) : null
  const assignedBy = userBrief(t.assigned_by_id)
  const reassignedBy = userBrief(t.reassigned_by_id)
  const previousAssignee = userBrief(t.previous_assignee_id)
  const completedBy = userBrief(t.completed_by_id)
  const project = t.project_id ? db.prepare('SELECT id,name FROM projects WHERE id=?').get(t.project_id) : null
  const subtasks = db.prepare('SELECT * FROM tasks WHERE parent_task_id=? ORDER BY created_at').all(t.id)
  // A split part needs to name its parent — it's shown out of context in lists
  // and dashboards now, where "part of X" is the only thing that makes it read.
  const parent = t.parent_task_id
    ? db.prepare('SELECT id,title,assignee_id FROM tasks WHERE id=?').get(t.parent_task_id)
    : null
  const comments = db.prepare(`SELECT c.*, u.name AS user_name, u.avatar_color FROM task_comments c JOIN users u ON u.id=c.user_id WHERE c.task_id=? ORDER BY c.created_at`).all(t.id)
  const deps = db.prepare(`SELECT d.depends_on_task_id AS id, t2.title, t2.status FROM task_dependencies d JOIN tasks t2 ON t2.id=d.depends_on_task_id WHERE d.task_id=?`).all(t.id)
  const attachments = db.prepare('SELECT * FROM attachments WHERE task_id=?').all(t.id)
  return {
    ...t, assignee, assignedBy, reassignedBy, previousAssignee, completedBy, parent, project,
    subtasks, comments, dependencies: deps, attachments,
    origin: taskOrigin(t),
    is_split_parent: subtasks.length > 0,
  }
}

// rows.map(hydrate) without hydrate's ~11 queries per task: each related table
// is read once for the whole list (ids passed as one JSON array, so there's no
// bound-parameter limit) and handed out from memory. GET /tasks returns every
// task a manager can see, so per-task queries made opening the Tasks page cost
// ~1 s of the server's only thread at 5,000 tasks. The result is the same as
// rows.map(hydrate), key order and missing-row `undefined`s included — change
// one, change the other.
function hydrateMany(rows) {
  if (!rows.length) return []
  const inList = (sql, ids) => db.prepare(sql).all(JSON.stringify([...ids]))
  const groupBy = (list, key, pick = (r) => r) => {
    const by = new Map()
    for (const r of list) {
      if (!by.has(r[key])) by.set(r[key], [])
      by.get(r[key]).push(pick(r))
    }
    return by
  }
  const taskIds = rows.map((t) => t.id)

  const userIds = new Set()
  for (const t of rows) {
    for (const k of ['assignee_id', 'assigned_by_id', 'reassigned_by_id', 'previous_assignee_id', 'completed_by_id']) {
      if (t[k]) userIds.add(t[k])
    }
  }
  const users = new Map(inList('SELECT id,name,avatar_color,role FROM users WHERE id IN (SELECT value FROM json_each(?))', userIds)
    .map((u) => [u.id, u]))
  const assigneeOf = (uid) => { if (!uid) return null; const u = users.get(uid); return u && { ...u } }
  const briefOf = (uid) => { if (!uid) return null; const u = users.get(uid); return u && { id: u.id, name: u.name, avatar_color: u.avatar_color } }

  const projects = new Map(inList('SELECT id,name FROM projects WHERE id IN (SELECT value FROM json_each(?))',
    new Set(rows.map((t) => t.project_id).filter(Boolean))).map((p) => [p.id, p]))
  const parents = new Map(inList('SELECT id,title,assignee_id FROM tasks WHERE id IN (SELECT value FROM json_each(?))',
    new Set(rows.map((t) => t.parent_task_id).filter(Boolean))).map((p) => [p.id, p]))
  const subtasks = groupBy(inList(`SELECT * FROM tasks WHERE parent_task_id IN (SELECT value FROM json_each(?))
    ORDER BY parent_task_id, created_at, rowid`, taskIds), 'parent_task_id')
  const comments = groupBy(inList(`SELECT c.*, u.name AS user_name, u.avatar_color FROM task_comments c JOIN users u ON u.id=c.user_id
    WHERE c.task_id IN (SELECT value FROM json_each(?)) ORDER BY c.task_id, c.created_at, c.rowid`, taskIds), 'task_id')
  const deps = groupBy(inList(`SELECT d.task_id AS of_task, d.depends_on_task_id AS id, t2.title, t2.status
    FROM task_dependencies d JOIN tasks t2 ON t2.id=d.depends_on_task_id
    WHERE d.task_id IN (SELECT value FROM json_each(?)) ORDER BY d.task_id, d.depends_on_task_id`, taskIds),
  'of_task', (d) => ({ id: d.id, title: d.title, status: d.status }))
  const attachments = groupBy(inList(`SELECT * FROM attachments WHERE task_id IN (SELECT value FROM json_each(?))
    ORDER BY task_id, rowid`, taskIds), 'task_id')

  return rows.map((t) => {
    const subs = subtasks.get(t.id) || []
    return {
      ...t,
      assignee: assigneeOf(t.assignee_id),
      assignedBy: briefOf(t.assigned_by_id),
      reassignedBy: briefOf(t.reassigned_by_id),
      previousAssignee: briefOf(t.previous_assignee_id),
      completedBy: briefOf(t.completed_by_id),
      parent: t.parent_task_id ? parents.get(t.parent_task_id) && { ...parents.get(t.parent_task_id) } : null,
      project: t.project_id ? projects.get(t.project_id) && { ...projects.get(t.project_id) } : null,
      subtasks: subs,
      comments: comments.get(t.id) || [],
      dependencies: deps.get(t.id) || [],
      attachments: attachments.get(t.id) || [],
      origin: taskOrigin(t),
      is_split_parent: subs.length > 0,
    }
  })
}

// WHO HEARS THAT A TASK IS DONE. Until this, finishing a task told nobody: only
// "submitted for approval" and the approval verdict sent anything, so a task
// closed directly — the ✓ tick, a board drag, the assistant — just turned green,
// and the manager who had asked for it found out by stumbling on it.
//
// The assigner and the owner always hear, unless they closed it themselves.
// When the closer is an employee, every manager hears too: closing work someone
// else assigned skipped the review they would have been asked for, so this is
// the audience "submitted for approval" reaches, told after the fact instead of
// before. A manager's close goes to the assigner and owner only — fanning it out
// to every other manager would bury the bell for no one's benefit.
// A task you raised for yourself involves nobody else, so it tells nobody.
function notifyCompleted(t, actor) {
  if (isOwnSelfCreated(t, actor.id)) return
  const msg = `${actor.name} marked "${t.title}" as done`
  const told = new Set([actor.id])
  const tell = (uid) => {
    if (!uid || told.has(uid)) return
    told.add(uid)
    notify(t.org_id, uid, 'task_completed', msg, t.id)
  }
  tell(t.assigned_by_id)
  tell(t.assignee_id)
  if (actor.role === 'employee') {
    for (const m of db.prepare("SELECT id FROM users WHERE org_id=? AND role IN ('manager','admin')").all(t.org_id)) tell(m.id)
  }
}

// Roll a split parent's status up from its children: once every shared part is
// Done the parent auto-completes; if a part is later reopened, the parent reopens
// too — so the owner stays accountable and the roll-up stays honest. `actor` is
// whoever finished (or reopened) the part that tipped it, and is recorded as the
// parent's closer: that is the action that completed it.
function syncParentStatus(parentId, actor) {
  if (!parentId) return
  const parent = db.prepare('SELECT * FROM tasks WHERE id=?').get(parentId)
  if (!parent) return
  const kids = db.prepare('SELECT status FROM tasks WHERE parent_task_id=?').all(parentId)
  if (!kids.length) return
  const allDone = kids.every((k) => k.status === 'Done')
  if (allDone && parent.status !== 'Done') {
    db.prepare('UPDATE tasks SET status=?, progress=100, completed_at=?, completed_by_id=?, updated_at=? WHERE id=?')
      .run('Done', now(), actor?.id || null, now(), parentId)
    // Its own action rather than task.status: nobody pressed Done on the parent,
    // and the Activity view should say it closed itself, not that they ticked it.
    audit(parent.org_id, actor?.id || null, 'task.rollup', 'task', parentId, 'Done')
    const msg = `All parts of "${parent.title}" are done — task completed`
    notify(parent.org_id, parent.assignee_id, 'task_approved', msg, parentId)
    // Whoever asked for the parent is waiting on it too, not only its owner.
    if (parent.assigned_by_id && parent.assigned_by_id !== parent.assignee_id && parent.assigned_by_id !== actor?.id) {
      notify(parent.org_id, parent.assigned_by_id, 'task_completed', msg, parentId)
    }
    indexTask(parentId)
  } else if (!allDone && parent.status === 'Done') {
    db.prepare('UPDATE tasks SET status=?, progress=?, completed_at=NULL, completed_by_id=NULL, updated_at=? WHERE id=?')
      .run('Reopened', Math.min(parent.progress ?? 0, 80), now(), parentId)
    audit(parent.org_id, actor?.id || null, 'task.rollup', 'task', parentId, 'Reopened')
    indexTask(parentId)
  }
}

// LIST with filters: ?status=&priority=&assignee=&project=&meeting=&mine=1&q=
r.get('/', (req, res) => {
  const { status, priority, assignee, project, meeting, mine, q, confidence, assigned_by_me } = req.query
  // NOTE: split parts (rows with a parent_task_id) used to be excluded here. That
  // made them unreachable — the assignee got a notification for a task that
  // appeared in no list, and couldn't open the parent either since it wasn't
  // theirs. Parts are ordinary tasks to the person doing them, so they're listed
  // like any other and carry a "Part of X" badge for context.
  let sql = `SELECT t.* FROM tasks t WHERE t.org_id=?`
  const args = [req.user.org_id]
  if (assigned_by_me) {
    // Work I handed to someone else — lets the dashboard's "Assigned by me"
    // section link through to the full list. This REPLACES the usual visibility
    // clause rather than adding to it: an employee's is `assignee_id = me`, which
    // can never also be `!= me`. Safe, because being the assigner (or the person
    // who moved it) is itself the grounds for seeing it.
    sql += ' AND t.assignee_id IS NOT NULL AND t.assignee_id != ? AND (t.assigned_by_id=? OR t.reassigned_by_id=?)'
    args.push(req.user.id, req.user.id, req.user.id)
  } else if (req.user.role === 'employee') {
    // Employees see all of their own tasks (including private drafts).
    sql += ' AND t.assignee_id=?'; args.push(req.user.id)
  } else {
    // Managers/admins don't see an employee's private draft until it's submitted.
    sql += ' AND (t.visible_to_manager=1 OR t.assignee_id=?)'; args.push(req.user.id)
  }
  if (mine) { sql += ' AND t.assignee_id=?'; args.push(req.user.id) }
  if (status) { sql += ' AND t.status=?'; args.push(status) }
  if (priority) { sql += ' AND t.priority=?'; args.push(priority) }
  if (assignee === 'unassigned') { sql += ' AND t.assignee_id IS NULL' }
  else if (assignee) { sql += ' AND t.assignee_id=?'; args.push(assignee) }
  if (project) { sql += ' AND t.project_id=?'; args.push(project) }
  if (meeting) { sql += ' AND t.meeting_id=?'; args.push(meeting) }
  if (confidence) { sql += ' AND t.ownership_confidence=?'; args.push(confidence) }
  // Match the query against the title, description, OR the assignee's name — so
  // searching (or saying) a person's name surfaces all of their tasks.
  if (q) {
    sql += ' AND (t.title LIKE ? OR t.description LIKE ? OR t.assignee_id IN (SELECT id FROM users WHERE org_id=? AND name LIKE ?))'
    args.push(`%${q}%`, `%${q}%`, req.user.org_id, `%${q}%`)
  }
  sql += " ORDER BY CASE t.priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, t.due_date IS NULL, t.due_date"
  const rows = db.prepare(sql).all(...args)
  res.json(hydrateMany(rows))
})

// ---- activity feed ----------------------------------------------------------
// Declared above `/:id` for the same reason as the recycle bin below.
//
// EVERYTHING THAT HAPPENED TO THE WORK: created, assigned, moved, completed,
// reopened, edited, commented on, deleted, restored — by whom and when. The
// audit log has recorded each of these with its author all along; until now
// only the dashboard's last-25 strip and a task's own "Edited by" list read it.
//
// Each row is an audit entry read as the event a person would name (its kind),
// joined to the task it touched: the live row, else its recycle-bin snapshot,
// so a deleted task still has a title, owner and priority to filter on.
//
// Tasks approved out of a meeting never wrote a task.create row (meetings.js
// logs meeting.assign on the meeting instead), so any task with no create or
// split entry gets one made from the task itself — when it was created and who
// asked for it. Without that, a meeting task's history would open at "completed".

// The filter groups the UI offers, in lifecycle order, and the kinds each one
// covers. Coarse on purpose: "Completed" must find a task whether it was ticked
// or approved, "Deleted" whether it is still in the bin or purged.
const ACTIVITY_GROUPS = {
  created: ['created'],
  assigned: ['assigned', 'reassigned', 'split'],
  progress: ['started', 'todo'],
  blocked: ['blocked'],
  submitted: ['submitted'],
  completed: ['completed', 'approved'],
  reopened: ['reopened', 'rejected'],
  edited: ['edited'],
  commented: ['commented'],
  attached: ['attached'],
  deleted: ['deleted', 'purged'],
  restored: ['restored'],
}
const STATUS_KIND = { 'Done': 'completed', 'Reopened': 'reopened', 'In Review': 'submitted', 'In Progress': 'started', 'Blocked': 'blocked', 'To Do': 'todo' }
const ACTIVITY_SORTS = {
  newest: 'ev.created_at DESC',
  oldest: 'ev.created_at ASC',
  task: 'ev.title COLLATE NOCASE ASC, ev.created_at DESC',
  person: "COALESCE(u.name, '~') COLLATE NOCASE ASC, ev.created_at DESC",
  type: `CASE ev.kind ${Object.values(ACTIVITY_GROUPS).flat().map((k, i) => `WHEN '${k}' THEN ${i}`).join(' ')} END, ev.created_at DESC`,
  priority: "CASE ev.priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END, ev.created_at DESC",
}

// json_extract throws on malformed JSON, and old detail columns hold plain
// strings too — CASE guarantees json_valid() is checked first.
const jx = (col, path) => `(CASE WHEN json_valid(${col}) THEN json_extract(${col}, '${path}') END)`
const jhas = (col, key) => `((CASE WHEN json_valid(${col}) THEN json_type(${col}, '$.${key}') END) IS NOT NULL)`
const statusKind = (expr) => `(CASE ${expr} ${Object.entries(STATUS_KIND).map(([s, k]) => `WHEN '${s}' THEN '${k}'`).join(' ')} END)`

// Built on first use: EDIT_FIELD_LABELS is declared further down this file.
let activitySqlCache = null
function activitySql() {
  if (activitySqlCache) return activitySqlCache
  // An edit only counts when it changed something a person would name. A bare
  // progress save files a row per slider move and would bury everything else.
  const editKeys = Object.keys(EDIT_FIELD_LABELS).filter((k) => k !== 'assignee_id')
  const kind = `CASE
    WHEN a.action = 'task.create' THEN 'created'
    WHEN a.action = 'task.reassign' THEN 'reassigned'
    WHEN a.action = 'task.split' THEN 'split'
    WHEN a.action IN ('task.status', 'task.rollup') THEN ${statusKind('a.detail')}
    WHEN a.action = 'task.approval' THEN CASE WHEN a.detail = 'approved' THEN 'approved' ELSE 'rejected' END
    WHEN a.action = 'task.update' THEN COALESCE(
      ${statusKind(jx('a.detail', '$.status'))},
      CASE WHEN ${jhas('a.detail', 'assignee_id')} THEN 'assigned' END,
      CASE WHEN ${editKeys.map((k) => jhas('a.detail', k)).join(' OR ')} THEN 'edited' END)
    WHEN a.action IN ('task.comment', 'task.comment.edit', 'task.comment.delete') THEN 'commented'
    WHEN a.action = 'task.attach' THEN 'attached'
    WHEN a.action = 'task.delete' THEN 'deleted'
    WHEN a.action = 'task.restore' THEN 'restored'
    WHEN a.action = 'task.purge' THEN 'purged'
  END`
  const noCreateRow = (col) => `NOT EXISTS (SELECT 1 FROM audit_logs x WHERE x.entity_type = 'task' AND x.entity_id = ${col} AND x.action IN ('task.create', 'task.split'))`
  const snap = (k) => jx('d.payload', `$.task.${k}`)
  activitySqlCache = `
    WITH raw AS (
      SELECT a.id, a.action, a.detail, a.created_at, a.actor_id, a.entity_id AS task_id, ${kind} AS kind
        FROM audit_logs a WHERE a.org_id = @org AND a.entity_type = 'task'
      UNION ALL
      SELECT 'made:' || t.id, 'task.made', NULL, t.created_at, t.assigned_by_id, t.id, 'created'
        FROM tasks t WHERE t.org_id = @org AND ${noCreateRow('t.id')}
      UNION ALL
      SELECT 'made:' || d.id, 'task.made', NULL, ${snap('created_at')}, ${snap('assigned_by_id')}, d.id, 'created'
        FROM deleted_tasks d WHERE d.org_id = @org AND ${noCreateRow('d.id')}
    ),
    ev AS (
      SELECT raw.*,
        COALESCE(t.title, d.title, (SELECT x.detail FROM audit_logs x WHERE x.entity_type = 'task' AND x.entity_id = raw.task_id
          AND x.action IN ('task.create', 'task.purge') ORDER BY x.created_at LIMIT 1)) AS title,
        CASE WHEN t.id IS NOT NULL THEN 'live' WHEN d.id IS NOT NULL THEN 'deleted' ELSE 'gone' END AS state,
        COALESCE(t.priority, ${snap('priority')}) AS priority,
        t.status AS status,
        COALESCE(t.category, ${snap('category')}) AS category,
        CASE WHEN t.id IS NOT NULL THEN t.assignee_id ELSE ${snap('assignee_id')} END AS assignee_id,
        CASE WHEN t.id IS NOT NULL THEN t.assigned_by_id ELSE ${snap('assigned_by_id')} END AS assigned_by_id,
        t.reassigned_by_id, t.previous_assignee_id, t.visible_to_manager,
        COALESCE(t.meeting_id, ${snap('meeting_id')}) AS meeting_id,
        CASE WHEN raw.action IN ('task.update', 'task.reassign') THEN ${jx('raw.detail', '$.assignee_id')}
             WHEN raw.action = 'task.split' THEN COALESCE(t.assignee_id, ${snap('assignee_id')}) END AS target_id,
        CASE WHEN raw.action IN ('task.status', 'task.rollup') THEN raw.detail
             WHEN raw.action = 'task.update' THEN ${jx('raw.detail', '$.status')} END AS status_to
      FROM raw
      LEFT JOIN tasks t ON t.id = raw.task_id
      LEFT JOIN deleted_tasks d ON d.id = raw.task_id
    )`
  return activitySqlCache
}

r.get('/activity', (req, res) => {
  const me = req.user
  const isManager = me.role === 'manager' || me.role === 'admin'
  const { actor, assignee, priority, status, q, since, until, mine } = req.query
  const sort = ACTIVITY_SORTS[req.query.sort] ? req.query.sort : 'newest'
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200)
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0)
  const groups = String(req.query.types || '').split(',').filter((g) => ACTIVITY_GROUPS[g])

  const params = { org: me.org_id, me: me.id }
  // Same visibility as the task list. A manager sees the org, minus an
  // employee's private draft; an employee sees work they own, handed out, or
  // were moved off — and anything they did themselves.
  const where = ['ev.kind IS NOT NULL', isManager
    ? "NOT (ev.state = 'live' AND ev.visible_to_manager = 0 AND COALESCE(ev.assignee_id, '') != @me)"
    : '(ev.actor_id = @me OR ev.assignee_id = @me OR ev.assigned_by_id = @me OR ev.reassigned_by_id = @me OR ev.previous_assignee_id = @me)']
  if (mine) where.push('ev.assignee_id = @me') // My Tasks: my own work only
  if (actor) { where.push('ev.actor_id = @actor'); params.actor = actor }
  if (assignee === 'unassigned') where.push('ev.assignee_id IS NULL')
  else if (assignee) { where.push('ev.assignee_id = @assignee'); params.assignee = assignee }
  if (priority) { where.push('ev.priority = @priority'); params.priority = priority }
  // The task's status NOW. A deleted task has none, so it drops out.
  if (status) { where.push('ev.status = @status'); params.status = status }
  if (q) { where.push('(ev.title LIKE @q OR u.name LIKE @q OR ow.name LIKE @q)'); params.q = `%${q}%` }
  // Bounds come from the browser as full ISO instants, so "today" is the
  // viewer's today, not the server's — Render runs in UTC.
  if (since) { where.push('ev.created_at >= @since'); params.since = String(since) }
  if (until) { where.push('ev.created_at < @until'); params.until = String(until) }

  const people = 'LEFT JOIN users u ON u.id = ev.actor_id LEFT JOIN users ow ON ow.id = ev.assignee_id'
  // Counts per group ignore the group filter itself, so each chip says what
  // picking it would show.
  const byKind = db.prepare(`${activitySql()}
    SELECT ev.kind, COUNT(*) AS n FROM ev ${people}
    WHERE ${where.join(' AND ')} GROUP BY ev.kind`).all(params)
  const counts = Object.fromEntries(Object.keys(ACTIVITY_GROUPS).map((g) => [g, 0]))
  const kindToGroup = Object.fromEntries(Object.entries(ACTIVITY_GROUPS).flatMap(([g, ks]) => ks.map((k) => [k, g])))
  for (const r0 of byKind) if (kindToGroup[r0.kind]) counts[kindToGroup[r0.kind]] += r0.n
  const all = Object.values(counts).reduce((s, n) => s + n, 0)
  const total = groups.length ? groups.reduce((s, g) => s + counts[g], 0) : all

  if (groups.length) {
    const kinds = groups.flatMap((g) => ACTIVITY_GROUPS[g])
    where.push(`ev.kind IN (${kinds.map((_, i) => `@k${i}`).join(', ')})`)
    kinds.forEach((k, i) => { params[`k${i}`] = k })
  }
  const rows = db.prepare(`${activitySql()}
    SELECT ev.id, ev.action, ev.detail, ev.created_at, ev.kind, ev.task_id, ev.title, ev.state,
      ev.priority, ev.status, ev.category, ev.status_to, ev.actor_id, u.name AS actor_name, u.avatar_color AS actor_color,
      ev.assignee_id, ow.name AS assignee_name, ow.avatar_color AS assignee_color,
      ev.target_id, tg.name AS target_name, ev.meeting_id, m.title AS meeting_title
    FROM ev ${people}
    LEFT JOIN users tg ON tg.id = ev.target_id
    LEFT JOIN meetings m ON m.id = ev.meeting_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${ACTIVITY_SORTS[sort]}
    LIMIT @limit OFFSET @offset`).all({ ...params, limit, offset })

  const items = rows.map((r0) => {
    let fields = []
    if (r0.kind === 'edited') {
      let body = {}
      try { body = JSON.parse(r0.detail || '{}') } catch { body = {} }
      fields = [...new Set(Object.keys(body).filter((k) => k in EDIT_FIELD_LABELS && k !== 'assignee_id').map((k) => EDIT_FIELD_LABELS[k]))]
    }
    return {
      id: r0.id, kind: r0.kind, action: r0.action, at: r0.created_at,
      status_to: r0.status_to || null, fields,
      file: r0.action === 'task.attach' ? r0.detail || null : null,
      actor: r0.actor_id ? { id: r0.actor_id, name: r0.actor_name || 'Someone', avatar_color: r0.actor_color } : null,
      target: r0.target_id ? { id: r0.target_id, name: r0.target_name || 'someone' } : null,
      meeting: r0.meeting_id ? { id: r0.meeting_id, title: r0.meeting_title || 'a meeting' } : null,
      task: {
        id: r0.task_id, title: r0.title || 'Untitled task', state: r0.state,
        priority: r0.priority, status: r0.status, category: r0.category,
        assignee: r0.assignee_id ? { id: r0.assignee_id, name: r0.assignee_name || 'Former member', avatar_color: r0.assignee_color } : null,
      },
    }
  })
  res.json({ items, total, all, counts, offset, limit })
})

// ---- recycle bin ------------------------------------------------------------
// These MUST be declared above `/:id`, or Express matches "trash" as a task id.

// Who may see and undo a deletion. A manager deals with the whole org's mistakes;
// an employee only ever deleted their own work, so that is all they get back.
const trashVisibleTo = (user) =>
  user.role === 'manager' || user.role === 'admin'
    ? db.prepare('SELECT * FROM deleted_tasks WHERE org_id=? ORDER BY deleted_at DESC').all(user.org_id)
    : db.prepare('SELECT * FROM deleted_tasks WHERE org_id=? AND deleted_by=? ORDER BY deleted_at DESC').all(user.org_id, user.id)

r.get('/trash', (req, res) => {
  res.json({
    recovery_days: RECOVERY_DAYS,
    tasks: trashVisibleTo(req.user).map((d) => {
      const p = JSON.parse(d.payload)
      return {
        id: d.id, title: d.title, assignee_name: d.assignee_name,
        priority: p.task?.priority, status: p.task?.status, due_date: p.task?.due_date,
        deleted_at: d.deleted_at, deleted_by: d.deleted_by_name, purge_after: d.purge_after,
        comments: (p.comments || []).length, attachments: (p.attachments || []).length,
      }
    }),
  })
})

// Put a task back, with everything the cascade took.
//
// The world may have moved on since it was deleted, so each foreign key is
// re-checked rather than trusted: an assignee who has left becomes unassigned,
// a parent that is itself gone becomes null (the subtask returns as a top-level
// task rather than vanishing again), and a dependency whose other end no longer
// exists is dropped. Restoring MOST of a task beats refusing to restore any of it.
r.post('/trash/:id/restore', (req, res) => {
  const d = trashVisibleTo(req.user).find((x) => x.id === req.params.id)
  if (!d) return res.status(404).json({ error: 'Not found' })
  const p = JSON.parse(d.payload)
  const userExists = (id) => !!(id && db.prepare('SELECT id FROM users WHERE id=?').get(id))
  const taskExists = (id) => !!(id && db.prepare('SELECT id FROM tasks WHERE id=?').get(id))

  const insertTask = (row) => {
    const r2 = { ...row }
    if (!userExists(r2.assignee_id)) r2.assignee_id = null
    if (!userExists(r2.assigned_by_id)) r2.assigned_by_id = null
    if (r2.parent_task_id && r2.parent_task_id !== d.id && !taskExists(r2.parent_task_id)) r2.parent_task_id = null
    const cols = Object.keys(r2)
    db.prepare(`INSERT OR IGNORE INTO tasks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...cols.map((c) => r2[c]))
  }

  db.transaction(() => {
    insertTask(p.task)
    for (const s of p.subtasks || []) insertTask(s)
    for (const c of p.comments || []) {
      if (!userExists(c.user_id) || !taskExists(c.task_id)) continue
      const cols = Object.keys(c)
      db.prepare(`INSERT OR IGNORE INTO task_comments (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((k) => c[k]))
    }
    for (const a of p.attachments || []) {
      if (!taskExists(a.task_id)) continue
      const cols = Object.keys(a)
      db.prepare(`INSERT OR IGNORE INTO attachments (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((k) => a[k]))
    }
    for (const dep of p.dependencies || []) {
      if (!taskExists(dep.task_id) || !taskExists(dep.depends_on_task_id)) continue
      db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?,?)').run(dep.task_id, dep.depends_on_task_id)
    }
    db.prepare('DELETE FROM deleted_tasks WHERE id=?').run(d.id)
  })()

  audit(req.user.org_id, req.user.id, 'task.restore', 'task', d.id, d.title)
  indexTask(d.id)
  const back = db.prepare('SELECT * FROM tasks WHERE id=?').get(d.id)
  res.json({ ok: true, task: back ? hydrate(back) : null })
})

// Purge one now, before its month is up. Irreversible — this is the delete the
// old handler used to do, moved behind a second, deliberate decision.
r.delete('/trash/:id', (req, res) => {
  const d = trashVisibleTo(req.user).find((x) => x.id === req.params.id)
  if (!d) return res.status(404).json({ error: 'Not found' })
  purgeDeletedTask(d)
  audit(req.user.org_id, req.user.id, 'task.purge', 'task', d.id, d.title)
  res.json({ ok: true })
})

r.get('/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) return res.status(404).json({ error: 'Not found' })
  res.json(hydrate(t))
})

// WHO CHANGED WHAT. Every PATCH already writes an audit row naming its author;
// this is the only thing that reads them back per task, so an edit stops being
// invisible the moment someone other than a manager can make one.
//
// Field edits only. A status move is already spelled out by the Timeline, and
// progress is the assignee's ordinary work — the slider alone would file a row
// per save and bury the changes that actually matter.
const EDIT_FIELD_LABELS = {
  title: 'title', description: 'description', priority: 'priority',
  category: 'category', due_date: 'due date', assignee_id: 'assignee',
  project_id: 'project', department_id: 'department',
}
r.get('/:id/history', (req, res) => {
  const t = db.prepare('SELECT id FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) return res.status(404).json({ error: 'Not found' })
  const rows = db.prepare(
    `SELECT a.action, a.detail, a.created_at, a.actor_id, u.name AS actor_name, u.avatar_color
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.entity_type = 'task' AND a.entity_id = ? AND a.action IN ('task.update', 'task.reassign')
     ORDER BY a.created_at DESC`
  ).all(t.id)
  const out = []
  for (const r0 of rows) {
    let body = {}
    try { body = JSON.parse(r0.detail || '{}') } catch { body = {} }
    const fields = Object.keys(body).filter((k) => k in EDIT_FIELD_LABELS).map((k) => EDIT_FIELD_LABELS[k])
    // due_date_raw always rides along with a due date edit; naming it twice reads wrong.
    const seen = [...new Set(fields)]
    if (!seen.length) continue // progress-only save, or nothing we name
    out.push({
      actor_id: r0.actor_id,
      actor_name: r0.actor_name || 'Someone',
      avatar_color: r0.avatar_color,
      fields: seen,
      reassigned: r0.action === 'task.reassign',
      at: r0.created_at,
    })
  }
  res.json(out)
})

// TRANSCRIBE a single dictated audio clip -> text. Powers the "Speak" button on
// the New Task modal for EVERYONE (employees included) — unlike the meetings
// transcriber, which is manager/admin only. Uses the same Sarvam/Whisper pipeline,
// which is far more reliable on Android and for Telugu/Hindi/English code-mixing
// than the browser's SpeechRecognition.
r.post('/transcribe', audioUpload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file required (field "audio")' })
  try {
    const { text, language } = await transcribeAudio(
      req.file.buffer,
      req.file.originalname || 'task.webm',
      req.file.mimetype || 'audio/webm',
    )
    recordUsage({ orgId: req.user.org_id, userId: req.user.id, provider: STT_PROVIDER, feature: 'transcription' })
    res.json({ text: text || '', language: language || null })
  } catch (err) {
    console.error('[tasks] transcribe failed:', err.message)
    res.status(err.code === 'NO_PROVIDER' ? 400 : 502).json({ error: err.message, code: err.code || null })
  }
})

// VOICE SEARCH: transcribe a spoken query (any language), translate it to English,
// and split it into structured filters the list endpoint understands. Saying a
// person's name returns ALL of that employee's tasks; topic words search title/desc.
r.post('/voice-search', audioUpload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file required (field "audio")' })
  try {
    const { text } = await transcribeAudio(
      req.file.buffer,
      req.file.originalname || 'search.webm',
      req.file.mimetype || 'audio/webm',
    )
    recordUsage({ orgId: req.user.org_id, userId: req.user.id, provider: STT_PROVIDER, feature: 'transcription' })
    const transcript = String(text || '').trim()
    // Default (no LLM / interpret failed): fall back to the raw transcript as the query.
    let interp = { query: transcript, person: null, status: null, priority: null }
    if (transcript && hasLLM()) {
      try {
        const users = db.prepare("SELECT id, name, role, aliases FROM users WHERE org_id=? AND role != 'admin'").all(req.user.org_id)
        interp = await interpretVoiceSearch(transcript, {
          users,
          onUsage: (u) => recordUsage({ orgId: req.user.org_id, userId: req.user.id, feature: 'voice_search', ...u }),
        })
      } catch (e) { console.warn('[tasks] voice-search interpret failed, using transcript:', e.message) }
    }
    // Resolve a named person to an assignee id (handles aliases / first-name-only).
    let assignee_id = null, assignee_name = null
    if (interp.person) {
      const u = resolveUser(req.user.org_id, interp.person)
      if (u) { assignee_id = u.id; assignee_name = u.name }
    }
    res.json({
      transcript,
      // When we matched a person but found no topic words, leave query empty so the
      // assignee filter alone returns every task for that employee.
      query: interp.query || (assignee_id ? '' : transcript),
      assignee_id,
      assignee_name,
      status: interp.status || null,
      priority: interp.priority || null,
    })
  } catch (err) {
    console.error('[tasks] voice-search failed:', err.message)
    res.status(err.code === 'NO_PROVIDER' ? 400 : 502).json({ error: err.message, code: err.code || null })
  }
})

// PARSE a dictated sentence into draft task fields (title/description/assignee/
// priority). Used by the "Speak" button on the New Task modal. Falls back to
// using the raw transcript as the title when no LLM is configured or the call
// fails, so voice always produces *something*.
r.post('/parse-voice', async (req, res) => {
  const transcript = String(req.body?.transcript || '').trim()
  if (!transcript) return res.status(400).json({ error: 'transcript required' })

  const fallback = () => res.json({
    title: transcript, description: '', assignee_id: null, assignee_name: null,
    priority: 'Medium', due_date_raw: null, engine: 'none',
  })

  if (!hasLLM()) return fallback()
  try {
    const users = db.prepare("SELECT id, name, role, aliases FROM users WHERE org_id=? AND role != 'admin'").all(req.user.org_id)
    const parsed = await parseSpokenTask(transcript, {
      users,
      onUsage: (u) => recordUsage({ orgId: req.user.org_id, userId: req.user.id, feature: 'voice_task', ...u }),
    })
    // Resolve the spoken name to a real org user (null if no confident match).
    const match = parsed.assignee_name ? resolveUser(req.user.org_id, parsed.assignee_name) : null
    // Resolve a spoken deadline ("by Friday", "tomorrow", "repu", "kal") to an
    // absolute YYYY-MM-DD, anchored to today. Try the AI's extracted phrase first,
    // then fall back to scanning the whole transcript.
    const today = new Date().toISOString().slice(0, 10)
    const due = parseDueDate(parsed.due_date_raw || '', today).date || parseDueDate(transcript, today).date
    res.json({
      title: parsed.title,
      description: parsed.description,
      assignee_id: match?.id || null,
      assignee_name: match?.name || parsed.assignee_name || null,
      priority: parsed.priority,
      due_date: due || null,
      due_date_raw: parsed.due_date_raw,
      engine: 'llm',
    })
  } catch (err) {
    console.warn('[tasks] voice parse failed, using raw transcript:', err.message)
    fallback()
  }
})

// CREATE
r.post('/', (req, res) => {
  const b = req.body || {}
  if (!b.title) return res.status(400).json({ error: 'title required' })
  // A personal task (b.personal — a private to-do / My Tasks) is owned by the
  // creator and hidden from everyone else. Otherwise ANYONE may assign the task
  // to ANYONE in the org (employee→employee, employee→manager, …) or leave it
  // unassigned.
  const personal = !!b.personal
  const assignee = personal
    ? { id: req.user.id }
    : (b.assignee_id ? db.prepare('SELECT id FROM users WHERE id=? AND org_id=?').get(b.assignee_id, req.user.org_id) : null)
  const visible = personal ? 0 : 1
  const confidence = personal ? 'high' : (b.ownership_confidence || (assignee ? 'high' : 'needs_confirmation'))
  const priority = b.priority || 'Medium'
  // Auto-fill the due date from priority when the caller didn't supply one.
  const dueDate = b.due_date || dueDateForPriority(priority)
  // Category: an explicit choice wins, else auto-detect from the task's text.
  const category = resolveCategory({ text: `${b.title} ${b.description || ''} ${b.source_quote || ''}`, explicit: b.category, orgId: req.user.org_id })
  const tid = id('task')
  db.prepare(`INSERT INTO tasks
    (id, org_id, title, description, assignee_id, assigned_by_id, due_date, due_date_raw, priority, status,
     project_id, department_id, meeting_id, ownership_confidence, parent_task_id, progress, approval_status, source_quote,
     category, assigned_at, visible_to_manager, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    tid, req.user.org_id, b.title, b.description || '', assignee?.id || null, req.user.id,
    dueDate, b.due_date_raw || null, priority, b.status || 'To Do',
    b.project_id || null, b.department_id || req.user.department_id || null, b.meeting_id || null,
    confidence, b.parent_task_id || null,
    0, 'none', b.source_quote || null, category, assignee ? now() : null, visible, now(), now())
  audit(req.user.org_id, req.user.id, 'task.create', 'task', tid, b.title)
  // Notify the assignee when someone assigns them a task (not their own).
  if (assignee && assignee.id !== req.user.id) {
    notify(req.user.org_id, assignee.id, 'task_assigned', `${req.user.name} assigned you "${b.title}"`, tid)
  }
  indexTask(tid) // fire-and-forget RAG indexing
  res.status(201).json(hydrate(db.prepare('SELECT * FROM tasks WHERE id=?').get(tid)))
})

// UPDATE (general fields)
r.patch('/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) return res.status(404).json({ error: 'Not found' })
  const b = req.body || {}
  const fields = ['title', 'description', 'priority', 'due_date', 'due_date_raw', 'project_id', 'department_id', 'progress', 'ownership_confidence']
  const sets = [], args = []
  for (const f of fields) if (f in b) { sets.push(`${f}=?`); args.push(b[f]) }
  // Category override: normalise to a known label, or null to clear (Uncategorized).
  if ('category' in b) { sets.push('category=?'); args.push(normalizeCategory(b.category, req.user.org_id)) }
  let newlyAssigned = null
  let takenFrom = null
  if ('assignee_id' in b) {
    sets.push('assignee_id=?'); args.push(b.assignee_id || null)
    sets.push('ownership_confidence=?'); args.push(b.assignee_id ? 'high' : 'needs_confirmation')
    if (b.assignee_id && b.assignee_id !== t.assignee_id) {
      newlyAssigned = b.assignee_id
      sets.push('assigned_at=?'); args.push(now())
      // Moving a task OFF someone is a reassignment, not a fresh assignment.
      // Record it: the row is overwritten in place, so this is the only trace
      // that the task ever belonged to anyone else.
      if (t.assignee_id) {
        takenFrom = t.assignee_id
        sets.push('reassigned_at=?'); args.push(now())
        sets.push('reassigned_by_id=?'); args.push(req.user.id)
        sets.push('previous_assignee_id=?'); args.push(t.assignee_id)
      }
    }
  }
  // Stamped on the way INTO Done only — see the same rule in POST /:id/status.
  const finishing = b.status === 'Done' && (t.status !== 'Done' || !t.completed_at)
  if ('status' in b) {
    if (!VALID_STATUS.includes(b.status)) return res.status(400).json({ error: 'invalid status' })
    sets.push('status=?'); args.push(b.status)
    if (b.status === 'Done') { sets.push('progress=?'); args.push(100) }
    if (finishing) { sets.push('completed_at=?'); args.push(now()); sets.push('completed_by_id=?'); args.push(req.user.id) }
    if (b.status === 'In Review') { sets.push('submitted_at=?'); args.push(now()) }
  }
  // Auto-fill a due date from priority when assigning or (re)prioritizing a task
  // that has none — unless the caller explicitly set due_date in this request.
  if (!('due_date' in b) && !t.due_date && (newlyAssigned || 'priority' in b)) {
    const effectivePriority = ('priority' in b && b.priority) ? b.priority : t.priority
    sets.push('due_date=?'); args.push(dueDateForPriority(effectivePriority))
  }
  if (!sets.length) return res.json(hydrate(t))
  sets.push('updated_at=?'); args.push(now())
  args.push(t.id)
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id=?`).run(...args)
  // Reassignment gets its own audit action so it can be told apart from an
  // ordinary field edit — 'task.update' is excluded from the activity feed.
  audit(req.user.org_id, req.user.id, takenFrom ? 'task.reassign' : 'task.update', 'task', t.id, b)
  if (newlyAssigned) notify(t.org_id, newlyAssigned, 'task_assigned', `${req.user.name} assigned you "${t.title}"`, t.id)
  // Tell whoever lost the task. Without this it simply disappears from their
  // dashboard with no explanation.
  if (takenFrom && takenFrom !== req.user.id) {
    notify(t.org_id, takenFrom, 'task_reassigned', `${req.user.name} reassigned "${t.title}" to someone else`, t.id)
  }
  const fresh = db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id)
  if (finishing) notifyCompleted(fresh, req.user) // fresh: this same edit may have changed the owner
  if (t.parent_task_id && 'status' in b) syncParentStatus(t.parent_task_id, req.user)
  indexTask(t.id) // re-index on edit (title/desc/assignee/status may have changed)
  res.json(hydrate(fresh))
})

// STATUS transitions with workflow semantics
r.post('/:id/status', (req, res) => {
  let { status } = req.body || {} // may be rewritten below for own self-created work
  if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: 'invalid status' })
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) return res.status(404).json({ error: 'Not found' })
  let approval = t.approval_status
  let progress = t.progress
  let submittedAt = t.submitted_at
  let completedAt = t.completed_at
  let completedBy = t.completed_by_id
  let visible = t.visible_to_manager
  // Your own self-created task has no approver, so it never enters the approval
  // flow: completing it is final, and a stray "submit for review" just marks it
  // done rather than parking it in a queue nobody is watching.
  const ownWork = isOwnSelfCreated(t, req.user.id)
  if (ownWork && status === 'In Review') status = 'Done'
  // Completion is stamped on the way INTO Done only. Pressing Done on a task that
  // is already Done (the assistant can) used to restamp completed_at; now it
  // would also hand the credit to whoever pressed it and notify everyone again.
  const finishing = status === 'Done' && (t.status !== 'Done' || !t.completed_at)
  if (status === 'In Review') { approval = 'pending'; submittedAt = now(); visible = 1 } // surface private drafts on submit
  if (status === 'Done') {
    progress = 100
    if (finishing) { completedAt = now(); completedBy = req.user.id }
    if (ownWork) approval = 'none'
  }
  if (status === 'Reopened') { approval = 'none'; progress = Math.min(progress, 80); completedAt = null; completedBy = null }
  db.prepare('UPDATE tasks SET status=?, approval_status=?, progress=?, submitted_at=?, completed_at=?, completed_by_id=?, visible_to_manager=?, updated_at=? WHERE id=?')
    .run(status, approval, progress, submittedAt, completedAt, completedBy, visible, now(), t.id)
  audit(req.user.org_id, req.user.id, 'task.status', 'task', t.id, status)
  if (finishing) notifyCompleted(t, req.user)
  // Employee submitted work for approval → ping the managers, and the assigner
  // (who can now approve it too — e.g. the colleague who split this part off).
  // Managers were all covered by the first call, so only an EMPLOYEE assigner
  // needs the extra ping; anyone else would be notified twice.
  if (status === 'In Review') {
    notifyManagers(t.org_id, 'task_submitted', `${req.user.name} submitted "${t.title}" for approval`, t.id, req.user.id)
    if (t.assigned_by_id && t.assigned_by_id !== req.user.id) {
      const assigner = db.prepare('SELECT role FROM users WHERE id=?').get(t.assigned_by_id)
      if (assigner?.role === 'employee') {
        notify(t.org_id, t.assigned_by_id, 'task_submitted', `${req.user.name} submitted "${t.title}" for your approval`, t.id)
      }
    }
  }
  if (t.parent_task_id) syncParentStatus(t.parent_task_id, req.user) // a shared part changed → re-roll the parent
  indexTask(t.id) // status change updates the embedded metadata
  res.json(hydrate(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id)))
})

// SPLIT — the task owner (or a manager) distributes parts of a task to peers as
// child tasks. Each part becomes a visible subtask assigned to a colleague, who
// is notified. The split always surfaces the parent to managers (visibility).
r.post('/:id/split', (req, res) => {
  const parent = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!parent) return res.status(404).json({ error: 'Not found' })
  const isManager = req.user.role === 'manager' || req.user.role === 'admin'
  if (!isManager && parent.assignee_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the task owner can split this task.' })
  }
  if (parent.parent_task_id) return res.status(400).json({ error: 'A shared part cannot be split again.' })

  const parts = (Array.isArray(req.body?.parts) ? req.body.parts : [])
    .map((p) => ({ title: String(p?.title || '').trim(), assignee_id: p?.assignee_id || null }))
    .filter((p) => p.title && p.assignee_id)
  if (!parts.length) return res.status(400).json({ error: 'Add at least one part with a title and a person.' })

  for (const p of parts) {
    const assignee = db.prepare('SELECT id, name FROM users WHERE id=? AND org_id=?').get(p.assignee_id, req.user.org_id)
    if (!assignee) continue
    const cid = id('task')
    // Inherit the parent's category unless the part's own title points elsewhere.
    const childCategory = resolveCategory({ text: p.title, aiSuggested: parent.category, orgId: req.user.org_id })
    db.prepare(`INSERT INTO tasks
      (id, org_id, title, description, assignee_id, assigned_by_id, due_date, due_date_raw, priority, status,
       project_id, department_id, meeting_id, ownership_confidence, parent_task_id, progress, approval_status, source_quote,
       category, assigned_at, visible_to_manager, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      cid, parent.org_id, p.title, '', assignee.id, req.user.id,
      parent.due_date, parent.due_date_raw, parent.priority, 'To Do',
      parent.project_id, parent.department_id, parent.meeting_id,
      'high', parent.id, 0, 'none', null, childCategory, now(), 1, now(), now())
    audit(parent.org_id, req.user.id, 'task.split', 'task', cid, p.title)
    indexTask(cid)
    if (assignee.id !== req.user.id) {
      notify(parent.org_id, assignee.id, 'task_assigned', `${req.user.name} shared a part of "${parent.title}" with you: ${p.title}`, cid)
    }
  }
  // Splitting makes the parent (and its parts) visible to managers for oversight.
  if (!parent.visible_to_manager) {
    db.prepare('UPDATE tasks SET visible_to_manager=1, updated_at=? WHERE id=?').run(now(), parent.id)
    indexTask(parent.id)
  }
  res.status(201).json(hydrate(db.prepare('SELECT * FROM tasks WHERE id=?').get(parent.id)))
})

// APPROVAL workflow — managers/admins, or the task's own assigner. The assigner
// check is per-task, not a role grant: an employee who assigned (or split a part
// to) a colleague decides only that work, nothing else. Assigner==assignee is
// excluded — self-created work never enters the approval flow anyway (see
// isOwnSelfCreated), so that combination reaching here means someone else
// submitted it and a real reviewer is required.
r.post('/:id/approve', (req, res) => {
  const { decision } = req.body || {} // approved | rejected
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) return res.status(404).json({ error: 'Not found' })
  const isManager = req.user.role === 'manager' || req.user.role === 'admin'
  const isAssigner = !!t.assigned_by_id && t.assigned_by_id === req.user.id && t.assignee_id !== req.user.id
  if (!isManager && !isAssigner) {
    return res.status(403).json({ error: 'Only a manager or the person who assigned this task can approve it.' })
  }
  const approved = decision === 'approved'
  db.prepare('UPDATE tasks SET approval_status=?, status=?, completed_at=?, completed_by_id=?, updated_at=? WHERE id=?')
    .run(approved ? 'approved' : 'rejected', approved ? 'Done' : 'Reopened', approved ? now() : null, approved ? req.user.id : null, now(), t.id)
  audit(req.user.org_id, req.user.id, 'task.approval', 'task', t.id, decision)
  // Tell the assignee the verdict.
  notify(
    t.org_id, t.assignee_id,
    approved ? 'task_approved' : 'task_reopened',
    approved ? `✓ "${t.title}" was approved by ${req.user.name}` : `↩ "${t.title}" needs changes — reopened by ${req.user.name}`,
    t.id,
  )
  // Any manager can approve, so the person who asked for the work is often not
  // the one who signs it off — and was never told it had been finished.
  if (approved && t.assigned_by_id && t.assigned_by_id !== req.user.id && t.assigned_by_id !== t.assignee_id) {
    notify(t.org_id, t.assigned_by_id, 'task_approved', `✓ "${t.title}" is done — approved by ${req.user.name}`, t.id)
  }
  // Approving a shared part is how a split normally completes now, so the parent
  // must re-roll here just like on a direct status change — without this the
  // last part's approval left the parent container open forever.
  if (t.parent_task_id) syncParentStatus(t.parent_task_id, req.user)
  res.json(hydrate(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id)))
})

// COMMENTS
r.post('/:id/comments', (req, res) => {
  const { body } = req.body || {}
  if (!body) return res.status(400).json({ error: 'body required' })
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) return res.status(404).json({ error: 'Not found' })
  const cid = id('cmt')
  db.prepare('INSERT INTO task_comments (id, task_id, user_id, body, created_at) VALUES (?,?,?,?,?)')
    .run(cid, t.id, req.user.id, body, now())
  audit(req.user.org_id, req.user.id, 'task.comment', 'task', t.id)
  // Notify the people involved (assignee + whoever assigned it), except the commenter.
  // The comment's id goes with it, so tapping the notification opens the task on
  // that comment instead of at the top of a long drawer.
  const snippet = body.length > 80 ? body.slice(0, 77) + '…' : body
  const recipients = new Set([t.assignee_id, t.assigned_by_id].filter(Boolean))
  recipients.delete(req.user.id)
  for (const uid of recipients) {
    notify(t.org_id, uid, 'task_comment', `${req.user.name} commented on "${t.title}": ${snippet}`, t.id, { commentId: cid })
  }
  res.status(201).json(hydrate(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id)))
})

// UNDO a just-posted comment: delete the CALLER'S most recent comment on the task.
// Deliberately "latest own" rather than /comments/:cid — the voice flow posts the
// comment through the drawer, which never surfaces the new row's id, and the only
// thing a spoken "undo" can honestly mean is "the comment I just left". Own
// comments only, so this can never be aimed at someone else's words.
r.delete('/:id/comments/latest-own', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) return res.status(404).json({ error: 'Not found' })
  const c = db.prepare('SELECT * FROM task_comments WHERE task_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1').get(t.id, req.user.id)
  if (!c) return res.status(404).json({ error: 'No comment of yours to remove' })
  db.prepare('DELETE FROM task_comments WHERE id=?').run(c.id)
  // The leaderboard counts comments live from task_comments, so the undone
  // comment's point disappears with it — exactly what an undo should mean.
  audit(req.user.org_id, req.user.id, 'task.comment.delete', 'task', t.id)
  res.json({ ok: true })
})

// EDIT a comment. Own comments only, and never anyone else's: a task's comment
// thread is the record of who said what, and letting one person rewrite another's
// words would quietly turn it into something else. `edited_at` is set so the
// change is visible rather than silent.
r.patch('/:id/comments/:cid', (req, res) => {
  const body = String(req.body?.body || '').trim()
  if (!body) return res.status(400).json({ error: 'body required' })
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) return res.status(404).json({ error: 'Not found' })
  const c = db.prepare('SELECT * FROM task_comments WHERE id=? AND task_id=?').get(req.params.cid, t.id)
  if (!c) return res.status(404).json({ error: 'Not found' })
  if (c.user_id !== req.user.id) return res.status(403).json({ error: 'You can only edit your own comments.' })
  db.prepare('UPDATE task_comments SET body=?, edited_at=? WHERE id=?').run(body, now(), c.id)
  audit(req.user.org_id, req.user.id, 'task.comment.edit', 'task', t.id)
  res.json(hydrate(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id)))
})

// DELETE a comment by id. Own always; a manager or admin may remove anyone's,
// which is the moderation lever — someone pasting the wrong customer's details
// into a thread should not have to be around for it to come down.
r.delete('/:id/comments/:cid', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) return res.status(404).json({ error: 'Not found' })
  const c = db.prepare('SELECT * FROM task_comments WHERE id=? AND task_id=?').get(req.params.cid, t.id)
  if (!c) return res.status(404).json({ error: 'Not found' })
  const isManager = req.user.role === 'manager' || req.user.role === 'admin'
  if (c.user_id !== req.user.id && !isManager) {
    return res.status(403).json({ error: 'You can only delete your own comments.' })
  }
  db.prepare('DELETE FROM task_comments WHERE id=?').run(c.id)
  // The leaderboard counts comments live, so its point goes with it.
  audit(req.user.org_id, req.user.id, 'task.comment.delete', 'task', t.id, c.user_id === req.user.id ? 'own' : `by ${c.user_id}`)
  res.json({ ok: true })
})

// ATTACHMENTS — upload any file onto a task. One file per request (the client
// loops for multiple). Anyone in the task's org may attach.
r.post('/:id/attachments', taskFiles.receive, (req, res) => {
  const cleanup = () => { if (req.file) try { fs.unlinkSync(req.file.path) } catch {} }
  if (!req.file) return res.status(400).json({ error: 'file required (field "file")' })
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) { cleanup(); return res.status(404).json({ error: 'Not found' }) }
  const aid = id('att')
  db.prepare(`INSERT INTO attachments (id, task_id, org_id, filename, stored_name, file_type, file_size, uploaded_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    aid, t.id, t.org_id, req.file.originalname || 'file', req.file.filename, req.file.mimetype || null, req.file.size || 0, req.user.id, now())
  audit(req.user.org_id, req.user.id, 'task.attach', 'task', t.id, req.file.originalname || '')
  db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(now(), t.id)
  res.status(201).json(hydrate(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id)))
})

// Remove an attachment (uploader, or any manager/admin). Deletes the file too.
r.delete('/attachments/:attId', (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id=?').get(req.params.attId)
  if (!a) return res.status(404).json({ error: 'Not found' })
  const taskOrg = a.org_id || db.prepare('SELECT org_id FROM tasks WHERE id=?').get(a.task_id)?.org_id
  if (taskOrg !== req.user.org_id) return res.status(403).json({ error: 'Out of organization' })
  const isManager = req.user.role === 'manager' || req.user.role === 'admin'
  if (!isManager && a.uploaded_by !== req.user.id) return res.status(403).json({ error: 'Only the uploader or a manager can remove this.' })
  if (a.stored_name) try { fs.unlinkSync(path.join(ATTACH_DIR, a.stored_name)) } catch {}
  db.prepare('DELETE FROM attachments WHERE id=?').run(a.id)
  res.json({ ok: true })
})

// DEPENDENCIES
r.post('/:id/dependencies', (req, res) => {
  const { depends_on } = req.body || {}
  const t = db.prepare('SELECT id FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  const dep = db.prepare('SELECT id FROM tasks WHERE id=? AND org_id=?').get(depends_on, req.user.org_id)
  if (!t || !dep) return res.status(404).json({ error: 'Not found' })
  if (t.id === dep.id) return res.status(400).json({ error: 'cannot depend on itself' })
  db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?,?)').run(t.id, dep.id)
  res.json(hydrate(db.prepare('SELECT * FROM tasks WHERE id=?').get(t.id)))
})

// DELETE — managers/admins may delete any task; an employee may delete only their
// own private draft (self-created, not yet submitted to the manager).
r.delete('/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=? AND org_id=?').get(req.params.id, req.user.org_id)
  if (!t) return res.status(404).json({ error: 'Not found' })
  const isManager = req.user.role === 'manager' || req.user.role === 'admin'
  const isOwnPrivateDraft = t.assignee_id === req.user.id && t.assigned_by_id === req.user.id && !t.visible_to_manager
  // Own self-created work can be binned whether or not managers can see it —
  // it was never their task to sign off. Anything handed to you by someone else
  // still needs a manager.
  if (!isManager && !isOwnSelfCreated(t, req.user.id) && !isOwnPrivateDraft) {
    return res.status(403).json({ error: 'You can only delete tasks you created for yourself.' })
  }
  // Snapshot everything the FK cascade is about to take, THEN remove the row.
  // Attachment files are deliberately left on disk — they are unlinked by the
  // purge, because a "recoverable" task whose files are already gone is not one.
  const subIds = db.prepare('SELECT id FROM tasks WHERE parent_task_id=?').all(t.id).map((s) => s.id)
  const ids = [t.id, ...subIds]
  const ph = ids.map(() => '?').join(',')
  const payload = {
    task: t,
    subtasks: db.prepare(`SELECT * FROM tasks WHERE id IN (${ph}) AND id != ?`).all(...ids, t.id),
    comments: db.prepare(`SELECT * FROM task_comments WHERE task_id IN (${ph})`).all(...ids),
    attachments: db.prepare(`SELECT * FROM attachments WHERE task_id IN (${ph})`).all(...ids),
    dependencies: db.prepare(`SELECT * FROM task_dependencies WHERE task_id IN (${ph}) OR depends_on_task_id IN (${ph})`).all(...ids, ...ids),
  }
  const assigneeName = t.assignee_id
    ? (db.prepare('SELECT name FROM users WHERE id=?').get(t.assignee_id)?.name || null)
    : null

  db.transaction(() => {
    db.prepare(`INSERT OR REPLACE INTO deleted_tasks
      (id, org_id, title, assignee_name, deleted_by, deleted_by_name, deleted_at, purge_after, payload)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      t.id, t.org_id, t.title, assigneeName, req.user.id, req.user.name, now(),
      new Date(Date.now() + RECOVERY_DAYS * 86_400_000).toISOString(), JSON.stringify(payload))
    db.prepare('DELETE FROM tasks WHERE id=?').run(t.id)
  })()
  audit(req.user.org_id, req.user.id, 'task.delete', 'task', t.id, `recoverable until ${new Date(Date.now() + RECOVERY_DAYS * 86_400_000).toISOString().slice(0, 10)}`)
  removeEmbedding('task', t.id)
  res.json({ ok: true, recoverable_until: new Date(Date.now() + RECOVERY_DAYS * 86_400_000).toISOString(), recovery_days: RECOVERY_DAYS })
})

export default r
