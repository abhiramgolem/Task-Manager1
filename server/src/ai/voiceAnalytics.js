// Deterministic analytics for the voice assistant.
//
// Numbers are computed in SQL and phrased with templates — the LLM never invents a
// metric. It only decides WHICH question to ask (which period, which grouping);
// the arithmetic happens here. A hallucinated "7 tasks overdue" would be worse
// than no answer at all.
//
// Everything is RBAC-scoped: an employee only ever sees their own tasks.
import { db } from '../db.js'
import { localDay, sqlDayShift } from '../clock.js'

const OPEN_STATUSES = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Reopened']

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
// The team's calendar (clock.js), not the server's: Render runs in UTC, where
// "today" lags IST until 05:30. Noon of the local day, so the Date arithmetic
// below (weekday, month starts) can't slip a day whatever zone the process is in.
const todayAt = () => new Date(localDay() + 'T12:00:00')
const today = () => localDay()
const shift = (days) => { const d = todayAt(); d.setDate(d.getDate() + days); return d }

export const PERIODS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'custom']

// Resolve a spoken period into an inclusive [from, to] date window + a spoken label.
export function dateRange(period, from, to) {
  const t = todayAt()
  switch (period) {
    case 'yesterday': { const d = shift(-1); return { from: ymd(d), to: ymd(d), label: 'Yesterday' } }
    case 'this_week': { const d = shift(-((t.getDay() + 6) % 7)); return { from: ymd(d), to: today(), label: 'This week' } }
    case 'last_week': {
      const mon = shift(-((t.getDay() + 6) % 7) - 7)
      const sun = new Date(mon); sun.setDate(sun.getDate() + 6)
      return { from: ymd(mon), to: ymd(sun), label: 'Last week' }
    }
    case 'this_month': { const d = new Date(t.getFullYear(), t.getMonth(), 1); return { from: ymd(d), to: today(), label: 'This month' } }
    case 'last_month': {
      const s = new Date(t.getFullYear(), t.getMonth() - 1, 1)
      const e = new Date(t.getFullYear(), t.getMonth(), 0)
      return { from: ymd(s), to: ymd(e), label: 'Last month' }
    }
    case 'custom':
      if (from && to) return { from, to, label: from === to ? from : `${from} to ${to}` }
      return { from: today(), to: today(), label: 'Today' }
    default: return { from: today(), to: today(), label: 'Today' }
  }
}

// Employees only ever count their own top-level tasks.
const scopeClause = (user) => (user.role === 'employee' ? 'AND t.assignee_id = @uid' : '')
// Bind exactly the params a statement uses — better-sqlite3 rejects extras.
const baseArgs = (user, extra = {}) => {
  const a = { org: user.org_id, ...extra }
  if (user.role === 'employee') a.uid = user.id
  return a
}

