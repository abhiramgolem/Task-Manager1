import React, { useEffect, useMemo, useState } from 'react'
import { api, userAvatarUrl } from '../../api'
import { Avatar, Ic } from '../../ui'
import { toast } from '../../lib/toast'
import { confirmDialog } from '../../lib/confirm'
import { Sheet } from './ChatDialogs'
import { TrendGlyph } from './glyphs'
import type { UpdateMeta, UpdateMetric, UpdateMetricDef, UpdateTemplate } from './types'
import { fmtTime } from './types'

// The daily update card (server: routes/dailyUpdates.js). Team members used to
// post the same few numbers every day as free text, copied from yesterday and
// edited. Here each person sets up their own card once (what they report,
// their targets, when to be reminded) and from then on only types the numbers.

// ---- numbers as people write them: 45k, 1.69L, 2cr, 45,000 ------------------
// Same rules as the server's parseAmount; NaN for anything else.
const MULT: Record<string, number> = {
  k: 1e3, thousand: 1e3, l: 1e5, lac: 1e5, lacs: 1e5, lakh: 1e5, lakhs: 1e5,
  cr: 1e7, crore: 1e7, crores: 1e7, m: 1e6, mn: 1e6, million: 1e6,
}
export function parseAmount(raw: string): number | null {
  const s = String(raw ?? '').toLowerCase().replace(/,/g, '').replace(/₹|\brs\.?|\binr\b/g, '').trim()
  if (!s) return null
  const m = /^(-?\d+(?:\.\d+)?)\s*([a-z]+)?$/.exec(s)
  if (!m) return NaN
  const mult = m[2] ? MULT[m[2]] : 1
  if (!mult) return NaN
  return Math.round(Number(m[1]) * mult * 100) / 100
}
export function fmtAmount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  const t = (x: number) => String(Number(x.toFixed(2)))
  if (a >= 1e7) return `${sign}${t(a / 1e7)}Cr`
  if (a >= 1e5) return `${sign}${t(a / 1e5)}L`
  if (a >= 1e3) return `${sign}${t(a / 1e3)}k`
  return sign + t(a)
}
// ₹ goes in front; any other unit (pcs, leads) after.
const withUnit = (n: number | null | undefined, unit: string) =>
  unit === '₹' ? `₹${fmtAmount(n)}` : `${fmtAmount(n)}${unit ? ' ' + unit : ''}`

const daysInMonth = (day: string) => { const [y, m] = day.split('-').map(Number); return new Date(y, m, 0).getDate() }
const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

// Where a month-to-date number should be by this day if it is to reach its
// target, spread evenly over the month.
function pace(m: UpdateMetric, day: string) {
  if (!m.target || m.total == null) return null
  const pct = Math.round((m.total / m.target) * 100)
  const d = Number(day.slice(8, 10))
  const due = (m.target * d) / daysInMonth(day)
  const duePct = Math.min(100, (due / m.target) * 100)
  if (m.total >= m.target) return { pct, duePct, tone: 'good', text: 'Target reached' }
  if (m.total >= due) return { pct, duePct, tone: 'good', text: 'On pace' }
  return { pct, duePct, tone: 'behind', text: `Behind pace by ${withUnit(due - m.total, m.unit)}` }
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
      {update.metrics.map((m) => {
        const p = pace(m, update.day)
        return (
          <div key={m.id} className="du-row">
            <div className="du-line">
              <span className="du-label">{m.label}</span>
              <span className="du-val">
                {withUnit(m.total, m.unit)}
                {m.target ? <span className="du-of"> / {withUnit(m.target, m.unit)}</span> : null}
              </span>
            </div>
            {m.mode === 'daily' && m.value != null && <div className="du-today">+{withUnit(m.value, m.unit)} today</div>}
            {p && (
              <>
                <div className="du-bar" role="img" aria-label={`${p.pct}% of target, ${p.text}`}>
                  <span className={p.tone} style={{ width: `${Math.min(100, p.pct)}%` }} />
                  <i style={{ left: `${p.duePct}%` }} />
                </div>
                <div className={'du-sub ' + p.tone}>{p.pct}% · {p.text}</div>
              </>
            )}
          </div>
        )
      })}
      {update.note && <div className="du-note">{update.note}</div>}
    </div>
  )
}

