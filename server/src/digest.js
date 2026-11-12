// Daily team digest: a Zoho Cliq summary, one message per org, listing every
// member's open work. Falls back to a console preview when no webhook is set.
//
// It used to also email each person their own task list. That job moved to
// taskMail.js, which does it better — at 10:00 in the reader's own timezone,
// broken out by priority band, and reaching people with nothing open too. Both
// running meant two near-identical emails a day for everyone, so this one is now
// the team channel only.
import { db } from './db.js'
import { localDay } from './clock.js'
import { postToCliq, cliqEnabled } from './cliq.js'

const today = () => localDay()
const OPEN = "('To Do','In Progress','Blocked','In Review','Reopened')"

function fmtTask(t) {
  const due = t.due_date ? ` (due ${t.due_date}${t.due_date < today() ? ' ⚠️ overdue' : ''})` : ''
  return `   • [${t.priority}] ${t.title} — ${t.status}${due}`
}

// One Cliq channel message summarising every member's open tasks (team standup).
export function buildTeamSummary(orgId) {
  const members = db.prepare("SELECT id, name FROM users WHERE org_id=? AND role IN ('employee','manager') ORDER BY name").all(orgId)
  const lines = [`📋 Daily Tasks — ${today()}`, '']
  let totalOpen = 0, totalOverdue = 0
  for (const u of members) {
    const tasks = db.prepare(
      `SELECT * FROM tasks WHERE assignee_id=? AND parent_task_id IS NULL AND status IN ${OPEN} AND visible_to_manager=1 ORDER BY due_date IS NULL, due_date`
    ).all(u.id)
    if (!tasks.length) continue
    const overdue = tasks.filter((t) => t.due_date && t.due_date < today()).length
    totalOpen += tasks.length; totalOverdue += overdue
    lines.push(`${u.name} — ${tasks.length} open${overdue ? ` (${overdue} overdue)` : ''}`)
    tasks.slice(0, 8).forEach((t) => lines.push(fmtTask(t)))
    if (tasks.length > 8) lines.push(`   …and ${tasks.length - 8} more`)
    lines.push('')
  }
  if (totalOpen === 0) lines.push('No open tasks today. 🎉')
  else lines.push(`Team total: ${totalOpen} open${totalOverdue ? `, ${totalOverdue} overdue` : ''}.`)
  return lines.join('\n')
}

// Run the digest: post a Cliq summary per org.
export async function sendDailyDigests() {
  const orgs = db.prepare('SELECT DISTINCT org_id FROM users').all().map((r) => r.org_id)
  let cliqMode = 'off', cliqMessages = 0
  for (const org of orgs) {
    const r = await postToCliq(buildTeamSummary(org))
    cliqMode = r.mode; cliqMessages++
  }
  const summary = { cliq: cliqEnabled() ? cliqMode : 'preview', cliqMessages }
  console.log(`[digest] ${today()} → cliq:${summary.cliq} (${cliqMessages} msg)`)
  return summary
}
