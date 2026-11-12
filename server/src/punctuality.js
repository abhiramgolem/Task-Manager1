// Delivery punctuality — how late each person's work is, in days.
//
// The points board (performance.js) measures volume: finish 10 tasks, earn 100.
// It says nothing about whether those tasks arrived on time, and someone who
// finishes everything a week late outranks someone who finishes fewer on the
// day. This is the other half: for every task with a deadline, how many days
// past it the work landed, averaged per person. Lower is better; 0 means every
// deadline was met.
//
// What counts, per person, for a window [since, until] (team days, clock.js):
//   - work DELIVERED in the window: days late = delivery day − due date, never
//     below 0 (early is on time, not a credit that hides another task's delay).
//     "Delivered" is when the assignee handed it over: the submission for review
//     when a reviewer approved it — the days a task waits in someone else's
//     review queue are not the assignee's delay — otherwise the completion. A
//     task sitting In Review is delivered as of its submission, pending.
//   - work still OPEN past its deadline: days late so far, still growing. It
//     counts in any window that reaches today (a task overdue since last month
//     is this month's problem too), and in a past window if its deadline fell
//     inside it.
// Left out: tasks with no deadline, split parents (their children are the work),
// and private to-dos (visible_to_manager=0) — a personal list is not something
// to be ranked on, and its titles must not surface here.
//
// Counted live on every read, like the points — no stored history to go stale.

import { db } from './db.js'
import { localDay, sqlDayShift } from './clock.js'

const _cache = new Map()
const P = (sql) => { let s = _cache.get(sql); if (!s) { s = db.prepare(sql); _cache.set(sql, s) } return s }

// One row per task in scope, with its delivery day (null = not delivered) and
// days late. `@uid` filter slot for the single-person case.
const scopeSql = (onlyUser) => `
  WITH x AS (
    SELECT t.id, t.title, t.status, t.priority, t.assignee_id AS uid, t.due_date,
      CASE
        WHEN t.status='Done' THEN
          CASE WHEN t.approval_status='approved' AND t.submitted_at IS NOT NULL AND t.submitted_at <= t.completed_at
            THEN t.submitted_at ELSE t.completed_at END
        WHEN t.status='In Review' THEN t.submitted_at
      END AS dlv
    FROM tasks t
    WHERE t.org_id=@org AND t.assignee_id IS NOT NULL ${onlyUser ? 'AND t.assignee_id=@uid' : ''}
      AND t.due_date IS NOT NULL AND julianday(t.due_date) IS NOT NULL
      AND COALESCE(t.visible_to_manager, 1)=1
      AND NOT (t.status='Done' AND t.completed_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id=t.id)
  ), y AS (
    SELECT *, CASE WHEN dlv IS NULL THEN NULL ELSE date(dlv, @shift) END AS dday FROM x
  )
  SELECT id, title, status, priority, uid, due_date, dday,
    CAST(CASE WHEN dday IS NOT NULL THEN max(0, julianday(dday) - julianday(due_date))
         ELSE julianday(@today) - julianday(due_date) END AS INTEGER) AS late
  FROM y
  WHERE (dday IS NOT NULL AND dday BETWEEN @since AND @until)
     OR (dday IS NULL AND due_date < @today AND due_date <= @until AND (due_date >= @since OR @until >= @today))`

const SQL_BY_USER = `SELECT uid, COUNT(*) AS n,
    SUM(dday IS NOT NULL AND late = 0) AS on_time,
    SUM(dday IS NOT NULL AND late > 0) AS late_done,
    SUM(dday IS NULL) AS overdue_open,
    SUM(late) AS late_days,
    MAX(late) AS worst
  FROM (${scopeSql(false)}) GROUP BY uid`

const params = (orgId, since, until, uid) => ({
  org: orgId, since, until, today: localDay(), shift: sqlDayShift(), ...(uid ? { uid } : {}),
})

// Raw counts → what the UI shows. avg_delay is late days per task with a
// deadline (on-time tasks count as 0), to one decimal.
export function shapeDelay(row) {
  const n = row?.n || 0
  return {
    tasks: n,
    on_time: row?.on_time || 0,
    late_done: row?.late_done || 0,
    overdue_open: row?.overdue_open || 0,
    late_days: row?.late_days || 0,
    worst: row?.worst || 0,
    avg_delay: n ? Math.round(((row.late_days || 0) / n) * 10) / 10 : null,
    on_time_rate: n ? Math.round(((row.on_time || 0) / n) * 100) : null,
  }
}

// Map<uid, delay summary> for everyone in the org with a deadline in scope.
export function delayByUser(orgId, since, until) {
  const out = new Map()
  for (const row of P(SQL_BY_USER).all(params(orgId, since, until))) out.set(row.uid, shapeDelay(row))
  return out
}

// Who delivers on time best: lowest average delay first, then the higher
// on-time share, then whoever met more deadlines (one task on time is a thinner
// record than thirty), then by name so the order is stable between reloads.
// People with no deadline in the window are listed after, unranked.
export function rankByDelay(rows) {
  const has = rows.filter((r) => r.delay?.tasks > 0).sort((a, b) =>
    a.delay.avg_delay - b.delay.avg_delay
    || b.delay.on_time_rate - a.delay.on_time_rate
    || b.delay.tasks - a.delay.tasks
    || a.name.localeCompare(b.name))
  const rank = new Map(has.map((r, i) => [r.id, i + 1]))
  return (r) => rank.get(r.id) || null
}

// One person: the summary, plus — when `withTasks` — the tasks behind it, worst
// first: what is overdue right now, then what was delivered late. Titles only
// for the person themselves and managers (the caller decides); everyone else
// sees the numbers, as they do on the points board.
export function delayDetail(orgId, userId, since, until, withTasks) {
  const rows = P(`${scopeSql(true)} ORDER BY (dday IS NULL) DESC, late DESC, due_date ASC`).all(params(orgId, since, until, userId))
  const sum = { n: rows.length, on_time: 0, late_done: 0, overdue_open: 0, late_days: 0, worst: 0 }
  for (const r of rows) {
    if (r.dday == null) sum.overdue_open++
    else if (r.late > 0) sum.late_done++
    else sum.on_time++
    sum.late_days += r.late
    sum.worst = Math.max(sum.worst, r.late)
  }
  const out = shapeDelay(sum)
  if (withTasks) {
    out.items = rows.filter((r) => r.late > 0).slice(0, 15).map((r) => ({
      id: r.id, title: r.title, status: r.status, priority: r.priority,
      due_date: r.due_date, delivered_on: r.dday, days_late: r.late, open: r.dday == null,
    }))
  }
  return out
}
