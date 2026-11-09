import React, { useEffect, useState } from 'react'
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
// A target as typed in set-up: one number, or a range "6L-18L" / "3L to 6L".
// NaN when either end is not a number.
export function parseTarget(raw: string): { target: number | null; stretch: number | null } | null {
  const r = /^\s*(\S.*?)\s*(?:-|–|to)\s*(\S.*)$/i.exec(raw || '')
  const target = parseAmount(r ? r[1] : raw)
  const stretch = r ? parseAmount(r[2]) : null
  if (Number.isNaN(target) || Number.isNaN(stretch)) return null
  return { target, stretch }
}
// A number put back in a box to be edited: the short form only when it reads
// back as exactly the same number, since 3,39,398 shown as 3.39L would be
// saved as 3,39,000.
const forInput = (n: number | null | undefined) => {
  if (n == null || !Number.isFinite(n)) return ''
  const short = fmtAmount(n)
  return parseAmount(short) === n ? short : String(n)
}
// ₹ goes in front; any other unit (pcs, leads) after.
const withUnit = (n: number | null | undefined, unit: string) =>
  unit === '₹' ? `₹${fmtAmount(n)}` : `${fmtAmount(n)}${unit ? ' ' + unit : ''}`

// "₹6L–18L" for a range, "₹1.69L" for one number.
const targetLabel = (m: UpdateMetricDef) =>
  m.stretch ? `${withUnit(m.target, m.unit)}–${fmtAmount(m.stretch)}` : withUnit(m.target, m.unit)

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
                {m.target ? <span className="du-of"> / {targetLabel(m)}</span> : null}
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
const newRow = (): Draft => ({ id: Math.random().toString(36).slice(2, 10), label: '', target: '', unit: '', mode: 'daily' })
const WEEK = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const WEEK_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

interface Loaded { template: UpdateTemplate | null; last: UpdateMeta | null; last_id: string | null; last_base: Record<string, number | null>; day: string }

// `editId`: open on that posted card to correct it (only the latest can be).
export function UpdateSheet({ convId, editId = null, onClose, onPosted }: { convId: string; editId?: string | null; onClose: () => void; onPosted: () => void }) {
  const [d, setD] = useState<Loaded | null>(null)
  const [setup, setSetup] = useState(false)
  const [fixing, setFixing] = useState<string | null>(editId)
  useEffect(() => {
    api.get(`/chat/conversations/${convId}/update-template`)
      .then((r: any) => {
        if (editId && r.last_id !== editId) { toast.info('Only your latest update can be edited'); onClose(); return }
        setD(r); setSetup(!r.template)
      })
      .catch((e: any) => { toast.error(e.message || 'Could not open your daily update'); onClose() })
  }, [convId, editId])

  if (!d) return <Sheet label="Daily update" title="Daily update" onClose={onClose}><div className="du-loading"><span className="spinner" /></div></Sheet>
  if (setup) {
    return <SetupForm convId={convId} tpl={d.template} onClose={d.template ? () => setSetup(false) : onClose}
      onSaved={(t) => { setD({ ...d, template: t }); setSetup(false) }} onStopped={onClose} />
  }
  return <FillForm key={fixing || 'new'} convId={convId} data={d} editId={fixing} onSetup={() => setSetup(true)}
    onFixLast={() => setFixing(d.last_id)} onClose={onClose} onPosted={onPosted} />
}

