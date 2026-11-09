import React, { useEffect, useRef, useState } from 'react'
import { api, userAvatarUrl, groupAvatarUrl } from '../../api'
import { Avatar, Ic } from '../../ui'
import { toast } from '../../lib/toast'
import { useDialog } from '../../lib/useDialog'
import type { LocationRef, Msg, OrgUser } from './types'
import { whenLabel, fmtTime, dayLabel } from './types'
import { ArrowIn, ArrowOut, Ticks } from './glyphs'
import { LocationCard } from './MessageCards'

// The chat's smaller dialogs. Each is a centred card on a wide screen and a
// sheet from the bottom on a phone (.wa-sheet), with lib/useDialog's focus
// handling: focus moves in, Tab stays in, Escape closes, focus goes back.

export function Sheet({ label, title, onClose, children, foot, className }: {
  label: string; title: React.ReactNode; onClose: () => void; children: React.ReactNode; foot?: React.ReactNode; className?: string
}) {
  const ref = useDialog<HTMLDivElement>(onClose)
  return (
    <div className="modal-overlay wa-sheet-overlay" onClick={onClose}>
      <div className={'modal-card wa-sheet' + (className ? ' ' + className : '')} ref={ref} role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <div className="wa-sheet-head"><h3>{title}</h3><button className="ic-btn" onClick={onClose} aria-label="Close"><Ic name="close" size={18} /></button></div>
        <div className="wa-sheet-body">{children}</div>
        {foot && <div className="wa-sheet-foot">{foot}</div>}
      </div>
    </div>
  )
}

// ---------- Message info ----------
interface InfoPerson { id: string; name: string; avatar_color?: string; avatar_file?: string | null; at?: string | null }
export function MessageInfoSheet({ message, preview, onClose }: { message: Msg; preview: React.ReactNode; onClose: () => void }) {
  const [info, setInfo] = useState<{ read: InfoPerson[]; delivered: InfoPerson[]; waiting: InfoPerson[] } | null>(null)
  useEffect(() => {
    api.get(`/chat/message/${message.id}/info`).then(setInfo).catch((e) => { toast.error('Could not load message info: ' + e.message); onClose() })
  }, [message.id])
  const row = (p: InfoPerson, note: string) => (
    <div key={p.id} className="mi-row">
      <Avatar name={p.name} color={p.avatar_color} size={34} src={p.avatar_file ? userAvatarUrl(p.id, p.avatar_file) : undefined} />
      <span className="mi-name">{p.name}</span>
      <span className="mi-when">{note}</span>
    </div>
  )
  return (
    <Sheet label="Message info" title="Message info" onClose={onClose}>
      <div className="mi-preview">{preview}</div>
      {!info && <div className="ta-empty"><span className="spinner" /></div>}
      {info && (
        <>
          <div className="mi-sec">
            <div className="mi-sec-head"><Ticks state="read" /> Read by</div>
            {info.read.length === 0 && <div className="mi-none">Nobody yet</div>}
            {info.read.map((p) => row(p, p.at ? whenLabel(p.at) : 'Read'))}
          </div>
          <div className="mi-sec">
            <div className="mi-sec-head"><Ticks state="delivered" /> Delivered to</div>
            {info.delivered.length === 0 && <div className="mi-none">{info.read.length && !info.waiting.length ? 'Everyone has read it' : 'Nobody else yet'}</div>}
            {info.delivered.map((p) => row(p, p.at ? whenLabel(p.at) : 'Delivered'))}
          </div>
          {info.waiting.length > 0 && (
            <div className="mi-sec">
              <div className="mi-sec-head"><Ticks state="sent" /> Not delivered yet</div>
              {info.waiting.map((p) => row(p, ''))}
            </div>
          )}
          <div className="mi-sent">Sent {whenLabel(message.created_at)}</div>
        </>
      )}
    </Sheet>
  )
}

