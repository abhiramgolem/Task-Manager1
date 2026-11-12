// The calendar day as the team reads it.
//
// The server runs in UTC (Render), and `new Date().toISOString().slice(0, 10)`
// is the UTC date — which in India turns over at 05:30, not at midnight. So
// between 00:00 and 05:30 IST "today" was still yesterday: tasks due yesterday
// were not overdue yet, "tomorrow" said to the assistant meant today, and the
// leaderboard's Today counted from 05:30 to 05:29 the next morning, filing
// anything done after midnight on the wrong day. Every day boundary in the app
// goes through here instead, read on a clock in APP_TZ — default the same zone
// taskMail.js already sends its mail in.
//
// Timestamps stay UTC ISO strings in the database; only the question "which day
// was that?" is asked in the team's zone.

export const appTz = () => process.env.APP_TZ || process.env.TASK_MAIL_TZ || 'Asia/Kolkata'

const fmts = new Map()
const fmt = (tz) => {
  let f = fmts.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
    fmts.set(tz, f)
  }
  return f
}
const parts = (d) => {
  const o = {}
  for (const p of fmt(appTz()).formatToParts(d)) if (p.type !== 'literal') o[p.type] = p.value
  return o
}

// 'YYYY-MM-DD' of an instant (Date, ISO string or ms) in the team's zone; null
// for something that isn't a time. No argument = today.
export function localDay(at = new Date()) {
  const d = at instanceof Date ? at : new Date(at)
  if (isNaN(d.getTime())) return null
  const o = parts(d)
  return `${o.year}-${o.month}-${o.day}`
}

// Minutes the team's clock is ahead of UTC at that instant (+330 for IST).
export function tzOffsetMinutes(at = new Date()) {
  const o = parts(at)
  const wall = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second)
  return Math.round((wall - Math.floor(at.getTime() / 1000) * 1000) / 60000)
}

// SQLite modifier that moves a stored UTC timestamp onto the team's clock:
// date(created_at, ?) with this bound is the local day it happened on. Uses the
// offset in force now — exact for IST, which has no daylight saving; a zone that
// has it would misfile the hour either side of a change in a past season.
export function sqlDayShift(at = new Date()) {
  const m = tzOffsetMinutes(at)
  return `${m >= 0 ? '+' : '-'}${Math.abs(m)} minutes`
}

// Calendar arithmetic on 'YYYY-MM-DD' strings — no clock involved.
export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
// Whole days from `a` to `b` (positive when b is later).
export function daysBetween(a, b) {
  const t = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) }
  return Math.round((t(b) - t(a)) / 86_400_000)
}
