import React, { useEffect, useState } from 'react'
import { api, userAvatarUrl } from '../../api'
import { Avatar, Ic, PRIORITY_COLORS, STATUS_COLORS, todayKey } from '../../ui'
import { useDialog } from '../../lib/useDialog'
import type { ContactRef, LocationRef, MeetingCard, Member, Msg, Poll, TaskRef } from './types'
import { PinDropGlyph, PollGlyph, SparkGlyph, TaskGlyph } from './glyphs'

// The message kinds that are not just text: what each one looks like inside a
// bubble. The Chats page decides WHERE they go; these decide what they show.

const shortDate = (iso?: string | null) => {
  if (!iso) return ''
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const days = Math.round((d.getTime() - today.getTime()) / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

// A link in a task's title, shortened for a card: no scheme, no www, and a
// long path cut to its start, as Cliq shows one. The full link is in the task.
const shortLinks = (text: string) =>
  text.replace(/\bhttps?:\/\/(?:www\.)?([^\s]+)/gi, (_, rest: string) => (rest.length > 32 ? rest.slice(0, 30) + '…' : rest))

// ---------- a task assigned from the chat ----------
// Read live from the task (server taskCard), so the card says In Progress or
// Done once the work moves — the chat stays a true picture of who owes what.
export function TaskCard({ task, meId, onOpen }: { task: TaskRef; meId: string; onOpen: () => void }) {
  if (task.deleted) {
    return <div className="task-card gone"><TaskGlyph size={16} /> <span>This task was deleted</span></div>
  }
  const today = todayKey()
  const overdue = !!task.due_date && task.due_date < today && task.status !== 'Done'
  const forMe = task.assignee_id === meId
  return (
    <button type="button" className={'task-card' + (task.status === 'Done' ? ' done' : '')} onClick={onOpen} aria-label={`Task: ${task.title}. Open it`}>
      <span className="task-card-top">
        <span className="task-card-ic" aria-hidden="true"><TaskGlyph size={15} /></span>
        <span className="task-card-kind">{forMe ? 'Task for you' : 'Task assigned'}</span>
        <span className="task-card-status" style={{ color: STATUS_COLORS[task.status || 'To Do'], borderColor: 'currentColor' }}>{task.status || 'To Do'}</span>
      </span>
      <span className="task-card-title">{shortLinks(task.title || '')}</span>
      <span className="task-card-meta">
        {task.assignee_id ? (
          <span className="task-card-who">
            <Avatar name={task.assignee_name || ''} color={task.assignee_color || undefined} size={18} src={task.assignee_avatar ? userAvatarUrl(task.assignee_id, task.assignee_avatar) : undefined} />
            {forMe ? 'You' : task.assignee_name}
          </span>
        ) : <span className="task-card-who muted">Unassigned</span>}
        {task.due_date && <span className={'task-card-due' + (overdue ? ' late' : '')}><Ic name="calendar" size={11} /> {overdue ? 'Overdue · ' : 'Due '}{shortDate(task.due_date)}</span>}
        {task.priority && <span className="task-card-pri" style={{ color: PRIORITY_COLORS[task.priority] }}>{task.priority}</span>}
      </span>
      <span className="task-card-open">Open task <Ic name="arrowRight" size={12} /></span>
    </button>
  )
}

// ---------- polls ----------
export function PollCard({ msg, meId, members, onVote, onViewVotes }: {
  msg: Msg; meId: string; members: Member[]; onVote: (picks: number[]) => void; onViewVotes: () => void
}) {
  const poll = msg.poll as Poll
  const voters = new Set(poll.options.flatMap((o) => o.voters))
  const most = Math.max(1, ...poll.options.map((o) => o.voters.length))
  const mine = poll.options.map((o, i) => (o.voters.includes(meId) ? i : -1)).filter((i) => i >= 0)
  const pick = (i: number) => {
    if (poll.multi) onVote(mine.includes(i) ? mine.filter((x) => x !== i) : [...mine, i])
    else onVote(mine.includes(i) ? [] : [i])
  }
  const face = (uid: string) => {
    const m = members.find((x) => x.id === uid)
    return <Avatar key={uid} name={m?.name || '?'} color={m?.avatar_color} size={16} src={m?.avatar_file ? userAvatarUrl(uid, m.avatar_file) : undefined} />
  }
  return (
    <div className="poll-card">
      <div className="poll-q"><span className="poll-ic" aria-hidden="true"><PollGlyph size={14} /></span>{msg.body}</div>
      <div className="poll-hint">{poll.multi ? 'Select one or more' : 'Select one'}</div>
      <div className="poll-opts" role={poll.multi ? 'group' : 'radiogroup'} aria-label={msg.body}>
        {poll.options.map((o, i) => {
          const on = mine.includes(i)
          return (
            <button key={i} type="button" className={'poll-opt' + (on ? ' on' : '')} role={poll.multi ? 'checkbox' : 'radio'} aria-checked={on}
              aria-label={`${o.text}, ${o.voters.length} vote${o.voters.length === 1 ? '' : 's'}`} onClick={() => pick(i)}>
              <span className={'poll-check' + (poll.multi ? ' sq' : '')} aria-hidden="true">{on && <Ic name="check" size={11} />}</span>
              <span className="poll-opt-main">
                <span className="poll-opt-row">
                  <span className="poll-opt-text">{o.text}</span>
                  <span className="poll-faces">{o.voters.slice(0, 3).map(face)}</span>
                  <span className="poll-count">{o.voters.length}</span>
                </span>
                <span className="poll-bar"><span style={{ width: `${(o.voters.length / most) * 100}%` }} /></span>
              </span>
            </button>
          )
        })}
      </div>
      <button type="button" className="poll-view" onClick={onViewVotes}>
        {voters.size ? `View votes · ${voters.size} ${voters.size === 1 ? 'person' : 'people'}` : 'No votes yet'}
      </button>
    </div>
  )
}

export function PollVotesSheet({ msg, members, meId, onClose }: { msg: Msg; members: Member[]; meId: string; onClose: () => void }) {
  const ref = useDialog<HTMLDivElement>(onClose)
  const poll = msg.poll as Poll
  const nameOf = (uid: string) => (uid === meId ? 'You' : members.find((m) => m.id === uid)?.name || 'Former member')
  return (
    <div className="modal-overlay wa-sheet-overlay" onClick={onClose}>
      <div className="modal-card wa-sheet" ref={ref} role="dialog" aria-modal="true" aria-label="Poll votes" onClick={(e) => e.stopPropagation()}>
        <div className="wa-sheet-head"><h3>Poll details</h3><button className="ic-btn" onClick={onClose} aria-label="Close"><Ic name="close" size={18} /></button></div>
        <div className="wa-sheet-body">
          <div className="pv-q">{msg.body}</div>
          {poll.options.map((o, i) => (
            <div key={i} className="pv-opt">
              <div className="pv-opt-head"><span>{o.text}</span><span className="muted">{o.voters.length} vote{o.voters.length === 1 ? '' : 's'}</span></div>
              {o.voters.length === 0 && <div className="pv-none">No votes</div>}
              {o.voters.map((uid) => {
                const m = members.find((x) => x.id === uid)
                return (
                  <div key={uid} className="pv-voter">
                    <Avatar name={m?.name || nameOf(uid)} color={m?.avatar_color} size={28} src={m?.avatar_file ? userAvatarUrl(uid, m.avatar_file) : undefined} />
                    <span>{nameOf(uid)}</span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------- a shared location ----------
// The map is three OpenStreetMap tiles across, centred on the pin — no map
// library, no key. Tapping opens the place in the phone's own maps app.
const TILE = 256
export function LocationCard({ loc }: { loc: LocationRef }) {
  const z = 15
  const n = 2 ** z
  const xt = ((loc.lng + 180) / 360) * n
  const latR = (loc.lat * Math.PI) / 180
  const yt = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n
  const tx = Math.floor(xt), ty = Math.floor(yt)
  const px = (xt - tx) * TILE, py = (yt - ty) * TILE
  const W = 264, H = 140
  const tiles: { x: number; y: number; left: number; top: number }[] = []
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    tiles.push({ x: (tx + dx + n) % n, y: ty + dy, left: W / 2 - px + dx * TILE, top: H / 2 - py + dy * TILE })
  }
  const href = `https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng}`
  return (
    <a className="loc-card" href={href} target="_blank" rel="noopener noreferrer" aria-label={`Location${loc.label ? `: ${loc.label}` : ''}. Open in maps`}>
      <span className="loc-map" style={{ width: W, height: H }}>
        {tiles.filter((t) => t.y >= 0 && t.y < n && t.left > -TILE && t.left < W && t.top > -TILE && t.top < H).map((t) => (
          <img key={`${t.x}-${t.y}`} src={`https://tile.openstreetmap.org/${z}/${t.x}/${t.y}.png`} alt="" loading="lazy" draggable={false} style={{ left: t.left, top: t.top }} />
        ))}
        <span className="loc-pin" aria-hidden="true"><PinDropGlyph size={30} /></span>
        <span className="loc-attr">© OpenStreetMap</span>
      </span>
      <span className="loc-label">
        <span className="loc-title">{loc.label || 'Shared location'}</span>
        <span className="loc-sub">{loc.lat.toFixed(5)}, {loc.lng.toFixed(5)}{loc.accuracy ? ` · ±${loc.accuracy} m` : ''}</span>
      </span>
    </a>
  )
}

// ---------- a teammate's contact ----------
export function ContactCard({ contact, meId, onMessage }: { contact: ContactRef | null; meId: string; onMessage: (userId: string) => void }) {
  if (!contact) return <div className="contact-card gone">This contact is no longer in the workspace</div>
  return (
    <div className="contact-card">
      <span className="contact-card-who">
        <Avatar name={contact.name} color={contact.avatar_color} size={40} src={contact.avatar_file ? userAvatarUrl(contact.id, contact.avatar_file) : undefined} />
        <span className="contact-card-text">
          <span className="contact-card-name">{contact.name}</span>
          <span className="contact-card-sub">
            {contact.role && <span className="contact-card-role">{contact.role}</span>}
            {contact.role && contact.email && ' · '}
            {contact.email}
          </span>
        </span>
      </span>
      {contact.id !== meId && <button type="button" className="contact-card-btn" onClick={() => onMessage(contact.id)}>Message</button>}
    </div>
  )
}

// ---------- link previews ----------
// One request per message (per version of it — an edit can change the link),
// remembered for the life of the page, so scrolling back over a thread does
// not ask again. The server caches across everyone.
interface Preview { url: string; title: string; description: string; image: string | null; site: string }
const previews = new Map<string, Preview | null | Promise<Preview | null>>()
function previewFor(messageId: string, version: string): Preview | null | Promise<Preview | null> {
  const key = `${messageId}|${version}`
  const hit = previews.get(key)
  if (hit !== undefined) return hit
  const p = api.get(`/chat/message/${messageId}/preview`)
    .then((d) => { previews.set(key, d.preview || null); return d.preview || null })
    .catch(() => { previews.set(key, null); return null })
  previews.set(key, p)
  return p
}
export function LinkPreview({ messageId, version = '' }: { messageId: string; version?: string }) {
  const first = previews.get(`${messageId}|${version}`)
  const [p, setP] = useState<Preview | null>(first && !(first instanceof Promise) ? first : null)
  const [imgOk, setImgOk] = useState(true)
  useEffect(() => {
    let live = true
    setImgOk(true)
    const v = previewFor(messageId, version)
    if (v instanceof Promise) v.then((x) => { if (live) setP(x) })
    else setP(v)
    return () => { live = false }
  }, [messageId, version])
  if (!p) return null
  return (
    <a className="link-prev" href={p.url} target="_blank" rel="noopener noreferrer">
      {p.image && imgOk && <img className="link-prev-img" src={p.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setImgOk(false)} />}
      <span className="link-prev-text">
        <span className="link-prev-title">{p.title}</span>
        {p.description && <span className="link-prev-desc">{p.description}</span>}
        <span className="link-prev-site">{p.site}</span>
      </span>
    </a>
  )
}

// ---------- the summary a call leaves behind ----------
// Who walked away with what, right in the thread. Everyone can open the full
// summary (in the chat's info panel). Nothing found on a call is assigned by
// itself, so while tasks wait the card says so: whoever may review them —
// anyone who was on the call, and managers (`can_review`) — gets the review as
// its main button, right here where the call happened; anyone else is told the
// tasks are waiting rather than left wondering why nobody has them.
export function CallSummaryCard({ meeting, isManager, meId, onOpenMeeting, onOpenTask }: {
  meeting: MeetingCard; isManager: boolean; meId: string; onOpenMeeting: (review: boolean) => void; onOpenTask: (taskId: string) => void
}) {
  const review = (meeting.can_review ?? isManager) && meeting.tasks > 0
  const [open, setOpen] = useState(false)
  const assigned = meeting.assigned || []
  return (
    <div className="meeting-card">
      <div className="meeting-card-head">
        <span className="mc-spark" aria-hidden="true"><SparkGlyph size={14} /></span>
        <span>{meeting.title}</span>
      </div>
      {meeting.summary && (
        <button type="button" className={'meeting-card-sum' + (open ? ' open' : '')} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {meeting.summary}
        </button>
      )}
      {assigned.length > 0 && (
        <div className="mc-tasks">
          <div className="mc-tasks-head">{assigned.length} task{assigned.length === 1 ? '' : 's'} assigned from this call</div>
          {assigned.map((t, i) => (
            <button key={t.task_id || i} type="button" className="mc-task" disabled={!t.task_id || (!isManager && t.assignee_id !== meId)} onClick={() => t.task_id && onOpenTask(t.task_id)}>
              <span className="mc-task-check" aria-hidden="true"><Ic name="check" size={11} /></span>
              <span className="mc-task-title">{t.title}</span>
              <span className={'mc-task-who' + (t.assignee_id === meId ? ' me' : '')}>{t.assignee_id === meId ? 'You' : (t.assignee_name || '').split(' ')[0]}</span>
            </button>
          ))}
        </div>
      )}
      {meeting.tasks > 0 && (review ? (
        <button type="button" className="mc-review" onClick={() => onOpenMeeting(true)}>
          <span className="mc-review-main">Review &amp; assign {meeting.tasks} task{meeting.tasks === 1 ? '' : 's'}</span>
          <span className="mc-review-sub">Suggested by AI · nothing assigned yet</span>
        </button>
      ) : (
        <div className="mc-waiting">{meeting.tasks} suggested task{meeting.tasks === 1 ? '' : 's'} waiting to be reviewed and assigned by someone who was on the call</div>
      ))}
      <div className="meeting-card-meta">
        {meeting.decisions > 0 && <span className="mc-chip">{meeting.decisions} decision{meeting.decisions === 1 ? '' : 's'}</span>}
        {meeting.risks > 0 && <span className="mc-chip warn">{meeting.risks} risk{meeting.risks === 1 ? '' : 's'}</span>}
        <button type="button" className="mc-open" onClick={() => onOpenMeeting(false)}>Full summary →</button>
      </div>
    </div>
  )
}
