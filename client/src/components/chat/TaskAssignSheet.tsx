import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, userAvatarUrl } from '../../api'
import { Avatar, Ic, defaultDueDate } from '../../ui'
import { toast } from '../../lib/toast'
import { useDialog } from '../../lib/useDialog'
import type { Conversation, Msg, OrgUser, Workload } from './types'
import { TaskGlyph } from './glyphs'
import { attachToTask, attachable } from '../../lib/taskAttach'

// Assign a task without leaving the chat.
//
// The old way out was "Assign as task" → the Tasks page's New task form, which
// meant losing the thread in the middle of a conversation about the work. This
// sheet asks only what assigning needs — what, who, by when, how urgent — with
// the answers the message already gave filled in (the server's task-draft
// rules: the @named or spoken-of teammate, "by Friday", "urgent"). Assigning
// creates the task through POST /api/tasks, the one place tasks are made, and
// then puts a task card in the thread quoting the message it came from, so
// everyone in the chat sees who now owns it. "More options" still opens the
// full form for the rare task that needs a project or a category.
//
// Nothing is created until Assign is pressed: handing someone work stays a
// deliberate act, the same rule as everywhere else in the app.

export interface Draft { title: string; description?: string; priority?: string; due_date?: string; assignee_id?: string; assignee_name?: string | null; source_message_id?: string }

const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'] as const
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const inDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return isoDay(d) }
const nextMonday = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return isoDay(d) }

