// Employee performance scores — the leaderboard and per-employee detail.
// Scores are visible to everyone in the org (by design); cross-org access is
// blocked. The heavy lifting lives in performance.js / scoring.js.
import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, requireRole } from '../auth.js'
import { audit } from '../util.js'
import { getLeaderboard, getUserDetail } from '../performance.js'

const r = Router()
r.use(authRequired)

// day | month | all | custom. month = one CALENDAR month (?month=yyyy-mm picks
// which; default the current one). custom = the org-wide window a manager set.
const PERIODS = ['day', 'month', 'all', 'custom']
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

// The org's admin-chosen custom window, or null when unset.
const customRange = (orgId) => {
  const o = db.prepare('SELECT leaderboard_from AS f, leaderboard_to AS t FROM organizations WHERE id=?').get(orgId)
  return o?.f && o?.t ? { from: o.f, to: o.t } : null
}

// Resolve the request's period against the org's saved custom range. No valid
// period given + a saved range → 'custom': the window a manager chose is what
// everyone lands on by default. Asking for 'custom' when nothing is saved falls
// back to the calendar month rather than erroring — the tab is just empty state.
const periodParams = (req) => {
  const range = customRange(req.user.org_id)
  let period = String(req.query.period || '')
  if (!PERIODS.includes(period)) period = range ? 'custom' : 'month'
  if (period === 'custom' && !range) period = 'month'
  const month = MONTH_RE.test(String(req.query.month || '')) ? String(req.query.month) : undefined
  return { period, month, from: range?.from, to: range?.to, range }
}

// Whole-org leaderboard. custom_range rides along so every client (any role)
// knows whether a Custom window is active and what it spans.
r.get('/leaderboard', (req, res) => {
  const p = periodParams(req)
  res.json({ ...getLeaderboard(req.user.org_id, p), custom_range: p.range })
})

// Set or clear the org-wide custom window. Managers/admins only — employees see
// the resulting Custom period read-only. An empty body clears it, returning
// everyone to the calendar-month default.
r.put('/range', requireRole('manager', 'admin'), (req, res) => {
  const { from, to } = req.body || {}
  if (!from && !to) {
    db.prepare('UPDATE organizations SET leaderboard_from=NULL, leaderboard_to=NULL WHERE id=?').run(req.user.org_id)
    audit(req.user.org_id, req.user.id, 'leaderboard.range', 'organization', req.user.org_id, 'cleared')
    return res.json({ custom_range: null })
  }
  if (!DAY_RE.test(String(from || '')) || !DAY_RE.test(String(to || ''))) {
    return res.status(400).json({ error: 'Both dates are required, as yyyy-mm-dd.' })
  }
  if (from > to) return res.status(400).json({ error: 'The start date must be on or before the end date.' })
  db.prepare('UPDATE organizations SET leaderboard_from=?, leaderboard_to=? WHERE id=?').run(from, to, req.user.org_id)
  audit(req.user.org_id, req.user.id, 'leaderboard.range', 'organization', req.user.org_id, { from, to })
  res.json({ custom_range: { from, to } })
})

// The signed-in user's own detail.
r.get('/me', (req, res) => {
  const detail = getUserDetail(req.user.id, { ...periodParams(req), withTasks: true })
  if (!detail) return res.status(404).json({ error: 'No score yet' })
  res.json(detail)
})

// Any user's detail — same org only.
r.get('/:userId', (req, res) => {
  const target = db.prepare('SELECT org_id FROM users WHERE id=?').get(req.params.userId)
  if (!target) return res.status(404).json({ error: 'User not found' })
  if (target.org_id !== req.user.org_id) return res.status(403).json({ error: 'Out of organization' })
  // The numbers are open to everyone, like the points; WHICH tasks ran late is
  // for the person themselves and managers — an employee's Tasks page doesn't
  // show them a colleague's work either.
  const canSeeTasks = req.params.userId === req.user.id || ['manager', 'admin'].includes(req.user.role)
  const detail = getUserDetail(req.params.userId, { ...periodParams(req), withTasks: canSeeTasks })
  if (!detail) return res.status(404).json({ error: 'No score yet' })
  res.json(detail)
})

// No /recompute any more: points are counted live from tasks / task_comments /
// audit_logs on every read, so there is no stored history that can go stale.

export default r