// ---- set up / fill in ---------------------------------------------------------------
type Draft = { id: string; label: string; target: string; unit: string; mode: 'total' | 'daily' }
const newRow = (): Draft => ({ id: Math.random().toString(36).slice(2, 10), label: '', target: '', unit: '', mode: 'total' })
const WEEK = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const WEEK_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function UpdateSheet({ convId, onClose, onPosted }: { convId: string; onClose: () => void; onPosted: () => void }) {
  const [loaded, setLoaded] = useState(false)
  const [tpl, setTpl] = useState<UpdateTemplate | null>(null)
  const [last, setLast] = useState<UpdateMeta | null>(null)
  const [day, setDay] = useState('')
  const [editing, setEditing] = useState(false)
  const load = () => api.get(`/chat/conversations/${convId}/update-template`)
    .then((d: any) => { setTpl(d.template); setLast(d.last); setDay(d.day); setEditing(!d.template); setLoaded(true) })
    .catch((e: any) => { toast.error(e.message || 'Could not open your daily update'); onClose() })
  useEffect(() => { load() }, [convId])

  if (!loaded) return <Sheet label="Daily update" title="Daily update" onClose={onClose}><div className="du-loading"><span className="spinner" /></div></Sheet>
  if (editing) {
    return <SetupForm convId={convId} tpl={tpl} onClose={tpl ? () => setEditing(false) : onClose}
      onSaved={(t) => { setTpl(t); setEditing(false) }} onStopped={onClose} />
  }
  return <FillForm convId={convId} tpl={tpl!} last={last} day={day} onEdit={() => setEditing(true)} onClose={onClose} onPosted={onPosted} />
}

