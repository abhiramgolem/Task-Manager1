import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, Task, User, Attachment, taskAttachmentUrl } from '../api'
import { useAuth } from '../auth'
import { PriorityBadge, StatusBadge, CategoryBadge, Avatar, ConfidenceTag, Evidence, Ic, dueLabel, fmtDateTime, fmtBytes, PRIORITY_COLORS, AutoTextarea } from '../ui'
import CategorySelect from './CategorySelect'
import PhotoViewer from './PhotoViewer'
import { confirmDialog } from '../lib/confirm'
import { toast } from '../lib/toast'
import { onDownloadLink } from '../lib/saveFile'
import { useDialog } from '../lib/useDialog'
import { clipboardFiles, droppedFiles, dragHasFiles } from '../lib/pasteFiles'
import { attachable, attachToTask, fileExt } from '../lib/taskAttach'
import { useSurface } from '../voice/uiRegistry'
import { typeInto, pickValue, flashPress, settle, findVaEl } from '../voice/uiController'

const STATUSES = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Reopened']

// onChange receives the updated task when the mutation returned one, so list pages
// can patch that row in place instead of re-fetching everything; called with no
// argument (→ caller should re-fetch) after deletes/uploads.
// `variant` decides how the drawer is mounted, not what it contains. 'modal' is
// the overlay it has always been; 'pane' docks the same content beside the list
// on a wide screen, where covering the page to read one task wastes the room.
// `focusCommentId` is a comment to open on (a tapped comment notification);
// `focusKey` changes on each such arrival, so a second tap lands again.
export default function TaskDrawer({ taskId, onClose, onChange, variant = 'modal', focusCommentId = null, focusKey = 0 }: { taskId: string; onClose: () => void; onChange?: (updated?: Task) => void; variant?: 'modal' | 'pane'; focusCommentId?: string | null; focusKey?: number }) {
  const { user } = useAuth()
  const pane = variant === 'pane'
  const drawerRef = useDialog<HTMLDivElement>(onClose, !pane)
  // A screenshot pasted anywhere in the drawer (Ctrl+V — in the comment box too)
  // or files dropped on it are attached to the task: comments carry words only,
  // so the task's attachments are where a picture belongs. A paste of words is
  // still words (lib/pasteFiles). Reached through a ref because `shell` is built
  // before uploadFiles exists in a render that returns early (while loading).
  const takeFilesRef = useRef<(files: File[]) => void>(() => {})
  const fileEvents = {
    onPaste: (e: React.ClipboardEvent) => {
      const files = clipboardFiles(e.clipboardData)
      if (!files.length) return
      e.preventDefault()
      takeFilesRef.current(files)
    },
    onDragOver: (e: React.DragEvent) => { if (dragHasFiles(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } },
    onDrop: (e: React.DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return
      e.preventDefault()
      takeFilesRef.current(droppedFiles(e.dataTransfer))
    },
  }
  // A plain function, deliberately not a component: a component declared inside
  // render is a new type every render, so React would unmount and remount the
  // whole drawer on each keystroke and every field would lose what was typed.
  const shell = (label: string, children: React.ReactNode) => pane
    ? <div className="drawer drawer-pane" ref={drawerRef} aria-label={label} {...fileEvents}>{children}</div>
    : (
      <div className="overlay" onClick={onClose}>
        <div className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()} {...fileEvents}>{children}</div>
      </div>
    )
  const [task, setTask] = useState<Task | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [comment, setComment] = useState('')
  // Which comment is open for editing, and the draft text while it is.
  const [editingComment, setEditingComment] = useState<string | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  // Which comment's ⋯ menu is open. Same pattern as the chat message menu,
  // reusing its classes so the two read as the same control.
  const [commentMenu, setCommentMenu] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingAssignee, setPendingAssignee] = useState('')
  // A status the user has picked but not yet confirmed — applied only on "Accept".
  const [pendingStatus, setPendingStatus] = useState('')
  // Inline edit of the task's core details (title, description, due date).
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState({ title: '', description: '', due_date: '' })
  // Split & share: when open, `parts` holds the rows (each = a piece + a person).
  const [showSplit, setShowSplit] = useState(false)
  const [parts, setParts] = useState<{ title: string; assignee_id: string }[]>([])
  const updatePart = (i: number, patch: Partial<{ title: string; assignee_id: string }>) =>
    setParts((ps) => ps.map((p, idx) => (idx === i ? { ...p, ...patch } : p)))

  // Progress slider: while the user is dragging, `dragProgress` owns the value so a
  // re-render (or a save still in flight) can't yank the thumb back to the stale
  // server number. null = nobody is dragging, the saved value is the truth.
  const [dragProgress, setDragProgress] = useState<number | null>(null)
  const draggingRef = useRef(false)                    // pointer is down on the slider
  const pendingProgress = useRef<number | null>(null)  // value still to be saved
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Who changed what, newest first — read back from the audit trail the server
  // has always written. Fetched alongside the task and refreshed after every
  // mutation, so an edit shows its author the moment it is made.
  type Edit = { actor_id: string; actor_name: string; avatar_color?: string; fields: string[]; reassigned: boolean; at: string }
  const [edits, setEdits] = useState<Edit[]>([])
  const loadEdits = () => api.get(`/tasks/${taskId}/history`).then(setEdits).catch(() => setEdits([]))

  const [loadErr, setLoadErr] = useState(false)
  const load = () => { setLoadErr(false); loadEdits(); return api.get(`/tasks/${taskId}`).then(setTask).catch(() => setLoadErr(true)) }
  useEffect(() => {
    setEditing(false); load(); api.get('/users').then(setUsers).catch(() => {})
    setDragProgress(null); pendingProgress.current = null; draggingRef.current = false
  }, [taskId])
  useEffect(() => () => { if (progressTimer.current) clearTimeout(progressTimer.current) }, [])
  // Close the comment menu on any click outside it.
  //
  // This listens for mousedown, which fires BEFORE click — so the menu itself
  // stops mousedown propagating (see msg-menu-wrap below). Without that the menu
  // unmounts before its own button's onClick can fire, and Edit silently does
  // nothing: the menu closes and no editor opens.
  useEffect(() => {
    if (!commentMenu) return
    const close = () => setCommentMenu(null)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [commentMenu])
  // Keep the member picker in sync whenever the task's current owner changes.
  useEffect(() => { setPendingAssignee(task?.assignee?.id || '') }, [task?.assignee?.id])
  // Reset the pending status whenever the saved status changes (incl. after Accept).
  useEffect(() => { setPendingStatus(task?.status || '') }, [task?.status])

  // Open on the comment a notification announced: scroll the drawer to it and
  // flash it. Comments sit at the very bottom, under the fields, timeline and
  // attachments, so opening at the top left the reader to hunt for it. Once per
  // arrival, not per render: the drawer re-renders on every edit and must not
  // drag the reader back to the comment each time.
  const [flashComment, setFlashComment] = useState<string | null>(null)
  const landedRef = useRef('')
  const refetchedRef = useRef('')
  useEffect(() => {
    if (!focusCommentId || !task || task.id !== taskId) return
    const key = `${focusKey}:${focusCommentId}`
    if (landedRef.current === key) return
    const hit = !!task.comments?.some((c: any) => c.id === focusCommentId)
    // A notification for the task already open names a comment posted after the
    // drawer loaded it: read the task again once before calling it deleted.
    if (!hit && refetchedRef.current !== key) { refetchedRef.current = key; load(); return }
    landedRef.current = key
    const box = drawerRef.current
    const el = box?.querySelector<HTMLElement>(hit ? `[data-comment="${focusCommentId}"]` : '[data-comments]')
    if (box && el) {
      // The drawer's own scroll, not scrollIntoView, which would also scroll
      // whatever page sits behind the drawer.
      const r = el.getBoundingClientRect(), b = box.getBoundingClientRect()
      const top = box.scrollTop + r.top - b.top - Math.max(16, (box.clientHeight - r.height) / 2)
      // A jump from far off, as in chat: a long glide ends after the flash does.
      const far = Math.abs(top - box.scrollTop) > box.clientHeight * 2
      box.scrollTo({ top, behavior: far ? 'auto' : 'smooth' })
    }
    // A flash still fading from the last notification belongs to that one.
    setFlashComment(null)
    if (!hit) { toast.info('That comment has since been deleted'); return }
    requestAnimationFrame(() => setFlashComment(focusCommentId))
    setTimeout(() => setFlashComment((f) => (f === focusCommentId ? null : f)), 2600)
  }, [focusCommentId, focusKey, task, taskId])

  const mutate = async (fn: () => Promise<any>) => {
    setBusy(true)
    try { const t = await fn(); if (t?.id) setTask(t); else await load(); await loadEdits(); onChange?.(t?.id ? t : undefined) }
    finally { setBusy(false) }
  }
  const setStatus = (status: string) => mutate(() => api.post(`/tasks/${taskId}/status`, { status }))
  const setAssignee = (assignee_id: string) => mutate(() => api.patch(`/tasks/${taskId}`, { assignee_id: assignee_id || null }))
  const setPriority = (priority: string) => mutate(() => api.patch(`/tasks/${taskId}`, { priority }))
  const setCategory = (category: string) => mutate(() => api.patch(`/tasks/${taskId}`, { category: category || null }))
  // Attach more files to an existing task (uploaded immediately). Any type, up
  // to 500 MB each. The upload has its own state rather than `busy`: a big video
  // takes minutes, and the rest of the drawer should not lock for all of them.
  const attachInput = useRef<HTMLInputElement>(null)
  const [upload, setUpload] = useState<{ taskId: string; name: string; pct: number; n: number; of: number } | null>(null)
  // The attached picture open full size, where it can be zoomed into. It used
  // to open in a new browser tab, which on the phone app left the app.
  const [photoAt, setPhotoAt] = useState<string | null>(null)
  // The task on screen now. The modal drawer is reused when another task opens,
  // so a file that lands after that must not put its old task back on screen.
  const taskIdRef = useRef(taskId)
  taskIdRef.current = taskId
  // `announce`: a paste or a drop has nothing else on screen to show it worked.
  const uploadFiles = async (list: FileList | File[] | null, announce = false) => {
    if (!list || upload) return
    const { ok: picked, skipped } = attachable(list)
    if (attachInput.current) attachInput.current.value = ''
    if (skipped) toast.error(skipped)
    if (!picked.length) return
    const tid = taskId
    const done: string[] = []
    try {
      for (let i = 0; i < picked.length; i++) {
        const f = picked[i]
        setUpload({ taskId: tid, name: f.name, pct: 0, n: i + 1, of: picked.length })
        try {
          const t = await attachToTask(tid, f, (pct) => setUpload((u) => (u ? { ...u, pct } : u)))
          done.push(f.name)
          // Each file shows up as it lands, not after the whole batch.
          if (t?.id && t.id === taskIdRef.current) setTask(t)
        } catch (e: any) { toast.error(`Couldn't attach ${f.name}: ${e?.message || 'upload failed'}`) }
      }
    } finally { setUpload(null) }
    if (done.length && tid === taskIdRef.current) loadEdits()
    if (done.length) onChange?.()
    if (announce && done.length) toast.success(done.length === 1 ? `Attached "${done[0]}" to this task` : `Attached ${done.length} files to this task`)
  }
  takeFilesRef.current = (files) => { if (!busy && !upload) uploadFiles(files, true) }
  // Deleting an attachment is irreversible — confirm it like the task delete.
  const removeAttachment = async (a: Attachment) => {
    if (!(await confirmDialog({ title: 'Remove attachment', message: `Remove "${a.filename}"? This cannot be undone.`, confirmText: 'Remove', danger: true }))) return
    mutate(() => api.del(`/tasks/attachments/${a.id}`))
  }
  const setProgress = (progress: number) => mutate(() => api.patch(`/tasks/${taskId}`, { progress }))
  // Save once, when the user lets go — not once per pixel of travel. Dragging only
  // moves the local value, so the thumb stays exactly where the finger left it.
  const commitProgress = async () => {
    if (progressTimer.current) { clearTimeout(progressTimer.current); progressTimer.current = null }
    draggingRef.current = false
    const value = pendingProgress.current
    pendingProgress.current = null
    // Hand the slider back to the saved value only if no newer drag has started.
    const release = () => { if (pendingProgress.current === null && !draggingRef.current) setDragProgress(null) }
    if (value === null) return
    if (value === task?.progress) { release(); return }
    try { await setProgress(value) } catch { toast.error("Couldn't save the progress — try again.") } finally { release() }
  }
  const onProgressInput = (value: number) => {
    setDragProgress(value)
    pendingProgress.current = value
    // Keyboard and assistive changes never send a pointer release — save shortly
    // after the last one instead. While a pointer is down, the release saves.
    if (progressTimer.current) clearTimeout(progressTimer.current)
    if (!draggingRef.current) progressTimer.current = setTimeout(commitProgress, 400)
  }
  const approve = (decision: string) => mutate(() => api.post(`/tasks/${taskId}/approve`, { decision }))
  const addComment = async () => { if (!comment.trim()) return; await mutate(() => api.post(`/tasks/${taskId}/comments`, { body: comment })); setComment('') }
  const saveComment = async (c: any) => {
    const body = commentDraft.trim()
    if (!body || body === c.body) { setEditingComment(null); return }
    await mutate(() => api.patch(`/tasks/${taskId}/comments/${c.id}`, { body }))
    setEditingComment(null)
  }
  // A comment has no recycle bin, unlike a task — so this asks, and says so.
  const removeComment = async (c: any) => {
    const ok = await confirmDialog({
      title: 'Delete this comment?',
      message: `“${c.body.length > 120 ? c.body.slice(0, 117) + '…' : c.body}”

This cannot be undone — comments are not kept in the recycle bin.`,
      confirmText: 'Delete', danger: true,
    })
    if (!ok) return
    await mutate(() => api.del(`/tasks/${taskId}/comments/${c.id}`))
  }

  // ---- Agent surface -------------------------------------------------------
  // Every capability drives the drawer's OWN handlers, so a voice edit and a hand
  // edit are the same code path — same optimistic update, same onChange back to the
  // list, same toast on failure. The flashPress calls only render the click; if a
  // control is not on screen for this role, the press is a no-op and the change
  // still happens correctly.
  useSurface('task.drawer', {
    id: () => taskId,
    changeStatus: async ({ status }: { status: string }) => {
      // Two real presses, as a person would: pick the status, then accept it.
      await flashPress(findVaEl(`task.drawer.status.${status}`))
      setPendingStatus(status)
      await settle()
      await flashPress(findVaEl('task.drawer.acceptStatus'))
      await setStatus(status)
    },
    assignTo: async ({ id }: { id: string }) => {
      await pickValue(findVaEl('task.drawer.assignee'), id, setPendingAssignee)
      await settle()
      await flashPress(findVaEl('task.drawer.assign'))
      await setAssignee(id)
    },
    comment: async ({ body }: { body: string }) => {
      await typeInto(findVaEl('task.drawer.comment'), body, setComment)
      await settle()          // addComment reads `comment` from state, not an arg
      await flashPress(findVaEl('task.drawer.postComment'))
      await addComment()
    },
  }, !!task)
  // Open the inline editor, seeded from the current task.
  const startEdit = () => {
    if (!task) return
    setEditForm({ title: task.title || '', description: task.description || '', due_date: task.due_date || '' })
    setEditing(true)
  }
  // Persist the edited details. Clearing due_date_raw makes the picked date authoritative.
  const saveEdit = async () => {
    const title = editForm.title.trim()
    if (!title) return
    await mutate(() => api.patch(`/tasks/${taskId}`, {
      title,
      description: editForm.description.trim(),
      due_date: editForm.due_date || null,
      due_date_raw: null,
    }))
    setEditing(false)
  }
  const openSplit = () => { setParts([{ title: task?.title || '', assignee_id: '' }]); setShowSplit(true) }
  const doSplit = async () => {
    const valid = parts.filter((p) => p.title.trim() && p.assignee_id)
    if (!valid.length) return
    await mutate(() => api.post(`/tasks/${taskId}/split`, { parts: valid }))
    // The response is only the parent, but the split CREATED new tasks — signal a
    // no-payload change so list pages re-fetch instead of just patching the parent.
    onChange?.()
    setShowSplit(false)
  }
  const del = async () => {
    if (!(await confirmDialog({ title: 'Delete task', message: 'Delete this task? This cannot be undone.', confirmText: 'Delete', danger: true }))) return
    setBusy(true)
    try { await api.del(`/tasks/${taskId}`); onChange?.(); onClose() }
    finally { setBusy(false) }
  }

  if (loadErr) return shell('Task', (
      <>
        <div className="card-head spread"><h3 style={{ margin: 0, fontSize: 16 }}>Task</h3><button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="empty-state">
          <div className="empty-state-icon"><Ic name="warning" size={40} /></div>
          <div className="empty-state-title">Couldn't load this task</div>
          <div className="empty-state-hint">Check your connection and try again.</div>
          <div className="empty-state-action"><button className="btn btn-primary btn-sm" onClick={load}>Retry</button></div>
        </div>
      </>
  ))
  if (!task) return shell('Loading task', (
    <div className="card-pad" style={{ display: 'grid', gap: 12 }}>{Array.from({ length: 5 }).map((_, i) => <span key={i} className="skeleton skel-row" />)}</div>
  ))
  const isManager = user?.role !== 'employee'
  // The person who handed this task out (assigned it, or split the part off) can
  // decide its submission too — mirrors the per-task check on POST /:id/approve.
  const isAssigner = !!user && task.assigned_by_id === user.id && task.assignee?.id !== user.id
  // A task you raised for yourself: yours to finish or bin, no manager sign-off.
  // Mirrors isOwnSelfCreated() on the server, which enforces it — split parts and
  // work reassigned onto you came from someone else's plan and keep the approval
  // flow. The server is the authority here; this only decides what to render.
  const isOwnWork = !!user
    && !task.parent_task_id && !task.reassigned_at
    && task.assignee?.id === user.id && task.assigned_by_id === user.id
  // Managers can delete anything; everyone else, only what they made for themselves.
  const canDelete = isManager || isOwnWork || (task.visible_to_manager === 0 && task.assignee?.id === user?.id)
  // The task owner (or a manager) can split a top-level task into shared parts.
  const canSplit = (isManager || task.assignee?.id === user?.id) && !task.parent_task_id
  // Whoever set the work owns what it asks for: managers, and the person who
  // handed it out. Being given a task is NOT a licence to rewrite it — the
  // assignee moves status and progress and nothing else, so they can't quietly
  // reword, reprioritise or hand on the brief someone set them. This gates the
  // whole brief, not just the title: assignee, priority, category and due date
  // hang off it too. `assigned_by_id` rather than isAssigner, so a task you
  // raised for yourself stays yours to edit (isAssigner excludes exactly that
  // case — you may not approve your own submission, but you may edit it).
  const canEdit = isManager || (!!user && task.assigned_by_id === user.id)
  const subs = task.subtasks || []
  const subDone = subs.filter((s: any) => s.status === 'Done').length
  const subPct = subs.length ? Math.round((subDone / subs.length) * 100) : 0
  const lookupUser = (uid?: string | null) => users.find((u) => u.id === uid)

  return shell(task.title, (
      <>
        <div className="card-head spread">
          <div className="dr-headtitle">Task details</div>
          <div className="row">
            {canEdit && !editing && <button className="btn btn-sm row" style={{ gap: 6 }} disabled={busy} onClick={startEdit} title="Edit task details"><Ic name="edit" size={14} /> Edit</button>}
            {canDelete && <button className="btn btn-sm btn-danger row" style={{ gap: 6 }} disabled={busy} onClick={del} title="Delete task"><Ic name="trash" size={14} /> Delete</button>}
            <button className="btn btn-ghost" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="card-pad">
          {editing ? (
            <div className="grid" style={{ gap: 10 }}>
              <div>
                <label htmlFor="task-edit-title">Title</label>
                <input id="task-edit-title" value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} autoFocus />
              </div>
              <div>
                <label htmlFor="task-edit-desc">Description</label>
                <textarea id="task-edit-desc" rows={3} value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} placeholder="Add more detail…" />
              </div>
              <div className="row">
                <button className="btn btn-primary btn-sm" disabled={busy || !editForm.title.trim()} onClick={saveEdit}>
                  {busy ? <span className="spinner" /> : '✓ Save changes'}
                </button>
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="dr-hero" style={{ ['--pr' as any]: PRIORITY_COLORS[task.priority] || 'var(--primary)' }}>
              <h2 className="dr-title">{task.title}</h2>
              <div className="dr-badges">
                <PriorityBadge p={task.priority} /><StatusBadge s={task.status} /><CategoryBadge c={task.category} />
                {task.visible_to_manager === 0 && <span className="badge row" style={{ gap: 5, background: 'var(--info-bg)', color: 'var(--info-ink)', border: '1px solid var(--info-border)' }}><Ic name="lock" size={12} /> Private</span>}
              </div>
              <ConfidenceTag c={task.ownership_confidence} />
              {task.description && task.description !== task.title && (
                <>
                  <div className="dr-section-label">Description</div>
                  <p className="dr-desc">{task.description}</p>
                </>
              )}
            </div>
          )}

          {(task.source_quote || (task as any).assignee_reasoning) && (
            <div style={{ margin: '12px 0' }}>
              <Evidence quote={task.source_quote} reasoning={(task as any).assignee_reasoning} />
            </div>
          )}

          <div className="dr-fields">
            <div className="dr-field dr-field--tall">
              <span className="dr-field-label">Assignee</span>
              <div className="dr-field-val">
                {canEdit ? (
                  <div className="row" style={{ gap: 8 }}>
                    <select data-va="task.drawer.assignee" value={pendingAssignee} disabled={busy} onChange={(e) => setPendingAssignee(e.target.value)} style={{ flex: 1 }}>
                      <option value="">Select member…</option>
                      {users.filter(u => u.role !== 'admin').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                    <button
                      data-va="task.drawer.assign"
                      className="btn btn-primary btn-sm"
                      disabled={busy || pendingAssignee === (task.assignee?.id || '')}
                      onClick={() => setAssignee(pendingAssignee)}
                    >
                      {busy ? <span className="spinner" /> : pendingAssignee ? 'Assign' : 'Unassign'}
                    </button>
                  </div>
                ) : (
                  <div className="row" style={{ gap: 8 }}>{task.assignee ? <><Avatar name={task.assignee.name} color={task.assignee.avatar_color} size={24} /> {task.assignee.name}</> : '—'}</div>
                )}
                {task.assignee_name_raw && !task.assignee && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Heard as: “{task.assignee_name_raw}”</div>}
              </div>
            </div>
            <div className="dr-field">
              <span className="dr-field-label">Priority</span>
              <div className="dr-field-val">
                {canEdit ? (
                  <select value={task.priority} onChange={(e) => setPriority(e.target.value)} style={{ width: 'auto' }}>
                    {['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}
                  </select>
                ) : <PriorityBadge p={task.priority} />}
              </div>
            </div>
            <div className="dr-field">
              <span className="dr-field-label">Category</span>
              <div className="dr-field-val">
                {canEdit ? (
                  <CategorySelect value={task.category || ''} onChange={setCategory} blankLabel="Uncategorized" compact />
                ) : (task.category ? <CategoryBadge c={task.category} /> : <span className="muted">Uncategorized</span>)}
              </div>
            </div>
            <div className="dr-field">
              <span className="dr-field-label">Assigned by</span>
              <div className="dr-field-val">
                <div className="row" style={{ gap: 8 }}>{task.assignedBy ? <><Avatar name={task.assignedBy.name} size={24} /> {task.assignedBy.name}</> : '—'}</div>
              </div>
            </div>
            {/* Who closed it, beside who asked for it. Without this a finished task
                showed when it was completed but never by whom, and closing can be
                done by the owner, any manager, or an approver. */}
            {task.status === 'Done' && (
              <div className="dr-field">
                <span className="dr-field-label">Completed by</span>
                <div className="dr-field-val">
                  {task.completedBy ? (
                    <div className="row" style={{ gap: 8 }}>
                      <Avatar name={task.completedBy.name} color={task.completedBy.avatar_color} size={24} /> {task.completedBy.name}
                      {task.approval_status === 'approved' && <span className="muted" style={{ fontWeight: 500, fontSize: 12.5 }}>· approved</span>}
                    </div>
                  ) : <span className="muted" style={{ fontWeight: 500 }}>Not recorded</span>}
                </div>
              </div>
            )}
            <div className="dr-field">
              <span className="dr-field-label">Due date</span>
              <div className="dr-field-val">
                {editing
                  ? <input type="date" value={editForm.due_date} onChange={(e) => setEditForm({ ...editForm, due_date: e.target.value })} style={{ width: 'auto' }} />
                  : <span>{dueLabel(task)}</span>}
              </div>
            </div>
          </div>

          <div style={{ margin: '16px 0' }}>
            <label>Timeline</label>
            <div style={{ fontSize: 13, display: 'grid', gap: 6 }}>
              <div className="spread"><span className="muted row" style={{ gap: 7 }}><Ic name="doc" size={14} /> Created</span><span>{fmtDateTime(task.created_at)}</span></div>
              <div className="spread"><span className="muted row" style={{ gap: 7 }}><Ic name="pin" size={14} /> Assigned</span><span>{fmtDateTime(task.assigned_at)}</span></div>
              {task.submitted_at && <div className="spread"><span className="muted row" style={{ gap: 7 }}><Ic name="send" size={14} /> Submitted</span><span>{fmtDateTime(task.submitted_at)}</span></div>}
              <div className="spread"><span className="muted row" style={{ gap: 7 }}><Ic name="check" size={14} /> Completed</span><span style={{ color: task.completed_at ? 'var(--success-ink)' : 'inherit', textAlign: 'right' }}>{fmtDateTime(task.completed_at)}{task.completed_at && task.completedBy && <> · {task.completedBy.name}</>}</span></div>
            </div>
          </div>

          {edits.length > 0 && (
            <div style={{ margin: '16px 0' }}>
              <label>Edited by</label>
              <div style={{ fontSize: 13, display: 'grid', gap: 8 }}>
                {edits.map((e, i) => (
                  <div key={i} className="spread" style={{ alignItems: 'flex-start', gap: 10 }}>
                    <span className="row" style={{ gap: 7, minWidth: 0 }}>
                      <Avatar name={e.actor_name} color={e.avatar_color} size={22} />
                      <span style={{ minWidth: 0 }}>
                        <b>{e.actor_name}</b>{' '}
                        <span className="muted">
                          {e.reassigned ? 'reassigned it and changed ' : 'changed '}{e.fields.join(', ')}
                        </span>
                      </span>
                    </span>
                    <span className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(e.at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ margin: '14px 0' }}>
            <label htmlFor="task-progress">Progress — {dragProgress ?? task.progress}%</label>
            <input id="task-progress" type="range" min={0} max={100} step={10} value={dragProgress ?? task.progress}
              aria-valuetext={`${dragProgress ?? task.progress} percent`}
              onChange={(e) => onProgressInput(Number(e.target.value))}
              onPointerDown={() => { draggingRef.current = true }}
              onPointerUp={commitProgress} onPointerCancel={commitProgress} onLostPointerCapture={commitProgress}
              onKeyUp={commitProgress} onBlur={commitProgress} />
          </div>

          <div style={{ margin: '16px 0' }}>
            <label>Status</label>
            {isManager ? (
              <>
                <div className="row wrap">
                  {STATUSES.map((s) => (
                    <button data-va={`task.drawer.status.${s}`} key={s} className={'btn btn-sm' + (pendingStatus === s ? ' btn-primary' : '')} disabled={busy} onClick={() => setPendingStatus(s)}>{s}</button>
                  ))}
                </div>
                {pendingStatus !== task.status && (
                  <div className="row" style={{ marginTop: 10 }}>
                    <button data-va="task.drawer.acceptStatus" className="btn btn-primary btn-sm" disabled={busy} onClick={() => setStatus(pendingStatus)}>
                      {busy ? <span className="spinner" /> : `✓ Accept change → ${pendingStatus}`}
                    </button>
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPendingStatus(task.status)}>Cancel</button>
                  </div>
                )}
              </>
            ) : isOwnWork ? (
              /* Your own task: the same direct control a manager gets, minus the
                 approval states — there is nobody to submit it to. */
              <>
                <div className="row wrap">
                  {['To Do', 'In Progress', 'Blocked', 'Done'].map((s) => (
                    <button key={s} className={'btn btn-sm' + (pendingStatus === s ? ' btn-primary' : '')} disabled={busy} onClick={() => setPendingStatus(s)}>{s}</button>
                  ))}
                </div>
                {pendingStatus !== task.status && (
                  <div className="row" style={{ marginTop: 10 }}>
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => setStatus(pendingStatus)}>
                      {busy ? <span className="spinner" /> : `✓ Accept change → ${pendingStatus}`}
                    </button>
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPendingStatus(task.status)}>Cancel</button>
                  </div>
                )}
                {task.status !== 'Done' && (
                  <>
                    <button className="btn btn-primary" style={{ marginTop: 10, width: '100%' }} disabled={busy} onClick={() => setStatus('Done')}>
                      {busy ? <span className="spinner" /> : '✓ Mark as complete'}
                    </button>
                    <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>You created this task for yourself — completing it needs no approval.</p>
                  </>
                )}
              </>
            ) : task.status === 'Done' ? (
              <div className="dr-done-note">
                {task.completedBy
                  ? `✓ Completed — ${task.approval_status === 'approved' ? 'approved' : 'marked done'} by ${task.completedBy.id === user?.id ? 'you' : task.completedBy.name}.`
                  : '✓ Completed.'}
              </div>
            ) : task.approval_status === 'pending' ? (
              <div className="card-pad" style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)', borderRadius: 10 }}>
                <strong className="row" style={{ gap: 7 }}><Ic name="clock" size={15} /> Submitted for review</strong>
                {task.assignee?.id === user?.id ? (
                  /* The assignee: their work is parked with the reviewer. */
                  <>
                    <p className="muted" style={{ margin: '4px 0 10px' }}>Waiting for your manager — or whoever assigned it to you — to approve. You'll get it back if changes are needed.</p>
                    <button className="btn btn-sm row" style={{ gap: 6 }} disabled={busy} onClick={() => setStatus('In Progress')}><Ic name="reply" size={14} /> Withdraw &amp; keep working</button>
                  </>
                ) : (
                  /* The assigner viewing via "Assigned by me": their decision panel is below. */
                  <p className="muted" style={{ margin: '4px 0 0' }}>{task.assignee?.name || 'The assignee'} submitted this — approve it or send it back below.</p>
                )}
              </div>
            ) : (
              <>
                <div className="row wrap">
                  {['To Do', 'In Progress', 'Blocked'].map((s) => (
                    <button key={s} className={'btn btn-sm' + (pendingStatus === s ? ' btn-primary' : '')} disabled={busy} onClick={() => setPendingStatus(s)}>{s}</button>
                  ))}
                </div>
                {pendingStatus !== task.status && ['To Do', 'In Progress', 'Blocked'].includes(pendingStatus) && (
                  <div className="row" style={{ marginTop: 10 }}>
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => setStatus(pendingStatus)}>
                      {busy ? <span className="spinner" /> : `✓ Accept change → ${pendingStatus}`}
                    </button>
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setPendingStatus(task.status)}>Cancel</button>
                  </div>
                )}
                <button className="btn btn-primary" style={{ marginTop: 10, width: '100%' }} disabled={busy} onClick={() => setStatus('In Review')}>
                  {busy ? <span className="spinner" /> : '✓ Submit as complete'}
                </button>
                <p className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>Sends this task for approval — to your manager, or to whoever assigned it to you.</p>
              </>
            )}
          </div>

          {!task.parent_task_id && (subs.length > 0 || canSplit) && (
            <div style={{ margin: '16px 0' }}>
              <div className="spread">
                <label style={{ margin: 0 }}>Shared parts{subs.length ? ` — ${subDone}/${subs.length} done` : ''}</label>
                {canSplit && <button className="btn btn-sm row" style={{ gap: 6 }} disabled={busy} onClick={openSplit}><Ic name="scissors" size={14} /> Split &amp; share</button>}
              </div>
              {subs.length > 0 ? (
                <>
                  <div className="bar-track" style={{ margin: '8px 0' }}><div className="bar-fill" style={{ width: subPct + '%', background: '#10b981' }} /></div>
                  <div style={{ display: 'grid', gap: 2 }}>
                    {subs.map((s: any) => {
                      const u = lookupUser(s.assignee_id)
                      return (
                        <div key={s.id} className="spread" style={{ fontSize: 13, padding: '7px 0', borderBottom: '1px solid #f1f5f9' }}>
                          <span className="row" style={{ gap: 6 }}>{s.status === 'Done' ? <Ic name="check" size={13} /> : <span style={{ color: 'var(--muted)' }}>•</span>} {s.title}</span>
                          <span className="row" style={{ gap: 6 }}>
                            {u && <Avatar name={u.name} color={u.avatar_color} size={18} />}
                            <span className="muted">{u?.name || '—'}</span>
                            <StatusBadge s={s.status} />
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </>
              ) : (
                <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>Break this task into parts and share them with colleagues. You stay responsible — it completes automatically when all parts are done.</p>
              )}
            </div>
          )}

          {(isManager || isAssigner) && task.approval_status === 'pending' && (
            <div className="dr-approve" role="region" aria-label="Approval requested">
              <div className="dr-approve-head">
                <span className="dr-approve-ic" aria-hidden="true"><Ic name="clock" size={16} /></span>
                <div className="dr-approve-body">
                  <strong className="dr-approve-title">Approval requested</strong>
                  <p className="dr-approve-text">
                    {isManager ? 'This task is in review and awaiting your approval.' : 'You handed this task out — it\'s submitted and waiting for you to accept the work.'}
                  </p>
                </div>
              </div>
              <div className="dr-approve-actions">
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => approve('approved')}><Ic name="check" size={14} /> Approve &amp; close</button>
                <button className="btn btn-sm" disabled={busy} onClick={() => approve('rejected')} title="Send back to the owner to keep working"><Ic name="reply" size={14} /> Send back for changes</button>
              </div>
            </div>
          )}

          {task.dependencies && task.dependencies.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <label>Depends on</label>
              {task.dependencies.map((d: any) => <div key={d.id} className="row" style={{ fontSize: 13 }}>↳ {d.title} <StatusBadge s={d.status} /></div>)}
            </div>
          )}

          <div style={{ marginBottom: 14 }}>
            <div className="spread" style={{ alignItems: 'center' }}>
              <label style={{ margin: 0 }}>Attachments ({task.attachments?.length || 0})</label>
              <input ref={attachInput} type="file" multiple style={{ display: 'none' }} onChange={(e) => uploadFiles(e.target.files)} />
              <button className="btn btn-sm row" style={{ gap: 6 }} disabled={busy || !!upload} onClick={() => attachInput.current?.click()} title="Attach any file up to 500 MB — or paste a screenshot here with Ctrl+V"><Ic name="attach" size={13} /> Attach</button>
            </div>
            {upload && upload.taskId === taskId && (
              <div className="attach-progress" role="status" aria-live="polite">
                <div className="attach-progress-line">
                  <span className="attach-progress-name">Uploading {upload.of > 1 ? `${upload.n} of ${upload.of}: ` : ''}{upload.name}</span>
                  <span className="attach-progress-pct">{upload.pct}%</span>
                </div>
                <div className="bar-track"><div className="bar-fill" style={{ width: upload.pct + '%', background: 'var(--primary)' }} /></div>
              </div>
            )}
            {task.attachments && task.attachments.length > 0 && (
              <div className="attach-grid" style={{ marginTop: 8 }}>
                {task.attachments.map((a: Attachment) => {
                  const isImg = (a.file_type || '').startsWith('image/')
                  const isVid = (a.file_type || '').startsWith('video/')
                  const canRemove = isManager || a.uploaded_by === user?.id
                  return (
                    <div key={a.id} className="attach-item">
                      {isImg ? (
                        <button type="button" className="attach-thumb attach-thumb-pic" onClick={() => setPhotoAt(a.id)} aria-label={`View ${a.filename}`}>
                          <img src={taskAttachmentUrl(a.id)} alt="" loading="lazy" />
                        </button>
                      ) : isVid ? (
                        <video className="attach-thumb" src={taskAttachmentUrl(a.id)} controls preload="metadata" />
                      ) : (
                        <a href={taskAttachmentUrl(a.id)} target="_blank" rel="noreferrer" className="attach-thumb attach-thumb-file" onClick={onDownloadLink(taskAttachmentUrl(a.id, true), a.filename, 'task:' + a.id)}>
                          <Ic name="doc" size={26} />
                          {/* XLSX, ZIP, DOCX… — without it every non-picture file is the same icon. */}
                          {fileExt(a.filename) && <span className="attach-ext">{fileExt(a.filename)}</span>}
                        </a>
                      )}
                      <div className="attach-meta">
                        <div className="attach-meta-text">
                          <a href={taskAttachmentUrl(a.id, true)} download={a.filename} onClick={onDownloadLink(taskAttachmentUrl(a.id, true), a.filename, 'task:' + a.id)} className="attach-name" title={`Download ${a.filename}`}>{a.filename}</a>
                          <span className="muted" style={{ fontSize: 11 }}>{fmtBytes(a.file_size)}</span>
                        </div>
                        {/* Its own button: the file name was the only way to save a
                            file, and nobody read a name as a download link — every
                            thumbnail opens or plays the file instead. */}
                        <a href={taskAttachmentUrl(a.id, true)} download={a.filename} onClick={onDownloadLink(taskAttachmentUrl(a.id, true), a.filename, 'task:' + a.id)} className="attach-dl" title={`Download ${a.filename}`} aria-label={`Download ${a.filename}`}>
                          <Ic name="download" size={14} />
                        </a>
                      </div>
                      {canRemove && <button className="attach-item-x" disabled={busy} onClick={() => removeAttachment(a)} aria-label={`Remove ${a.filename}`}>✕</button>}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div data-comments>
            <label>Comments ({task.comments?.length || 0})</label>
            {task.comments?.map((c: any) => {
              // Editing is your own words only, deliberately: the thread is the
              // record of who said what, and rewriting someone else's line would
              // quietly turn it into something else. Deleting is yours, or a
              // manager's — that is the lever for something that must come down.
              const mine = c.user_id === user?.id
              const editing = editingComment === c.id
              return (
                <div className={'comment' + (flashComment === c.id ? ' flash' : '')} key={c.id} data-comment={c.id}>
                  <Avatar name={c.user_name} color={c.avatar_color} size={28} />
                  <div className="body" style={{ minWidth: 0 }}>
                    <div className="spread">
                      <strong style={{ fontSize: 12.5 }}>{c.user_name}</strong>
                      <span className="row" style={{ gap: 4 }}>
                        <span className="muted" style={{ fontSize: 11 }}>
                          {new Date(c.created_at).toLocaleString()}{c.edited_at ? ' · edited' : ''}
                        </span>
                        {(mine || isManager) && !editing && (
                          <div className="msg-menu-wrap" onMouseDown={(e) => e.stopPropagation()}>
                            <button
                              className="msg-tool-btn" title="Comment options" aria-label="Comment options"
                              aria-haspopup="menu" aria-expanded={commentMenu === c.id}
                              onClick={(e) => { e.stopPropagation(); setCommentMenu(commentMenu === c.id ? null : c.id) }}
                            >⋯</button>
                            {commentMenu === c.id && (
                              <div className="msg-menu mine" role="menu" onClick={(e) => e.stopPropagation()}>
                                {mine && (
                                  <button role="menuitem" onClick={() => { setCommentMenu(null); setEditingComment(c.id); setCommentDraft(c.body) }}>Edit</button>
                                )}
                                <button className="danger" role="menuitem" onClick={() => { setCommentMenu(null); removeComment(c) }}>Delete</button>
                              </div>
                            )}
                          </div>
                        )}
                      </span>
                    </div>
                    {editing ? (
                      <div className="grid" style={{ gap: 6, marginTop: 4 }}>
                        <AutoTextarea
                          value={commentDraft}
                          onChange={(e) => setCommentDraft(e.target.value)}
                          autoFocus
                          style={{ width: '100%', fontSize: 13 }}
                        />
                        <div className="row" style={{ gap: 6 }}>
                          <button className="btn btn-primary btn-sm" disabled={busy || !commentDraft.trim()} onClick={() => saveComment(c)}>Save</button>
                          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setEditingComment(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{c.body}</div>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
            <div className="row" style={{ marginTop: 10 }}>
              <AutoTextarea
                data-va="task.drawer.comment"
                aria-label="Add a comment"
                placeholder="Add a comment…"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                // Enter posts, Shift+Enter breaks the line — the messenger
                // convention, and the only way to write a second line now that
                // this is a textarea rather than a single-line input.
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addComment() } }}
                style={{ flex: 1 }}
              />
              <button data-va="task.drawer.postComment" className="btn btn-primary" onClick={addComment} disabled={busy}>Post</button>
            </div>
          </div>
        </div>

        {showSplit && (
          <div className="modal-center" onClick={() => setShowSplit(false)}>
            <div className="modal" role="dialog" aria-modal="true" aria-label="Split and share task" onClick={(e) => e.stopPropagation()}>
              <div className="card-head spread"><h3 style={{ fontSize: 16 }}>Split &amp; share</h3><button className="btn btn-ghost" onClick={() => setShowSplit(false)} aria-label="Close">✕</button></div>
              <div className="card-pad grid" style={{ gap: 10 }}>
                <p className="muted" style={{ fontSize: 12 }}>Add each part and pick who does it. Parts inherit this task's due date &amp; priority. You stay responsible — it completes when all parts are done.</p>
                {parts.map((p, i) => (
                  <div className="row split-part" key={i} style={{ gap: 8 }}>
                    <input className="split-part-title" placeholder={`Part ${i + 1} — what needs doing`} value={p.title} onChange={(e) => updatePart(i, { title: e.target.value })} autoFocus={i === 0} />
                    <select className="split-part-who" value={p.assignee_id} onChange={(e) => updatePart(i, { assignee_id: e.target.value })}>
                      <option value="">Who…</option>
                      {users.filter((u) => u.role !== 'admin').map((u) => <option key={u.id} value={u.id}>{u.name}{u.id === user?.id ? ' (me)' : ''}</option>)}
                    </select>
                    {parts.length > 1 && <button className="btn btn-ghost btn-sm" title="Remove" onClick={() => setParts((ps) => ps.filter((_, idx) => idx !== i))}>✕</button>}
                  </div>
                ))}
                <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setParts((ps) => [...ps, { title: '', assignee_id: '' }])}>+ Add another part</button>
                <div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn" onClick={() => setShowSplit(false)}>Cancel</button>
                  <button className="btn btn-primary row" style={{ gap: 6 }} disabled={busy || !parts.some((p) => p.title.trim() && p.assignee_id)} onClick={doSplit}>{busy ? <span className="spinner" /> : <><Ic name="send" size={14} /> Share parts</>}</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Into <body>: inside the drawer it would share the drawer's stacking
            context and sit under the bottom nav. Closes by itself if the
            attachment is removed, or another task opens in the drawer. */}
        {photoAt && createPortal(
          <PhotoViewer
            label="Attachment viewer"
            items={(task.attachments || []).filter((a) => (a.file_type || '').startsWith('image/')).map((a) => ({
              id: a.id, src: taskAttachmentUrl(a.id), alt: a.filename, title: a.filename,
              subtitle: [fmtBytes(a.file_size), a.created_at ? fmtDateTime(a.created_at) : ''].filter(Boolean).join(' · '),
            }))}
            startId={photoAt}
            onClose={() => setPhotoAt(null)}
            actions={(it) => (
              <>
                <a className="mv-btn" href={taskAttachmentUrl(it.id)} target="_blank" rel="noreferrer" onClick={onDownloadLink(taskAttachmentUrl(it.id, true), it.title || 'file', 'task:' + it.id)} aria-label="Open in a new tab" title="Open in a new tab"><Ic name="external" size={19} /></a>
                <a className="mv-btn" href={taskAttachmentUrl(it.id, true)} download={it.title} onClick={onDownloadLink(taskAttachmentUrl(it.id, true), it.title || 'file', 'task:' + it.id)} aria-label="Download" title="Download"><Ic name="download" size={19} /></a>
              </>
            )}
          />,
          document.body,
        )}
      </>
  ))
}
