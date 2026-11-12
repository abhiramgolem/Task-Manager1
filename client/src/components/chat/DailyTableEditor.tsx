import React from 'react'
import { Ic } from '../../ui'

// Editing a daily metrics card that is a table (DailyUpdate.tsx), as a grid of
// boxes instead of the "| AMAZON | 35 | ___ |" text it is saved as. Columns
// are either fixed (targets: typed here, the same every day) or daily (a box
// filled in each day). Rows are a plain row, a bold row (still filled in), or
// a total, whose daily cells add up the rows above it or the rows chosen.

export const cellsOf = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
const bold = (s: string) => /^\*.*\*$/.test(s)
const unbold = (s: string) => s.replace(/^\*(.*)\*$/, '$1').trim()

export type RowKind = 'row' | 'bold' | 'total'
export interface GridRow { key: string; name: string; kind: RowKind; cells: string[]; adds: string[] }
export interface Grid { head: string[]; daily: boolean[]; rows: GridRow[] }

// What a cell may hold: no "|" (it ends a cell); a row name also no ";" or
// "*", which mark totals.
const clean = (s: string) => s.replace(/[|\n]/g, '')
const cleanName = (s: string) => s.replace(/[|;*\n]/g, '')
const key = () => Math.random().toString(36).slice(2, 9)
const SUM = /^\{sum(?::(.*))?\}$/

// The text back as a grid, or null when it is not one table the grid can
// show exactly (other lines around it, or a cell the grid has no box for):
// those are edited as text.
export function parseGrid(text: string): Grid | null {
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length < 2 || !lines.every((l) => l.trim().startsWith('|'))) return null
  const head = cellsOf(lines[0])
  const body = lines.slice(1).map(cellsOf)
  if (body.some((c) => c.length !== head.length)) return null
  const daily = head.map((_, col) => col > 0 && body.some((c) => c[col] === '___' || SUM.test(c[col])))
  const rows: GridRow[] = body.map((c) => {
    const sums = c.filter((x, col) => daily[col] && SUM.test(x))
    const kind: RowKind = sums.length ? 'total' : bold(c[0]) ? 'bold' : 'row'
    const named = sums.map((x) => SUM.exec(x)![1] || '')
    return {
      key: key(), name: unbold(c[0]), kind,
      cells: c.map((x, col) => (col === 0 || daily[col] ? '' : x)),
      adds: named[0] ? named[0].split(';').map((s) => s.trim()).filter(Boolean) : [],
    }
  })
  const g = { head, daily, rows }
  return gridText(g) === lines.join('\n').split('\n').map((l) => `| ${cellsOf(l).join(' | ')} |`).join('\n') ? g : null
}

export function gridText(g: Grid): string {
  const line = (cells: string[]) => `| ${cells.join(' | ')} |`
  return [line(g.head), ...g.rows.map((r) => line(g.head.map((_, col) => {
    if (col === 0) return r.kind === 'row' ? r.name : `*${r.name}*`
    if (!g.daily[col]) return r.cells[col] || ''
    if (r.kind !== 'total') return '___'
    return r.adds.length ? `{sum:${r.adds.join(';')}}` : '{sum}'
  })))].join('\n')
}

// A fresh sheet for someone starting one: two daily columns, two rows.
export const newGrid = (): Grid => ({
  head: ['CATEGORY', 'TARGET', 'MONTH SO FAR', 'YESTERDAY'], daily: [false, false, true, true],
  rows: [
    { key: key(), name: 'Item 1', kind: 'row', cells: ['', '', '', ''], adds: [] },
    { key: key(), name: 'Item 2', kind: 'row', cells: ['', '', '', ''], adds: [] },
    { key: key(), name: 'TOTAL', kind: 'total', cells: ['', '', '', ''], adds: [] },
  ],
})