function SetupForm({ convId, tpl, onClose, onSaved, onStopped }: {
  convId: string; tpl: UpdateTemplate | null; onClose: () => void; onSaved: (t: UpdateTemplate) => void; onStopped: () => void
}) {
  const [title, setTitle] = useState(tpl?.title || 'Daily update')
  const [rows, setRows] = useState<Draft[]>(() => tpl
    ? tpl.metrics.map((m) => ({ id: m.id, label: m.label, target: m.target ? fmtAmount(m.target) : '', unit: m.unit, mode: m.mode }))
    : [newRow(), newRow()])
  const [remind, setRemind] = useState(!!tpl?.remind_at || !tpl)
  const [at, setAt] = useState(tpl?.remind_at || '18:00')
  const [days, setDays] = useState<number[]>(tpl?.remind_days?.length ? tpl.remind_days : [1, 2, 3, 4, 5, 6])
  const [busy, setBusy] = useState(false)
  const set = (i: number, patch: Partial<Draft>) => setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const used = rows.filter((r) => r.label.trim())
  const badTarget = used.find((r) => Number.isNaN(parseAmount(r.target)))
  const save = async () => {
    if (busy || !used.length || badTarget) return
    setBusy(true)
    try {
      const d: any = await api.put(`/chat/conversations/${convId}/update-template`, {
        title: title.trim() || 'Daily update',
        metrics: used.map((r) => ({ id: r.id, label: r.label.trim(), target: r.target.trim() || null, unit: r.unit.trim(), mode: r.mode })),
        remind_at: remind ? at : null,
        remind_days: days,
      })
      onSaved(d.template)
    } catch (e: any) { toast.error(e.message || 'Could not save your card'); setBusy(false) }
  }
  const stop = async () => {
    const yes = await confirmDialog({
      title: 'Stop daily updates in this chat?',
      message: "Your card and its reminder go. The updates you've already posted stay in the chat.",
      confirmText: 'Stop', cancelText: 'Keep', danger: true,
    })
    if (!yes) return
    try { await api.del(`/chat/conversations/${convId}/update-template`); toast.success('Daily updates stopped here'); onStopped() }
    catch (e: any) { toast.error(e.message || 'Could not stop them') }
  }
  return (
    <Sheet label="Set up your daily update" title={tpl ? 'Edit your card' : 'Set up your daily update'} onClose={onClose} className="du-sheet"
      foot={<button className="btn btn-primary" disabled={busy || !used.length || !!badTarget} onClick={save}>{busy ? 'Saving…' : tpl ? 'Save card' : 'Save and fill in'}</button>}>
      {!tpl && <p className="du-intro">Set this up once. After that you only type today's numbers, and the card adds up the month and shows how close each one is to its target.</p>}
      <label className="ta-label" htmlFor="du-title">Card name</label>
      <input id="du-title" className="ta-input" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Daily update" />
      <div className="ta-label">What you report</div>
      {rows.map((r, i) => (
        <div key={r.id} className="du-def">
          <div className="du-def-top">
            <input className="ta-input" maxLength={40} placeholder={i === 0 ? 'e.g. Sales' : i === 1 ? 'e.g. Reviews received' : 'Name'} value={r.label}
              aria-label={`Number ${i + 1} name`} onChange={(e) => set(i, { label: e.target.value })} />
            <button className="ic-btn" aria-label={`Remove ${r.label || `number ${i + 1}`}`} disabled={rows.length <= 1}
              onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}><Ic name="close" size={14} /></button>
          </div>
          <div className="du-def-more">
            <input className={'ta-input' + (Number.isNaN(parseAmount(r.target)) ? ' bad' : '')} inputMode="decimal" placeholder="Monthly target (optional)"
              aria-label={`${r.label || `Number ${i + 1}`} monthly target`} value={r.target} onChange={(e) => set(i, { target: e.target.value })} />
            <input className="ta-input du-unit" maxLength={10} placeholder="Unit" list="du-units" aria-label={`${r.label || `Number ${i + 1}`} unit`}
              value={r.unit} onChange={(e) => set(i, { unit: e.target.value })} />
          </div>
          <div className="du-mode" role="radiogroup" aria-label={`How you enter ${r.label || `number ${i + 1}`}`}>
            <button type="button" role="radio" aria-checked={r.mode === 'total'} className={r.mode === 'total' ? 'on' : ''} onClick={() => set(i, { mode: 'total' })}>I enter the month's total</button>
            <button type="button" role="radio" aria-checked={r.mode === 'daily'} className={r.mode === 'daily' ? 'on' : ''} onClick={() => set(i, { mode: 'daily' })}>I enter today's, app adds up</button>
          </div>
        </div>
      ))}
      <datalist id="du-units"><option value="₹" /><option value="pcs" /><option value="leads" /><option value="calls" /></datalist>
      {badTarget && <div className="pc-warn">"{badTarget.label}": write the target as a number, like 1.69L, 45k or 100.</div>}
      {rows.length < 12 && <button type="button" className="btn btn-ghost btn-sm du-add" onClick={() => setRows((cur) => [...cur, newRow()])}><Ic name="plus" size={14} /> Add a number</button>}

      <label className="pc-multi du-remind">
        <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} />
        <span>Remind me if I haven't posted by</span>
        <input type="time" className="ta-input du-time" value={at} disabled={!remind} onChange={(e) => setAt(e.target.value)} aria-label="Reminder time" />
      </label>
      {remind && (
        <div className="du-days" role="group" aria-label="Days to remind me">
          {WEEK.map((w, d) => (
            <button key={d} type="button" aria-pressed={days.includes(d)} aria-label={WEEK_FULL[d]} className={days.includes(d) ? 'on' : ''}
              onClick={() => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()))}>{w}</button>
          ))}
        </div>
      )}
      {tpl && <button type="button" className="du-stop" onClick={stop}>Stop daily updates in this chat</button>}
    </Sheet>
  )
}

