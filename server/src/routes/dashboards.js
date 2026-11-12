import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, requireRole } from '../auth.js'
import { localDay } from '../clock.js'

const r = Router()
r.use(authRequired)
// The team's day (clock.js) — the UTC date lags IST until 05:30.
const today = () => localDay()
const OPEN = "('To Do','In Progress','Blocked','In Review','Reopened')"

// A task counts once, for whoever actually does it. When a task is split, the
// PARTS are the real work and the parent is just a container holding them — so
// counting both would double-report. "Leaf" = has no children of its own.
// This replaces the old `parent_task_id IS NULL`, which did the opposite: it
// counted containers and hid the parts, so split work was attributed to nobody
// and the people doing it couldn't see their own tasks at all.
const LEAF = 'NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id = t.id)'

// How a task reached its owner, for the badge on each card. Mirrors taskOrigin()
// in routes/tasks.js — kept in sync by hand because dashboards read rows directly
// rather than going through hydrate() (which costs ~8 queries per task).
const originOf = (t) => {
  if (t.parent_task_id) return 'split'
  if (t.reassigned_at) return 'reassigned'
  if (t.assigned_by_id && t.assignee_id && t.assigned_by_id !== t.assignee_id) return 'assigned'
  return 'self'
}

// EMPLOYEE dashboard: my work
r.get('/employee', (req, res) => {
  const uid = req.user.id
  // Everything I personally have to do — including parts of a split task, which
  // used to be invisible in every list view despite sending a notification.
  const mine = db.prepare(`SELECT t.*, m.title AS meeting_title,
      ab.name AS assigned_by_name, rb.name AS reassigned_by_name, p.title AS parent_title
    FROM tasks t
    LEFT JOIN meetings m ON m.id=t.meeting_id
    LEFT JOIN users ab ON ab.id=t.assigned_by_id
    LEFT JOIN users rb ON rb.id=t.reassigned_by_id
    LEFT JOIN tasks p ON p.id=t.parent_task_id
    WHERE t.assignee_id=? AND t.org_id=? AND ${LEAF}`).all(uid, req.user.org_id).map((t) => ({ ...t, origin: originOf(t) }))

  // Work I handed to someone else: tasks I created for a colleague, parts I
  // distributed, and tasks I moved off someone. Deliberately NOT folded into the
  // counts above — my Overdue tile should reflect what I owe, not what I'm owed.
  const assignedByMe = db.prepare(`SELECT t.*, u.name AS assignee_name, u.avatar_color AS assignee_color,
      p.title AS parent_title
    FROM tasks t
    LEFT JOIN users u ON u.id=t.assignee_id
    LEFT JOIN tasks p ON p.id=t.parent_task_id
    WHERE t.org_id=? AND t.assignee_id IS NOT NULL AND t.assignee_id != ?
      AND (t.assigned_by_id=? OR t.reassigned_by_id=?) AND ${LEAF}
    ORDER BY t.due_date IS NULL, t.due_date`).all(req.user.org_id, uid, uid, uid)
    .map((t) => ({ ...t, origin: originOf(t) }))

  // Tasks of mine that I split up. They're containers, so they're excluded from
  // the counts above — but the owner still needs to see them, with the parts.
  const sharedByMe = db.prepare(`SELECT t.* FROM tasks t
    WHERE t.assignee_id=? AND t.org_id=? AND NOT (${LEAF})`).all(uid, req.user.org_id).map((t) => ({
      ...t,
      parts: db.prepare(`SELECT c.id, c.title, c.status, c.due_date, u.name AS assignee_name, u.avatar_color AS assignee_color
        FROM tasks c LEFT JOIN users u ON u.id=c.assignee_id
        WHERE c.parent_task_id=? ORDER BY c.created_at`).all(t.id),
    }))

  const open = mine.filter((t) => !['Done'].includes(t.status))
  res.json({
    counts: {
      assigned: mine.length,
      pending: open.length,
      completed: mine.filter((t) => t.status === 'Done').length,
      overdue: mine.filter((t) => t.due_date && t.due_date < today() && t.status !== 'Done').length,
      blocked: mine.filter((t) => t.status === 'Blocked').length,
      assigned_by_me: assignedByMe.length,
    },
    upcoming: open.filter((t) => t.due_date).sort((a, b) => (a.due_date || '').localeCompare(b.due_date || '')).slice(0, 6),
    by_status: ['To Do', 'In Progress', 'Blocked', 'In Review', 'Done'].map((s) => ({ status: s, count: mine.filter((t) => t.status === s).length })),
    needs_confirmation: mine.filter((t) => t.ownership_confidence === 'needs_confirmation').length,
    assigned_by_me: assignedByMe,
    shared_by_me: sharedByMe,
  })
})

