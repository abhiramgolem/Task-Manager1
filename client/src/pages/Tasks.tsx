import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, Task, User, API_BASE, getToken } from '../api'
import { useAuth } from '../auth'
import { PriorityBadge, StatusBadge, CategoryBadge, Avatar, ConfidenceTag, EmptyState, Ic, dueLabel, fmtDateTime, fmtBytes, PRIORITY_COLORS, AutoTextarea, todayKey, dayKeyOf } from '../ui'
import TaskDrawer from '../components/TaskDrawer'
import CategorySelect from '../components/CategorySelect'
import PickerWithAdd from '../components/PickerWithAdd'
import { UserForm } from '../components/UserManagement'
import TaskBoard from '../components/TaskBoard'
import TaskActivity from '../components/TaskActivity'
import { TaskHandoverLine } from '../components/TaskOriginBadge'
import { pushBackHandler } from '../back'
import { toast } from '../lib/toast'
import { takeTaskDraft, TaskDraft } from '../lib/taskDraft'
import { useEscape } from '../lib/useEscape'
import { clipboardFiles, droppedFiles, dragHasFiles } from '../lib/pasteFiles'
import { attachable, attachToTask } from '../lib/taskAttach'
import { useSurface } from '../voice/uiRegistry'
import { typeInto, pickValue, flashPress, highlight, pause, settle, findVaEl, waitForVaEl } from '../voice/uiController'

// Date the task was GIVEN to its owner — drives grouping, ordering, and the Time
// column. Using the given date (not the latest activity) means completing a task
// or sending it to review never bumps it to Today or to the top of the table.
const givenOf = (t: Task) => t.assigned_at || t.created_at || ''
const givenLabel = (t: Task) => (t.assigned_at ? 'Assigned' : 'Created')

