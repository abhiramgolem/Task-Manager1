import React, { useEffect, useRef, useState } from 'react'
import { api, userAvatarUrl } from '../../api'
import { Avatar, Ic } from '../../ui'
import { toast } from '../../lib/toast'
import { confirmDialog } from '../../lib/confirm'
import { Sheet } from './ChatDialogs'
import { TrendGlyph } from './glyphs'
import { TableEditor, parseGrid, gridText, newGrid, cellsOf, type Grid } from './DailyTableEditor'
import type { UpdateMeta, UpdateTemplate } from './types'
import { fmtTime } from './types'

// The daily metrics card (server: routes/dailyUpdates.js). Team members post
// the same message every day with new numbers, and used to copy yesterday's
// and edit it by hand. Here the message is kept as a template, with ___ where
// a number goes, {month} for the month (filled in by the app) and {date} for
// a date they pick; each day they only type the blanks.

// A value slot is a typed blank (___) or a table total ({sum}, {sum:Row;Row})
// that the form adds up and the person may type over.
const SLOT_G = /_{3,}|\{sum(?::[^}\n]*)?\}/g
const TOKEN = /(_{3,}|\{sum(?::[^}\n]*)?\}|\{month\}|\{date\})/
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dateLabel = (ymd?: string | null) => (ymd ? `${Number(ymd.slice(8, 10))} ${MON[Number(ymd.slice(5, 7)) - 1]}` : '')
const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const blanksIn = (text: string) => (text.match(SLOT_G) || []).length
const isSum = (seg: string) => seg.startsWith('{sum')

// ---- tables and totals: same rules as the server's sumsOf (dailyUpdates.js) ----
// Lines starting with "|" are a table; its first line the header, a row whose
// first cell is *bold* a total row. {sum} adds the rows above it up to the
// previous total row; {sum:A;B} the rows named A and B. Same column either way.
const rowName = (cell: string) => cell.replace(/\*/g, '').trim().toLowerCase()
const numOf = (s?: string) => { const t = String(s ?? '').replace(/[,₹\s]/g, ''); return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null }
const decimalsOf = (s?: string) => { const m = /\.(\d+)/.exec(String(s ?? '').replace(/[,₹\s]/g, '')); return m ? m[1].length : 0 }
const isTotalRow = (cells: string[]) => /^\*.*\*$/.test(cells[0] || '')

export function sumsOf(text: string, values: string[]): string[] {
  const out = values.slice()
  type Cell = { text: string; slots: number[]; sum: string | null }
  const tables: Cell[][][] = []
  let cur: Cell[][] | null = null
  let slot = 0
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) { cur = null; slot += (line.match(SLOT_G) || []).length; continue }
    if (!cur) { cur = []; tables.push(cur) }
    cur.push(cellsOf(line).map((t) => {
      const toks = t.match(SLOT_G) || []
      return { text: t, slots: toks.map(() => slot++), sum: toks.length === 1 && isSum(toks[0]) ? toks[0] : null }
    }))
  }
  const val = (c: Cell) => (c.slots.length ? out[c.slots[0]] : c.text)
  for (const rows of tables) {
    rows.forEach((row, r) => row.forEach((c, col) => {
      if (!c.sum || out[c.slots[0]]) return
      let from: Cell[][] = []
      const names = /^\{sum:(.*)\}$/.exec(c.sum)
      if (names) {
        const want = names[1].split(';').map(rowName).filter(Boolean)
        from = rows.filter((x, j) => j > 0 && want.includes(rowName(x[0]?.text || '')))
      } else {
        for (let j = r - 1; j >= 1 && !isTotalRow(rows[j].map((x) => x.text)); j--) from.push(rows[j])
      }
      const parts = from.map((x) => x[col]).filter(Boolean).map(val)
      const nums = parts.map(numOf).filter((n): n is number => n != null)
      if (!nums.length) return
      out[c.slots[0]] = nums.reduce((a, b) => a + b, 0).toFixed(Math.min(2, Math.max(0, ...parts.map(decimalsOf))))
    }))
  }
  return out
}

// Plain text with WhatsApp-style *bold*, as the team writes headings.
function Rich({ text }: { text: string }) {
  const parts = text.split(/\*([^*\n]+)\*/)
  return <>{parts.map((p, i) => (i % 2 ? <b key={i}>{p}</b> : p))}</>
}