// ---------- Delete: for me, or for everyone ----------
// WhatsApp's three-way choice. "For everyone" only when every message chosen
// is yours and still there to unsend.
export function DeleteDialog({ count, canEveryone, onPick, onClose }: { count: number; canEveryone: boolean; onPick: (scope: 'me' | 'all') => void; onClose: () => void }) {
  const ref = useDialog<HTMLDivElement>(onClose)
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card del-dialog" ref={ref} role="alertdialog" aria-modal="true" aria-label={count === 1 ? 'Delete message?' : `Delete ${count} messages?`} onClick={(e) => e.stopPropagation()}>
        <div className="del-title">{count === 1 ? 'Delete message?' : `Delete ${count} messages?`}</div>
        {!canEveryone && <div className="del-sub">{count === 1 ? 'It will be removed for you only. Everyone else in the chat will still see it.' : 'They will be removed for you only.'}</div>}
        <div className="del-actions">
          {canEveryone && <button className="del-btn danger" onClick={() => onPick('all')}>Delete for everyone</button>}
          <button className="del-btn" onClick={() => onPick('me')}>Delete for me</button>
          <button className="del-btn ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ---------- New poll ----------
export function PollComposer({ onSend, onClose }: { onSend: (q: string, options: string[], multi: boolean) => Promise<boolean>; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [opts, setOpts] = useState<string[]>(['', ''])
  const [multi, setMulti] = useState(true)
  const [busy, setBusy] = useState(false)
  const filled = opts.map((o) => o.trim()).filter(Boolean)
  const dupe = new Set(filled.map((o) => o.toLowerCase())).size !== filled.length
  const setOpt = (i: number, v: string) => setOpts((cur) => {
    const next = cur.slice(); next[i] = v
    // A fresh empty row appears once the last one is used, up to twelve —
    // WhatsApp's way, so there is never an "Add option" button to hunt for.
    if (i === next.length - 1 && v.trim() && next.length < 12) next.push('')
    return next
  })
  const drop = (i: number) => setOpts((cur) => (cur.length <= 2 ? cur.map((o, j) => (j === i ? '' : o)) : cur.filter((_, j) => j !== i)))
  const go = async () => {
    if (busy || !q.trim() || filled.length < 2 || dupe) return
    setBusy(true)
    if (!(await onSend(q.trim(), filled, multi))) setBusy(false)
  }
  return (
    <Sheet label="Create poll" title="Create poll" onClose={onClose} className="poll-compose"
      foot={<button className="btn btn-primary" disabled={busy || !q.trim() || filled.length < 2 || dupe} onClick={go}>{busy ? 'Sending…' : 'Send poll'}</button>}>
      <label className="ta-label" htmlFor="pc-q">Question</label>
      <input id="pc-q" className="ta-input" autoFocus maxLength={300} placeholder="Ask a question" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="ta-label">Options</div>
      {opts.map((o, i) => (
        <div key={i} className="pc-opt">
          <input className="ta-input" maxLength={100} placeholder={`Option ${i + 1}`} value={o} aria-label={`Option ${i + 1}`} onChange={(e) => setOpt(i, e.target.value)} />
          {(o || opts.length > 2) && <button className="ic-btn" aria-label={`Remove option ${i + 1}`} onClick={() => drop(i)}><Ic name="close" size={14} /></button>}
        </div>
      ))}
      {dupe && <div className="pc-warn">Two options say the same thing.</div>}
      <label className="pc-multi">
        <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} />
        <span>Allow multiple answers</span>
      </label>
    </Sheet>
  )
}

// ---------- Share my location ----------
export function LocationPicker({ onSend, onClose }: { onSend: (loc: LocationRef) => Promise<boolean>; onClose: () => void }) {
  const [loc, setLoc] = useState<LocationRef | null>(null)
  const [err, setErr] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!navigator.geolocation) { setErr('This device cannot share its location.'); return }
    navigator.geolocation.getCurrentPosition(
      (p) => setLoc({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy), label: '' }),
      (e) => setErr(e.code === 1 ? 'Location permission was refused. Allow it for this site in the browser settings and try again.' : 'Could not find where you are right now. Try again in a moment.'),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    )
  }, [])
  const go = async () => {
    if (!loc || busy) return
    setBusy(true)
    if (!(await onSend({ ...loc, label: label.trim() }))) setBusy(false)
  }
  return (
    <Sheet label="Send location" title="Send your location" onClose={onClose}
      foot={<button className="btn btn-primary" disabled={!loc || busy} onClick={go}>{busy ? 'Sending…' : 'Send current location'}</button>}>
      {!loc && !err && <div className="ta-empty"><span className="spinner" /> Finding you…</div>}
      {err && <div className="pc-warn">{err}</div>}
      {loc && (
        <>
          <div className="lp-map"><LocationCard loc={{ ...loc, label: label.trim() }} /></div>
          <label className="ta-label" htmlFor="lp-label">Name this place <span className="muted">(optional)</span></label>
          <input id="lp-label" className="ta-input" maxLength={120} placeholder="e.g. Client site, Gate 3" value={label} onChange={(e) => setLabel(e.target.value)} />
        </>
      )}
    </Sheet>
  )
}

