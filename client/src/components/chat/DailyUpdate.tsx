import React, { useEffect, useRef, useState } from 'react'
import { api, userAvatarUrl } from '../../api'
import { Avatar, Ic } from '../../ui'
import { toast } from '../../lib/toast'
import { confirmDialog } from '../../lib/confirm'
import { Sheet } from './ChatDialogs'
import { TrendGlyph } from './glyphs'
import { TableEditor, parseGrid, gridText, newGrid, type Grid } from './DailyTableEditor'
import { TOKEN, SLOT_G, isAuto, slotsIn, cellsOf, isBoldRow, computeAll } from './dailyMath'
import type { UpdateMeta, UpdateTemplate } from './types'
import { fmtTime } from './types'

// The daily metrics card (server: routes/dailyUpdates.js). Team members post
// the same message every day with new numbers, and used to copy yesterday's
// and edit it by hand. Here the message is kept as a template, with ___ where
// a number goes, {month} for the month (filled in by the app) and {date} for
// a date they pick; each day they only type the blanks.

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dateLabel = (ymd?: string | null) => (ymd ? `${Number(ymd.slice(8, 10))} ${MON[Number(ymd.slice(5, 7)) - 1]}` : '')
const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
const blanksIn = (text: string) => slotsIn(text).length

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
    return <React.Fragment key={si}>{blank(i, isAuto(seg))}</React.Fragment>
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
                const total = isBoldRow(cells)
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
  // What month totals ({run:…}) add to: the previous post's cells by "row|column".
  run_prev?: Record<string, string | number>; run_fresh?: boolean
  // Whose card this is: a manager may open a teammate's (own = false).
  owner?: { id: string; name: string }; own?: boolean
}

// `editId`: open on that posted card to correct it. `userId`: a teammate's
// card, opened by a manager to see it as they do and fix it for them.
export function UpdateSheet({ convId, editId = null, userId = null, onClose, onPosted }: {
  convId: string; editId?: string | null; userId?: string | null; onClose: () => void; onPosted: () => void
}) {
  const [d, setD] = useState<Loaded | null>(null)
  const [setup, setSetup] = useState(false)
  const [fixing, setFixing] = useState<string | null>(editId)
  const userQ = userId ? `user=${encodeURIComponent(userId)}` : ''
  useEffect(() => {
    const q = [userQ, fixing ? `edit=${encodeURIComponent(fixing)}` : ''].filter(Boolean).join('&')
    api.get(`/chat/conversations/${convId}/update-template${q ? `?${q}` : ''}`)
      .then((r: any) => { setD(r); setSetup(!r.template && !r.edit) })
      .catch((e: any) => { toast.error(e.message || 'Could not open your daily metrics'); onClose() })
  }, [convId, fixing])

  if (!d) return <Sheet label="Daily metrics" title="Daily metrics" onClose={onClose}><div className="du-loading"><span className="spinner" /></div></Sheet>
  if (setup) {
    return <SetupForm convId={convId} tpl={d.template} userQ={userQ} owner={d.own === false ? d.owner?.name || 'them' : null} onClose={d.template ? () => setSetup(false) : onClose}
      onSaved={(t) => { setD({ ...d, template: t }); setSetup(false) }} onStopped={onClose} />
  }
  return <FillForm key={d.edit?.id || 'new'} convId={convId} data={d} userQ={userQ} onSetup={() => setSetup(true)}
    onFixLast={() => { setD(null); setFixing(d.last_id) }} onClose={onClose} onPosted={onPosted} />
}