// The template line by line, "|" lines as a table: `blank(i, total)` draws the
// i-th value slot (a value on the card, an input on the form).
function Lines({ text, month, date, blank }: { text: string; month: string; date: string; blank: (i: number, total: boolean) => React.ReactNode }) {
  let n = 0
  const segs = (s: string) => s.split(TOKEN).map((seg, si) => {
    if (si % 2 === 0) return <Rich key={si} text={seg} />
    if (seg === '{month}') return <span key={si}>{month}</span>
    if (seg === '{date}') return <span key={si}>{date}</span>
    const i = n++
    return <React.Fragment key={si}>{blank(i, isSum(seg))}</React.Fragment>
  })
  // Runs of table lines become one table each, in order with the other lines.
  const blocks: { table: boolean; lines: string[] }[] = []
  for (const line of text.split('\n')) {
    const table = line.trim().startsWith('|')
    const last = blocks[blocks.length - 1]
    if (table && last?.table) last.lines.push(line)
    else blocks.push({ table, lines: [line] })
  }
  return (
    <div className="du-text">
      {blocks.map((b, bi) => b.table ? (
        <div key={bi} className="du-table-wrap">
          <table className="du-table">
            <tbody>
              {b.lines.map((line, ri) => {
                const cells = cellsOf(line)
                const total = isTotalRow(cells)
                return (
                  <tr key={ri} className={ri === 0 ? 'du-th' : total ? 'du-tot' : ''}>
                    {cells.map((c, ci) => (
                      <td key={ci} className={ci ? 'num' : ''}>{segs(total && ci === 0 ? c.replace(/\*/g, '') : c)}</td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div key={bi} className="du-tline">{b.lines[0] ? segs(b.lines[0]) : ' '}</div>
      ))}
    </div>
  )
}

// A card posted before the text templates: its numbers as they were.
const fmtOld = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(n)) return '—'
  const a = Math.abs(n), t = (x: number) => String(Number(x.toFixed(2)))
  return (n < 0 ? '-' : '') + (a >= 1e7 ? `${t(a / 1e7)}Cr` : a >= 1e5 ? `${t(a / 1e5)}L` : a >= 1e3 ? `${t(a / 1e3)}k` : t(a))
}

// ---- the card in the thread ------------------------------------------------------
export function UpdateCard({ update }: { update: UpdateMeta }) {
  return (
    <div className="du-card">
      <div className="du-head">
        <span className="du-ic" aria-hidden="true"><TrendGlyph size={14} /></span>
        <span className="du-title">{update.title}</span>
        <span className="du-day">{dayLabel(update.day)}</span>
      </div>
      {typeof update.text === 'string' ? (
        <Lines text={update.text} month={update.month || ''} date={dateLabel(update.date)}
          blank={(i) => <b className="du-v">{update.values?.[i] || '-'}</b>} />
      ) : (
        <div className="du-text">
          {(update.metrics || []).map((m) => (
            <div key={m.id} className="du-tline">{m.label} = <b className="du-v">{m.unit === '₹' ? '₹' : ''}{fmtOld(m.total)}</b>{m.target ? ` / ${fmtOld(m.target)}` : ''}</div>
          ))}
        </div>
      )}
      {update.note && <div className="du-note">{update.note}</div>}
    </div>
  )
}

// ---- set up / fill in ---------------------------------------------------------------
const WEEK = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const WEEK_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

interface Loaded {
  template: UpdateTemplate | null; last: UpdateMeta | null; last_id: string | null; posted_today: boolean
  day: string; month: string; edit: (UpdateMeta & { id: string }) | null
}

// `editId`: open on that posted card to correct it.
export function UpdateSheet({ convId, editId = null, onClose, onPosted }: { convId: string; editId?: string | null; onClose: () => void; onPosted: () => void }) {
  const [d, setD] = useState<Loaded | null>(null)
  const [setup, setSetup] = useState(false)
  const [fixing, setFixing] = useState<string | null>(editId)
  useEffect(() => {
    api.get(`/chat/conversations/${convId}/update-template${fixing ? `?edit=${encodeURIComponent(fixing)}` : ''}`)
      .then((r: any) => { setD(r); setSetup(!r.template && !r.edit) })
      .catch((e: any) => { toast.error(e.message || 'Could not open your daily metrics'); onClose() })
  }, [convId, fixing])

  if (!d) return <Sheet label="Daily metrics" title="Daily metrics" onClose={onClose}><div className="du-loading"><span className="spinner" /></div></Sheet>
  if (setup) {
    return <SetupForm convId={convId} tpl={d.template} onClose={d.template ? () => setSetup(false) : onClose}
      onSaved={(t) => { setD({ ...d, template: t }); setSetup(false) }} onStopped={onClose} />
  }
  return <FillForm key={d.edit?.id || 'new'} convId={convId} data={d} onSetup={() => setSetup(true)}
    onFixLast={() => { setD(null); setFixing(d.last_id) }} onClose={onClose} onPosted={onPosted} />
}

function SetupForm({ convId, tpl, onClose, onSaved, onStopped }: {
  convId: string; tpl: UpdateTemplate | null; onClose: () => void; onSaved: (t: UpdateTemplate) => void; onStopped: () => void
}) {
  const [title, setTitle] = useState(tpl?.title || 'Daily metrics')
  const [body, setBody] = useState(tpl?.body || '')
  // A card that is one table is edited as a grid of boxes; anything else (or
  // on request) as text. The grid writes the same text the card is saved as.
  const [grid, setGrid] = useState<Grid | null>(() => (tpl?.body ? parseGrid(tpl.body) : null))
  const editGrid = (g: Grid) => { setGrid(g); setBody(gridText(g)) }
  const [remind, setRemind] = useState(!!tpl?.remind_at || !tpl)
  const [at, setAt] = useState(tpl?.remind_at || '11:00')
  const [days, setDays] = useState<number[]>(tpl?.remind_days?.length ? tpl.remind_days : [1, 2, 3, 4, 5, 6])
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const blanks = blanksIn(body)
  // Put a token where the cursor is, and leave the cursor after it.
  const insert = (tok: string) => {
    const el = box.current
    const s = el ? el.selectionStart : body.length, e = el ? el.selectionEnd : body.length
    setBody(body.slice(0, s) + tok + body.slice(e))
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(s + tok.length, s + tok.length) } })
  }
  const save = async () => {
    if (busy || !blanks) return
    setBusy(true)
    try {
      const res: any = await api.put(`/chat/conversations/${convId}/update-template`, {
        title: title.trim() || 'Daily metrics', body, remind_at: remind ? at : null, remind_days: days,
      })
      onSaved(res.template)
    } catch (e: any) { toast.error(e.message || 'Could not save your card'); setBusy(false) }
  }
  const stop = async () => {
    const yes = await confirmDialog({
      title: 'Stop daily metrics in this chat?',
      message: "Your card and its reminder go. The updates you've already posted stay in the chat.",
      confirmText: 'Stop', cancelText: 'Keep', danger: true,
    })
    if (!yes) return
    try { await api.del(`/chat/conversations/${convId}/update-template`); toast.success('Daily metrics stopped here'); onStopped() }
    catch (e: any) { toast.error(e.message || 'Could not stop them') }
  }
  return (
    <Sheet label="Set up your daily metrics" title={tpl ? 'Edit your card' : 'Set up your daily metrics'} onClose={onClose} className="du-sheet"
      foot={<button className="btn btn-primary" disabled={busy || !blanks} onClick={save}>{busy ? 'Saving…' : tpl ? 'Save card' : 'Save and fill in'}</button>}>
      {!tpl && <p className="du-intro">Paste the message you post every day, and put ___ where you type a number. After that you only fill in the numbers.</p>}
      <label className="ta-label" htmlFor="du-title">Card name</label>
      <input id="du-title" className="ta-input" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Daily metrics" />
      <div className="du-body-head">
        <label className="ta-label" htmlFor={grid ? undefined : 'du-body'}>{grid ? 'Your daily sheet' : 'Your daily message'}</label>
        {grid
          ? <button type="button" className="du-switch" onClick={() => setGrid(null)}>Edit as text</button>
          : parseGrid(body) ? <button type="button" className="du-switch" onClick={() => setGrid(parseGrid(body))}>Edit as table</button>
          : !body.trim() && <button type="button" className="du-switch" onClick={() => editGrid(newGrid())}>Start a table instead</button>}
      </div>
      {grid ? <TableEditor grid={grid} onChange={editGrid} /> : (
        <>
          <textarea id="du-body" ref={box} className="ta-input du-body-in" rows={9} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)}
            placeholder={'Leads for Dcal B2C = ___\nSales target for {month} = ___/___\nJunk leads = ___'} />
          <div className="du-tokens">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => insert('___')}>+ Blank</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => insert('{month}')} title="Filled in with the current month">+ Month</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => insert('{date}')} title="You pick the date when posting">+ Date</button>
            {body.includes('|') && <button type="button" className="btn btn-ghost btn-sm" onClick={() => insert('{sum}')} title="In a table's *total* row: adds up the rows above it">+ Total</button>}
            <span className="du-count">{blanks === 1 ? '1 blank' : `${blanks} blanks`}</span>
          </div>
        </>
      )}
      {!blanks && body.trim() && <div className="pc-warn">{grid ? 'Make at least one column Daily.' : 'Put ___ where you type a number each day.'}</div>}

      <label className="pc-multi du-remind">
        <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} />
        <span>Remind me if I haven't posted by</span>
        <input type="time" className="ta-input du-time" value={at} disabled={!remind} onChange={(e) => setAt(e.target.value)} aria-label="Reminder time" />
      </label>
      {remind && (
        <div className="du-days" role="group" aria-label="Days to remind me">
          {WEEK.map((w, dd) => (
            <button key={dd} type="button" aria-pressed={days.includes(dd)} aria-label={WEEK_FULL[dd]} className={days.includes(dd) ? 'on' : ''}
              onClick={() => setDays((cur) => (cur.includes(dd) ? cur.filter((x) => x !== dd) : [...cur, dd].sort()))}>{w}</button>
          ))}
        </div>
      )}
      {tpl && <button type="button" className="du-stop" onClick={stop}>Stop daily metrics in this chat</button>}
    </Sheet>
  )
}