function SetupForm({ convId, tpl, onClose, onSaved, onStopped }: {
  convId: string; tpl: UpdateTemplate | null; onClose: () => void; onSaved: (t: UpdateTemplate) => void; onStopped: () => void
}) {
  const [title, setTitle] = useState(tpl?.title || 'Daily update')
  const [rows, setRows] = useState<Draft[]>(() => tpl
    ? tpl.metrics.map((m) => ({ id: m.id, label: m.label, target: m.target ? forInput(m.target) + (m.stretch ? '-' + forInput(m.stretch) : '') : '', unit: m.unit, mode: m.mode }))
    : [newRow(), newRow()])
  const [remind, setRemind] = useState(!!tpl?.remind_at || !tpl)
  const [at, setAt] = useState(tpl?.remind_at || '18:00')
  const [days, setDays] = useState<number[]>(tpl?.remind_days?.length ? tpl.remind_days : [1, 2, 3, 4, 5, 6])
  const [busy, setBusy] = useState(false)
  const set = (i: number, patch: Partial<Draft>) => setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const used = rows.filter((r) => r.label.trim())
  const badTarget = used.find((r) => !parseTarget(r.target))
  const save = async () => {
    if (busy || !used.length || badTarget) return
    setBusy(true)
    try {
      const res: any = await api.put(`/chat/conversations/${convId}/update-template`, {
        title: title.trim() || 'Daily update',
        metrics: used.map((r) => ({ id: r.id, label: r.label.trim(), target: r.target.trim() || null, unit: r.unit.trim(), mode: r.mode })),
        remind_at: remind ? at : null,
        remind_days: days,
      })
      onSaved(res.template)
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
            <input className={'ta-input' + (!parseTarget(r.target) ? ' bad' : '')} placeholder="Monthly target, e.g. 1.69L or 6L-18L"
              aria-label={`${r.label || `Number ${i + 1}`} monthly target`} value={r.target} onChange={(e) => set(i, { target: e.target.value })} />
            <input className="ta-input du-unit" maxLength={10} placeholder="Unit" list="du-units" aria-label={`${r.label || `Number ${i + 1}`} unit`}
              value={r.unit} onChange={(e) => set(i, { unit: e.target.value })} />
          </div>
          <div className="du-mode" role="radiogroup" aria-label={`How you enter ${r.label || `number ${i + 1}`}`}>
            <button type="button" role="radio" aria-checked={r.mode === 'daily'} className={r.mode === 'daily' ? 'on' : ''} onClick={() => set(i, { mode: 'daily' })}>I enter today's, app adds up</button>
            <button type="button" role="radio" aria-checked={r.mode === 'total'} className={r.mode === 'total' ? 'on' : ''} onClick={() => set(i, { mode: 'total' })}>I enter the month's total</button>
          </div>
        </div>
      ))}
      <datalist id="du-units"><option value="₹" /><option value="pcs" /><option value="leads" /><option value="calls" /></datalist>
      {badTarget && <div className="pc-warn">"{badTarget.label}": write the target as a number or a range, like 1.69L, 100 or 6L-18L.</div>}
      {rows.length < 12 && <button type="button" className="btn btn-ghost btn-sm du-add" onClick={() => setRows((cur) => [...cur, newRow()])}><Ic name="plus" size={14} /> Add a number</button>}

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
      {tpl && <button type="button" className="du-stop" onClick={stop}>Stop daily updates in this chat</button>}
    </Sheet>
  )
}

