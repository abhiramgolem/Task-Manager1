// Natural-language deadline parsing across English / Hindi / Telugu (romanized + script).
// Returns { date: 'YYYY-MM-DD' | null, raw: <matched phrase> | null }.
// `ref` is the meeting date (anchor for relative phrases).

import { localDay } from '../clock.js'

const WEEKDAYS = {
  sunday: 0, sun: 0, ravivar: 0, aadivaram: 0, bhanuvaram: 0, 'ఆదివారం': 0,
  monday: 1, mon: 1, somvar: 1, somavaram: 1, 'సోమవారం': 1, 'सोमवार': 1,
  tuesday: 2, tue: 2, mangalvar: 2, mangalavaram: 2, 'మంగళవారం': 2, 'मंगलवार': 2,
  wednesday: 3, wed: 3, budhvar: 3, budhavaram: 3, 'బుధవారం': 3, 'बुधवार': 3,
  thursday: 4, thu: 4, guruvar: 4, guruvaram: 4, brihaspativar: 4, 'గురువారం': 4, 'गुरुवार': 4,
  friday: 5, fri: 5, shukravar: 5, shukravaram: 5, 'శుక్రవారం': 5, 'शुक्रवार': 5,
  saturday: 6, sat: 6, shanivar: 6, shanivaram: 6, 'శనివారం': 6, 'शनिवार': 6,
}

function toISO(d) {
  // Local date parts (NOT toISOString, which is UTC) — otherwise a midnight-local
  // date shifts back a day on servers/machines east of UTC (e.g. IST), making
  // "tomorrow" resolve to today.
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${da}`
}
function addDays(refDate, n) {
  const d = new Date(refDate)
  d.setDate(d.getDate() + n)
  return d
}
function nextWeekday(refDate, target, forceNextWeek = false) {
  const d = new Date(refDate)
  const cur = d.getDay()
  let diff = (target - cur + 7) % 7
  if (diff === 0) diff = 7 // "Friday" said on Friday => next Friday
  if (forceNextWeek && diff < 7) diff += 7
  return addDays(d, diff)
}

export function parseDueDate(text, refISO) {
  const ref = new Date((refISO || localDay()) + 'T00:00:00')
  // Normalize: lowercase, strip punctuation to spaces, collapse whitespace, pad with spaces.
  const t = ' ' + text.toLowerCase().replace(/[.,!?;:।'"()]/g, ' ').replace(/\s+/g, ' ').trim() + ' '

  // A cue matches as a whole word/phrase (space-bounded) — punctuation-safe.
  const has = (...words) => words.find((w) => t.includes(' ' + w.toLowerCase().trim() + ' '))
  // Weekday name present as a standalone token (handles both latin and script names).
  const wordHit = (name) => t.includes(' ' + name + ' ')

  // Day-after-tomorrow (check before "tomorrow")
  let m = has('day after tomorrow', 'parso', 'parson', 'ellundi', 'ఎల్లుండి', 'परसों')
  if (m) return { date: toISO(addDays(ref, 2)), raw: m }

  // Tomorrow
  m = has('tomorrow', 'repu', 'rēpu', 'రేపు', 'kal', 'कल')
  if (m) return { date: toISO(addDays(ref, 1)), raw: m }

  // Today / EOD / tonight
  m = has('end of day', 'eod', 'today', 'tonight', 'aaj', 'aaj raat', 'eroju', 'ఈ రోజు', 'आज', 'ఈరోజు')
  if (m) return { date: toISO(ref), raw: m }

  // Next <weekday>
  for (const [name, idx] of Object.entries(WEEKDAYS)) {
    if (t.includes(' next ' + name + ' ') || t.includes(' agle ' + name + ' ') || t.includes(' ' + name + ' next ')) {
      return { date: toISO(nextWeekday(ref, idx, true)), raw: 'next ' + name }
    }
  }

  // End of week / this week
  m = has('end of week', 'eow', 'this week', 'is hafte', 'ee vaaram', 'is week')
  if (m) {
    // Friday of the current week
    return { date: toISO(nextWeekday(ref, 5, false)), raw: m }
  }
  m = has('next week', 'agle hafte', 'vachhe vaaram', 'agले हफ्ते')
  if (m) return { date: toISO(addDays(nextWeekday(ref, 1, false), 7)), raw: m }

  // Bare weekday name
  for (const [name, idx] of Object.entries(WEEKDAYS)) {
    if (wordHit(name)) {
      return { date: toISO(nextWeekday(ref, idx, false)), raw: name }
    }
  }

  // Relative event-based anchors (no exact date computable) — keep the phrase, leave date open.
  m = has('before deployment', 'before release', 'before client demo', 'before demo', 'before launch')
  if (m) return { date: null, raw: m }

  // Explicit ISO / dd-mm style date
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/)
  if (iso) return { date: iso[1], raw: iso[1] }

  return { date: null, raw: null }
}