// ---------- Share a teammate's contact ----------
export function ContactPicker({ meId, onPick, onClose }: { meId: string; onPick: (u: OrgUser) => void; onClose: () => void }) {
  const [users, setUsers] = useState<OrgUser[] | null>(null)
  const [q, setQ] = useState('')
  useEffect(() => { api.get('/chat/users').then((d) => setUsers(d.users || [])).catch(() => setUsers([])) }, [])
  const shown = (users || []).filter((u) => u.id !== meId && (u.name.toLowerCase().includes(q.trim().toLowerCase()) || u.email.toLowerCase().includes(q.trim().toLowerCase())))
  return (
    <Sheet label="Share a contact" title="Share a contact" onClose={onClose}>
      <input className="ta-input" autoFocus placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
      <div className="ta-pick-list tall">
        {users === null && <div className="ta-empty"><span className="spinner" /></div>}
        {users !== null && shown.length === 0 && <div className="ta-empty">Nobody matches</div>}
        {shown.map((u) => (
          <button key={u.id} type="button" className="ta-pick-row" onClick={() => onPick(u)}>
            <Avatar name={u.name} color={u.avatar_color} size={32} src={u.avatar_file ? userAvatarUrl(u.id, u.avatar_file) : undefined} />
            <span className="ta-pick-name">{u.name}<span className="ta-pick-sub">{u.role}</span></span>
          </button>
        ))}
      </div>
    </Sheet>
  )
}