// The message with a box in each blank. A new one starts empty, last time's
// numbers shown faintly in the boxes as a reminder; editing a posted one
// starts filled in.
function FillForm({ convId, data, onSetup, onFixLast, onClose, onPosted }: {
  convId: string; data: Loaded; onSetup: () => void; onFixLast: () => void; onClose: () => void; onPosted: () => void
}) {
  const { template: tpl, last, edit } = data
  const text = edit ? edit.text || '' : tpl!.body
  const month = edit ? edit.month || '' : data.month
  const n = blanksIn(text)
  const hint = !edit && last?.text === text ? last.values || [] : []
  // Which slots are totals: those fill themselves in from the rows they add.
  const totals = (text.match(SLOT_G) || []).map(isSum)
  // `vals` is what was typed; a total left empty shows its sum. Editing a
  // posted card, a total that still equals its sum goes back to adding itself.
  const [vals, setVals] = useState<string[]>(() => {
    const v = Array.from({ length: n }, (_, i) => edit?.values?.[i] || '')
    const typed = v.map((x, i) => (totals[i] ? '' : x))
    const auto = sumsOf(text, typed)
    return v.map((x, i) => (totals[i] && x === auto[i] ? '' : x))
  })
  const shown = sumsOf(text, vals.map((v) => v.trim()))
  const [date, setDate] = useState(edit?.date || data.day)
  const [note, setNote] = useState(edit?.note || '')
  const [busy, setBusy] = useState(false)
  const withDate = text.includes('{date}')
  const any = vals.some((v, i) => !totals[i] && v.trim()) || !!note.trim()
  const post = async () => {
    if (busy || !any) return
    setBusy(true)
    try {
      const payload = { values: shown, note: note.trim(), date: withDate ? date : null }
      if (edit) await api.put(`/chat/message/${edit.id}/update`, payload)
      else await api.post(`/chat/conversations/${convId}/update`, payload)
      onPosted()
    } catch (e: any) { toast.error(e.message || 'Could not post your update'); setBusy(false) }
  }
  const title = edit ? edit.title : tpl!.title
  return (
    <Sheet label={title} title={<span className="du-sheet-title"><TrendGlyph size={17} /> {edit ? `Edit ${title}` : title}</span>} onClose={onClose} className="du-sheet"
      foot={<>
        {!edit && tpl ? <button className="btn btn-ghost" onClick={onSetup}><Ic name="edit" size={14} /> Edit card</button> : <span />}
        <button className="btn btn-primary" disabled={busy || !any} onClick={post}>{busy ? 'Saving…' : edit ? 'Save changes' : 'Post update'}</button>
      </>}>
      <div className="du-fill-day">{dayLabel(edit ? edit.day : data.day)}</div>
      {!edit && data.posted_today && data.last_id && (
        <div className="du-again">
          <span>You've posted today already. Posting again adds another card.</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onFixLast}><Ic name="edit" size={13} /> Edit today's</button>
        </div>
      )}
      {withDate && (
        <label className="du-date">
          <span>Date</span>
          <input type="date" className="ta-input" value={date} onChange={(e) => setDate(e.target.value || data.day)} />
        </label>
      )}
      <div className="du-fill">
        <Lines text={text} month={month} date={dateLabel(date)} blank={(i, total) => {
          const auto = total && !vals[i]
          return (
            <input className={'du-blank' + (auto ? ' auto' : '')} inputMode={total ? 'decimal' : 'text'} enterKeyHint="next" maxLength={30}
              aria-label={total ? `Total ${i + 1}, added up for you` : `Blank ${i + 1}`}
              title={total ? 'Added up for you. Type to change it; clear it to add up again.' : undefined}
              size={Math.max(3, Math.min(14, ((auto ? shown[i] : vals[i]) || hint[i] || '').length + 1))}
              placeholder={total ? '' : hint[i] && hint[i] !== '-' ? hint[i] : ''} value={(auto ? shown[i] : vals[i]) || ''}
              onChange={(e) => setVals((v) => v.map((x, j) => (j === i ? e.target.value : x)))} />
          )
        }} />
      </div>
      {hint.length > 0 && <div className="du-hint">Faint numbers are from your last update.</div>}
      {totals.some(Boolean) && <div className="du-hint">Totals add themselves up. Type over one to change it.</div>}
      <label className="ta-label" htmlFor="du-note">Note (optional)</label>
      <textarea id="du-note" className="ta-input du-note-in" rows={2} maxLength={1000} placeholder="Anything else today" value={note} onChange={(e) => setNote(e.target.value)} />
    </Sheet>
  )
}