function FillForm({ convId, tpl, last, day, onEdit, onClose, onPosted }: {
  convId: string; tpl: UpdateTemplate; last: UpdateMeta | null; day: string; onEdit: () => void; onClose: () => void; onPosted: () => void
}) {
  const sameMonth = !!last && last.day.slice(0, 7) === day.slice(0, 7)
  const postedToday = !!last && last.day === day
  const prev = useMemo(() => {
    const by: Record<string, UpdateMetric> = {}
    if (sameMonth) for (const m of last!.metrics) by[m.id] = m
    return by
  }, [last, sameMonth])
  // A running total starts at its last figure, ready to be changed; today's
  // count starts empty (or at what was posted earlier today, if re-posting).
  const [vals, setVals] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {}
    for (const m of tpl.metrics) {
      const p = prev[m.id]
      if (m.mode === 'total') v[m.id] = p?.total != null ? fmtAmount(p.total) : ''
      else v[m.id] = postedToday && p?.value != null ? fmtAmount(p.value) : ''
    }
    return v
  })
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  // The month before today, for a daily count's running total.
  const baseOf = (m: UpdateMetricDef) => {
    const p = prev[m.id]
    if (!p) return 0
    return postedToday ? (p.total || 0) - (p.value || 0) : (p.total || 0)
  }
  const bad = tpl.metrics.find((m) => Number.isNaN(parseAmount(vals[m.id] || '')))
  const any = tpl.metrics.some((m) => parseAmount(vals[m.id] || '') != null) || !!note.trim()
  const post = async () => {
    if (busy || bad || !any) return
    setBusy(true)
    try {
      const values: Record<string, number | null> = {}
      for (const m of tpl.metrics) values[m.id] = parseAmount(vals[m.id] || '')
      await api.post(`/chat/conversations/${convId}/update`, { values, note: note.trim() })
      onPosted()
    } catch (e: any) { toast.error(e.message || 'Could not post your update'); setBusy(false) }
  }
  return (
    <Sheet label={tpl.title} title={<span className="du-sheet-title"><TrendGlyph size={17} /> {tpl.title}</span>} onClose={onClose} className="du-sheet"
      foot={<>
        <button className="btn btn-ghost" onClick={onEdit}><Ic name="edit" size={14} /> Edit card</button>
        <button className="btn btn-primary" disabled={busy || !!bad || !any} onClick={post}>{busy ? 'Posting…' : 'Post update'}</button>
      </>}>
      <div className="du-fill-day">{dayLabel(day)}</div>
      {postedToday && <div className="du-again">You've posted today already. This one replaces it in the month's totals.</div>}
      {tpl.metrics.map((m) => {
        const n = parseAmount(vals[m.id] || '')
        const total = m.mode === 'daily' ? baseOf(m) + (Number.isFinite(n) ? (n as number) : 0) : n
        return (
          <div key={m.id} className="du-field">
            <label htmlFor={`du-${m.id}`}>
              <span className="du-field-name">{m.label}</span>
              <span className="du-field-hint">{m.mode === 'daily' ? 'Today' : 'This month so far'}{m.target ? ` · target ${withUnit(m.target, m.unit)}` : ''}</span>
            </label>
            <input id={`du-${m.id}`} className={'ta-input' + (Number.isNaN(n) ? ' bad' : '')} inputMode="decimal" enterKeyHint="next"
              placeholder={m.mode === 'daily' ? '0' : prev[m.id]?.total != null ? fmtAmount(prev[m.id].total) : 'e.g. 45k'}
              value={vals[m.id] || ''} onChange={(e) => setVals((v) => ({ ...v, [m.id]: e.target.value }))} />
            {m.mode === 'daily' && Number.isFinite(total) && (n != null || baseOf(m) > 0) && (
              <div className="du-field-total">Month: {withUnit(total as number, m.unit)}{m.target ? ` of ${withUnit(m.target, m.unit)}` : ''}</div>
            )}
          </div>
        )
      })}
      {bad && <div className="pc-warn">"{bad.label}": write a number, like 45k, 1.69L or 12.</div>}
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
          <span>Daily updates: <b>{posted.length} of {people.length}</b> posted today</span>
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