export default function TaskAssignSheet({ conversation, meId, source, draft, files = [], workload, senderName, onClose, onDone, onMoreOptions }: {
  conversation: Conversation
  meId: string
  source: Msg | null
  draft: Draft
  // Files staged in the composer when the task was made from it: they go on
  // the task as attachments (a screenshot is usually the point of the task).
  files?: File[]
  workload: Workload
  senderName: (uid: string) => string
  onClose: () => void
  onDone: (card: Msg) => void
  onMoreOptions: (d: Draft) => void
}) {
  const cardRef = useDialog<HTMLDivElement>(onClose)
  const [title, setTitle] = useState(draft.title || '')
  const [notes, setNotes] = useState(draft.description || '')
  const [priority, setPriority] = useState<string>(PRIORITIES.includes(draft.priority as any) ? draft.priority! : 'Medium')
  // A date the message named wins; otherwise follow the priority (the same
  // default the server would apply) until the person picks one themselves.
  const [due, setDue] = useState(draft.due_date || defaultDueDate(draft.priority || 'Medium'))
  const dueTouched = useRef(!!draft.due_date)
  const [assignee, setAssignee] = useState<string>(draft.assignee_id || '')
  const [others, setOthers] = useState<OrgUser[] | null>(null)
  const [picking, setPicking] = useState(false)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { api.get('/chat/users').then((d) => setOthers(d.users || [])).catch(() => setOthers([])) }, [])
  useEffect(() => { if (!dueTouched.current) setDue(defaultDueDate(priority)) }, [priority])

  // Who is offered first: the people in this chat (the obvious owners), you
  // included — assigning to yourself is how a chat becomes your own to-do.
  const inChat = useMemo(() => {
    const ms = conversation.members.slice().sort((a, b) => (a.id === meId ? 1 : b.id === meId ? -1 : a.name.localeCompare(b.name)))
    return ms.map((m) => ({ id: m.id, name: m.name, avatar_color: m.avatar_color, avatar_file: m.avatar_file || null, role: m.job_role || '' }))
  }, [conversation.members, meId])
  const everyone = useMemo(() => {
    const base = [...inChat]
    for (const u of others || []) if (!base.some((b) => b.id === u.id)) base.push({ id: u.id, name: u.name, avatar_color: u.avatar_color, avatar_file: u.avatar_file || null, role: u.role })
    return base
  }, [inChat, others])
  const chosen = everyone.find((p) => p.id === assignee) || (draft.assignee_id === assignee && draft.assignee_name ? { id: assignee, name: draft.assignee_name, avatar_color: undefined, avatar_file: null, role: '' } : null)
  const shown = q.trim()
    ? everyone.filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()))
    : everyone
  const load = assignee ? workload[assignee] : undefined
  const firstName = (n?: string) => (n || '').split(' ')[0]

  const submit = async () => {
    if (!title.trim() || !assignee || busy) return
    setBusy(true)
    try {
      const task = await api.post('/tasks', {
        title: title.trim(),
        description: notes.trim(),
        assignee_id: assignee,
        priority,
        due_date: due || undefined,
        source_quote: source?.body || source?.transcript || undefined,
        // The message's own picture or document goes onto the task (server-side,
        // so nothing is downloaded and sent back up from the phone).
        source_message_id: draft.source_message_id || (source?.file ? source.id : undefined),
      })
      // The task exists from here on; a card or a file that fails to post
      // must not pretend the assignment failed too.
      if (files.length) {
        const { ok, skipped } = attachable(files)
        const sent = await Promise.allSettled(ok.map((f) => attachToTask(task.id, f)))
        const lost = sent.filter((x) => x.status === 'rejected').length
        if (lost) toast.error(lost === 1 ? 'The task was assigned, but one file could not be attached to it' : `The task was assigned, but ${lost} files could not be attached to it`)
        if (skipped) toast.error(skipped)
      }
      try {
        const card = await api.post(`/chat/conversations/${conversation.id}/task-card`, { taskId: task.id, replyTo: source?.id })
        onDone(card)
      } catch (e: any) {
        toast.error('The task was assigned, but its card could not be posted here: ' + e.message)
        onClose()
        return
      }
      toast.success(assignee === meId ? 'Added to your tasks' : `Assigned to ${firstName(chosen?.name) || 'them'}`)
    } catch (e: any) {
      toast.error('Could not assign the task: ' + e.message)
      setBusy(false)
    }
  }

  const person = (p: { id: string; name: string; avatar_color?: string; avatar_file?: string | null }, size = 28) =>
    <Avatar name={p.name} color={p.avatar_color} size={size} src={p.avatar_file ? userAvatarUrl(p.id, p.avatar_file) : undefined} />

  return (
    <div className="modal-overlay wa-sheet-overlay" onClick={onClose}>
      <div className="modal-card wa-sheet ta-sheet" ref={cardRef} role="dialog" aria-modal="true" aria-label="Assign a task" onClick={(e) => e.stopPropagation()}>
        <div className="wa-sheet-head">
          <span className="ta-head-ic" aria-hidden="true"><TaskGlyph size={18} /></span>
          <h3>Assign a task</h3>
          <button className="ic-btn" onClick={onClose} aria-label="Close"><Ic name="close" size={18} /></button>
        </div>
        <div className="wa-sheet-body">
          {source && (source.body || source.transcript || source.file) && (
            <div className="ta-quote">
              <span className="ta-quote-who">{source.sender_id === meId ? 'You' : senderName(source.sender_id)}</span>
              <span className="ta-quote-text">{source.transcript || source.body || source.file?.name}</span>
            </div>
          )}

          {files.length > 0 && (
            <div className="ta-files">
              <Ic name="attach" size={14} />
              <span>{files.length === 1 ? `${files[0].name} goes with the task` : `${files.length} files go with the task`}</span>
            </div>
          )}
          {!files.length && source?.file && (
            <div className="ta-files">
              <Ic name="attach" size={14} />
              <span>{(source.file.type || '').startsWith('image/') ? 'The photo' : source.file.name} goes with the task</span>
            </div>
          )}

          <label className="ta-label" htmlFor="ta-title">Task</label>
          <input id="ta-title" className="ta-input" value={title} maxLength={200} autoFocus
            placeholder="What needs doing?" onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }} />

          <div className="ta-label">Assign to</div>
          {!picking ? (
            <div className="ta-people" role="radiogroup" aria-label="Assign to">
              {inChat.map((p) => (
                <button key={p.id} type="button" role="radio" aria-checked={assignee === p.id}
                  className={'ta-person' + (assignee === p.id ? ' on' : '')} onClick={() => setAssignee(p.id)}>
                  {person(p, 26)}
                  <span>{p.id === meId ? 'Me' : firstName(p.name)}</span>
                </button>
              ))}
              {chosen && !inChat.some((p) => p.id === chosen.id) && (
                <button type="button" role="radio" aria-checked className="ta-person on" onClick={() => setPicking(true)}>
                  {person(chosen, 26)}<span>{firstName(chosen.name)}</span>
                </button>
              )}
              <button type="button" className="ta-person ta-more" onClick={() => { setPicking(true); setQ('') }}>
                <span className="ta-more-ic"><Ic name="search" size={14} /></span><span>Someone else</span>
              </button>
            </div>
          ) : (
            <div className="ta-pick">
              <input className="ta-input" autoFocus placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
              <div className="ta-pick-list">
                {others === null && <div className="ta-empty"><span className="spinner" /></div>}
                {others !== null && shown.length === 0 && <div className="ta-empty">Nobody matches</div>}
                {shown.map((p) => (
                  <button key={p.id} type="button" className={'ta-pick-row' + (assignee === p.id ? ' on' : '')} onClick={() => { setAssignee(p.id); setPicking(false) }}>
                    {person(p, 30)}
                    <span className="ta-pick-name">{p.id === meId ? `${p.name} (you)` : p.name}</span>
                    {workload[p.id]?.open ? <span className={'ta-load' + (workload[p.id].overdue ? ' late' : '')}>{workload[p.id].open} open</span> : null}
                  </button>
                ))}
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicking(false)}>Done</button>
            </div>
          )}
          {/* What they are already carrying, at the moment you hand them more. */}
          {chosen && load && load.open > 0 && !picking && (
            <div className={'ta-loadline' + (load.overdue ? ' late' : '')}>
              <Ic name={load.overdue ? 'warning' : 'check'} size={12} />
              {chosen.id === meId ? 'You have' : `${firstName(chosen.name)} has`} {load.open} open task{load.open === 1 ? '' : 's'}{load.overdue ? `, ${load.overdue} overdue` : ''}
            </div>
          )}

          <div className="ta-label">Due</div>
          <div className="ta-chips">
            {([['Today', inDays(0)], ['Tomorrow', inDays(1)], ['In 3 days', inDays(3)], ['Next Monday', nextMonday()]] as const).map(([l, v]) => (
              <button key={l} type="button" className={'ta-chip' + (due === v ? ' on' : '')} onClick={() => { dueTouched.current = true; setDue(v) }}>{l}</button>
            ))}
            <input type="date" className="ta-date" value={due} min={inDays(0)} aria-label="Due date"
              onChange={(e) => { dueTouched.current = true; setDue(e.target.value) }} />
          </div>

          <div className="ta-label">Priority</div>
          <div className="ta-seg" role="radiogroup" aria-label="Priority">
            {PRIORITIES.map((p) => (
              <button key={p} type="button" role="radio" aria-checked={priority === p} className={'ta-seg-btn p-' + p.toLowerCase() + (priority === p ? ' on' : '')} onClick={() => setPriority(p)}>{p}</button>
            ))}
          </div>

          <label className="ta-label" htmlFor="ta-notes">Notes <span className="muted">(optional)</span></label>
          <textarea id="ta-notes" className="ta-input ta-notes" rows={2} value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} placeholder="Anything they should know" />
        </div>
        <div className="wa-sheet-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onMoreOptions({ title, description: notes, priority, due_date: due, assignee_id: assignee, assignee_name: chosen?.name || null })}>More options</button>
          <button type="button" className="btn btn-primary" disabled={busy || !title.trim() || !assignee} onClick={submit}>
            {busy ? 'Assigning…' : !assignee ? 'Pick who' : assignee === meId ? 'Add to my tasks' : `Assign to ${firstName(chosen?.name)}`}
          </button>
        </div>
      </div>
    </div>
  )
}