// MANAGER dashboard: team view.
// Optional ?from=&to= (YYYY-MM-DD) scopes every figure to tasks CREATED in that
// window, so the manager's Today / Week / Month / Custom buttons re-filter the
// live dashboard. With no range the whole org is shown.
r.get('/manager', requireRole('manager', 'admin'), (req, res) => {
  const org = req.user.org_id
  let { from, to } = req.query
  const valid = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  const scoped = valid(from) && valid(to)
  if (scoped && from > to) [from, to] = [to, from]
  const inRange = (iso) => { if (!scoped) return true; if (!iso) return false; const day = localDay(iso); return !!day && day >= from && day <= to }
  const OPEN_STATUSES = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Reopened']

  const allTasks = db.prepare(`SELECT t.*, u.name AS assignee_name,
      ab.name AS assigned_by_name, rb.name AS reassigned_by_name, p.title AS parent_title
    FROM tasks t
    LEFT JOIN users u ON u.id=t.assignee_id
    LEFT JOIN users ab ON ab.id=t.assigned_by_id
    LEFT JOIN users rb ON rb.id=t.reassigned_by_id
    LEFT JOIN tasks p ON p.id=t.parent_task_id
    WHERE t.org_id=? AND ${LEAF} AND t.visible_to_manager=1`).all(org).map((t) => ({ ...t, origin: originOf(t) }))
  const tasks = allTasks.filter((t) => inRange(t.created_at))
  const overdue = tasks.filter((t) => t.due_date && t.due_date < today() && t.status !== 'Done')

  // Workload is derived from the scoped set in JS so it honours the date range.
  // Everyone in the org is included (employees, managers AND admins) so the manager
  // can see their own load and any tasks assigned to fellow managers/admins too.
  const members = db.prepare('SELECT id, name, avatar_color, role FROM users WHERE org_id=?').all(org)
  const workload = members.map((u) => {
    const mine = tasks.filter((t) => t.assignee_id === u.id)
    return {
      id: u.id, name: u.name, avatar_color: u.avatar_color, role: u.role,
      open_count: mine.filter((t) => OPEN_STATUSES.includes(t.status)).length,
      done_count: mine.filter((t) => t.status === 'Done').length,
      overdue_count: mine.filter((t) => t.due_date && t.due_date < today() && t.status !== 'Done').length,
    }
  }).sort((a, b) => b.open_count - a.open_count)
  // Work submitted for approval — the manager's own queue. Deliberately built
  // from allTasks, NOT the date-scoped set: an approval is a to-do, and one made
  // outside the selected window is still waiting. Scoping it would mean a manager
  // on the "Today" tab silently misses last week's submissions — which is exactly
  // how these went unnoticed. Oldest submission first, so the longest wait leads.
  const inReview = allTasks
    .filter((t) => t.status === 'In Review')
    .sort((a, b) => String(a.submitted_at || a.updated_at || '').localeCompare(String(b.submitted_at || b.updated_at || '')))
  const projects = db.prepare(`
    SELECT p.id, p.name,
      COUNT(t.id) AS total,
      SUM(CASE WHEN t.status='Done' THEN 1 ELSE 0 END) AS done
    FROM projects p LEFT JOIN tasks t ON t.project_id=p.id WHERE p.org_id=? GROUP BY p.id
  `).all(org)
  const meetings = db.prepare('SELECT COUNT(*) c FROM meetings WHERE org_id=?').get(org).c
  // Recent activity feed for the dashboard — TASK events only (created, status
  // changes, approvals, splits, comments). Auth/file/invite events are excluded.
  // Joins the task so the feed can name it (task.status only stores the status).
  const recentActivity = db.prepare(`SELECT a.id, a.action, a.detail, a.created_at,
      u.name AS actor_name, u.avatar_color AS actor_color, t.title AS task_title
    FROM audit_logs a
    LEFT JOIN users u ON u.id=a.actor_id
    LEFT JOIN tasks t ON t.id=a.entity_id AND a.entity_type='task'
    WHERE a.org_id=? AND a.entity_type='task'
      AND a.action IN ('task.create','task.status','task.approval','task.split','task.comment','task.reassign')
    ORDER BY a.created_at DESC LIMIT 25`).all(org)
  res.json({
    counts: {
      total: tasks.length,
      open: tasks.filter((t) => t.status !== 'Done').length,
      completed: tasks.filter((t) => t.status === 'Done').length,
      overdue: overdue.length,
      blocked: tasks.filter((t) => t.status === 'Blocked').length,
      needs_confirmation: tasks.filter((t) => t.ownership_confidence === 'needs_confirmation').length,
      // Unscoped, to match the in_review list below.
      in_review: inReview.length,
      meetings,
    },
    by_priority: ['Critical', 'High', 'Medium', 'Low'].map((p) => ({ priority: p, count: tasks.filter((t) => t.priority === p && t.status !== 'Done').length })),
    by_status: ['To Do', 'In Progress', 'In Review', 'Blocked', 'Reopened', 'Done'].map((s) => ({ status: s, count: tasks.filter((t) => t.status === s).length })),
    workload,
    projects: projects.map((p) => ({ ...p, progress: p.total ? Math.round((p.done / p.total) * 100) : 0 })),
    // 25, not 8: the dashboard shows the first 5 and expands in place, so the cap
    // is what "View all" can actually reveal. Still a cap — the card links out to
    // the full Tasks list when the real count exceeds it.
    overdue: overdue.slice(0, 25),
    in_review: inReview.slice(0, 8),
    recent_activity: recentActivity,
  })
})