// A new update starts empty: last time's numbers were left in the boxes, and
// every one had to be cleared before typing today's. What was there shows as a
// hint instead. Editing a posted update is the one case that starts filled in.
function FillForm({ convId, data, editId, onSetup, onFixLast, onClose, onPosted }: {
  convId: string; data: Loaded; editId: string | null; onSetup: () => void; onFixLast: () => void; onClose: () => void; onPosted: () => void
}) {
  const { template: tpl, last, day } = data
  const fixing = !!editId && !!last
  const postedToday = !!last && last.day === day
  // What the post is measured against: the month before it. A second post
  // today replaces the first, so it starts from the same place the first did.
  const base: Record<string, number | null> = fixing || postedToday ? data.last_base : (() => {
    const t: Record<string, number | null> = {}
    for (const m of last?.metrics || []) t[m.id] = m.total
    return t
  })()
  const metrics: UpdateMetricDef[] = fixing ? last!.metrics : tpl!.metrics
  const was: Record<string, UpdateMetric> = {}
  for (const m of last?.metrics || []) was[m.id] = m
  const [vals, setVals] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {}
    if (fixing) for (const m of last!.metrics) v[m.id] = forInput(m.value)
    return v
  })
  // A daily count's month, typed over what the app added up: a card started
  // mid-month, or a figure corrected from the CRM.
  const [fix, setFix] = useState<Record<string, string>>(() => {
    const f: Record<string, string> = {}
    if (fixing) {
      for (const m of last!.metrics) {
        if (m.mode !== 'daily' || m.total == null) continue
        const added = (base[m.id] || 0) + (m.value || 0)
        if (Math.abs(added - m.total) > 0.005) f[m.id] = forInput(m.total)
      }
    }
    return f
  })
  // The correction box opens on request; most days the added-up month is right.
  const [fixOpen, setFixOpen] = useState<Set<string>>(() => new Set(Object.keys(fix)))
  const [note, setNote] = useState(fixing ? last!.note || '' : '')
  const [busy, setBusy] = useState(false)
  const num = (s?: string) => parseAmount(s || '')
  const bad = metrics.find((m) => Number.isNaN(num(vals[m.id])) || Number.isNaN(num(fix[m.id])))
  const any = metrics.some((m) => num(vals[m.id]) != null) || !!note.trim()
  const post = async () => {
    if (busy || bad || !any) return
    setBusy(true)
    try {
      const values: Record<string, number | null> = {}
      const totals: Record<string, number> = {}
      for (const m of metrics) {
        values[m.id] = num(vals[m.id])
        const t = num(fix[m.id])
        if (m.mode === 'daily' && t != null) totals[m.id] = t
      }
      if (fixing) await api.put(`/chat/message/${editId}/update`, { values, totals, note: note.trim() })
      else await api.post(`/chat/conversations/${convId}/update`, { values, totals, note: note.trim() })
      onPosted()
    } catch (e: any) { toast.error(e.message || 'Could not post your update'); setBusy(false) }
  }
  const title = fixing ? last!.title : tpl!.title
  return (
    <Sheet label={title} title={<span className="du-sheet-title"><TrendGlyph size={17} /> {fixing ? `Edit ${title}` : title}</span>} onClose={onClose} className="du-sheet"
      foot={<>
        {!fixing ? <button className="btn btn-ghost" onClick={onSetup}><Ic name="edit" size={14} /> Edit card</button> : <span />}
        <button className="btn btn-primary" disabled={busy || !!bad || !any} onClick={post}>{busy ? 'Saving…' : fixing ? 'Save changes' : 'Post update'}</button>
      </>}>
      <div className="du-fill-day">{dayLabel(fixing ? last!.day : day)}</div>
      {!fixing && postedToday && (
        <div className="du-again">
          <span>You've posted today already. A new one replaces it in the month's totals.</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onFixLast}><Ic name="edit" size={13} /> Edit today's</button>
        </div>
      )}
      {metrics.map((m) => {
        const n = num(vals[m.id])
        const added = (base[m.id] || 0) + (Number.isFinite(n) ? (n as number) : 0)
        const prevTotal = was[m.id]?.total
        return (
          <div key={m.id} className="du-field">
            <label htmlFor={`du-${m.id}`}>
              <span className="du-field-name">{m.label}</span>
              <span className="du-field-hint">{m.mode === 'daily' ? 'Today' : 'This month so far'}{m.target ? ` · target ${targetLabel(m)}` : ''}</span>
            </label>
            <input id={`du-${m.id}`} className={'ta-input' + (Number.isNaN(n) ? ' bad' : '')} inputMode="decimal" enterKeyHint="next"
              placeholder={m.mode === 'daily' ? '0' : prevTotal != null && !fixing ? `Last: ${fmtAmount(prevTotal)} (empty keeps it)` : 'e.g. 45k'}
              value={vals[m.id] || ''} onChange={(e) => setVals((v) => ({ ...v, [m.id]: e.target.value }))} />
            {m.mode === 'daily' && (fixOpen.has(m.id) ? (
              <div className="du-month">
                <label htmlFor={`du-t-${m.id}`}>Month so far</label>
                <input id={`du-t-${m.id}`} className={'ta-input' + (Number.isNaN(num(fix[m.id])) ? ' bad' : '')} inputMode="decimal" autoFocus={!fixing}
                  placeholder={fmtAmount(added)} value={fix[m.id] || ''} onChange={(e) => setFix((f) => ({ ...f, [m.id]: e.target.value }))} />
              </div>
            ) : (
              <div className="du-month">
                <span>Month so far: {withUnit(added, m.unit)}</span>
                <button type="button" className="du-correct" onClick={() => setFixOpen((o) => new Set(o).add(m.id))}
                  aria-label={`Correct ${m.label} month so far`}>Correct</button>
              </div>
            ))}
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
