// The arithmetic of daily metrics tables, as the server does it
// (server/src/dailyMath.js): change one, change both. The form uses it to show,
// as people type, what the posted card will say.
//
// In a table ("| ... |" lines, the first the header; a *bold* first cell makes
// a bold or total row), a cell's value slot is one of:
//   ___               typed every day
//   {sum}             a total of the rows above, up to the previous bold row
//   {sum:Row A;Row B} a total of those rows
//   {run:COLUMN}      a month total: the previous post's figure plus this row's
//                     COLUMN today (CUMM SALES = last CUMM SALES + YESTERDAY)

export const SLOT_G = /_{3,}|\{sum(?::[^}\n]*)?\}|\{run:[^}\n]+\}/g
export const TOKEN = /(_{3,}|\{sum(?::[^}\n]*)?\}|\{run:[^}\n]+\}|\{month\}|\{date\})/
// A slot the form fills in by itself (and that can be typed over).
export const isAuto = (tok: string) => tok.startsWith('{sum') || tok.startsWith('{run:')
export const slotsIn = (text: string) => text.match(SLOT_G) || []

export const cellsOf = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
export const rowName = (cell?: string) => String(cell || '').replace(/\*/g, '').trim().toLowerCase()
export const isBoldRow = (cells: string[]) => /^\*.*\*$/.test(cells[0] || '')
const numOf = (s?: string) => { const t = String(s ?? '').replace(/[,₹\s]/g, ''); return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null }
const decimalsOf = (s?: string) => { const m = /\.(\d+)/.exec(String(s ?? '').replace(/[,₹\s]/g, '')); return m ? m[1].length : 0 }
const fmt = (n: number, parts: string[]) => n.toFixed(Math.min(2, Math.max(0, ...parts.map(decimalsOf))))

interface Cell { text: string; slot: number; sum: string | null; run: string | null }
interface Row { name: string; bold: boolean; cells: Cell[] }
interface Table { head: string[]; rows: Row[] }

export function tablesOf(text: string): Table[] {
  const tables: Table[] = []
  let cur: Table | null = null
  let slot = 0
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) { cur = null; slot += slotsIn(line).length; continue }
    const cells = cellsOf(line).map((t): Cell => {
      const toks = t.match(SLOT_G) || []
      const first = toks.length ? slot : -1
      slot += toks.length
      const one = toks.length === 1 ? toks[0] : ''
      return { text: t, slot: first, sum: one.startsWith('{sum') ? one : null, run: (/^\{run:(.+)\}$/.exec(one) || [])[1]?.trim() || null }
    })
    if (!cur) { cur = { head: cells.map((c) => rowName(c.text)), rows: [] }; tables.push(cur); continue }
    cur.rows.push({ name: rowName(cells[0]?.text), bold: isBoldRow(cells.map((c) => c.text)), cells })
  }
  return tables
}

export function runsOf(text: string, values: string[], prev: Record<string, string | number> = {}, fresh = false): string[] {
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
        out[c.slot] = fmt((numOf(String(was ?? '')) || 0) + add, [String(was ?? ''), String(today)])
      })
    }
  }
  return out
}

export function sumsOf(text: string, values: string[]): string[] {
  const out = values.slice()
  for (const tb of tablesOf(text)) {
    tb.rows.forEach((row, r) => row.cells.forEach((c, col) => {
      if (!c.sum || out[c.slot]) return
      let from: Row[] = []
      const names = /^\{sum:(.*)\}$/.exec(c.sum)
      if (names) {
        const want = names[1].split(';').map(rowName).filter(Boolean)
        from = tb.rows.filter((x) => want.includes(x.name))
      } else {
        for (let j = r - 1; j >= 0 && !tb.rows[j].bold; j--) from.push(tb.rows[j])
      }
      const parts = from.map((x) => x.cells[col]).filter(Boolean).map((x) => (x.slot >= 0 ? out[x.slot] : x.text))
      const nums = parts.map(numOf).filter((n): n is number => n != null)
      if (nums.length) out[c.slot] = fmt(nums.reduce((a, b) => a + b, 0), parts)
    }))
  }
  return out
}

export const computeAll = (text: string, values: string[], prev: Record<string, string | number> = {}, fresh = false) =>
  sumsOf(text, runsOf(text, values, prev, fresh))
