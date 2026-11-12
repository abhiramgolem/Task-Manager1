// Engagement scoring service — counts each person's scoring actions straight out
// of tasks / task_comments and turns them into points. The policy (what an action
// is worth) lives in scoring.js; this file is the DB-facing glue.
//
// Nothing is persisted: a point is a row that already exists in one of those
// tables, so the leaderboard is always live and there is no job to run, no cache
// to invalidate and no history to rebuild. Completing a task updates the board on
// the next read — including retroactively, since removing a scoring rule changes
// every past score too.
//
// Day boundaries are the team's (clock.js): a day runs 00:00–23:59 IST, and a
// timestamp is filed under the IST day it happened on — date(iso, shift) in SQL.
// They used to be UTC (substr(iso,1,10)), so "Today" ran 05:30–05:29 IST and
// anything done after midnight counted for the day before.

import { db } from './db.js'
import { scoreCounts, pointRules, RULE_POINTS } from './scoring.js'
import { localDay, addDays, sqlDayShift } from './clock.js'
import { delayByUser, rankByDelay, delayDetail } from './punctuality.js'

const today = () => localDay()

// Prepared statements compiled lazily (tables may not exist at import time).
const _cache = new Map()
const P = (sql) => { let s = _cache.get(sql); if (!s) { s = db.prepare(sql); _cache.set(sql, s) } return s }

// --- The four scoring queries -------------------------------------------------
// Each returns {uid, c} per person for one org within [since, until], both
// inclusive team-calendar yyyy-mm-dd days. All-time passes '0000-00-00'..'9999-12-31' so
// the BETWEEN always holds. The upper bound exists so a PAST calendar month (or
// an admin's custom window) can be viewed without later activity bleeding in.
//
// Each query has an optional `AND <col>=?` slot appended for the single-user case,
// so the leaderboard and the detail view can't drift apart.

// +1 per task this person handed to SOMEONE ELSE. Self-assigned tasks don't count:
// otherwise you could farm 2 points by making a task for yourself and ticking it.
const SQL_ASSIGNED = `
  SELECT assigned_by_id AS uid, COUNT(*) AS c FROM tasks
  WHERE org_id=? AND assigned_by_id IS NOT NULL AND assignee_id IS NOT NULL
    AND assigned_by_id != assignee_id AND date(created_at, ?) BETWEEN ? AND ?`
// +1 per task this person finished (excludes split PARENTS, whose completion is a
// roll-up of their children rather than work done directly).
const SQL_COMPLETED = `
  SELECT assignee_id AS uid, COUNT(*) AS c FROM tasks t
  WHERE org_id=? AND status='Done' AND assignee_id IS NOT NULL AND completed_at IS NOT NULL
    AND date(completed_at, ?) BETWEEN ? AND ?
    AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id=t.id)`
// +1 per COMMENT — ten replies on one task is ten points. Used to dedupe by task,
// but the policy is now to pay every comment (see scoring.js).
const SQL_COMMENTED = `
  SELECT c.user_id AS uid, COUNT(*) AS c FROM task_comments c
  JOIN tasks t ON t.id=c.task_id
  WHERE t.org_id=? AND date(c.created_at, ?) BETWEEN ? AND ?`
// Status changes are no longer scored (see scoring.js), so there is no query for
// them here — the audit rows are still written, they just don't pay.

// key → [sql, groupByColumn]. The group-by column doubles as the single-user filter.
const RULE_SQL = {
  assigned: [SQL_ASSIGNED, 'assigned_by_id'],
  completed: [SQL_COMPLETED, 'assignee_id'],
  commented: [SQL_COMMENTED, 'c.user_id'],
}

// Raw action counts for every person in the org: Map<uid, {assigned,…}>.
function gatherCounts(orgId, since, until, onlyUserId = null) {
  const out = new Map()
  const bump = (uid, key, c) => {
    if (!uid) return
    if (!out.has(uid)) out.set(uid, { assigned: 0, completed: 0, commented: 0 })
    out.get(uid)[key] = c
  }
  for (const [key, [sql, col]] of Object.entries(RULE_SQL)) {
    const q = onlyUserId ? `${sql} AND ${col}=? GROUP BY ${col}` : `${sql} GROUP BY ${col}`
    const shift = sqlDayShift()
    const args = onlyUserId ? [orgId, shift, since, until, onlyUserId] : [orgId, shift, since, until]
    for (const row of P(q).all(...args)) bump(row.uid, key, row.c)
  }
  return out
}

// --- Read side ----------------------------------------------------------------

const ALL_TIME = { since: '0000-00-00', until: '9999-12-31' }

// Period token → the inclusive [since, until] team-day range that counts.
//   day    → today only
//   month  → one CALENDAR month (`month` = 'yyyy-mm', defaults to the current
//            one) — not a rolling 30 days, so April / May / June each stand alone
//   all    → everything
//   custom → the org's admin-chosen from/to window (falls back to the current
//            month if the range is missing — routes/scores.js normally guards this)
export function periodRange(period, { month, from, to } = {}) {
  if (period === 'day') return { since: today(), until: today() }
  if (period === 'all') return ALL_TIME
  if (period === 'custom' && from && to) return { since: from, until: to }
  const m = /^\d{4}-(0[1-9]|1[0-2])$/.test(month || '') ? month : today().slice(0, 7)
  // Last day of the month: jump to the 1st of the next month, step back one day.
  const nextFirst = new Date(m + '-01T00:00:00Z')
  nextFirst.setUTCMonth(nextFirst.getUTCMonth() + 1)
  return { since: m + '-01', until: addDays(nextFirst.toISOString().slice(0, 10), -1) }
}

