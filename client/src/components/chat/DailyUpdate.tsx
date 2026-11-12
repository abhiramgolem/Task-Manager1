import React, { useEffect, useRef, useState } from 'react'
import { api, userAvatarUrl } from '../../api'
import { Avatar, Ic } from '../../ui'
import { toast } from '../../lib/toast'
import { confirmDialog } from '../../lib/confirm'
import { Sheet } from './ChatDialogs'
import { TrendGlyph } from './glyphs'
import type { UpdateMeta, UpdateTemplate } from './types'
import { fmtTime } from './types'

// The daily metrics card (server: routes/dailyUpdates.js). Team members post
// the same message every day with new numbers, and used to copy yesterday's
// and edit it by hand. Here the message is kept as a template, with ___ where
// a number goes, {month} for the month (filled in by the app) and {date} for
// a date they pick; each day they only type the blanks.

const TOKEN = /(_{3,}|\{month\}|\{date\})/
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dateLabel = (ymd?: string | null) => (ymd ? `${Number(ymd.slice(8, 10))} ${MON[Number(ymd.slice(5, 7)) - 1]}` : '')
const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const blanksIn = (text: string) => (text.match(/_{3,}/g) || []).length

// Plain text with WhatsApp-style *bold*, as the team writes headings.
function Rich({ text }: { text: string }) {
  const parts = text.split(/\*([^*\n]+)\*/)
  return <>{parts.map((p, i) => (i % 2 ? <b key={i}>{p}</b> : p))}</>
}

// The template line by line: `blank(i)` draws the i-th blank (a value on the
// card, an input on the form).
function Lines({ text, month, date, blank }: { text: string; month: string; date: string; blank: (i: number) => React.ReactNode }) {
  let n = 0
  return (
    <div className="du-text">
      {text.split('\n').map((line, li) => (
        <div key={li} className="du-tline">
          {line ? line.split(TOKEN).map((seg, si) => {
            if (si % 2 === 0) return <Rich key={si} text={seg} />
            if (seg === '{month}') return <span key={si}>{month}</span>
            if (seg === '{date}') return <span key={si}>{date}</span>
            const i = n++
            return <React.Fragment key={si}>{blank(i)}</React.Fragment>
          }) : ' '}
        </div>
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
      <label className="ta-label" htmlFor="du-body">Your daily message</label>
      <textarea id="du-body" ref={box} className="ta-input du-body-in" rows={9} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)}
        placeholder={'Leads for Dcal B2C = ___\nSales target for {month} = ___/___\nJunk leads = ___'} />
      <div className="du-tokens">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => insert('___')}>+ Blank</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => insert('{month}')} title="Filled in with the current month">+ Month</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => insert('{date}')} title="You pick the date when posting">+ Date</button>
        <span className="du-count">{blanks === 1 ? '1 blank' : `${blanks} blanks`}</span>
      </div>
      {!blanks && body.trim() && <div className="pc-warn">Put ___ where you type a number each day.</div>}

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
  const [vals, setVals] = useState<string[]>(() => Array.from({ length: n }, (_, i) => edit?.values?.[i] || ''))
  const [date, setDate] = useState(edit?.date || data.day)
  const [note, setNote] = useState(edit?.note || '')
  const [busy, setBusy] = useState(false)
  const withDate = text.includes('{date}')
  const any = vals.some((v) => v.trim()) || !!note.trim()
  const post = async () => {
    if (busy || !any) return
    setBusy(true)
    try {
      const payload = { values: vals.map((v) => v.trim()), note: note.trim(), date: withDate ? date : null }
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
        <Lines text={text} month={month} date={dateLabel(date)} blank={(i) => (
          <input className="du-blank" inputMode="text" enterKeyHint="next" aria-label={`Blank ${i + 1}`} maxLength={30}
            size={Math.max(3, Math.min(14, (vals[i] || hint[i] || '').length + 1))}
            placeholder={hint[i] && hint[i] !== '-' ? hint[i] : ''} value={vals[i] || ''}
            onChange={(e) => setVals((v) => v.map((x, j) => (j === i ? e.target.value : x)))} />
        )} />
      </div>
      {hint.length > 0 && <div className="du-hint">Faint numbers are from your last update.</div>}
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