// ---- who has posted today ------------------------------------------------------------
interface TodayPerson { user_id: string; name: string; avatar_color?: string; avatar_file?: string | null; posted: boolean; message_id: string | null; at: string | null }

// A line under the chat's header once anyone here has a card: how many have
// posted today, opening to the list. Hidden in chats where nobody reports.
export function TodayUpdates({ convId, refreshKey, meId, onFill, onOpen }: {
  convId: string; refreshKey: number; meId: string; onFill: () => void; onOpen: (messageId: string) => void
}) {
  const [people, setPeople] = useState<TodayPerson[]>([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let live = true
    api.get(`/chat/conversations/${convId}/updates/today`).then((d: any) => { if (live) setPeople(d.people || []) }).catch(() => {})
    return () => { live = false }
  }, [convId, refreshKey])
  useEffect(() => setOpen(false), [convId])
  if (!people.length) return null
  const posted = people.filter((p) => p.posted)
  const me = people.find((p) => p.user_id === meId)
  return (
    <div className="du-today-wrap">
      <div className="du-today-bar">
        <button className="du-today-main" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="du-ic" aria-hidden="true"><TrendGlyph size={13} /></span>
          <span>Daily metrics: <b>{posted.length} of {people.length}</b> posted today</span>
          <Ic name={open ? 'chevronUp' : 'chevronDown'} size={14} />
        </button>
        {me && !me.posted && <button className="btn btn-primary btn-sm" onClick={onFill}>Fill yours</button>}
      </div>
      {open && (
        <ul className="du-people">
          {[...posted.sort((a, b) => (a.at || '').localeCompare(b.at || '')), ...people.filter((p) => !p.posted)].map((p) => (
            <li key={p.user_id}>
              <button type="button" disabled={!p.posted} onClick={() => { if (p.message_id) { setOpen(false); onOpen(p.message_id) } }}>
                <Avatar name={p.name} color={p.avatar_color} size={24} src={p.avatar_file ? userAvatarUrl(p.user_id, p.avatar_file) : undefined} />
                <span className="du-person">{p.user_id === meId ? 'You' : p.name}</span>
                {p.posted
                  ? <span className="du-state ok"><Ic name="check" size={12} /> {p.at ? fmtTime(p.at) : 'Posted'}</span>
                  : <span className="du-state">Not yet</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