export function TableEditor({ grid, onChange }: { grid: Grid; onChange: (g: Grid) => void }) {
  const set = (patch: Partial<Grid>) => onChange({ ...grid, ...patch })
  const setRow = (i: number, patch: Partial<GridRow>) => set({ rows: grid.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  const move = (i: number, by: number) => {
    const rows = grid.rows.slice(); const j = i + by
    if (j < 0 || j >= rows.length) return
    ;[rows[i], rows[j]] = [rows[j], rows[i]]; set({ rows })
  }
  const addCol = () => set({ head: [...grid.head, 'NEW'], daily: [...grid.daily, false], rows: grid.rows.map((r) => ({ ...r, cells: [...r.cells, ''] })) })
  const dropCol = (col: number) => set({
    head: grid.head.filter((_, c) => c !== col), daily: grid.daily.filter((_, c) => c !== col),
    rows: grid.rows.map((r) => ({ ...r, cells: r.cells.filter((_, c) => c !== col) })),
  })
  const addRow = () => set({ rows: [...grid.rows, { key: key(), name: '', kind: 'row', cells: grid.head.map(() => ''), adds: [] }] })
  const names = grid.rows.map((r) => r.name.trim()).filter(Boolean)
  // Totals whose row list is open: the list is long, so it opens on request
  // (or by itself for a total that already picks rows).
  const [picking, setPicking] = React.useState<Set<string>>(() => new Set())
  return (
    <div className="dte">
      <div className="du-table-wrap">
        <table className="du-table dte-table">
          <thead>
            <tr>
              <td />
              {grid.head.map((h, col) => (
                <td key={col}>
                  <input className="dte-in dte-h" value={h} size={Math.max(5, Math.min(16, h.length))} aria-label={`Column ${col + 1} name`} onChange={(e) => set({ head: grid.head.map((x, c) => (c === col ? clean(e.target.value) : x)) })} />
                  {col > 0 && (
                    <div className="dte-colopt">
                      <button type="button" className={'dte-kind' + (grid.daily[col] ? ' on' : '')} title="Daily: a box they fill in every day. Fixed: typed here, the same every day."
                        onClick={() => set({ daily: grid.daily.map((x, c) => (c === col ? !x : x)) })}>{grid.daily[col] ? 'Daily' : 'Fixed'}</button>
                      {grid.head.length > 2 && <button type="button" className="ic-btn dte-x" aria-label={`Remove column ${h}`} onClick={() => dropCol(col)}><Ic name="close" size={12} /></button>}
                    </div>
                  )}
                </td>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((r, i) => (
              <React.Fragment key={r.key}>
                <tr className={r.kind === 'row' ? '' : 'du-tot'}>
                  <td className="dte-rowopt">
                    <select className="dte-sel" value={r.kind} aria-label={`${r.name || 'Row'} type`} onChange={(e) => setRow(i, { kind: e.target.value as RowKind })}>
                      <option value="row">Row</option><option value="bold">Bold</option><option value="total">Total</option>
                    </select>
                    <button type="button" className="ic-btn dte-x" aria-label={`Move ${r.name || 'row'} up`} disabled={!i} onClick={() => move(i, -1)}><Ic name="chevronUp" size={12} /></button>
                    <button type="button" className="ic-btn dte-x" aria-label={`Remove ${r.name || 'row'}`} disabled={grid.rows.length <= 1}
                      onClick={() => set({ rows: grid.rows.filter((_, j) => j !== i) })}><Ic name="close" size={12} /></button>
                  </td>
                  {grid.head.map((_, col) => (
                    <td key={col} className={col ? 'num' : ''}>
                      {col === 0 ? <input className="dte-in dte-name" value={r.name} placeholder="Name" size={Math.max(8, Math.min(24, r.name.length + 1))} aria-label={`Row ${i + 1} name`} onChange={(e) => setRow(i, { name: cleanName(e.target.value) })} />
                        : grid.daily[col] ? <span className={'dte-slot' + (r.kind === 'total' ? ' auto' : '')}>{r.kind === 'total' ? 'auto' : 'daily'}</span>
                        : <input className="dte-in dte-num" value={r.cells[col] || ''} aria-label={`${r.name || `Row ${i + 1}`} ${grid.head[col]}`} inputMode="decimal"
                            onChange={(e) => setRow(i, { cells: r.cells.map((x, c) => (c === col ? clean(e.target.value) : x)) })} />}
                    </td>
                  ))}
                </tr>
                {r.kind === 'total' && (
                  <tr className="dte-adds-row">
                    <td />
                    <td colSpan={grid.head.length}>
                      <div className="dte-adds">
                        <span>Adds up:</span>
                        {picking.has(r.key) ? (
                          <>
                            <button type="button" className={'dte-chip' + (!r.adds.length ? ' on' : '')} title="The rows above it, up to the last bold or total row"
                              onClick={() => setRow(i, { adds: [] })}>Rows above</button>
                            {names.filter((n) => n !== r.name.trim()).map((n) => {
                              const on = r.adds.some((a) => a.toLowerCase() === n.toLowerCase())
                              return <button key={n} type="button" className={'dte-chip' + (on ? ' on' : '')}
                                onClick={() => setRow(i, { adds: on ? r.adds.filter((a) => a.toLowerCase() !== n.toLowerCase()) : [...r.adds, n] })}>{n}</button>
                            })}
                            <button type="button" className="du-switch" onClick={() => setPicking((p) => { const s = new Set(p); s.delete(r.key); return s })}>Done</button>
                          </>
                        ) : (
                          <>
                            {r.adds.length ? r.adds.map((a) => <span key={a} className="dte-chip on">{a}</span>) : <span className="dte-chip on">Rows above</span>}
                            <button type="button" className="du-switch" onClick={() => setPicking((p) => new Set(p).add(r.key))}>Change</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="du-tokens">
        <button type="button" className="btn btn-ghost btn-sm" onClick={addRow}><Ic name="plus" size={13} /> Row</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={addCol}><Ic name="plus" size={13} /> Column</button>
      </div>
      <p className="du-hint">Fixed columns (targets) are typed here. Daily columns are boxes filled in each day. A Total row adds up the rows above it, or the rows you pick.</p>
    </div>
  )
}