// `owner`: the teammate's name when a manager is editing their card.
function SetupForm({ convId, tpl, userQ = '', owner = null, onClose, onSaved, onStopped }: {
  convId: string; tpl: UpdateTemplate | null; userQ?: string; owner?: string | null; onClose: () => void; onSaved: (t: UpdateTemplate) => void; onStopped: () => void
}) {
  const url = `/chat/conversations/${convId}/update-template${userQ ? `?${userQ}` : ''}`
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
      const res: any = await api.put(url, {
        title: title.trim() || 'Daily metrics', body, remind_at: remind ? at : null, remind_days: days,
      })
      onSaved(res.template)
    } catch (e: any) { toast.error(e.message || 'Could not save your card'); setBusy(false) }
  }
  const stop = async () => {
    const yes = await confirmDialog({
      title: owner ? `Stop ${owner}'s daily metrics in this chat?` : 'Stop daily metrics in this chat?',
      message: owner ? 'Their card and its reminder go. The updates they have already posted stay in the chat.' : "Your card and its reminder go. The updates you've already posted stay in the chat.",
      confirmText: 'Stop', cancelText: 'Keep', danger: true,
    })
    if (!yes) return
    try { await api.del(url); toast.success('Daily metrics stopped here'); onStopped() }
    catch (e: any) { toast.error(e.message || 'Could not stop them') }
  }
  return (
    <Sheet label="Set up your daily metrics" title={owner ? `Edit ${owner}'s card` : tpl ? 'Edit your card' : 'Set up your daily metrics'} onClose={onClose} className="du-sheet"
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
      {owner && <p className="du-intro">You are changing {owner}'s card. They see your changes the next time they open it.</p>}
      {tpl && <button type="button" className="du-stop" onClick={stop}>{owner ? `Stop ${owner}'s daily metrics in this chat` : 'Stop daily metrics in this chat'}</button>}
    </Sheet>
  )
}

