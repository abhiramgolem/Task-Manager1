// Deadline reminders in the app (bell + phone push), for every task.
//
// Profile → Notifications has had a "Deadlines" switch ("reminders as a due date
// approaches") that nothing ever sent: the only deadline warning was an email,
// for Critical tasks only, and off unless TASK_MAIL_TO_OWNERS is set. Cliq users
// were used to being reminded. Two reminders per open task, on the team's clock:
//
//   the evening before   — at the deadline hour (default 18:00) the day before
//   an hour before       — at deadline hour − 1 on the due day (17:00)
//
// due_date has no time of day, so "the deadline" is the end of the working day,
// the same assumption taskMail.js makes (TASK_MAIL_DEADLINE_HOUR).
//
// Each (task, kind) is sent once — task_due_reminders records it — so a restart,
// a slow tick or a server that was asleep at 17:00 never sends twice; a late
// tick still sends (late beats never), but only while the slot still makes
// sense: an hour-before reminder is not sent after the deadline has passed.
import { db } from './db.js'
import { notify } from './util.js'
import { zonedNow, deadlineHour } from './taskMail.js'
import { addDays } from './clock.js'

const OPEN = "('To Do','In Progress','Blocked','Reopened')"

const due = (day) => db.prepare(`
  SELECT t.id, t.org_id, t.title, t.assignee_id FROM tasks t
  WHERE t.due_date = ? AND t.status IN ${OPEN} AND t.assignee_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id = t.id)
    AND NOT EXISTS (SELECT 1 FROM task_due_reminders r WHERE r.task_id = t.id AND r.kind = ?)`)

export function runDueReminders(now = new Date()) {
  const z = zonedNow(now)
  const h = deadlineHour()
  const mark = db.prepare('INSERT OR IGNORE INTO task_due_reminders (task_id, kind, sent_at) VALUES (?,?,?)')
  const send = (rows, kind, text) => {
    for (const t of rows) {
      mark.run(t.id, kind, now.toISOString())
      notify(t.org_id, t.assignee_id, 'task_due_soon', text(t), t.id)
    }
  }
  // The evening before: tasks due tomorrow.
  if (z.hour >= h) {
    const tomorrow = addDays(z.date, 1)
    send(due(tomorrow).all(tomorrow, 'day'), 'day', (t) => `Due tomorrow: "${t.title}"`)
  }
  // An hour before: tasks due today, between deadline−1 and the deadline.
  if (h >= 1 && z.hour === h - 1) {
    send(due(z.date).all(z.date, 'hour'), 'hour', (t) => `Due in about an hour: "${t.title}"`)
  }
}