// Counts for a date window, plus "right now" state (overdue/blocked are point-in-time).
export function overview(user, range) {
  const s = scopeClause(user)
  const one = (sql, args) => db.prepare(sql).get(args).c

  const inWindow = (col) => `
    SELECT COUNT(*) c FROM tasks t
    WHERE t.org_id=@org AND t.parent_task_id IS NULL ${s}
      AND t.${col} IS NOT NULL AND date(t.${col}, @shift) BETWEEN @from AND @to`

  const winArgs = baseArgs(user, { from: range.from, to: range.to, shift: sqlDayShift() })
  const created = one(inWindow('created_at'), winArgs)
  const assigned = one(inWindow('assigned_at'), winArgs)
  const completed = one(inWindow('completed_at'), winArgs)

  const dueArgs = baseArgs(user, { today: today() })
  const plainArgs = baseArgs(user)
  const overdue = one(`SELECT COUNT(*) c FROM tasks t WHERE t.org_id=@org AND t.parent_task_id IS NULL ${s}
      AND t.due_date IS NOT NULL AND t.due_date < @today AND t.status != 'Done'`, dueArgs)
  const blocked = one(`SELECT COUNT(*) c FROM tasks t WHERE t.org_id=@org AND t.parent_task_id IS NULL ${s}
      AND t.status='Blocked'`, plainArgs)
  const inReview = one(`SELECT COUNT(*) c FROM tasks t WHERE t.org_id=@org AND t.parent_task_id IS NULL ${s}
      AND t.status='In Review'`, plainArgs)
  const open = one(`SELECT COUNT(*) c FROM tasks t WHERE t.org_id=@org AND t.parent_task_id IS NULL ${s}
      AND t.status IN (${OPEN_STATUSES.map((x) => `'${x}'`).join(',')})`, plainArgs)

  const stats = { created, assigned, completed, overdue, blocked, in_review: inReview, open }
  return { range, stats, say: sayOverview(range, stats) }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

// Always report the same four "in the window" numbers and the same "right now"
// picture. Suppressing zeros made the answer feel like it dodged the question
// (asked "how many did I assign?", got nothing back).
function sayOverview(range, s) {
  const out = [
    `${range.label}: ${plural(s.created, 'task created', 'tasks created')}, `
    + `${s.assigned} assigned, ${s.completed} completed.`,
  ]
  if (!s.open) { out.push('Nothing is open right now.'); return out.join(' ') }

  const now = [`${plural(s.open, 'task is', 'tasks are')} open`]
  now.push(`${s.overdue} overdue`)
  if (s.blocked) now.push(`${s.blocked} blocked`)
  if (s.in_review) now.push(`${s.in_review} awaiting review`)
  out.push(`Right now ${now.join(', ')}.`)
  return out.join(' ')
}

// Open tasks per person (managers/admins only — an employee has no team view).
export function workload(user, assigneeId) {
  const args = { org: user.org_id }
  if (assigneeId) args.aid = assigneeId
  const rows = db.prepare(`
    SELECT u.id, u.name, COUNT(t.id) c
    FROM users u LEFT JOIN tasks t
      ON t.assignee_id=u.id AND t.org_id=@org AND t.parent_task_id IS NULL
     AND t.status IN (${OPEN_STATUSES.map((x) => `'${x}'`).join(',')})
    WHERE u.org_id=@org AND u.role!='admin' ${assigneeId ? 'AND u.id=@aid' : ''}
    GROUP BY u.id ORDER BY c DESC`).all(args)
  if (!rows.length) return { rows, say: "I couldn't find anyone to report on." }
  if (assigneeId) {
    const r = rows[0]
    return { rows, say: `${r.name} has ${plural(r.c, 'open task', 'open tasks')}.` }
  }
  const top = rows.slice(0, 5).map((r) => `${r.name} ${r.c}`).join(', ')
  return { rows, say: `Open tasks per person — ${top}.` }
}

// Group tasks by a field, with optional filters. Powers "group the overdue tasks".
// NOTE: single quotes around 'Unassigned' — SQLite reads a double-quoted token as
// an identifier (column name) first, which raised "no such column".
const GROUPABLE = { assignee: "COALESCE(u.name, 'Unassigned')", status: 't.status', priority: 't.priority' }

export function groupTasks(user, { group_by = 'assignee', overdue = false, status = null, priority = null, assignee_id = null } = {}) {
  const col = GROUPABLE[group_by] || GROUPABLE.assignee
  const where = [`t.org_id=@org`, `t.parent_task_id IS NULL`]
  // better-sqlite3 rejects named params the statement doesn't use, so bind exactly.
  const args = { org: user.org_id }
  if (user.role === 'employee') { where.push('t.assignee_id=@uid'); args.uid = user.id }
  if (overdue) { where.push(`t.due_date IS NOT NULL AND t.due_date < @today AND t.status != 'Done'`); args.today = today() }
  if (status) { where.push('t.status=@status'); args.status = status }
  if (priority) { where.push('t.priority=@priority'); args.priority = priority }
  if (assignee_id) { where.push('t.assignee_id=@aid'); args.aid = assignee_id }

  const rows = db.prepare(`
    SELECT ${col} AS label, COUNT(*) c
    FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
    WHERE ${where.join(' AND ')}
    GROUP BY label ORDER BY c DESC`).all(args)

  const total = rows.reduce((n, r) => n + r.c, 0)
  const what = overdue ? 'overdue task' : (status ? `${status} task` : (priority ? `${priority} priority task` : 'task'))
  if (!total) return { rows, total, say: `You have no ${what}s.` }
  const by = rows.map((r) => `${r.label} ${r.c}`).join(', ')
  return { rows, total, say: `${plural(total, what, what + 's')} by ${group_by}: ${by}.` }
}