// The message with a box in each blank. A new one starts empty, last time's
// numbers shown faintly in the boxes as a reminder; editing a posted one
// starts filled in.
function FillForm({ convId, data, userQ = '', onSetup, onFixLast, onClose, onPosted }: {
  convId: string; data: Loaded; userQ?: string; onSetup: () => void; onFixLast: () => void; onClose: () => void; onPosted: () => void
}) {
  const { template: tpl, last, edit } = data
  const text = edit ? edit.text || '' : tpl!.body
  const month = edit ? edit.month || '' : data.month
  const n = blanksIn(text)
  const hint = !edit && last?.text === text ? last.values || [] : []
  // Which slots fill themselves in: totals, and month totals ({run:…}) that
  // add today's figure to the last post's.
  const totals = (text.match(SLOT_G) || []).map(isAuto)
  const prev = data.run_prev || {}
  const fresh = !!data.run_fresh
  const preview = data.own === false
  // `vals` is what was typed; a total left empty shows its sum. Editing a
  // posted card, a total that still equals its sum goes back to adding itself.
  const [vals, setVals] = useState<string[]>(() => {
    const v = Array.from({ length: n }, (_, i) => edit?.values?.[i] || '')
    const typed = v.map((x, i) => (totals[i] ? '' : x))
    const auto = computeAll(text, typed, prev, fresh)
    return v.map((x, i) => (totals[i] && x === auto[i] ? '' : x))
  })
  const shown = computeAll(text, vals.map((v) => v.trim()), prev, fresh)
  const [date, setDate] = useState(edit?.date || data.day)
  const [note, setNote] = useState(edit?.note || '')
  const [busy, setBusy] = useState(false)
  const withDate = text.includes('{date}')
  const any = vals.some((v, i) => !totals[i] && v.trim()) || !!note.trim()
  const post = async () => {
    if (busy || !any || preview) return
    setBusy(true)
    try {
      const payload = { values: shown, note: note.trim(), date: withDate ? date : null }
      if (edit) await api.put(`/chat/message/${edit.id}/update`, payload)
      else await api.post(`/chat/conversations/${convId}/update`, payload)
      onPosted()
    } catch (e: any) { toast.error(e.message || 'Could not post your update'); setBusy(false) }
  }
  // A manager setting a teammate's month totals by hand: what is typed into the
  // month-total boxes becomes "month so far" as of today's report, and their
  // cards add each day's figure to it from tomorrow.
  const runSlot = (text.match(SLOT_G) || []).map((t) => t.startsWith('{run:'))
  const typedRun = vals.some((v, i) => runSlot[i] && v.trim())
  const saveMonth = async () => {
    if (busy || !typedRun) return
    const yes = await confirmDialog({
      title: `Set ${data.owner?.name || 'their'} month so far?`,
      message: 'The figures in the month-total boxes become the month so far as of today. From tomorrow their card adds each day to these.',
      confirmText: 'Save', cancelText: 'Cancel',
    })
    if (!yes) return
    setBusy(true)
    try {
      // Every month-total box as it shows, typed or worked out: what they see is what is kept.
      const r: any = await api.put(`/chat/conversations/${convId}/update-template/month-so-far${userQ ? `?${userQ}` : ''}`, { values: shown })
      toast.success(`Month so far saved (${r.count} figures)`)
      onClose()
    } catch (e: any) { toast.error(e.message || 'Could not save the month so far'); setBusy(false) }
  }
  const title = edit ? edit.title : tpl!.title
  return (
    <Sheet label={title} title={<span className="du-sheet-title"><TrendGlyph size={17} /> {edit ? `Edit ${title}` : title}</span>} onClose={onClose} className="du-sheet"
      foot={<>
        {!edit && tpl ? <button className="btn btn-ghost" onClick={onSetup}><Ic name="edit" size={14} /> {preview ? 'Edit their card' : 'Edit card'}</button> : <span />}
        {!preview && <button className="btn btn-primary" disabled={busy || !any} onClick={post}>{busy ? 'Saving…' : edit ? 'Save changes' : 'Post update'}</button>}
        {preview && runSlot.some(Boolean) && <button className="btn btn-primary" disabled={busy || !typedRun} onClick={saveMonth}>{busy ? 'Saving…' : 'Save as month so far'}</button>}
      </>}>
      {preview && <div className="du-again"><span>This is how {data.owner?.name ? `${data.owner.name}'s` : 'their'} card looks to them. Only they can post it; you can fix the card itself{runSlot.some(Boolean) ? ', or type the month so far into the shaded month-total boxes and save it' : ''}.</span></div>}
      <div className="du-fill-day">{dayLabel(edit ? edit.day : data.day)}</div>
      {!preview && !edit && data.posted_today && data.last_id && (
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
              title={total ? (shown[i] ? 'Added up for you. Type to change it; clear it to add up again.' : 'Type the month so far once; after that it adds up by itself.') : undefined}
              size={Math.max(3, Math.min(14, ((auto ? shown[i] : vals[i]) || hint[i] || '').length + 1))}
              placeholder={total ? '' : hint[i] && hint[i] !== '-' ? hint[i] : ''} value={(auto ? shown[i] : vals[i]) || ''}
              onChange={(e) => setVals((v) => v.map((x, j) => (j === i ? e.target.value : x)))} />
          )
        }} />
      </div>
      {hint.length > 0 && <div className="du-hint">Faint numbers are from your last update.</div>}
      {totals.some(Boolean) && <div className="du-hint">Shaded boxes add themselves up (month totals from your last update, and the totals). Type over one to change it.</div>}
      <label className="ta-label" htmlFor="du-note">Note (optional)</label>
      <textarea id="du-note" className="ta-input du-note-in" rows={2} maxLength={1000} placeholder="Anything else today" value={note} onChange={(e) => setNote(e.target.value)} />
    </Sheet>
  )
}

// ---- who has posted today ------------------------------------------------------------
interface TodayPerson { user_id: string; name: string; avatar_color?: string; avatar_file?: string | null; posted: boolean; message_id: string | null; at: string | null }

// A line under the chat's header once anyone here has a card: how many have
// posted today, opening to the list. Hidden in chats where nobody reports.
// `onCard`: given to managers and admins, a "Card" button by each teammate opens
// that person's card as they see it, to check it or fix it for them.
export function TodayUpdates({ convId, refreshKey, meId, onFill, onOpen, onCard }: {
  convId: string; refreshKey: number; meId: string; onFill: () => void; onOpen: (messageId: string) => void
  onCard?: (userId: string) => void
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
              {onCard && p.user_id !== meId && (
                <button type="button" className="btn btn-ghost btn-sm du-card-btn" aria-label={`Open ${p.name}'s card`}
                  onClick={() => { setOpen(false); onCard(p.user_id) }}>Card</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
