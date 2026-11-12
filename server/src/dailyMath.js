// The arithmetic of daily metrics tables (routes/dailyUpdates.js). The client
// has the same rules in client/src/components/chat/dailyMath.ts, so the form
// shows what the server will post: change one, change both.
//
// Lines starting with "|" are a table ("| AMAZON | 35 | 30 | ___ |"); its
// first line is the header, and a row whose first cell is *bold* is a bold or
// total row. Value slots in a cell:
//   ___              typed every day
//   {sum}            a total: the rows above it, up to the previous bold row
//   {sum:Row A;Row B} a total of those rows, by their first cell
//   {run:COLUMN}     a month total that adds itself up: the same cell of the
//                    previous post this month, plus this row's COLUMN today
//                    (CUMM SALES = last CUMM SALES + YESTERDAY)
// Every one of these can be typed over; an empty one is worked out.

// Every value slot, in the order the values array holds them.
export const SLOT = /_{3,}|\{sum(?::[^}\n]*)?\}|\{run:[^}\n]+\}/g

export const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
export const rowName = (cell) => String(cell || '').replace(/\*/g, '').trim().toLowerCase()
const numOf = (s) => { const t = String(s ?? '').replace(/[,₹\s]/g, ''); return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null }
const decimalsOf = (s) => { const m = /\.(\d+)/.exec(String(s ?? '').replace(/[,₹\s]/g, '')); return m ? m[1].length : 0 }
const fmt = (n, parts) => n.toFixed(Math.min(2, Math.max(0, ...parts.map(decimalsOf))))

// The tables in a template, each cell with the slots it holds.
// [{ head: [name], rows: [{ name, bold, cells: [{ text, slot, sum, run }] }] }]
// `slot`: the index of the cell's single value slot, or -1.
export function tablesOf(text) {
  const tables = []
  let cur = null
  let slot = 0
  for (const line of String(text || '').split('\n')) {
    if (!line.trim().startsWith('|')) { cur = null; slot += (line.match(SLOT) || []).length; continue }
    const cells = cellsOf(line).map((t) => {
      const toks = t.match(SLOT) || []
      const first = toks.length ? slot : -1
      slot += toks.length
      const one = toks.length === 1 ? toks[0] : ''
      return { text: t, slot: first, sum: one.startsWith('{sum') ? one : null, run: (/^\{run:(.+)\}$/.exec(one) || [])[1]?.trim() || null }
    })
    if (!cur) { cur = { head: cells.map((c) => rowName(c.text)), rows: [] }; tables.push(cur); continue }
    cur.rows.push({ name: rowName(cells[0]?.text), bold: /^\*.*\*$/.test(cells[0]?.text || ''), cells })
  }
  return tables
}

// "row|column" → the figure as typed (a number), for every filled slot of a posted card: what the
// next day's month totals add to. Keyed by names, so a row taken out or added
// since does not shift the others.
export function cellMap(text, values) {
  const out = {}
  for (const tb of tablesOf(text)) {
    for (const row of tb.rows) {
      row.cells.forEach((c, col) => {
        const v = c.slot >= 0 ? String(values?.[c.slot] ?? '').trim() : ''
        if (numOf(v) != null) out[`${row.name}|${tb.head[col]}`] = v
      })
    }
  }
  return out
}

// `values` with every empty month total ({run:…}) worked out from `prev` (a
// cellMap of the previous post this month). With no previous post, `fresh`
// says the month has just begun, so it starts from 0; otherwise it is left
// for the person to type once.
export function runsOf(text, values, prev = {}, fresh = false) {
  const out = values.slice()
  for (const tb of tablesOf(text)) {
    for (const row of tb.rows) {
      row.cells.forEach((c, col) => {
        if (!c.run || out[c.slot]) return
        const srcCol = tb.head.indexOf(rowName(c.run))
        const src = srcCol >= 0 ? row.cells[srcCol] : null
        const today = src ? (src.slot >= 0 ? out[src.slot] : src.text) : ''
        const was = prev[`${row.name}|${tb.head[col]}`]
        if (was == null && !fresh) return
        const add = numOf(today)
        if (add == null) { if (was != null) out[c.slot] = String(was); return }
        out[c.slot] = fmt((numOf(was) || 0) + add, [String(was ?? ''), String(today)])
      })
    }
  }
  return out
}

// `values` with every empty total ({sum…}) worked out. Totals are added after
// the month totals, so a total of month totals uses today's figures.
export function sumsOf(text, values) {
  const out = values.slice()
  for (const tb of tablesOf(text)) {
    tb.rows.forEach((row, r) => row.cells.forEach((c, col) => {
      if (!c.sum || out[c.slot]) return
      let from = []
      const names = /^\{sum:(.*)\}$/.exec(c.sum)
      if (names) {
        const want = names[1].split(';').map(rowName).filter(Boolean)
        from = tb.rows.filter((x) => want.includes(x.name))
      } else {
        for (let j = r - 1; j >= 0 && !tb.rows[j].bold; j--) from.push(tb.rows[j])
      }
      const parts = from.map((x) => x.cells[col]).filter(Boolean).map((x) => (x.slot >= 0 ? out[x.slot] : x.text))
      const nums = parts.map(numOf).filter((n) => n != null)
      if (nums.length) out[c.slot] = fmt(nums.reduce((a, b) => a + b, 0), parts)
    }))
  }
  return out
}

// Everything worked out: month totals first, then the totals over them.
export const computeAll = (text, values, prev, fresh) => sumsOf(text, runsOf(text, values, prev, fresh))

// ---- which month a running total belongs to ---------------------------------
// The figures are yesterday's, so the month is the one yesterday fell in: the
// card posted on 1 Dec still adds 30 Nov to November, and the one posted on
// 2 Dec starts December.
export const addDay = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
export const runMonth = (day) => addDay(day, -1).slice(0, 7)
// The first post day that belongs to `day`'s running month, and whether `day`
// is that first day (the month starts from 0).
export const runMonthStart = (day) => addDay(`${runMonth(day)}-01`, 1)