// The whole-org leaderboard for a period. EVERYONE in the org is listed; people
// with no activity in range score 0 and trail the ranked list. Ranked on total
// points — a straight count of work done, so volume is exactly what it measures.
export function getLeaderboard(orgId, { period = 'month', month, from, to } = {}) {
  const { since, until } = periodRange(period, { month, from, to })
  const counts = gatherCounts(orgId, since, until)
  const delays = delayByUser(orgId, since, until)
  const users = db.prepare('SELECT id, name, avatar_color, avatar_file, role FROM users WHERE org_id=?').all(orgId)

  const rows = users.map((u) => {
    const { points, breakdown } = scoreCounts(counts.get(u.id))
    return {
      id: u.id, name: u.name, avatar_color: u.avatar_color, avatar_file: u.avatar_file, role: u.role,
      score: points,
      breakdown,
      // Punctuality over the same window (punctuality.js) — the "On time" ranking.
      delay: delays.get(u.id) || null,
    }
  })
  const delayRank = rankByDelay(rows)
  for (const r of rows) r.delay_rank = delayRank(r)

  // Ranked by points, highest first; ties break alphabetically so the order is
  // stable between reloads. Zero-point people are listed but not ranked.
  const active = rows.filter((r) => r.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((r, i) => ({ ...r, rank: i + 1 }))
  const idle = rows.filter((r) => r.score === 0).sort((a, b) => a.name.localeCompare(b.name))

  return {
    period,
    since,
    until,
    // Which calendar month the range represents, so the client's month picker
    // can reflect the default ('month' with no explicit month = the current one).
    month: period === 'month' ? since.slice(0, 7) : undefined,
    rules: pointRules(),
    ranked: [...active, ...idle],
    scored_count: active.length,
    total_points: active.reduce((s, r) => s + r.score, 0),
    delay_ranked_count: rows.filter((r) => r.delay_rank).length,
  }
}

// One person's detail: their points for the period, the count behind each rule,
// their all-time total, and a per-day series for the chart.
// `withTasks`: also list the late / overdue tasks behind the delay numbers —
// only for the person themselves or a manager (routes/scores.js decides).
export function getUserDetail(userId, { period = 'month', month, from, to, historyDays = 30, withTasks = false } = {}) {
  const u = db.prepare('SELECT id, name, avatar_color, avatar_file, role, org_id FROM users WHERE id=?').get(userId)
  if (!u) return null
  const { since, until } = periodRange(period, { month, from, to })
  const { points, breakdown } = scoreCounts(gatherCounts(u.org_id, since, until, userId).get(userId))
  const allTime = scoreCounts(gatherCounts(u.org_id, ALL_TIME.since, ALL_TIME.until, userId).get(userId))

  return {
    user: { id: u.id, name: u.name, avatar_color: u.avatar_color, avatar_file: u.avatar_file, role: u.role },
    period,
    since,
    until,
    points,
    breakdown,
    all_time_points: allTime.points,
    rules: pointRules(),
    history: dailyPoints(u.org_id, userId, historyDays),
    delay: delayDetail(u.org_id, userId, since, until, withTasks),
  }
}

// Points per day for the last `days` days, oldest first — the detail chart.
// Same four rules, grouped by day instead of by person, each day's raw counts
// multiplied by what that rule pays so the bars match the headline total.
function dailyPoints(orgId, userId, days) {
  const from = addDays(today(), -(days - 1))
  const shift = sqlDayShift()
  const perDay = new Map()
  const bump = (day, n) => perDay.set(day, (perDay.get(day) || 0) + n)

  const DAY_SQL = {
    assigned: `SELECT date(created_at, @shift) AS d, COUNT(*) AS c FROM tasks
      WHERE org_id=@org AND assigned_by_id=@uid AND assignee_id IS NOT NULL AND assigned_by_id != assignee_id
        AND date(created_at, @shift) >= @from GROUP BY d`,
    completed: `SELECT date(completed_at, @shift) AS d, COUNT(*) AS c FROM tasks t
      WHERE org_id=@org AND assignee_id=@uid AND status='Done' AND completed_at IS NOT NULL
        AND date(completed_at, @shift) >= @from
        AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id=t.id) GROUP BY d`,
    commented: `SELECT date(c.created_at, @shift) AS d, COUNT(*) AS c FROM task_comments c
      JOIN tasks t ON t.id=c.task_id
      WHERE t.org_id=@org AND c.user_id=@uid AND date(c.created_at, @shift) >= @from GROUP BY d`,
  }
  for (const [key, sql] of Object.entries(DAY_SQL)) {
    const per = RULE_POINTS[key] || 0
    for (const row of P(sql).all({ org: orgId, uid: userId, from, shift })) if (row.d) bump(row.d, row.c * per)
  }

  const out = []
  for (let d = from; d <= today(); d = addDays(d, 1)) out.push({ day: d, points: perDay.get(d) || 0 })
  return out
}
