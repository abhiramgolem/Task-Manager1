// Natural-language assistant + search over tasks.
// Rule/intent based so it works offline; scoped by the caller's role.
import { db } from '../db.js'
import { localDay, addDays } from '../clock.js'
import { resolveUser } from './extractor.js'

const OPEN_STATUSES = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Reopened']

function taskRows(orgId) {
  return db.prepare(`
    SELECT t.*, u.name AS assignee_name, b.name AS assigned_by_name, p.name AS project_name
    FROM tasks t
    LEFT JOIN users u ON u.id = t.assignee_id
    LEFT JOIN users b ON b.id = t.assigned_by_id
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.org_id = ? AND t.parent_task_id IS NULL
  `).all(orgId)
}

const today = () => localDay()
const isOverdue = (t) => t.due_date && t.due_date < today() && !['Done'].includes(t.status)

// Scope to what the requesting user may see.
function scope(tasks, user) {
  if (user.role === 'employee') return tasks.filter((t) => t.assignee_id === user.id)
  return tasks // managers + admins see the whole org
}

export function answerQuery(rawQuery, user) {
  const q = (rawQuery || '').toLowerCase().trim()
  let tasks = scope(taskRows(user.org_id), user)

  // who is responsible for <X>?
  let m = q.match(/who (?:owns|is responsible for|handles?|is doing)\s+(.+)/)
  if (m) {
    const kw = m[1].replace(/[?.]/g, '').trim()
    const hits = tasks.filter((t) => (t.title + ' ' + (t.description || '')).toLowerCase().includes(kw))
    if (!hits.length) return { answer: `No task matching “${kw}” found.`, tasks: [] }
    const lines = hits.map((t) => `• ${t.title} → ${t.assignee_name || 'Unassigned'}${t.due_date ? ' (due ' + t.due_date + ')' : ''}`)
    return { answer: `Ownership for “${kw}”:\n` + lines.join('\n'), tasks: hits }
  }

  // tasks assigned to / for <name>
  m = q.match(/(?:tasks?\s+(?:assigned to|for|of)|show me tasks for|^)\s*([a-z][a-z .]+?)(?:'s)?\s*(?:tasks)?$/)
  const nameMatch = q.match(/(?:assigned to|tasks for|tasks of|for)\s+([a-z][a-z]+)/)
  if (nameMatch) {
    const u = resolveUser(user.org_id, nameMatch[1])
    if (!u) return { answer: `I couldn't find a user named “${nameMatch[1]}”.`, tasks: [] }
    const hits = tasks.filter((t) => t.assignee_id === u.id)
    return { answer: `${u.name} has ${hits.length} task(s):`, tasks: hits }
  }

  // overdue
  if (/\boverdue\b|past due|deadline missed|late/.test(q)) {
    const hits = tasks.filter(isOverdue)
    return { answer: `${hits.length} overdue task(s):`, tasks: hits }
  }

  // priority
  for (const p of ['critical', 'high', 'medium', 'low']) {
    if (q.includes(p + ' priority') || q.includes(p + '-priority') || q.includes('priority ' + p)) {
      const hits = tasks.filter((t) => t.priority.toLowerCase() === p && OPEN_STATUSES.includes(t.status))
      return { answer: `${hits.length} open ${p}-priority task(s):`, tasks: hits }
    }
  }

  // pending / open
  if (/\bpending\b|open tasks|to do|not done|incomplete/.test(q)) {
    const hits = tasks.filter((t) => OPEN_STATUSES.includes(t.status))
    return { answer: `${hits.length} open task(s):`, tasks: hits }
  }

  // from a meeting / yesterday's meeting
  if (/meeting/.test(q)) {
    let meetings = db.prepare('SELECT * FROM meetings WHERE org_id = ? ORDER BY meeting_date DESC').all(user.org_id)
    let target = meetings[0]
    if (/yesterday/.test(q)) {
      const yi = addDays(localDay(), -1)
      target = meetings.find((mt) => (mt.meeting_date || '').slice(0, 10) === yi) || target
    }
    if (!target) return { answer: 'No meetings found.', tasks: [] }
    const hits = tasks.filter((t) => t.meeting_id === target.id)
    return { answer: `Meeting “${target.title}” (${(target.meeting_date || '').slice(0, 10)}) produced ${hits.length} task(s):`, tasks: hits }
  }

  // daily status report
  if (/daily (status|report)|today'?s status|status report/.test(q)) {
    return { answer: dailyReport(tasks), tasks: tasks.filter((t) => isOverdue(t) || t.due_date === today()) }
  }

  // weekly progress report
  if (/weekly (report|progress)|this week.*report/.test(q)) {
    return { answer: weeklyReport(tasks), tasks: [] }
  }

  // workload imbalance / reassignment
  if (/workload|imbalance|overload|reassign|balance/.test(q)) {
    return workloadAnswer(user.org_id)
  }

  // completed
  if (/completed|done|finished/.test(q)) {
    const hits = tasks.filter((t) => t.status === 'Done')
    return { answer: `${hits.length} completed task(s):`, tasks: hits }
  }

  // fallback: keyword search across titles/descriptions
  const kw = q.replace(/show( me)?|tasks?|list|find|give me/g, '').trim()
  if (kw) {
    const hits = tasks.filter((t) => (t.title + ' ' + (t.description || '')).toLowerCase().includes(kw))
    if (hits.length) return { answer: `${hits.length} task(s) matching “${kw}”:`, tasks: hits }
  }
  return {
    answer: 'Try: “show overdue tasks”, “tasks assigned to Munidhar”, “high priority tasks”, “who is responsible for deployment”, “daily status report”, “weekly progress report”, or “workload imbalance”.',
    tasks: [],
  }
}

function dailyReport(tasks) {
  const overdue = tasks.filter(isOverdue)
  const dueToday = tasks.filter((t) => t.due_date === today() && t.status !== 'Done')
  const inProgress = tasks.filter((t) => t.status === 'In Progress')
  const blocked = tasks.filter((t) => t.status === 'Blocked')
  return [
    `📋 Daily Status — ${today()}`,
    `• Due today: ${dueToday.length}`,
    `• Overdue: ${overdue.length}`,
    `• In progress: ${inProgress.length}`,
    `• Blocked: ${blocked.length}`,
    blocked.length ? `\n⚠️ Blocked: ${blocked.map((t) => t.title).join('; ')}` : '',
  ].filter(Boolean).join('\n')
}

function weeklyReport(tasks) {
  const done = tasks.filter((t) => t.status === 'Done')
  const open = tasks.filter((t) => OPEN_STATUSES.includes(t.status))
  const overdue = tasks.filter(isOverdue)
  const completion = tasks.length ? Math.round((done.length / tasks.length) * 100) : 0
  return [
    `📈 Weekly Progress Report`,
    `• Total tasks: ${tasks.length}`,
    `• Completed: ${done.length} (${completion}%)`,
    `• Still open: ${open.length}`,
    `• Overdue: ${overdue.length}`,
  ].join('\n')
}

export function workloadAnswer(orgId) {
  const rows = db.prepare(`
    SELECT u.id, u.name, COUNT(t.id) AS open_count
    FROM users u
    LEFT JOIN tasks t ON t.assignee_id = u.id AND t.status IN ('To Do','In Progress','Blocked','In Review','Reopened') AND t.parent_task_id IS NULL
    WHERE u.org_id = ? AND u.role != 'admin'
    GROUP BY u.id ORDER BY open_count DESC
  `).all(orgId)
  if (!rows.length) return { answer: 'No users found.', tasks: [], data: [] }
  const avg = rows.reduce((s, r) => s + r.open_count, 0) / rows.length
  const overloaded = rows.filter((r) => r.open_count > avg * 1.5 && r.open_count >= 3)
  const lines = rows.map((r) => `• ${r.name}: ${r.open_count} open${r.open_count > avg * 1.5 ? '  ⚠️ overloaded' : ''}`)
  let answer = `Workload (avg ${avg.toFixed(1)} open/person):\n` + lines.join('\n')
  if (overloaded.length) {
    const light = rows.filter((r) => r.open_count < avg).map((r) => r.name)
    answer += `\n\n💡 Suggestion: ${overloaded.map((o) => o.name).join(', ')} ${overloaded.length > 1 ? 'are' : 'is'} overloaded.` +
      (light.length ? ` Consider reassigning some tasks to ${light.slice(0, 3).join(', ')}.` : '')
  }
  return { answer, tasks: [], data: rows }
}
