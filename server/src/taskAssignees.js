import { db } from './db.js'

// A task can be shared by several people. tasks.assignee_id stays the task's
// main owner, and everything that reads it (about sixty places: reminders,
// dashboards, the leaderboard, voice, meetings, chat cards) keeps working
// unchanged. task_assignees holds the others who share it. They see it as
// their own (lists, "My tasks", the assignee filter), hear what the owner hears
// (comments, completion, approval) and can move it along. The main owner is
// never also a row here.

// SQL: is user ? one of this task's people. Bind the user id twice.
export const IS_ASSIGNEE = '(t.assignee_id=? OR EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id=t.id AND ta.user_id=?))'

export function coAssigneeIds(taskId) {
  return db.prepare('SELECT user_id FROM task_assignees WHERE task_id=? ORDER BY added_at, rowid').all(taskId).map((r) => r.user_id)
}

// The owner first, then the others in the order they were added.
export function allAssigneeIds(t) {
  if (!t) return []
  return [...new Set([t.assignee_id, ...coAssigneeIds(t.id)].filter(Boolean))]
}

export function isAssigneeOf(t, userId) {
  if (!t || !userId) return false
  return t.assignee_id === userId || !!db.prepare('SELECT 1 FROM task_assignees WHERE task_id=? AND user_id=?').get(t.id, userId)
}

// Adds people (already checked to be in the org) to a task. The owner and
// anyone already on it are skipped. Returns who was actually added.
export function addCoAssignees(t, userIds, byId, at) {
  const added = []
  const ins = db.prepare('INSERT OR IGNORE INTO task_assignees (task_id, user_id, added_by_id, added_at) VALUES (?,?,?,?)')
  for (const uid of userIds) {
    if (!uid || uid === t.assignee_id) continue
    if (ins.run(t.id, uid, byId || null, at).changes) added.push(uid)
  }
  return added
}

// Ids from a request, kept to real people of this org, without repeats.
export function orgUserIds(orgId, ids, max = 20) {
  if (!Array.isArray(ids)) return []
  const ok = db.prepare('SELECT id FROM users WHERE id=? AND org_id=?')
  return [...new Set(ids.filter((x) => typeof x === 'string' && x))].filter((uid) => ok.get(uid, orgId)).slice(0, max)
}