// Mirror of the server's priority→due-date default (server/src/util.js) so the
// New Task form SHOWS the date the task will actually get. Critical=today,
// High=+1, Medium=+3, Low=+5 days. Local date parts (matches the server).
const DUE_DAYS_BY_PRIORITY: Record<string, number> = { Critical: 0, High: 1, Medium: 3, Low: 5 }
const dueDateForPriority = (priority: string) => {
  const d = new Date()
  d.setDate(d.getDate() + (DUE_DAYS_BY_PRIORITY[priority] ?? DUE_DAYS_BY_PRIORITY.Medium))
  const y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${da}`
}

// Auto-growing textarea: wraps long text and grows with content so the whole
// title is readable instead of scrolling word-by-word inside a one-line input.
// Clean line-art magnifier for the collapsible search control.
const SearchIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
)

// Clean line-art microphone (replaces the old 🎤 emoji on the Speak button).
const MicIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="2" width="6" height="11" rx="3" />
    <path d="M5 10a7 7 0 0 0 14 0" />
    <line x1="12" y1="17" x2="12" y2="21" />
    <line x1="8" y1="21" x2="16" y2="21" />
  </svg>
)

// ---- Sorting -----------------------------------------------------------------
// Three rules the whole sort obeys, so results never surprise:
//   1. Ranked, not alphabetical — Priority and Status sort by their real order,
//      so Critical beats High and Done always lands last.
//   2. Blanks sink, in BOTH directions — a task with no due date or no assignee
//      is never "the answer" to "what's due first?" nor to its reverse. This is
//      why direction is applied to the value comparison alone and never to the
//      blank check: negating a sentinel used to float blanks to the top.
//   3. Total order — every comparison falls through to a tie-break chain ending
//      in the task id, so equal keys can't drift with whatever order the server
//      happened to return.
type SortKey = 'task' | 'priority' | 'status' | 'assignee' | 'due' | 'time'
type SortDir = 'asc' | 'desc'
const PRIORITY_RANK: Record<string, number> = { Critical: 4, High: 3, Medium: 2, Low: 1 }
// Pipeline order, with the two terminal-ish states at the end and Done dead last
// — sorting by status ascending should surface actionable work, not completed.
const STATUS_RANK: Record<string, number> = { 'To Do': 0, 'In Progress': 1, 'Blocked': 2, 'In Review': 3, 'Reopened': 4, 'Done': 5 }
// One collator for the whole list; `numeric` keeps "Task 2" before "Task 10".
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

// The value a task sorts by for a given column. `null` means "blank" and always
// sinks to the bottom, whichever way the column is pointing.
const sortValue = (t: Task, key: SortKey): string | number | null => {
  switch (key) {
    case 'task': return t.title?.trim() || null
    case 'priority': return PRIORITY_RANK[t.priority] ?? null
    case 'status': return STATUS_RANK[t.status] ?? null
    case 'assignee': return t.assignee?.name?.trim() || null
    case 'due': return t.due_date || null
    case 'time': return givenOf(t) || null
  }
}

const compareTasks = (a: Task, b: Task, key: SortKey, dir: SortDir): number => {
  const va = sortValue(a, key)
  const vb = sortValue(b, key)
  // Blanks sink. Deliberately outside the direction flip (see rule 2 above).
  if (va === null || vb === null) {
    if (va === vb) return tieBreak(a, b)
    return va === null ? 1 : -1
  }
  const cmp = typeof va === 'number' && typeof vb === 'number'
    ? va - vb
    : collator.compare(String(va), String(vb))
  if (cmp !== 0) return dir === 'desc' ? -cmp : cmp
  return tieBreak(a, b)
}

// Same inputs always give the same order: newest activity first, then id.
const tieBreak = (a: Task, b: Task): number =>
  givenOf(b).localeCompare(givenOf(a)) || (a.id || '').localeCompare(b.id || '')

// Which way a column points when you first pick it: "biggest first" for the ones
// people scan for urgency, A→Z / soonest-first for the rest.
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  time: 'desc', priority: 'desc', status: 'asc', assignee: 'asc', due: 'asc', task: 'asc',
}
// The chronological feed keeps its day headings; every other column is one
// ordered list, not a re-shuffle inside each day. (No longer the default —
// priority is — but picking Newest still gives you the day-grouped feed.)
const isGroupedSort = (key: SortKey) => key === 'time'

// A nicely themed sort control (replaces the plain native <select>, whose popup
// can't be styled). Shows the active option, opens a rounded menu with a check on
// the current choice, and closes on outside-click or selection.
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'priority', label: 'Priority' },
  { key: 'time', label: 'Newest' },
  { key: 'status', label: 'Status' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'due', label: 'Due date' },
]
const SortGlyph = () => (
  <svg className="sortmenu-ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m3 16 4 4 4-4" /><path d="M7 20V4" /><path d="m21 8-4-4-4 4" /><path d="M17 4v16" />
  </svg>
)
// What each column means in each direction, so the menu can say it in words
// rather than making you decode an arrow.
const DIR_HINT: Record<SortKey, { asc: string; desc: string }> = {
  time: { asc: 'oldest first', desc: 'newest first' },
  priority: { asc: 'Low → Critical', desc: 'Critical → Low' },
  status: { asc: 'To Do → Done', desc: 'Done → To Do' },
  assignee: { asc: 'A → Z', desc: 'Z → A' },
  due: { asc: 'soonest first', desc: 'latest first' },
  task: { asc: 'A → Z', desc: 'Z → A' },
}
function SortMenu({ sortKey, sortDir, onPick }: { sortKey: SortKey; sortDir: SortDir; onPick: (key: SortKey) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  const current = SORT_OPTIONS.find((o) => o.key === sortKey) || SORT_OPTIONS[0]
  return (
    <div className="sortmenu toolbar-sort" ref={ref}>
      <button
        className="sortmenu-btn"
        onClick={() => setOpen((o) => !o)}
        title={`Sorted by ${current.label.toLowerCase()}, ${DIR_HINT[sortKey][sortDir]}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <SortGlyph />
        <span className="sortmenu-label">Sort: {current.label}</span>
        <span className="sortmenu-dir" aria-hidden="true">{sortDir === 'desc' ? '↓' : '↑'}</span>
        <svg className={'sortmenu-chev' + (open ? ' flip' : '')} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="sortmenu-pop" role="listbox">
          {SORT_OPTIONS.map((o) => {
            const active = o.key === sortKey
            return (
              <button
                key={o.key}
                role="option"
                aria-selected={active}
                className={'sortmenu-item' + (active ? ' active' : '')}
                // Tapping the active option reverses it; the hint tells you what
                // you'd get, so the second tap isn't a guess.
                title={active ? `Reverse — ${DIR_HINT[o.key][sortDir === 'asc' ? 'desc' : 'asc']}` : DIR_HINT[o.key][DEFAULT_DIR[o.key]]}
                onClick={() => { onPick(o.key); setOpen(false) }}
              >
                <span className="sortmenu-item-label">
                  {o.label}
                  <span className="sortmenu-item-hint">{active ? DIR_HINT[o.key][sortDir] : DIR_HINT[o.key][DEFAULT_DIR[o.key]]}</span>
                </span>
                {active && (
                  <span className="sortmenu-dir" aria-hidden="true">{sortDir === 'desc' ? '↓' : '↑'}</span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Search dialog: type or speak to search tasks. On submit it sets the query and
// closes; the filtered list is then visible behind it. Voice uses the same
// server-side transcription as the New Task form (reliable on Android).
type SearchApply = { q?: string; assignee?: string; status?: string; priority?: string }
function SearchDialog({ initial, onApply, onClose }: { initial: string; onApply: (f: SearchApply) => void; onClose: () => void }) {
  const [q, setQ] = useState(initial)
  const [listening, setListening] = useState(false)
  const [parsing, setParsing] = useState(false)
  // Extra filters resolved from a voice query (e.g. an employee name → assignee id).
  const [voiceFilters, setVoiceFilters] = useState<{ assignee?: string; assigneeName?: string; status?: string; priority?: string } | null>(null)
  const mrRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  useEscape(onClose)
  const canRecord = typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof (window as any).MediaRecorder !== 'undefined'

  const releaseMic = () => {
    try { if (mrRef.current && mrRef.current.state !== 'inactive') mrRef.current.stop() } catch {}
    try { streamRef.current?.getTracks().forEach((t) => t.stop()) } catch {}
    streamRef.current = null
  }
  useEffect(() => releaseMic, [])

  const transcribe = async (blob: Blob) => {
    setParsing(true)
    try {
      const fd = new FormData()
      fd.append('audio', blob, 'search.webm')
      const headers: Record<string, string> = {}
      const token = getToken()
      if (token) headers.authorization = `Bearer ${token}`
      // /voice-search transcribes ANY language, translates to English, and resolves
      // a spoken employee name to an assignee id so we can show all their tasks.
      const res = await fetch(`${API_BASE}/api/tasks/voice-search`, { method: 'POST', headers, body: fd, cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || `Voice search failed (${res.status})`)
      const query = String(data?.query || '').trim()
      const extra = {
        assignee: data?.assignee_id || undefined,
        assigneeName: data?.assignee_name || undefined,
        status: data?.status || undefined,
        priority: data?.priority || undefined,
      }
      const heardSomething = query || extra.assignee || extra.status || extra.priority
      if (heardSomething) {
        setQ(query)
        setVoiceFilters((extra.assignee || extra.status || extra.priority) ? extra : null)
      } else {
        toast.info("Didn't catch that — please tap and try again.")
      }
    } catch (err: any) {
      toast.error(err?.message || 'Could not search by voice. Check your connection and try again.')
    } finally { setParsing(false) }
  }

  const toggleMic = async () => {
    if (listening) { setListening(false); try { mrRef.current?.stop() } catch {}; return }
    if (!canRecord) { toast.error('Voice search needs microphone access on this device.'); return }
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
    catch { toast.error('Microphone access is blocked. Allow mic permission and try again.'); return }
    streamRef.current = stream
    chunksRef.current = []
    let mr: MediaRecorder
    try { mr = new MediaRecorder(stream, { mimeType: 'audio/webm' }) } catch { mr = new MediaRecorder(stream) }
    mrRef.current = mr
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data) }
    mr.onstop = () => {
      try { streamRef.current?.getTracks().forEach((t) => t.stop()) } catch {}
      streamRef.current = null
      const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' })
      chunksRef.current = []
      if (blob.size) transcribe(blob)
    }
    try { mr.start() } catch { setListening(false); releaseMic(); return }
    setListening(true)
  }

  const submit = () => {
    const f: SearchApply = { q: q.trim() }
    // A voice query may also have resolved an employee / status / priority — apply
    // those alongside the text so e.g. "Shabbir's blocked tasks" filters correctly.
    if (voiceFilters) {
      f.assignee = voiceFilters.assignee || ''
      f.status = voiceFilters.status || ''
      f.priority = voiceFilters.priority || ''
    }
    onApply(f)
    onClose()
  }

  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal search-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Search tasks">
        <div className="card-head spread"><h3>Search tasks</h3><button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="card-pad grid" style={{ gap: 12 }}>
          <div className="search-dialog-field">
            <span className="search-dialog-icon"><SearchIcon size={18} /></span>
            <input
              autoFocus
              placeholder="Search tasks by title…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            />
            {q && <button className="search-dialog-clear" onClick={() => setQ('')} title="Clear" aria-label="Clear">✕</button>}
          </div>
          {canRecord && (
            <button
              type="button"
              className={'btn btn-mic search-dialog-mic' + (listening ? ' btn-mic-live' : '')}
              onClick={toggleMic}
              disabled={parsing}
              title="Speak to search"
            >
              {parsing
                ? <><span className="spinner" /> Transcribing…</>
                : listening
                  ? <><span className="mic-dot" /> Stop & search</>
                  : <><MicIcon size={16} /> Speak to search</>}
            </button>
          )}
          {listening && <div className="muted" style={{ fontSize: 12 }}>Listening… tap Stop when done.</div>}
          {voiceFilters && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', fontSize: 12 }}>
              <span className="muted">Voice search:</span>
              {voiceFilters.assigneeName && <span className="badge row" style={{ gap: 5, background: 'var(--info-bg)', color: 'var(--info-ink)' }}><Ic name="user" size={12} /> {voiceFilters.assigneeName}</span>}
              {voiceFilters.status && <span className="badge" style={{ background: '#f1f5f9', color: '#334155' }}>{voiceFilters.status}</span>}
              {voiceFilters.priority && <span className="badge" style={{ background: '#fff7ed', color: '#c2410c' }}>{voiceFilters.priority}</span>}
              <button className="search-dialog-clear" style={{ position: 'static' }} onClick={() => setVoiceFilters(null)} title="Clear voice filters" aria-label="Clear voice filters">✕</button>
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={submit}>Search</button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Mobile-only Filters dialog: the same priority/status/assignee filters as the
// desktop toolbar dropdowns (which are CSS-hidden on phones). Staged locally and
// applied on confirm, so tapping through options doesn't fire a fetch per change.
function FiltersDialog({ filters, users, isManager, onApply, onClose }: {
  filters: { priority: string; status: string; assignee: string }
  users: User[]
  isManager: boolean
  onApply: (f: { priority: string; status: string; assignee: string }) => void
  onClose: () => void
}) {
  useEscape(onClose)
  const [f, setF] = useState({ priority: filters.priority, status: filters.status, assignee: filters.assignee })
  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal search-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Filter tasks">
        <div className="card-head spread"><h3>Filter tasks</h3><button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="card-pad grid" style={{ gap: 12 }}>
          <label>Priority
            <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              <option value="">All priorities</option>
              {['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}
            </select>
          </label>
          <label>Status
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="">All statuses</option>
              {['To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Reopened'].map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          {isManager && (
            <label>Assignee
              <select value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
                <option value="">All assignees</option>
                <option value="unassigned">Unassigned</option>
                {users.filter((u) => u.role !== 'admin').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
          )}
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" onClick={() => { onApply({ priority: '', status: '', assignee: '' }); onClose() }}>Clear all</button>
            <button className="btn btn-primary" onClick={() => { onApply(f); onClose() }}>Apply filters</button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function Tasks({ personal = false }: { personal?: boolean }) {
  const { user } = useAuth()
  // Dashboard KPI cards deep-link here, e.g. /tasks?view=completed or
  // /tasks?status=Blocked — seed the quick view / status filter from the URL.
  const [searchParams, setSearchParams] = useSearchParams()
  const QUICK_VIEWS = ['active', 'overdue', 'today', 'completed'] as const
  const urlView = searchParams.get('view')
  const urlStatus = searchParams.get('status')
  const assignedByMe = searchParams.get('assigned_by_me') === '1'
  const initialQuick = (QUICK_VIEWS as readonly string[]).includes(urlView || '')
    ? (urlView as 'active' | 'overdue' | 'today' | 'completed')
    // A Done deep-link (e.g. clicking "Done" on the dashboard) must land on the
    // Completed view — the default 'active' view hides Done tasks, so pairing it
    // with status=Done would filter everything out and show "No tasks".
    : (urlStatus === 'Done' ? 'completed' : 'active')
  const [tasks, setTasks] = useState<Task[]>([])
  const [users, setUsers] = useState<User[]>([])
  // Opening a task by id (e.g. ?task=… from a clicked notification) shows its drawer.
  const [openId, setOpenId] = useState<string | null>(searchParams.get('task'))
  const [showNew, setShowNew] = useState(false)
  // A task drafted elsewhere — today, from a chat message — that the New task form
  // should open pre-filled on. Read once out of sessionStorage (see lib/taskDraft),
  // never from the URL: a 4000-character message does not belong in a query string.
  const [draft, setDraft] = useState<TaskDraft | null>(null)
  const [showTrash, setShowTrash] = useState(false)
  // ?view=activity opens straight on the Activity feed; the quick views share the
  // same param but never use this value, so the two can't collide.
  const [view, setView] = useState<'list' | 'board' | 'activity'>(() => (searchParams.get('view') === 'activity' ? 'activity' : 'list'))
  // Bumped when the drawer changes a task, so the Activity feed shows the change.
  const [activityTick, setActivityTick] = useState(0)
  // Wide enough to show the list and one task side by side. Below this the
  // drawer stays a modal, because a pane would leave neither half usable.
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 1280px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1280px)')
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  // Search is collapsed to just an icon by default; tapping it reveals the input.
  const [searchOpen, setSearchOpen] = useState(false)
  // Mobile-only Filters dialog (the inline desktop dropdowns are CSS-hidden on phones).
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [quickView, setQuickView] = useState<'active' | 'overdue' | 'today' | 'completed'>(initialQuick)
  const [filters, setFilters] = useState<{ q: string; priority: string; status: string; assignee: string }>({ q: '', priority: searchParams.get('priority') || '', status: searchParams.get('status') || '', assignee: searchParams.get('assignee') || '' })
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'priority', dir: DEFAULT_DIR.priority })
  // Pick a column: reversing the one you're already on, otherwise switching to it
  // the way round that column is normally read. Shared by the desktop column
  // headers and the mobile Sort menu, so both behave identically.
  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: DEFAULT_DIR[key] }))

  const [loadError, setLoadError] = useState(false)
  // True only until the FIRST response lands. Without it, the initial fetch is
  // indistinguishable from a genuinely empty list, so users briefly saw the
  // "You're all caught up!" empty state before their rows popped in.
  const [loading, setLoading] = useState(true)
  // Guard against out-of-order responses: only the latest request may apply state.
  const reqIdRef = useRef(0)
  const load = () => {
    const myReq = ++reqIdRef.current
    setLoadError(false)
    const p = new URLSearchParams()
    Object.entries(filters).forEach(([k, v]) => v && p.set(k, v))
    if (personal) p.set('mine', '1') // My Tasks: only the current user's own tasks
    // Deep-link from the dashboard's "Assigned by me" section — work this user
    // handed to someone else, which the normal assignee filter excludes.
    if (assignedByMe) p.set('assigned_by_me', '1')
    api.get('/tasks?' + p.toString())
      .then((d) => { if (myReq === reqIdRef.current) { setTasks(d); setLoading(false) } })
      .catch(() => { if (myReq === reqIdRef.current) { setLoadError(true); setLoading(false) } })
  }
  // Re-fetch on `personal` too: /tasks and /my-tasks reuse this same component, so
  // navigating between them flips `personal` without changing `filters` — without
  // this dep the list would keep showing the previous route's tasks until a refresh.
  useEffect(() => { load() }, [filters, personal, assignedByMe])
  useEffect(() => { api.get('/users').then(setUsers) }, [])

  // Deep-links (dashboard KPI cards, voice navigation) can arrive while this page
  // is ALREADY mounted. The useState initializers above only run once, so the URL
  // would change while the filters stayed stale — sync them explicitly here.
  const spPriority = searchParams.get('priority') || ''
  const spStatus = searchParams.get('status') || ''
  const spAssignee = searchParams.get('assignee') || ''
  const spView = searchParams.get('view') || ''
  useEffect(() => {
    setFilters((f) => (f.priority === spPriority && f.status === spStatus && f.assignee === spAssignee
      ? f // nothing to do — don't retrigger the load effect
      : { ...f, priority: spPriority, status: spStatus, assignee: spAssignee }))
    // Mirror the mount-time rule: an explicit view wins, a Done deep-link means
    // "completed", otherwise fall back to the active view.
    setQuickView((QUICK_VIEWS as readonly string[]).includes(spView)
      ? (spView as typeof quickView)
      : (spStatus === 'Done' ? 'completed' : 'active'))
  }, [spPriority, spStatus, spAssignee, spView])
  // Refresh when the voice assistant (or another surface) changes tasks while
  // this list is already mounted.
  useEffect(() => {
    const onChanged = () => load()
    window.addEventListener('tasks-changed', onChanged)
    return () => window.removeEventListener('tasks-changed', onChanged)
  }, [filters, personal])

  // If navigated here with ?task=… (e.g. by clicking a notification) while already
  // on this page, open that task's drawer too.
  //
  // A comment notification adds &comment=…, which the drawer lands on. It is
  // taken out of the URL once read, as the chat does with ?msg=: a second tap on
  // the same notification is then a new URL and lands again, and a filter change
  // later (which rewrites the URL) cannot pull the reader back to the comment.
  const [focusComment, setFocusComment] = useState<{ taskId: string; commentId: string; n: number } | null>(null)
  useEffect(() => {
    const t = searchParams.get('task')
    if (t) setOpenId(t)
    const c = searchParams.get('comment')
    if (!c) return
    if (t) setFocusComment((f) => ({ taskId: t, commentId: c, n: (f?.n || 0) + 1 }))
    const next = new URLSearchParams(searchParams)
    next.delete('comment')
    setSearchParams(next, { replace: true })
  }, [searchParams])
  // Only for the task it came with: opening another task, or this one again
  // later from the list, opens at the top as usual.
  useEffect(() => {
    if (focusComment && focusComment.taskId !== openId) setFocusComment(null)
  }, [openId])
  const focusFor = (taskId: string | null) =>
    focusComment && focusComment.taskId === taskId ? { focusCommentId: focusComment.commentId, focusKey: focusComment.n } : {}

  // Arrived from "Assign as task" in the chat: take the stashed draft, open the
  // real New task form on it, and drop ?new=1 so a reload doesn't reopen an empty
  // form over the list.
  //
  // The ref is load-bearing, not defensive: takeTaskDraft() CONSUMES the draft, and
  // StrictMode runs this effect twice on mount — without the guard the second pass
  // reads an empty sessionStorage and blanks the form that the first pass filled.
  const draftTaken = useRef(false)
  useEffect(() => {
    if (searchParams.get('new') !== '1' || draftTaken.current) return
    draftTaken.current = true
    setDraft(takeTaskDraft())
    setShowNew(true)
    const next = new URLSearchParams(searchParams)
    next.delete('new')
    setSearchParams(next, { replace: true })
  }, [searchParams])

  // Opening a task splits the screen and the list becomes a scroll box of its
  // own (starting at the top); closing it puts the list back in the page. Either
  // way the list jumped to the top and the task you were on was lost. So the
  // row's place on screen is noted before the switch and given back after it.
  const placeRef = useRef<{ id: string; top: number } | null>(null)
  const notePlace = (id: string | null) => {
    const row = id && document.querySelector<HTMLElement>(`[data-va="task.${id}"]`)
    placeRef.current = row ? { id: id!, top: row.getBoundingClientRect().top } : null
  }
  // Only where the layout switches (split view); a phone's drawer covers the
  // list and leaves it where it was.
  const pickTask = (id: string) => { if (!openId && split) notePlace(id); setOpenId(id) }

  // Close the drawer and drop the ?task= param so it stays closed and the URL is clean.
  const closeDrawer = () => {
    if (paneOpen) notePlace(openId)
    setOpenId(null)
    if (searchParams.get('task')) {
      const next = new URLSearchParams(searchParams)
      next.delete('task')
      setSearchParams(next, { replace: true })
    }
  }

  // Android back button: close the open task drawer / new-task modal first.
  useEffect(() => pushBackHandler(() => {
    if (filtersOpen) { setFiltersOpen(false); return true }
    if (showNew) { setShowNew(false); return true }
    if (openId) { if (paneOpen) notePlace(openId); setOpenId(null); return true }
    return false
  }), [showNew, openId, filtersOpen])

  // ---- Agent surface -------------------------------------------------------
  // The task list's capabilities. `openNew` presses the real button rather than
  // just flipping state, so the user sees the same affordance they would have used.
  useSurface('tasks', {
    openNew: async () => {
      await flashPress(findVaEl('tasks.newTask'))
      setShowNew(true)
    },
    filter: async ({ priority, status, assignee }: { priority?: string; status?: string; assignee?: string }) => {
      setFilters((f) => ({ ...f, ...(priority && { priority }), ...(status && { status }), ...(assignee && { assignee }) }))
      await pause(400)
    },
    // Point at a row after the agent changed it. The row may not have rendered yet
    // (the list reloads after a create), so this waits rather than missing it.
    highlightTask: async ({ id }: { id: string }) => {
      const el = await waitForVaEl(`task.${id}`)
      await highlight(el)
    },
    openTask: ({ id }: { id: string }) => setOpenId(id),
    reload: () => load(),
  })

  // In "My Tasks" (personal) mode, behave like a personal board even for managers:
  // own tasks only, no assignee column/picker, and new tasks are private.
  const isManager = user?.role !== 'employee' && !personal
  // The person who handed this task out (assigned it, or split the part off) can
  // approve its submission — mirrors the per-task check on POST /:id/approve.
  const isAssignerOf = (t: Task) => !!user && t.assigned_by_id === user.id && t.assignee?.id !== user.id
  // "Assigned by me" is a scope, not a view: it swaps WHAT is listed (work I
  // handed out instead of work I got) and always renders as a list — a board of
  // someone else's columns isn't actionable from here.
  const effectiveView = assignedByMe ? 'list' : view
  // The pane only makes sense on the list: the board already fills the width,
  // and the completed archive is a read-only table nobody drills into.
  const split = wide && effectiveView === 'list' && quickView !== 'completed'
  // Whether the page is ACTUALLY two columns right now. `split` only says the
  // layout is available; until a task is picked there is nothing to put beside
  // the list, so the table keeps the full width and the page behaves exactly as
  // it did before the pane existed. Choosing a task is what splits the screen.
  const paneOpen = split && !!openId
  // With the pane open the two columns own the scrolling, so the document must
  // not also scroll, or reading down the task pane drags the whole page, header
  // and all, out from under it. A class on <body> rather than styles here,
  // because the chain that has to stop growing (.app -> .main -> .content) sits
  // above this page. It reverts when the pane closes and on unmount, so the page
  // always gets its normal scrolling back. A layout effect, so the switch is
  // complete before the row is put back in place (below) and before any paint.
  React.useLayoutEffect(() => {
    if (!paneOpen) return
    document.body.classList.add('is-split-view')
    return () => document.body.classList.remove('is-split-view')
  }, [paneOpen])
  // After the switch: the row back where it was on screen (notePlace above).
  React.useLayoutEffect(() => {
    const p = placeRef.current
    placeRef.current = null
    const row = p && document.querySelector<HTMLElement>(`[data-va="task.${p.id}"]`)
    if (!p || !row) return
    // The nearest box that scrolls: the list in split view, the page otherwise.
    let el: HTMLElement | null = row.parentElement
    while (el && !(/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight)) el = el.parentElement
    const by = (d: number) => { if (Math.abs(d) < 1) return; if (el) el.scrollTop += d; else window.scrollBy(0, d) }
    by(row.getBoundingClientRect().top - p.top)
    // Where it was may be outside the box now (the split list starts below the
    // header): then just inside the nearest edge, never hidden behind it. The
    // table's sticky header row covers the top of the box, so that is the edge.
    const r = row.getBoundingClientRect()
    const box = el ? el.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
    const head = el?.querySelector('thead')?.getBoundingClientRect().height || 0
    if (r.top < box.top + head) by(r.top - box.top - head - 8)
    else if (r.bottom > box.bottom) by(r.bottom - box.bottom + 8)
  }, [paneOpen])
  const setScopeAssigned = (on: boolean) => {
    const next = new URLSearchParams(searchParams)
    if (on) next.set('assigned_by_me', '1'); else next.delete('assigned_by_me')
    setSearchParams(next)
  }
  // A row is "narrowed" when a server filter or a non-default quick view is active —
  // used to tailor the empty-state copy (and offer a Clear button).
  const narrowed = !!(filters.q || filters.priority || filters.status || filters.assignee) || quickView === 'overdue' || quickView === 'today'
  const clearFilters = () => { setFilters({ q: '', priority: '', status: '', assignee: '' }); setQuickView('active') }

  // Quick views split the list into ACTIVE work vs the COMPLETED archive.
  // A completed task = status 'Done' (employee tasks reach 'Done' only once a
  // manager accepts them); these are removed from the active list and shown,
  // with their assigned + completed dates, in the Completed view.
  const todayStr = todayKey()
  const matchesQuick = (t: Task, key: typeof quickView) => {
    switch (key) {
      case 'completed': return t.status === 'Done'
      case 'overdue': return !!t.due_date && t.due_date < todayStr && t.status !== 'Done'
      case 'today': return t.due_date === todayStr && t.status !== 'Done'
      default: return t.status !== 'Done' // 'active'
    }
  }
  const visibleTasks = useMemo(() => tasks.filter((t) => matchesQuick(t, quickView)), [tasks, quickView])
  const QUICK_CHIPS: { key: typeof quickView; label: string; danger?: boolean }[] = [
    { key: 'active', label: 'Active' },
    { key: 'overdue', label: 'Overdue', danger: true },
    { key: 'today', label: 'Due today' },
    { key: 'completed', label: '✓ Completed' },
  ]

  // Left-edge accent on each row by due-date urgency (overdue/today) or completion.
  const rowClass = (t: Task) => {
    if (t.status === 'Done') return 'row-done'
    if (t.due_date && t.due_date < todayStr) return 'row-overdue'
    if (t.due_date === todayStr) return 'row-today'
    return ''
  }

  // Every sort produces this one fully-ordered list. Memoized: it used to
  // recompute on every keystroke-driven re-render.
  const sortedTasks = useMemo(
    () => [...visibleTasks].sort((a, b) => compareTasks(a, b, sort.key, sort.dir)),
    [visibleTasks, sort.key, sort.dir],
  )

  // On Default, that list is then cut into day headings — the chronological feed.
  // Days run newest-first; undated tasks land in a trailing "No date" group. Any
  // other column renders sortedTasks flat, so e.g. Due date really is
  // soonest-first across every date rather than within one day at a time.
  const groupedByDay = useMemo(() => {
    if (!isGroupedSort(sort.key)) return []
    const groups: Record<string, Task[]> = {}
    for (const t of sortedTasks) {
      const day = dayKeyOf(givenOf(t)) || 'No date'
      ;(groups[day] ||= []).push(t)
    }
    const keys = Object.keys(groups).sort((a, b) => (a === 'No date' ? 1 : b === 'No date' ? -1 : b.localeCompare(a)))
    return keys.map((day) => ({ day, items: groups[day] }))
  }, [sortedTasks, sort.key])

  // Friendly heading for a day group, e.g. "Today · Wednesday, 11 June 2026".
  const dayHeading = (day: string) => {
    if (day === 'No date') return 'No date'
    const d = new Date(day + 'T00:00:00')
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const diff = Math.round((today.getTime() - d.getTime()) / 86400000)
    const rel = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : null
    const full = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    return rel ? `${rel} · ${full}` : full
  }

  // Every mutation endpoint returns the updated task — patch it into the list in
  // place instead of re-fetching everything (a full reload after each inline edit
  // made the whole table flash and re-render). Failures fall back to a reload.
  const patchTask = (updated: Task) => setTasks((ts) => ts.map((t) => (t.id === updated.id ? updated : t)))

  // Inline assign from the table row (managers only). Sets owner + flips confidence to confirmed.
  const assign = (taskId: string, userId: string) => {
    if (!userId) return
    api.patch(`/tasks/${taskId}`, { assignee_id: userId }).then(patchTask).catch(() => load())
  }
  // Inline priority change from the report row (managers only).
  const changePriority = (taskId: string, priority: string) =>
    api.patch(`/tasks/${taskId}`, { priority }).then(patchTask).catch(() => load())
  // Inline approve: a manager marks an In-Review task as Done straight from the row.
  const markDone = (taskId: string) =>
    api.post(`/tasks/${taskId}/approve`, { decision: 'approved' }).then(patchTask).catch(() => load())

  // A task you raised for yourself — yours to tick off without a manager. Mirrors
  // isOwnSelfCreated() on the server, which is what actually enforces it.
  const isOwnWork = (t: Task) => !!user
    && !t.parent_task_id && !t.reassigned_at
    && t.assignee?.id === user.id && t.assigned_by_id === user.id

  // Board drag-and-drop: optimistically move the card, then persist via the status API.
  const moveStatus = (taskId: string, status: string) => {
    setTasks((ts) => ts.map((t) => (t.id === taskId ? { ...t, status } : t)))
    api.post(`/tasks/${taskId}/status`, { status }).then(patchTask).catch(() => load())
  }

  // Clickable, sortable column header. Active column shows the direction arrow; the
  // others show a faint ↕ to hint they're sortable too.
  const sortTh = (label: string, key: SortKey) => (
    <th className="clickable" style={{ userSelect: 'none' }} onClick={() => toggleSort(key)} title={`Sort by ${label.toLowerCase()}`}>
      {label} {sort.key === key ? (sort.dir === 'desc' ? '↓' : '↑') : <span style={{ opacity: 0.3 }}>↕</span>}
    </th>
  )

  // data-va lets the assistant point at this row after it changes something. Without
  // it `highlightTask` polls for four seconds and gives up, which reads to the user
  // as the agent hanging at the end of every create.
  const renderRow = (t: Task) => (
    <tr data-va={`task.${t.id}`} key={t.id} className={'clickable ' + rowClass(t)} onClick={() => pickTask(t.id)}>
      <td className="cell-title">
        <div style={{ fontWeight: 600 }}>{t.title}</div>
        <span className="row" style={{ gap: 6 }}><ConfidenceTag c={t.ownership_confidence} /><CategoryBadge c={t.category} /></span>
        <TaskHandoverLine task={t} />
      </td>
      <td data-label="Priority">
        {isManager ? (
          /* Wrapped so the caret can be drawn by us rather than by the browser.
             The native one is painted in the UA's own colour at the UA's own
             size — on a 12.5px control tinted red it read as no arrow at all, so
             the cell looked like a badge and nobody could tell the priority was
             editable. The caret inherits `color` from this span, which means it
             tracks the priority like the label and border already do. */
          <span className="prio-pick" style={{ color: PRIORITY_COLORS[t.priority] }}>
          <select
            className="prio-pick-sel"
            value={t.priority}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => { e.stopPropagation(); changePriority(t.id, e.target.value) }}
            style={{ color: PRIORITY_COLORS[t.priority], borderColor: (PRIORITY_COLORS[t.priority] || '#cbd5e1') + '88' }}
          >
            {/* Each option carries its OWN priority colour, not the select's. Without a
                colour here they inherit the select's, so every choice renders in the
                colour of the one already picked; with the fixed near-black that used to
                be here they were near-black on the dark popup surface, invisible until
                the hover highlight swept over them. The -ink tokens are built for this:
                dark and saturated on light, light on dark, legible on both. */}
            {['Critical', 'High', 'Medium', 'Low'].map((p) => (
              <option key={p} value={p} style={{ color: PRIORITY_COLORS[p], background: 'var(--surface)' }}>{p}</option>
            ))}
          </select>
            {/* pointer-events off so the caret is part of the button, not a hole
                in it — clicking the arrow must open the menu, as it would on any
                other dropdown. */}
            <svg className="prio-pick-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </span>
        ) : <PriorityBadge p={t.priority} />}
      </td>
      <td data-label="Status">
        <span className="row" style={{ gap: 8 }}>
          <StatusBadge s={t.status} />
          {(isManager || isAssignerOf(t)) && t.status === 'In Review' && (
            <button className="btn btn-sm btn-done" onClick={(e) => { e.stopPropagation(); markDone(t.id) }} title="Approve & mark as done">✓ Done</button>
          )}
          {(isManager || isOwnWork(t)) && t.status !== 'In Review' && t.status !== 'Done' && (
            <button className="btn-tick" onClick={(e) => { e.stopPropagation(); moveStatus(t.id, 'Done') }} title="Mark as completed" aria-label="Mark as completed">✓</button>
          )}
        </span>
      </td>
      {!personal && (
        <td data-label="Assignee">
          {t.assignee ? (
            <span className="row an"><Avatar name={t.assignee.name} color={t.assignee.avatar_color} size={22} /> <span className="an-name">{t.assignee.name}</span></span>
          ) : isManager ? (
            <select
              className="btn btn-sm"
              style={{ maxWidth: 150 }}
              value=""
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => { e.stopPropagation(); assign(t.id, e.target.value) }}
            >
              <option value="">＋ Assign…</option>
              {users.filter(u => u.role !== 'admin').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          ) : (
            <span className="muted">Unassigned</span>
          )}
        </td>
      )}
      <td data-label="Due">{dueLabel(t)}</td>
      {/* Dropped while the detail pane is open: six columns in half the width
          is unreadable, and this is the one the pane itself repeats. Back again
          the moment the pane closes and the table has the screen to itself. */}
      {!paneOpen && (
        <td data-label="Time">
          <div style={{ fontSize: 12.5 }}>{fmtDateTime(givenOf(t))}</div>
          <div className="muted" style={{ fontSize: 11 }}>{givenLabel(t)}</div>
        </td>
      )}
    </tr>
  )

  // Completed archive: accepted/done tasks, newest completion first, with both dates.
  const completedRows = useMemo(
    () => [...visibleTasks].sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || '')),
    [visibleTasks])
  const renderCompletedRow = (t: Task) => (
    <tr data-va={`task.${t.id}`} key={t.id} className="clickable" onClick={() => pickTask(t.id)}>
      <td className="cell-title"><div style={{ fontWeight: 600 }}>{t.title}</div><CategoryBadge c={t.category} /></td>
      <td data-label="Priority"><PriorityBadge p={t.priority} /></td>
      {!personal && (
        <td data-label="Assignee">
          {t.assignee
            ? <span className="row"><Avatar name={t.assignee.name} color={t.assignee.avatar_color} size={22} /> {t.assignee.name}</span>
            : <span className="muted">Unassigned</span>}
        </td>
      )}
      <td data-label="Assigned">{fmtDateTime(givenOf(t))}</td>
      <td data-label="Completed">
        <div style={{ color: '#10b981', fontWeight: 600 }}>{fmtDateTime(t.completed_at)}</div>
        {t.completedBy && <div className="muted" style={{ fontSize: 11 }}>by {t.completedBy.id === user?.id ? 'you' : t.completedBy.name}</div>}
      </td>
    </tr>
  )

  return (
    // The grid lives HERE, at the page root, not around the table — that is what
    // lets the details pane run the full height of the screen. As a row below the
    // toolbar and stat cards it could only ever start halfway down, because those
    // sit above it. Now they are simply the first rows of column one, and the pane
    // spans every row of column two.
    <div className={'tasks-page' + (paneOpen ? ' tasks-split' : '')}>
      {/* Column one, as ONE grid item. Spanning the toolbar, view bar, stat cards
          and table across separate rows meant the pane could only span the rows the
          explicit grid knew about — which was none, so it collapsed to the first.
          One item per column keeps it to a single row that both sides stretch to. */}
      <div className="tasks-col">
      <div className="toolbar">
        {/* search + sort + new task stay together on one line (esp. on mobile).
            `.toolbar-actions` is display:contents on desktop so these flow into the
            toolbar individually, and a single nowrap flex row on mobile. */}
        <div className="toolbar-actions">
          {/* Search opens a dialog (type or speak) — keeps the toolbar aligned.
              When a search is active, show a compact chip to edit/clear it. */}
          {filters.q ? (
            <div className="search-active toolbar-search">
              <button className="search-active-label" onClick={() => setSearchOpen(true)} title="Edit search">
                <SearchIcon size={14} /> <span className="search-active-q">{filters.q}</span>
              </button>
              <button className="search-active-clear" onClick={() => setFilters({ ...filters, q: '' })} title="Clear search" aria-label="Clear search">✕</button>
            </div>
          ) : (
            <button className="icon-btn toolbar-search" onClick={() => setSearchOpen(true)} title="Search tasks" aria-label="Search tasks">
              <SearchIcon />
            </button>
          )}
          {/* MOBILE-ONLY: sort the visible tasks. 'priority' (Critical first) is the
              default; each column picks a sensible direction when first chosen. */}
          {effectiveView === 'list' && (
            <SortMenu sortKey={sort.key} sortDir={sort.dir} onPick={toggleSort} />
          )}
          {/* MOBILE-ONLY: the priority/status/assignee filters, in a dialog — the
              inline desktop dropdowns below are hidden on phones, which used to
              leave mobile with no way to filter at all. */}
          <button className="icon-btn toolbar-filterbtn" onClick={() => setFiltersOpen(true)} title="Filter tasks" aria-label="Filter tasks">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="22 3 2 3 10 12.5 10 19 14 21 14 12.5 22 3" />
            </svg>
            {(Number(!!filters.priority) + Number(!!filters.status) + Number(!!filters.assignee)) > 0 && (
              <span className="filterbtn-dot">{Number(!!filters.priority) + Number(!!filters.status) + Number(!!filters.assignee)}</span>
            )}
          </button>
          {/* Sits at the far right of the toolbar, under the notification bell,
              rather than among the filters: it is not a way of narrowing the list,
              it is a different list. See .toolbar-trash. */}
          <button className="btn btn-sm row toolbar-trash" style={{ gap: 6 }} title="Tasks deleted in the last 30 days" onClick={() => setShowTrash(true)}>
            <Ic name="trash" size={14} /> Deleted Tasks
          </button>
          <button data-va="tasks.newTask" className="btn btn-primary btn-sm toolbar-newtask" onClick={() => setShowNew(true)}>+ New task</button>
        </div>
        {/* DESKTOP: the three filter dropdowns (+ sortable column headers). Hidden on
            mobile, where the Sort control above takes their place instead. */}
        <div className="toolbar-filters">
          <select value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value })}>
            <option value="">All priorities</option>{['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}
          </select>
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
            <option value="">All statuses</option>{['To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Reopened'].map((s) => <option key={s}>{s}</option>)}
          </select>
          {isManager && (
            <select value={filters.assignee} onChange={(e) => setFilters({ ...filters, assignee: e.target.value })}>
              <option value="">All assignees</option>
              <option value="unassigned">Unassigned</option>
              {users.filter(u => u.role !== 'admin').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          )}
        </div>
      </div>

      {/* Line 1: View toggle (left) + the "Active" chip. List/Board show the work
          I got; "Assigned by me" flips the scope to what I handed out or split. */}
      <div className="viewbar">
        <div className="seg">
          <button className={'seg-btn row' + (effectiveView === 'list' && !assignedByMe ? ' active' : '')} style={{ gap: 6 }} onClick={() => { setView('list'); setScopeAssigned(false) }} title="List view"><Ic name="menu" size={14} /> List</button>
          <button className={'seg-btn row' + (effectiveView === 'board' ? ' active' : '')} style={{ gap: 6 }} onClick={() => { setView('board'); setScopeAssigned(false) }} title="Board view"><Ic name="board" size={14} /> Board</button>
          <button className={'seg-btn row' + (effectiveView === 'activity' ? ' active' : '')} style={{ gap: 6 }} onClick={() => { setView('activity'); setScopeAssigned(false) }}
            title="Everything that happened to tasks, newest first"><Ic name="clock" size={14} /> Activity</button>
          {!personal && (
            <button className={'seg-btn row' + (assignedByMe ? ' active' : '')} style={{ gap: 6 }} onClick={() => { setView('list'); setScopeAssigned(true) }}
              title="Tasks you assigned to others or split with them"><Ic name="send" size={14} /> Assigned by me</button>
          )}
        </div>
        {effectiveView === 'list' && tasks.length > 0 && QUICK_CHIPS.filter((c) => c.key === 'active').map((c) => {
          const count = tasks.filter((t) => matchesQuick(t, c.key)).length
          return (
            <button key={c.key} className={'chip' + (quickView === c.key ? ' active' : '')} onClick={() => setQuickView(c.key)}>
              {c.label}<span className="chip-count">{count}</span>
            </button>
          )
        })}
      </div>

      {/* Line 2: quick-view stat cards (Overdue, Due today, Completed) — double as
          filters. Mirrors the template's stat-card row above the task list. */}
      {effectiveView === 'list' && tasks.length > 0 && (
        <div className="task-stats">
          {([
            { key: 'overdue' as const, label: 'Overdue', color: 'var(--danger-ink)', icon: <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2" /><path d="M5 3 2 6" /><path d="m22 6-3-3" /></> },
            { key: 'today' as const, label: 'Due today', color: '#3b82f6', icon: <><rect x="3" y="4" width="18" height="18" rx="3" /><path d="M16 2v4M8 2v4M3 10h18" /></> },
            { key: 'completed' as const, label: 'Completed', color: '#10b981', icon: <><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5L16 9" /></> },
          ]).map((s) => {
            const count = tasks.filter((t) => matchesQuick(t, s.key)).length
            return (
              <button
                key={s.key}
                className={'task-stat' + (quickView === s.key ? ' active' : '')}
                style={{ ['--sc' as any]: s.color }}
                onClick={() => setQuickView(s.key)}
              >
                <span className="task-stat-ic">
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{s.icon}</svg>
                </span>
                <span className="task-stat-val">{count}</span>
                <span className="task-stat-label">{s.label}</span>
              </button>
            )
          })}
        </div>
      )}

      {effectiveView === 'activity' ? (
        <TaskActivity
          filters={filters}
          users={users}
          personal={personal}
          refreshKey={activityTick}
          onOpen={setOpenId}
          onClearPageFilters={() => setFilters({ q: '', priority: '', status: '', assignee: '' })}
        />
      ) : loadError ? (
        <div className="card">
          <EmptyState icon={<Ic name="warning" size={40} />} title="Couldn't load tasks" hint="Check your connection and try again."
            action={<button className="btn btn-primary btn-sm" onClick={load}>Retry</button>} />
        </div>
      ) : loading ? (
        /* First fetch in flight: skeleton rows, never the "all caught up" empty state. */
        <div className="card table-card-wrap" aria-busy="true">
          <div className="card-pad">{Array.from({ length: 6 }).map((_, i) => <span key={i} className="skeleton skel-row" />)}</div>
        </div>
      ) : effectiveView === 'board' ? (
        tasks.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={<Ic name="check" size={40} />}
              title="You're all caught up!"
              hint={isManager
                ? 'No tasks yet. Create one to start tracking work.'
                : 'No tasks assigned to you yet. Create a personal task to get started.'}
              action={<button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>+ New task</button>}
            />
          </div>
        ) : (
          <TaskBoard tasks={tasks} onOpen={setOpenId} onMove={moveStatus} />
        )
      ) : (
        <>
          {visibleTasks.length === 0 ? (
            <div className="card">
              {assignedByMe && !narrowed && quickView !== 'completed' ? (
                <EmptyState
                  icon={<Ic name="send" size={40} />}
                  title="Nothing assigned to others yet"
                  hint="Tasks you assign to a colleague — or parts you split and share — will show up here, so you can track them and approve the work when it's submitted."
                />
              ) : quickView === 'completed' ? (
                <EmptyState
                  icon={<Ic name="box" size={40} />}
                  title="No completed tasks yet"
                  hint="Tasks marked Done and accepted by a manager will appear here, with their assigned and completed dates."
                />
              ) : narrowed ? (
                <EmptyState
                  icon={<Ic name="search" size={40} />}
                  title="No tasks match your filters"
                  hint="Try a different search term, or clear the filters to see everything."
                  action={<button className="btn btn-sm" onClick={clearFilters}>Clear filters</button>}
                />
              ) : (
                <EmptyState
                  icon={<Ic name="check" size={40} />}
                  title="You're all caught up!"
                  hint={isManager
                    ? 'No active tasks. Create one to start tracking work.'
                    : 'No active tasks assigned to you. Create a personal task to get started.'}
                  action={<button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>+ New task</button>}
                />
              )}
            </div>
          ) : quickView === 'completed' ? (
            <div className="card table-card-wrap">
              <table className="table-cards">
                <thead><tr>
                  <th>Task</th><th>Priority</th>{!personal && <th>Assignee</th>}<th>Assigned</th><th>Completed ↓</th>
                </tr></thead>
                <tbody>{completedRows.map(renderCompletedRow)}</tbody>
              </table>
            </div>
          ) : (
            /* Always display:contents — it groups the table and the pane in the
               JSX, but the grid that positions them is the page root above, so
               this must never become a box of its own. */
            <div className="tasks-splitwrap">
            <div className="card table-card-wrap tasks-split-list">
              <table className="table-cards table-tasks">
                <thead><tr>
                  {sortTh('Task', 'task')}
                  {sortTh('Priority', 'priority')}
                  {sortTh('Status', 'status')}
                  {!personal && sortTh('Assignee', 'assignee')}
                  {sortTh('Due', 'due')}
                  {!paneOpen && sortTh('Time', 'time')}
                </tr></thead>
                <tbody>
                  {!isGroupedSort(sort.key)
                    ? sortedTasks.map(renderRow)
                    : groupedByDay.map((g) => (
                      <React.Fragment key={g.day}>
                        <tr className="day-group-row">
                          <td colSpan={(personal ? 5 : 6) - (paneOpen ? 1 : 0)}>{dayHeading(g.day)} <span className="day-group-count">{g.items.length}</span></td>
                        </tr>
                        {g.items.map(renderRow)}
                      </React.Fragment>
                    ))}
                </tbody>
              </table>
            </div>
            </div>
          )}
        </>
      )}
      </div>

      {/* Rendered at the page root, beside the whole left column rather than
          inside the row with the table — that is what lets it run the full height.
          Only once a task is picked: an empty pane reserved half the screen to say
          nothing, and took the Time column with it. */}
      {paneOpen && (
        <aside className="tasks-split-pane">
          <TaskDrawer key={openId} taskId={openId!} variant="pane" {...focusFor(openId)} onClose={closeDrawer} onChange={(t) => (t && t.status ? patchTask(t) : load())} />
        </aside>
      )}

      {/* Mobile floating action button — the primary "add" action, in thumb reach.
          Replaces the toolbar "+ New task" button on phones (hidden there via CSS). */}
      <button className="fab-newtask" onClick={() => setShowNew(true)} aria-label={personal ? 'New personal task' : 'New task'} title={personal ? 'New personal task' : 'New task'}>
        <Ic name="plus" size={24} />
      </button>

      {/* Drawer edits patch the single row in place when the mutation returned the
          updated task; anything else (delete, uploads) falls back to a reload. */}
      {openId && !paneOpen && <TaskDrawer taskId={openId} {...focusFor(openId)} onClose={closeDrawer} onChange={(t) => { setActivityTick((n) => n + 1); return t && t.status ? patchTask(t) : load() }} />}
      {showNew && <NewTaskModal users={users} personal={personal} draft={draft} onUserCreated={(u) => setUsers((p) => [...p, u])} onClose={() => { setShowNew(false); setDraft(null) }} onCreated={() => { setShowNew(false); setDraft(null); load() }} />}
      {showTrash && <TrashModal onClose={() => setShowTrash(false)} onRestored={load} />}
      {searchOpen && <SearchDialog initial={filters.q} onApply={(f) => { setFilters({ ...filters, ...f }); if (f.status === 'Done') setQuickView('completed') }} onClose={() => setSearchOpen(false)} />}
      {filtersOpen && (
        <FiltersDialog
          filters={filters}
          users={users}
          isManager={isManager}
          onApply={(f) => { setFilters({ ...filters, ...f }); if (f.status === 'Done') setQuickView('completed') }}
          onClose={() => setFiltersOpen(false)}
        />
      )}
    </div>
  )
}

// Locate one of the new-task form's controls. The agent uses these ONLY to show
// where it is working (scroll into view, focus ring, typing caret) — every value it
// sets goes through React state, so a missing element degrades to an instant,
// still-correct change rather than a broken one.
const findField = (key: string) => findVaEl(`tasks.new.${key}`)

function NewTaskModal({ users, personal, draft, onUserCreated, onClose, onCreated }: { users: User[]; personal?: boolean; draft?: TaskDraft | null; onUserCreated?: (u: User) => void; onClose: () => void; onCreated: () => void }) {
  const { user } = useAuth()
  useEscape(onClose)
  const isEmployee = user?.role === 'employee'
  // "Add new employee or manager…" on the assignee picker: the person you want
  // to hand this to is not in the system yet, and the round trip through
  // Administration lost the task you were typing. The same Add-user form opens
  // on top of this one; who it creates joins the list and is selected. Managers
  // and admins only — the server would refuse anyone else anyway.
  const canAddPeople = user?.role === 'manager' || user?.role === 'admin'
  const [showNewUser, setShowNewUser] = useState(false)
  const [depts, setDepts] = useState<any[]>([])
  useEffect(() => {
    if (showNewUser && !depts.length) api.get('/users/meta/departments').then(setDepts).catch(() => {})
  }, [showNewUser]) // eslint-disable-line react-hooks/exhaustive-deps
  // Private only in My Tasks (personal) mode. Everywhere else, anyone may assign
  // the task to anyone — so the assignee picker is shown to everyone.
  const asPersonal = !!personal
  // Default the owner to yourself (so it shows in your list); managers triage, so
  // they default to Unassigned.
  // A draft handed over from elsewhere (a chat message) wins over the defaults for
  // whatever it actually filled in; anything it left blank falls back to the same
  // defaults a hand-opened form would have.
  const draftPriority = draft?.priority || 'Medium'
  const [form, setForm] = useState<any>({
    title: draft?.title || '',
    description: draft?.description || '',
    priority: draftPriority,
    assignee_id: draft?.assignee_id || (isEmployee ? (user?.id || '') : ''),
    due_date: draft?.due_date || dueDateForPriority(draftPriority),
    source_message_id: draft?.source_message_id || undefined,
  })
  // Once the user picks a date by hand, stop auto-syncing it to the priority. A
  // date the draft read out of the message ("by Friday") counts as picked — the
  // sender said it, so a later priority change must not silently overwrite it.
  const [dueManual, setDueManual] = useState(!!draft?.due_date)
  // Change priority and keep the due date in step (unless the user set it by hand).
  const setPriority = (priority: string) =>
    setForm((f: any) => ({ ...f, priority, due_date: dueManual ? f.due_date : dueDateForPriority(priority) }))
  const [busy, setBusy] = useState(false)
  // Files staged in the form; uploaded to the task right AFTER it's created
  // (the task has no id until then). Any type, up to 500 MB each.
  const [files, setFiles] = useState<File[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  // Which staged file is going up and how far, for the Create button — a big
  // video takes minutes, and a bare spinner for that long reads as stuck.
  const [sending, setSending] = useState<{ n: number; of: number; pct: number } | null>(null)
  // Returns how many were taken, so a paste can say what it added.
  const addFiles = (list: FileList | File[] | null) => {
    if (!list) return 0
    const { ok, skipped } = attachable(list)
    if (skipped) toast.error(skipped)
    setFiles((prev) => [...prev, ...ok])
    if (fileInput.current) fileInput.current.value = ''
    return ok.length
  }
  const removeFile = (i: number) => setFiles((prev) => prev.filter((_, idx) => idx !== i))
  const save = async () => {
    if (!form.title) return
    setBusy(true)
    try {
      const created = await api.post('/tasks', { ...form, personal: asPersonal })
      // Upload staged attachments to the freshly-created task (best-effort per file).
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        setSending({ n: i + 1, of: files.length, pct: 0 })
        try { await attachToTask(created.id, f, (pct) => setSending((s) => (s ? { ...s, pct } : s))) }
        catch (e: any) { toast.error(`Couldn't attach ${f.name}: ${e?.message || 'upload failed'}`) }
      }
      onCreated()
      return created
    } finally { setBusy(false); setSending(null) }
  }

  // ---- Agent surface -------------------------------------------------------
  // What the voice assistant is allowed to do to this form. Each capability drives
  // the SAME React state a human keystroke would, so what the user watches happen is
  // the real thing — there is no second, invisible code path that could diverge.
  //
  // The DOM is touched only through uiController, and only to show where the agent
  // is working (scroll, ring, caret). Values always go through setForm.
  const assignable = users.filter((u) => u.role !== 'admin')
  useSurface('tasks.new', {
    // Match a spoken name to a real teammate. Exact wins; otherwise a unique
    // case-insensitive prefix/substring match. An ambiguous or absent name returns
    // candidates so the Action Engine can ask instead of picking someone at random —
    // assigning work to the wrong person is not a recoverable mistake.
    resolveAssignee: ({ name }: { name: string }) => {
      const q = String(name || '').trim().toLowerCase()
      if (!q) return { match: null, candidates: [] }
      const exact = assignable.find((u) => u.name.toLowerCase() === q)
      if (exact) return { match: { id: exact.id, name: exact.name }, candidates: [] }
      const hits = assignable.filter((u) => u.name.toLowerCase().includes(q) || q.includes(u.name.toLowerCase().split(' ')[0]))
      return {
        match: hits.length === 1 ? { id: hits[0].id, name: hits[0].name } : null,
        candidates: hits.slice(0, 4).map((u) => ({ id: u.id, name: u.name })),
      }
    },
    setTitle: ({ value }: { value: string }) =>
      typeInto(findField('title'), value, (v) => setForm((f: any) => ({ ...f, title: v }))),
    setDescription: ({ value }: { value: string }) =>
      typeInto(findField('description'), value, (v) => setForm((f: any) => ({ ...f, description: v }))),
    setPriority: ({ value }: { value: string }) =>
      pickValue(findField('priority'), value, (v) => setPriority(v)),
    setAssignee: ({ id }: { id: string }) =>
      pickValue(findField('assignee'), id, (v) => setForm((f: any) => ({ ...f, assignee_id: v }))),
    setDueDate: ({ value }: { value: string }) =>
      pickValue(findField('due_date'), value, (v) => { setDueManual(true); setForm((f: any) => ({ ...f, due_date: v })) }),
    // Read back what is on screen, so the agent can confirm before submitting
    // ("Creating 'Fix login bug' for Reddeppa, high priority, due Friday").
    read: () => ({ ...form, assignee_name: assignable.find((u) => u.id === form.assignee_id)?.name || null }),
    submit: async () => {
      await pause(260)                       // a beat so the filled form is readable
      await settle()                         // ...and make sure the last field committed
      await flashPress(findField('submit'))
      return await save()
    },
    // Fill, then stop. The agent uses this instead of submit() so the person
    // reads what was heard before it becomes a real task assigned to a real
    // colleague. Everything else about the workflow is unchanged — the fields
    // are filled by driving the actual form, so what you approve is exactly what
    // saves. Focusing Create (rather than only flashing it) means Enter finishes
    // the job, so the fast path stays one keystroke.
    handOver: async () => {
      await pause(260)
      await settle()
      await flashPress(findField('submit'))
      return { ...form, assignee_name: assignable.find((u) => u.id === form.assignee_id)?.name || null }
    },
    cancel: () => onClose(),
  })

  // ---- Voice input: record a short clip and transcribe it SERVER-SIDE (Sarvam /
  // Whisper), which is far more reliable on Android and for Telugu/Hindi/English
  // code-mixing than the browser's SpeechRecognition. The AI then extracts the
  // title, description, assignee, priority & due date and fills the form. ----
  const canRecord = typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof (window as any).MediaRecorder !== 'undefined'
  const mrRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const listeningRef = useRef(false)          // read inside MediaRecorder callbacks
  // Elapsed recording time. Tied to `listening`, not to the segment loop, so it
  // counts the whole take rather than restarting every 20s when a segment rolls.
  const [recSecs, setRecSecs] = useState(0)
  const recTimerRef = useRef<number | null>(null)
  const segTimerRef = useRef<number | null>(null)
  const segSeqRef = useRef(0)                 // spoken order of each segment
  const segTextRef = useRef<string[]>([])     // transcript per segment, by seq
  const segJobsRef = useRef<Promise<unknown>[]>([])
  const segErrRef = useRef('')
  const [listening, setListening] = useState(false) // actively recording
  const [parsing, setParsing] = useState(false)     // transcribing + AI extraction
  const [heard, setHeard] = useState('')
  // Read the "user picked a date by hand" flag from a ref so the async voice
  // handler always sees the CURRENT value (not a stale render closure).
  const dueManualRef = useRef(dueManual)
  useEffect(() => { dueManualRef.current = dueManual }, [dueManual])

  // Stop recording and release the mic device.
  const releaseMic = () => {
    try { if (mrRef.current && mrRef.current.state !== 'inactive') mrRef.current.stop() } catch {}
    try { streamRef.current?.getTracks().forEach((t) => t.stop()) } catch {}
    streamRef.current = null
  }
  useEffect(() => () => {
    releaseMic()
    if (recTimerRef.current) clearInterval(recTimerRef.current)
  }, []) // release the mic and the ticker on unmount (close)

  // Merge the AI-extracted fields into the form. Assignee applies only when not in
  // personal mode. The due date is NEVER left blank: spoken date wins, else it
  // tracks the priority unless the user already picked one by hand.
  const applyVoice = async (transcript: string) => {
    const text = transcript.trim()
    if (!text) return
    const d = await api.post('/tasks/parse-voice', { transcript: text })
    if (d.due_date) { setDueManual(true); dueManualRef.current = true }
    setForm((f: any) => {
      const priority = d.priority || f.priority
      const due = d.due_date
        || (dueManualRef.current ? f.due_date : '')
        || dueDateForPriority(priority)
      return {
        ...f,
        title: d.title || f.title || text,
        description: d.description || f.description,
        priority,
        due_date: due,
        assignee_id: !asPersonal && d.assignee_id ? d.assignee_id : f.assignee_id,
      }
    })
  }

  // Send ONE segment for transcription. Returns its text; the caller stitches.
  const transcribeSegment = async (blob: Blob) => {
    const fd = new FormData()
    fd.append('audio', blob, 'task.webm')
    const headers: Record<string, string> = {}
    const token = getToken()
    if (token) headers.authorization = `Bearer ${token}`
    const res = await fetch(`${API_BASE}/api/tasks/transcribe`, { method: 'POST', headers, body: fd, cache: 'no-store' })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error || `Transcription failed (${res.status})`)
    return String(data?.text || '').trim()
  }

  // Speak for as long as you like.
  //
  // Sarvam's instant endpoint refuses anything past 30 seconds, and this recorder
  // used to hand it one unbounded blob — so a long task description failed AFTER
  // you had finished speaking, with the audio already gone. The answer is not to
  // cut the person off: recording runs until they stop it, and the CLIP is what
  // gets divided.
  //
  // Segments are cut by stopping and restarting MediaRecorder rather than using
  // start(timeslice). A timeslice emits fragments where only the first carries the
  // webm header, so segments 2..n are not decodable alone and every one of them
  // would fail upstream. Stop/start yields complete, independently valid files.
  // The MediaStream is untouched across cycles, so the mic is never re-acquired
  // and no audio is lost to a device spin-up.
  const SEGMENT_MS = 20000   // comfortably inside Sarvam's 30s ceiling
  const startSegment = (stream: MediaStream) => {
    let mr: MediaRecorder
    try { mr = new MediaRecorder(stream, { mimeType: 'audio/webm' }) } catch { mr = new MediaRecorder(stream) }
    mrRef.current = mr
    const parts: BlobPart[] = []
    const seq = segSeqRef.current++
    mr.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data) }
    mr.onstop = () => {
      const blob = new Blob(parts, { type: mr.mimeType || 'audio/webm' })
      // Segments upload in parallel but must be stitched in the order they were
      // SPOKEN, so each keeps its sequence number instead of racing to append.
      if (blob.size) {
        segTextRef.current[seq] = ''
        segJobsRef.current.push(
          transcribeSegment(blob)
            .then((t) => { segTextRef.current[seq] = t; setHeard(segTextRef.current.filter(Boolean).join(' ')) })
            .catch((err) => { segErrRef.current = err?.message || 'Transcription failed' })
        )
      }
      if (listeningRef.current) startSegment(stream)   // still talking — next segment
      else finishRecording()
    }
    try { mr.start() } catch {
      setListening(false); listeningRef.current = false
      if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null }
      releaseMic(); return
    }
    segTimerRef.current = window.setTimeout(() => {
      if (mrRef.current === mr && mr.state !== 'inactive') { try { mr.stop() } catch {} }
    }, SEGMENT_MS)
  }

  // Runs once the final segment has closed: wait for every upload, stitch the
  // transcript in spoken order, then run the LLM parse ONCE over the whole thing.
  // The fields it fills — assignee, priority, due date — only make sense against
  // the complete sentence, not a 20-second slice of it.
  const finishRecording = async () => {
    if (segTimerRef.current) { clearTimeout(segTimerRef.current); segTimerRef.current = null }
    try { streamRef.current?.getTracks().forEach((t) => t.stop()) } catch {}
    streamRef.current = null
    if (!segJobsRef.current.length) return
    setParsing(true)
    try {
      await Promise.allSettled(segJobsRef.current)
      const text = segTextRef.current.filter(Boolean).join(' ').trim()
      setHeard(text)
      if (!text) { toast.error(segErrRef.current || "Didn't catch that — please tap Speak and try again."); return }
      // A failed segment mid-way means words are missing. Say so, rather than
      // quietly building a task out of half a sentence.
      if (segErrRef.current) toast.info('Part of the audio could not be transcribed — check the text before creating.')
      await applyVoice(text)
    } catch (err: any) {
      toast.error(err?.message || 'Could not transcribe the audio. Check your connection and try again.')
    } finally {
      setParsing(false)
      segJobsRef.current = []; segTextRef.current = []; segErrRef.current = ''; segSeqRef.current = 0
    }
  }

  // m:ss — minutes are not zero-padded because a task is rarely dictated for ten.
  const recClock = `${Math.floor(recSecs / 60)}:${String(recSecs % 60).padStart(2, '0')}`

  const toggleMic = async () => {
    // Tapping while recording = Stop → the open segment closes and its onstop
    // calls finishRecording() once every upload has landed.
    if (listening) {
      setListening(false)
      listeningRef.current = false
      if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null }
      if (segTimerRef.current) { clearTimeout(segTimerRef.current); segTimerRef.current = null }
      try { mrRef.current?.stop() } catch { finishRecording() }
      return
    }
    if (!canRecord) { toast.error('Voice input needs microphone access on this device.'); return }
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
    catch { toast.error('Microphone access is blocked. Allow mic permission for this app and try again.'); return }
    streamRef.current = stream
    segSeqRef.current = 0; segTextRef.current = []; segJobsRef.current = []; segErrRef.current = ''
    setHeard('')
    setListening(true)
    listeningRef.current = true
    setRecSecs(0)
    if (recTimerRef.current) clearInterval(recTimerRef.current)
    recTimerRef.current = window.setInterval(() => setRecSecs((n) => n + 1), 1000)
    startSegment(stream)
  }

  return (
    <div className="modal-center" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        // A screenshot pasted anywhere in the form (Ctrl+V — in the title or the
        // description too) or files dropped on it join the attachments below; a
        // paste of words is still words (lib/pasteFiles).
        onPaste={(e) => {
          const pasted = clipboardFiles(e.clipboardData)
          if (!pasted.length) return
          e.preventDefault()
          const added = addFiles(pasted)
          if (added) toast.success(added === 1 ? 'Added the pasted file to the attachments below' : `Added ${added} pasted files to the attachments below`)
        }}
        onDragOver={(e) => { if (dragHasFiles(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } }}
        onDrop={(e) => { if (!dragHasFiles(e.dataTransfer)) return; e.preventDefault(); addFiles(droppedFiles(e.dataTransfer)) }}
      >
        <div className="card-head spread"><h3>{asPersonal ? 'New personal task' : 'New task'}</h3><button className="btn btn-ghost" onClick={onClose}>✕</button></div>
        <div className="card-pad grid" style={{ gap: 12 }}>
          {asPersonal && <div className="muted row" style={{ gap: 7, fontSize: 12, background: 'var(--info-bg)', border: '1px solid var(--info-border)', color: 'var(--info-ink)', borderRadius: 8, padding: '8px 10px' }}><Ic name="lock" size={13} /> Private to you — only you can see this task.</div>}
          <div>
            <label>
              Title
              {listening && <span style={{ color: '#b91c1c', fontWeight: 700, fontSize: 11 }}> ● recording {recClock}</span>}
              {parsing && <span style={{ color: 'var(--primary)', fontWeight: 700, fontSize: 11 }}> ● understanding…</span>}
            </label>
            {canRecord && (
              <div className="speak-row">
                <button
                  type="button"
                  className={'btn btn-mic btn-mic-hero' + (listening ? ' btn-mic-live' : '')}
                  onClick={toggleMic}
                  disabled={parsing}
                  title="Speak the task — AI fills in the title, details, assignee & priority"
                >
                  {parsing
                    ? <><span className="spinner" /> Thinking…</>
                    : listening
                      ? <><span className="mic-dot" /> Stop recording · {recClock}</>
                      : <><MicIcon size={18} /> Speak your task</>}
                </button>
              </div>
            )}
            {canRecord && !listening && !parsing && !heard && (
              <div className="muted" style={{ fontSize: 11.5, marginTop: 6, textAlign: 'center' }}>
                Tip: say the whole task — e.g. “High priority task for Ravi to fix the login page bug by Friday.”
              </div>
            )}
            {listening && (
              <div className="muted" style={{ fontSize: 11.5, marginTop: 6, textAlign: 'center' }}>Listening… tap Stop when you're done.</div>
            )}
            {parsing && heard && (
              <div className="muted" style={{ fontSize: 12, marginTop: 6, fontStyle: 'italic', textAlign: 'center' }}>“{heard}”</div>
            )}
            <AutoTextarea data-va="tasks.new.title" style={{ width: '100%', marginTop: 8 }} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="What needs doing?" autoFocus />
          </div>
          <div><label>Description</label><textarea data-va="tasks.new.description" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
          <div className={asPersonal ? 'grid grid-2' : 'grid grid-3'} style={{ gap: 10 }}>
            <div><label>Priority</label><select data-va="tasks.new.priority" value={form.priority} onChange={(e) => setPriority(e.target.value)}>{['Critical', 'High', 'Medium', 'Low'].map((p) => <option key={p}>{p}</option>)}</select></div>
            {!asPersonal && <div><label>Assign to {form.assignee_id === user?.id && <span className="muted" style={{ fontWeight: 500, fontSize: 10.5 }}>· defaults to you — pick anyone</span>}</label>
              <PickerWithAdd
                dataVa="tasks.new.assignee" value={form.assignee_id} onChange={(id) => setForm((f: any) => ({ ...f, assignee_id: id }))}
                options={assignable.map((u) => ({ id: u.id, name: u.name + (u.id === user?.id ? ' (me)' : '') }))}
                blankLabel="Unassigned" addLabel="Add new employee or manager…" noun="person"
                canAdd={canAddPeople} onAddClick={() => setShowNewUser(true)} ariaLabel="Assign to"
              />
            </div>}
            <div><label>Due date {!dueManual && <span className="muted" style={{ fontWeight: 500, fontSize: 10.5 }}>· auto from priority</span>}</label><input data-va="tasks.new.due_date" type="date" value={form.due_date} onChange={(e) => { setDueManual(true); setForm({ ...form, due_date: e.target.value }) }} /></div>
          </div>
          <div><label>Category {!form.category && <span className="muted" style={{ fontWeight: 500, fontSize: 10.5 }}>· auto-detected if left blank</span>}</label>
            <CategorySelect value={form.category || ''} onChange={(c) => setForm((f: any) => ({ ...f, category: c }))} blankLabel="Auto-detect" />
          </div>
          <div>
            <label>Attachments <span className="muted" style={{ fontWeight: 500, fontSize: 10.5 }}>· any file, up to 500 MB each</span></label>
            <input ref={fileInput} type="file" multiple style={{ display: 'none' }} onChange={(e) => addFiles(e.target.files)} />
            <button type="button" className="btn btn-sm row" style={{ gap: 6 }} onClick={() => fileInput.current?.click()} title="Or paste a screenshot anywhere in this form with Ctrl+V"><Ic name="attach" size={14} /> Attach files</button>
            {files.length > 0 && (
              <div className="attach-stage">
                {files.map((f, i) => (
                  <div key={i} className="attach-chip">
                    <Ic name={f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : 'doc'} size={14} />
                    <span className="attach-chip-name" title={f.name}>{f.name}</span>
                    <span className="muted" style={{ fontSize: 11 }}>{fmtBytes(f.size)}</span>
                    <button type="button" className="attach-chip-x" onClick={() => removeFile(i)} aria-label={`Remove ${f.name}`}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button data-va="tasks.new.submit" className="btn btn-primary" onClick={save} disabled={busy || !form.title}>
              {sending ? `Attaching${sending.of > 1 ? ` ${sending.n} of ${sending.of}` : ''}… ${sending.pct}%` : busy ? <span className="spinner" /> : 'Create task'}
            </button>
          </div>
          {showNewUser && (
            // display:contents, so the wrapper adds no row to the form's grid. It
            // exists only to keep the user form's clicks and Escape from reaching
            // this modal, which would close the task form underneath.
            <div style={{ display: 'contents' }} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setShowNewUser(false) } }}>
              <UserForm
                user={null} depts={depts} isAdmin={user?.role === 'admin'} onClose={() => setShowNewUser(false)}
                onDone={(u) => {
                  setShowNewUser(false)
                  if (!u) return
                  onUserCreated?.(u)
                  setForm((f: any) => ({ ...f, assignee_id: u.id }))
                  toast.success(`${u.name} added and assigned`)
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

interface TrashRow {
  id: string; title: string; assignee_name: string | null
  priority?: string; status?: string; due_date?: string | null
  deleted_at: string; deleted_by: string | null; purge_after: string
  comments: number; attachments: number
}

// The recycle bin.
//
// A deleted task is not gone, it is here, for RECOVERY_DAYS. The countdown is the
// point of the screen: "deleted yesterday" is reassuring and useless, "3 days left"
// is the thing that makes someone act. Permanent deletion lives behind a second,
// separate button so that emptying the bin can never be a slip of the same click
// that filled it.
function TrashModal({ onClose, onRestored }: { onClose: () => void; onRestored: () => void }) {
  const [rows, setRows] = useState<TrashRow[]>([])
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [err, setErr] = useState('')

  const load = () => {
    setLoading(true)
    api.get('/tasks/trash')
      .then((d) => { setRows(d.tasks || []); setDays(d.recovery_days || 30) })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])
  useEscape(onClose)

  const daysLeft = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86400000))

  const restore = async (t: TrashRow) => {
    setBusyId(t.id); setErr('')
    try { await api.post(`/tasks/trash/${t.id}/restore`, {}); toast.success(`Restored "${t.title}"`); load(); onRestored() }
    catch (e: any) { setErr(e.message) } finally { setBusyId(null) }
  }

  const purge = async (t: TrashRow) => {
    if (!window.confirm(`Delete "${t.title}" permanently?\n\nThis cannot be undone — it will not be recoverable afterwards.`)) return
    setBusyId(t.id); setErr('')
    try { await api.del(`/tasks/trash/${t.id}`); toast.success('Deleted permanently'); load() }
    catch (e: any) { setErr(e.message) } finally { setBusyId(null) }
  }

  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Recently deleted tasks"
        onClick={(e) => e.stopPropagation()} style={{ maxWidth: 780, width: '94%' }}>
        <div className="card-head spread">
          <h3 className="row" style={{ gap: 8 }}><Ic name="trash" size={16} /> Recently deleted</h3>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="card-pad" style={{ maxHeight: '68vh', overflow: 'auto' }}>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 12 }}>
            Deleted tasks are kept for {days} days and can be restored with their comments and attachments.
            After that they are removed permanently.
          </div>
          {err && <div style={{ color: 'var(--danger-ink)', fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>{err}</div>}
          {loading ? <span className="spinner" /> : rows.length === 0 ? (
            <EmptyState icon={<Ic name="trash" size={40} />} title="Nothing deleted"
              hint="Tasks you delete show up here, and can be restored for a month." />
          ) : (
            <table>
              <thead><tr><th>Task</th><th>Deleted</th><th>Time left</th><th></th></tr></thead>
              <tbody>
                {rows.map((t) => {
                  const left = daysLeft(t.purge_after)
                  return (
                    <tr key={t.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{t.title}</div>
                        <div className="muted" style={{ fontSize: 11.5 }}>
                          {t.assignee_name || 'Unassigned'}
                          {t.priority ? ` · ${t.priority}` : ''}
                          {t.comments ? ` · ${t.comments} comment${t.comments > 1 ? 's' : ''}` : ''}
                          {t.attachments ? ` · ${t.attachments} file${t.attachments > 1 ? 's' : ''}` : ''}
                        </div>
                      </td>
                      <td className="muted" style={{ fontSize: 12 }}>
                        {new Date(t.deleted_at).toLocaleDateString()}
                        {t.deleted_by ? <><br />by {t.deleted_by}</> : null}
                      </td>
                      <td style={{ fontSize: 12, fontWeight: 600, color: left <= 3 ? 'var(--danger-ink)' : 'inherit' }}>
                        {left === 0 ? 'today' : `${left} day${left > 1 ? 's' : ''}`}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="btn btn-primary btn-sm" disabled={busyId === t.id} onClick={() => restore(t)}>
                          {busyId === t.id ? <span className="spinner" /> : 'Restore'}
                        </button>{' '}
                        <button className="btn btn-sm btn-danger" disabled={busyId === t.id} onClick={() => purge(t)} title="Delete permanently now">
                          Delete forever
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