// MANAGER report: activity scoped to a date range [from, to] (inclusive, YYYY-MM-DD).
// Powers the Daily / Weekly / Monthly / custom-range downloadable reports.
r.get('/report', requireRole('manager', 'admin'), (req, res) => {
  const org = req.user.org_id
  let { from, to } = req.query
  const valid = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  if (!valid(from) || !valid(to)) return res.status(400).json({ error: 'from and to dates (YYYY-MM-DD) are required' })
  if (from > to) [from, to] = [to, from]
  const inRange = (iso) => { if (!iso) return false; const day = localDay(iso); return !!day && day >= from && day <= to }

  const tasks = db.prepare(`SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
    WHERE t.org_id=? AND ${LEAF} AND t.visible_to_manager=1`).all(org)
  const created = tasks.filter((t) => inRange(t.created_at))
  const completed = tasks.filter((t) => t.status === 'Done' && inRange(t.completed_at))
  const dueInRange = tasks.filter((t) => t.due_date && t.due_date >= from && t.due_date <= to)
  const overdue = tasks.filter((t) => t.due_date && t.due_date < today() && t.status !== 'Done')

  const users = db.prepare("SELECT id, name, avatar_color FROM users WHERE org_id=? AND role='employee'").all(org)
  const workload = users.map((u) => ({
    id: u.id, name: u.name, avatar_color: u.avatar_color,
    created_count: created.filter((t) => t.assignee_id === u.id).length,
    completed_count: completed.filter((t) => t.assignee_id === u.id).length,
    overdue_count: overdue.filter((t) => t.assignee_id === u.id).length,
  })).filter((w) => w.created_count || w.completed_count || w.overdue_count)
    .sort((a, b) => b.completed_count - a.completed_count)

  res.json({
    range: { from, to },
    counts: {
      created: created.length,
      completed: completed.length,
      due: dueInRange.length,
      open: created.filter((t) => t.status !== 'Done').length,
      overdue: overdue.length,
    },
    by_priority: ['Critical', 'High', 'Medium', 'Low'].map((p) => ({ priority: p, count: created.filter((t) => t.priority === p).length })),
    by_status: ['To Do', 'In Progress', 'In Review', 'Blocked', 'Reopened', 'Done'].map((s) => ({ status: s, count: created.filter((t) => t.status === s).length })),
    workload,
    completed_tasks: completed.slice(0, 60).map((t) => ({ id: t.id, title: t.title, assignee_name: t.assignee_name, completed_at: t.completed_at })),
    overdue_tasks: overdue.slice(0, 60).map((t) => ({ id: t.id, title: t.title, assignee_name: t.assignee_name, due_date: t.due_date })),
  })
})

// ADMIN dashboard: org-wide. The manager is the org admin, so it owns this view.
r.get('/admin', requireRole('manager', 'admin'), (req, res) => {
  const org = req.user.org_id
  const users = db.prepare('SELECT role, COUNT(*) c FROM users WHERE org_id=? GROUP BY role').all(org)
  const tasks = db.prepare(`SELECT status, COUNT(*) c FROM tasks t WHERE org_id=? AND ${LEAF} GROUP BY status`).all(org)
  const totals = {
    users: db.prepare('SELECT COUNT(*) c FROM users WHERE org_id=?').get(org).c,
    tasks: db.prepare(`SELECT COUNT(*) c FROM tasks t WHERE org_id=? AND ${LEAF}`).get(org).c,
    meetings: db.prepare('SELECT COUNT(*) c FROM meetings WHERE org_id=?').get(org).c,
    projects: db.prepare('SELECT COUNT(*) c FROM projects WHERE org_id=?').get(org).c,
  }
  const recentAudit = db.prepare(`SELECT a.*, u.name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id
    WHERE a.org_id=? ORDER BY a.created_at DESC LIMIT 25`).all(org)
  res.json({ totals, users_by_role: users, tasks_by_status: tasks, recent_audit: recentAudit })
})

export default r