// ---------- Calls: WhatsApp's call log ----------
interface CallRow {
  id: string; conversation_id: string; type: 'direct' | 'group'; name: string; avatar_color?: string | null; avatar_file?: string | null
  other_user_id?: string | null; kind: 'audio' | 'video'; status: string; outgoing: boolean; missed: boolean; started_at: string; duration_sec: number; meeting_id?: string | null
}
const dur = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60 ? `${s % 60}s` : ''}`.trim() : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`)
export function CallsSheet({ isManager, onCall, onOpenChat, onOpenSummary, onClose }: {
  isManager: boolean
  onCall: (conversationId: string, kind: 'audio' | 'video', name: string) => void
  onOpenChat: (conversationId: string, otherUserId?: string | null) => void
  onOpenSummary: (meetingId: string) => void
  onClose: () => void
}) {
  const [items, setItems] = useState<CallRow[] | null>(null)
  const [tab, setTab] = useState<'all' | 'missed'>('all')
  useEffect(() => { api.get('/chat/calls').then((d) => setItems(d.items || [])).catch(() => setItems([])) }, [])
  const shown = (items || []).filter((c) => tab === 'all' || c.missed)
  const pic = (c: CallRow) => c.type === 'group'
    ? (c.avatar_file ? <img className="avatar" src={groupAvatarUrl(c.conversation_id, c.avatar_file)} style={{ width: 40, height: 40, objectFit: 'cover' }} alt="" /> : <span className="avatar group-avatar" style={{ background: c.avatar_color || undefined, width: 40, height: 40 }}>#</span>)
    : <Avatar name={c.name} color={c.avatar_color || undefined} size={40} src={c.avatar_file && c.other_user_id ? userAvatarUrl(c.other_user_id, c.avatar_file) : undefined} />
  return (
    <Sheet label="Calls" title="Calls" onClose={onClose} className="calls-sheet">
      <div className="modal-tabs">
        <button className={tab === 'all' ? 'active' : ''} onClick={() => setTab('all')}>All</button>
        <button className={tab === 'missed' ? 'active' : ''} onClick={() => setTab('missed')}>Missed</button>
      </div>
      {items === null && <div className="ta-empty"><span className="spinner" /></div>}
      {items !== null && shown.length === 0 && <div className="ta-empty">{tab === 'missed' ? 'No missed calls' : 'No calls yet. Start one from any chat with the phone or camera button.'}</div>}
      {shown.map((c) => (
        <div key={c.id} className="cl-row">
          <button type="button" className="cl-main" onClick={() => onOpenChat(c.conversation_id, c.other_user_id)} aria-label={`${c.name}, ${c.missed ? 'missed' : c.outgoing ? 'outgoing' : 'incoming'} ${c.kind} call, ${whenLabel(c.started_at)}. Open chat`}>
            {pic(c)}
            <span className="cl-text">
              <span className={'cl-name' + (c.missed ? ' missed' : '')}>{c.name}</span>
              <span className="cl-sub">
                <span className={'cl-dir' + (c.missed ? ' missed' : c.outgoing ? ' out' : ' in')}>{c.outgoing ? <ArrowOut /> : <ArrowIn />}</span>
                {dayLabel(c.started_at)}, {fmtTime(c.started_at)}
                {c.duration_sec > 0 && <> · {dur(c.duration_sec)}</>}
                {c.status === 'declined' && ' · declined'}
              </span>
            </span>
          </button>
          {c.meeting_id && isManager && (
            <button type="button" className="cl-sum" onClick={() => onOpenSummary(c.meeting_id!)} title="Summary and tasks from this call">Summary</button>
          )}
          <button type="button" className="ic-btn cl-call" onClick={() => onCall(c.conversation_id, c.kind, c.name)} aria-label={`${c.kind === 'video' ? 'Video' : 'Audio'} call ${c.name}`} title={`${c.kind === 'video' ? 'Video' : 'Audio'} call`}>
            <Ic name={c.kind === 'video' ? 'video' : 'phone'} size={19} />
          </button>
        </div>
      ))}
    </Sheet>
  )
}

// ---------- Group description (admin) ----------
export function DescriptionEditor({ initial, onSave, onClose }: { initial: string; onSave: (v: string) => Promise<boolean>; onClose: () => void }) {
  const [v, setV] = useState(initial)
  const [busy, setBusy] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { const el = ta.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) } }, [])
  return (
    <Sheet label="Group description" title="Group description" onClose={onClose}
      foot={<button className="btn btn-primary" disabled={busy || v.trim() === initial.trim()} onClick={async () => { setBusy(true); if (!(await onSave(v.trim()))) setBusy(false) }}>Save</button>}>
      <textarea ref={ta} className="ta-input ta-notes" rows={5} maxLength={500} value={v} onChange={(e) => setV(e.target.value)} placeholder="What this group is for, who should be in it, links people keep asking for" />
      <div className="muted" style={{ fontSize: 11.5, textAlign: 'right' }}>{v.length}/500</div>
    </Sheet>
  )
}
