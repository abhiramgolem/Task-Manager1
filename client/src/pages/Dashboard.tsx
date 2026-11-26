import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, Task } from '../api'
import { useAuth } from '../auth'
import { Bar, PriorityBadge, Avatar, EmptyState, Ic, dueLabel, STATUS_COLORS, Donut, PRIORITY_COLORS } from '../ui'
import TaskDrawer from '../components/TaskDrawer'
import TaskOriginBadge, { TaskHandoverLine } from '../components/TaskOriginBadge'
import { presetRange, todayYmd, ReportRange, downloadManagerReport } from '../report'
import { toast } from '../lib/toast'
import { listReviewDrafts } from '../lib/reviewDraft'

export default function Dashboard() {
  const { user } = useAuth()
  if (!user) return null
  if (user.role === 'employee') return (
    <>
      <Greeting name={user.name} style={{ marginBottom: 18 }} />
      <EmployeeDash />
    </>
  )
  return <ManagerDash admin={user.role !== 'manager'} name={user.name} />
}

// Friendly time-of-day greeting shown at the top-left of the dashboard.
function Greeting({ name, style }: { name: string; style?: React.CSSProperties }) {
  const h = new Date().getHours()
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  const first = (name || '').trim().split(' ')[0] || name
  return (
    <div style={style}>
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{part}, {first}</h2>
      <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>Here's your overview for today.</div>
    </div>
  )
}

// AI-suggestion banner — mirrors the template's "AI suggestions" card. Surfaces the
// real overdue count and deep-links to the overdue view. Hidden when nothing's overdue.
function AiSuggestBanner({ overdue, onGo }: { overdue: number; onGo: () => void }) {
  if (!overdue) return null
  return (
    <button className="ai-suggest section" onClick={onGo}>
      <span className="ai-suggest-ic">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2.5 14 8.2l5.7 2-5.7 2L12 19.9l-2-5.7-5.7-2L10 8.2z" />
          <path d="M19 13.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z" />
        </svg>
      </span>
      <span className="ai-suggest-body">
        <span className="ai-suggest-title">You have {overdue} overdue task{overdue === 1 ? '' : 's'}</span>
        <span className="ai-suggest-sub">Tap to review and reschedule them.</span>
      </span>
      <span className="ai-suggest-go" aria-hidden="true">›</span>
    </button>
  )
}

// Meeting tasks the AI extracted and nobody has approved yet. This is the first
// thing a manager should see after a meeting, and — since a killed app cold-starts
// on the dashboard, not on the screen they were interrupted on — it is also the
// only signpost back to a review they abandoned halfway through.
function UnreviewedBanner({ meetings, drafts, onGo }: { meetings: any[]; drafts: Set<string>; onGo: (id: string) => void }) {
  if (!meetings.length) return null
  const tasks = meetings.reduce((n, m) => n + (m.pending_count || 0), 0)
  // An unfinished review outranks a merely untouched one: that manager already
  // spent time on it, and their edits are sitting on this device waiting.
  const resume = meetings.find((m) => drafts.has(m.id))
  const target = resume || meetings[0]
  return (
    <button className="ai-suggest section" onClick={() => onGo(target.id)}>
      <span className="ai-suggest-ic"><Ic name="ai" size={22} /></span>
      <span className="ai-suggest-body">
        <span className="ai-suggest-title">
          {tasks} AI meeting task{tasks === 1 ? '' : 's'} waiting to be reviewed
        </span>
        <span className="ai-suggest-sub">
          {resume
            ? `You left “${resume.title}” half-reviewed — your edits were saved.`
            : `From ${meetings.length} meeting${meetings.length === 1 ? '' : 's'}. Nothing is assigned until you approve it.`}
        </span>
      </span>
      <span className="ai-suggest-go" aria-hidden="true">›</span>
    </button>
  )
}

// Meetings with suggestions still pending, plus which of them this device holds
// unfinished edits for. Its own endpoint rather than a field on the dashboard
// payload, so a banner about two meetings can't drag the whole dashboard
// aggregate — or fail with it: a 500 here just hides the banner.
function useUnreviewedMeetings(userId?: string) {
  const [meetings, setMeetings] = useState<any[]>([])
  useEffect(() => {
    api.get('/meetings/pending-review').then(setMeetings).catch(() => setMeetings([]))
  }, [])
  const drafts = React.useMemo(() => new Set(listReviewDrafts(userId || 'anon').map((d) => d.meetingId)), [userId])
  return { meetings, drafts }
}

// Relative "time ago" for audit rows. SQLite stores UTC as a bare "YYYY-MM-DD
// HH:MM:SS" string, so normalise it to a real UTC instant first.
function timeAgo(raw: string | number): string {
  let ms: number
  if (typeof raw === 'number') ms = raw
  else {
    const s = /\dT|\dZ|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z'
    ms = Date.parse(s)
  }
  if (isNaN(ms)) return ''
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (sec < 60) return 'just now'
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago'
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago'
  return Math.floor(sec / 86400) + 'd ago'
}

const ActSvg = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
)
const ACT_ICONS = {
  create: <ActSvg><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M12 8v8M8 12h8" /></ActSvg>,
  status: <ActSvg><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M3 21v-5h5" /></ActSvg>,
  done: <ActSvg><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="m9 11 3 3L22 4" /></ActSvg>,
  comment: <ActSvg><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></ActSvg>,
  split: <ActSvg><path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9" /></ActSvg>,
} as const

// Format one TASK audit row into a readable line + coloured icon. The status of a
// task.status row rides in `detail` (e.g. "In Review"); the task's name comes from
// the joined `task_title`.
function actMeta(a: any): { text: React.ReactNode; color: string; icon: React.ReactNode } {
  const who = <b>{a.actor_name || 'Someone'}</b>
  const title = a.task_title || (a.action === 'task.create' ? a.detail : '')
  const named = title ? <>“{title}”</> : 'a task'
  switch (a.action) {
    case 'task.status': {
      const st: string = a.detail || ''
      const color = (STATUS_COLORS as any)[st] || '#ea580c'
      return { color, icon: st === 'Done' ? ACT_ICONS.done : ACT_ICONS.status,
        text: <>{who} moved {named} to <b style={{ color }}>{st}</b></> }
    }
    case 'task.approval':
      return a.detail === 'reject'
        ? { color: 'var(--danger-ink)', icon: ACT_ICONS.status, text: <>{who} sent {named} back</> }
        : { color: '#10b981', icon: ACT_ICONS.done, text: <>{who} approved {named}</> }
    case 'task.comment':
      return { color: '#8b5cf6', icon: ACT_ICONS.comment, text: <>{who} commented on {named}</> }
    case 'task.split':
      return { color: '#0ea5a3', icon: ACT_ICONS.split, text: <>{who} split out {named}</> }
    case 'task.create':
    default:
      return { color: '#ea580c', icon: ACT_ICONS.create, text: <>{who} created {named}</> }
  }
}

// Recent activity feed — task events only (created / status changes / approvals /
// comments), backed by the org audit log returned with the manager dashboard.
function RecentActivity({ items }: { items: any[] }) {
  // Own state rather than the page's: nothing outside this card cares whether it
  // is expanded, and the toggle lives with the list it controls.
  const [showAll, setShowAll] = useState(false)
  const rows = items || []
  return (
    <div className="pbi-card">
      <div className="pbi-head"><h3>Recent activity</h3></div>
      <div className="act-list">
        {rows.length === 0 && <div className="muted" style={{ padding: '10px 4px', fontSize: 13 }}>No task activity yet.</div>}
        {(showAll ? rows : rows.slice(0, 5)).map((a: any) => {
          const m = actMeta(a)
          return (
            <div key={a.id} className="act-row">
              <span className="act-ic" style={{ ['--ac' as any]: m.color }}>{m.icon}</span>
              <div className="act-body"><div className="act-text">{m.text}</div></div>
              <span className="act-time">{timeAgo(a.created_at)}</span>
            </div>
          )
        })}
        {rows.length > 5 && (
          <button className="view-more-btn" onClick={() => setShowAll((s) => !s)}>
            {showAll ? 'View less' : `View all ${rows.length} events`}
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: showAll ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}><path d="m6 9 6 6 6-6" /></svg>
          </button>
        )}
      </div>
    </div>
  )
}

// Work employees have submitted and that is waiting on THIS manager. Nothing
// else on the dashboard surfaced it, so submissions sat unapproved. Decide right
// here — approve, or send back for changes — without opening each task.
function ReviewQueue({ items, onOpen, onDecided }: { items: any[]; onOpen: (id: string) => void; onDecided: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const decide = async (e: React.MouseEvent, id: string, decision: 'approved' | 'rejected') => {
    e.stopPropagation() // the row itself opens the task
    setBusyId(id)
    try {
      await api.post(`/tasks/${id}/approve`, { decision })
      toast.success(decision === 'approved' ? 'Task approved' : 'Sent back for changes')
      onDecided()
    } catch (err: any) {
      toast.error(err?.message || 'Could not update the task')
    } finally {
      setBusyId(null)
    }
  }
  return (
    <div className="pbi-card pbi-review">
      <div className="pbi-head">
        <h3>Awaiting your approval</h3>
        {items.length > 0 && <span className="badge" style={{ marginLeft: 'auto', background: 'var(--warning-bg)', color: 'var(--warning-ink)' }}>{items.length}</span>}
      </div>
      <div className="pbi-scroll" style={{ padding: 0 }}>
        {items.length === 0 ? (
          <div className="muted" style={{ padding: '14px 16px', fontSize: 13 }}>Nothing waiting on you.</div>
        ) : items.map((t: any) => (
          <div
            key={t.id}
            className="rev-row clickable"
            role="button"
            tabIndex={0}
            aria-label={`Open ${t.title}`}
            onClick={() => onOpen(t.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(t.id) } }}
          >
            <div className="rev-main">
              <div className="rev-title">{t.title}</div>
              <div className="rev-meta muted">
                {t.assignee_name || 'Unassigned'}
                {t.submitted_at && <> · submitted {timeAgo(t.submitted_at)}</>}
              </div>
            </div>
            <div className="rev-actions">
              <button
                className="btn btn-sm btn-done"
                disabled={busyId === t.id}
                onClick={(e) => decide(e, t.id, 'approved')}
                title="Approve and mark as done"
              >
                {busyId === t.id ? <span className="spinner" /> : '✓ Approve'}
              </button>
              <button
                className="btn btn-sm"
                disabled={busyId === t.id}
                onClick={(e) => decide(e, t.id, 'rejected')}
                title="Send back to the assignee for changes"
              >
                Changes
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function useDrawer() {
  const [openId, setOpenId] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const node = openId ? <TaskDrawer taskId={openId} onClose={() => setOpenId(null)} onChange={() => setTick((t) => t + 1)} /> : null
  return { openId, setOpenId, tick, node }
}

function EmployeeDash() {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState(false)
  const d = useDrawer()
  const navigate = useNavigate()
  // Refetches (e.g. after a drawer edit) keep the current data on screen and swap
  // it in place — nulling it would flash the whole page back to skeletons.
  const load = () => { setError(false); api.get('/dashboards/employee').then(setData).catch(() => setError(true)) }
  useEffect(load, [d.tick])
  if (error) return (
    <div className="card section">
      <EmptyState icon={<Ic name="warning" size={40} />} title="Couldn't load your dashboard" hint="Check your connection and try again."
        action={<button className="btn btn-primary btn-sm" onClick={load}>Retry</button>} />
    </div>
  )
  if (!data) return (
    <>
      <div className="skel-kpis emp section">{Array.from({ length: 5 }).map((_, i) => <span key={i} className="skeleton skel-kpi" />)}</div>
      <div className="grid grid-2">
        <div className="card section"><div className="card-pad">{Array.from({ length: 4 }).map((_, i) => <span key={i} className="skeleton skel-row" />)}</div></div>
        <div className="card section"><div className="card-pad">{Array.from({ length: 4 }).map((_, i) => <span key={i} className="skeleton skel-row" />)}</div></div>
      </div>
    </>
  )
  const c = data.counts
  const maxStatus = Math.max(...data.by_status.map((x: any) => x.count), 1)
  return (
    <>
      <AiSuggestBanner overdue={c.overdue} onGo={() => navigate('/tasks?view=overdue')} />
      <div className="emp-kpis section">
        <Kpi value={c.assigned} label="Assigned" icon={KPI_ICONS.assigned} color="#ea580c" onClick={() => navigate('/tasks')} />
        <Kpi value={c.pending} label="Pending" icon={KPI_ICONS.pending} color="#3b82f6" onClick={() => navigate('/tasks?view=active')} />
        <Kpi value={c.completed} label="Completed" icon={KPI_ICONS.completed} color="#10b981" onClick={() => navigate('/tasks?view=completed')} />
        <Kpi value={c.overdue} label="Overdue" icon={KPI_ICONS.overdue} color="#ef4444" alert={c.overdue > 0} onClick={() => navigate('/tasks?view=overdue')} />
        <Kpi value={c.blocked} label="Blocked" icon={KPI_ICONS.blocked} color="#f59e0b" onClick={() => navigate('/tasks?status=Blocked')} />
      </div>
      <div className="grid grid-2">
        <div className="card section">
          <div className="card-head"><h3>Upcoming deadlines</h3></div>
          <div className="emp-list">
            {data.upcoming.length === 0 && <div className="empty">No upcoming deadlines</div>}
            {data.upcoming.map((t: Task) => (
              <div key={t.id} className="emp-list-row clickable" onClick={() => d.setOpenId(t.id)} role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d.setOpenId(t.id) } }}>
                <div style={{ minWidth: 0 }}>
                  <div className="emp-list-title">{t.title}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{dueLabel(t)}</div>
                  <TaskHandoverLine task={t} />
                </div>
                <PriorityBadge p={t.priority} />
              </div>
            ))}
          </div>
        </div>
        <div className="card section">
          <div className="card-head"><h3>My work by status</h3></div>
          <div className="card-pad">
            {data.by_status.map((s: any) => (
              <div key={s.status} style={{ marginBottom: 13 }}>
                <div className="spread" style={{ marginBottom: 5 }}>
                  <span className="row" style={{ gap: 8, fontSize: 13 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 3, background: STATUS_COLORS[s.status] || '#94a3b8' }} />
                    {s.status}
                  </span>
                  <strong>{s.count}</strong>
                </div>
                <Bar value={s.count} max={maxStatus} color={STATUS_COLORS[s.status] || '#ea580c'} />
              </div>
            ))}
            {data.needs_confirmation > 0 && <div className="emp-confirm-note row" style={{ gap: 7 }}><Ic name="warning" size={14} /> {data.needs_confirmation} task(s) need ownership confirmation.</div>}
          </div>
        </div>
      </div>

      {/* Work handed to someone else. Deliberately below the fold and outside the
          KPIs above: it is not this person's workload, so it must not inflate
          their Overdue count — but until now it was invisible everywhere. */}
      {data.assigned_by_me?.length > 0 && (
        <div className="card section">
          <div className="card-head">
            <h3>Assigned by me</h3>
            <button className="btn btn-ghost btn-sm" onClick={() => navigate('/tasks?assigned_by_me=1')}>View all</button>
          </div>
          <div className="emp-list">
            {data.assigned_by_me.slice(0, 8).map((t: Task) => (
              <div key={t.id} className="emp-list-row clickable" onClick={() => d.setOpenId(t.id)} role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d.setOpenId(t.id) } }}>
                <div style={{ minWidth: 0 }}>
                  <div className="emp-list-title">{t.title}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {t.assignee_name || 'Unassigned'} · {dueLabel(t)}
                  </div>
                  <span className="task-handover"><TaskOriginBadge task={t} /><StatusPill status={t.status} /></span>
                </div>
                <PriorityBadge p={t.priority} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tasks of mine that I split up. They're containers, so they're kept out of
          the counts above — but the owner still has to be able to see them and
          who holds which part. */}
      {data.shared_by_me?.length > 0 && (
        <div className="card section">
          <div className="card-head"><h3>Split by me</h3></div>
          <div className="emp-list">
            {data.shared_by_me.map((t: any) => (
              <div key={t.id} className="split-parent">
                <div className="emp-list-row clickable" onClick={() => d.setOpenId(t.id)} role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d.setOpenId(t.id) } }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="emp-list-title">{t.title}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {t.parts.filter((p: any) => p.status === 'Done').length} of {t.parts.length} parts done · {dueLabel(t)}
                    </div>
                  </div>
                  <PriorityBadge p={t.priority} />
                </div>
                <div className="split-parts">
                  {t.parts.map((p: any) => (
                    <div key={p.id} className="split-part clickable" onClick={() => d.setOpenId(p.id)} role="button" tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d.setOpenId(p.id) } }}>
                      <span className="split-part-title">{p.title}</span>
                      <span className="muted">{p.assignee_name || 'Unassigned'}</span>
                      <StatusPill status={p.status} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {d.node}
    </>
  )
}

// Small status chip, so a delegated task's state reads without opening it.
function StatusPill({ status }: { status: string }) {
  return <span className="status-pill" style={{ ['--sc' as any]: STATUS_COLORS[status] || '#94a3b8' }}>{status}</span>
}

// Clean line-style KPI icons (inherit currentColor → tinted to each card's accent).
const KpiSvg = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
)
const KPI_ICONS = {
  total: <KpiSvg><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="M9 12h6M9 16h6" /></KpiSvg>,
  assigned: <KpiSvg><path d="M12 17v5" /><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" /></KpiSvg>,
  pending: <KpiSvg><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></KpiSvg>,
  completed: <KpiSvg><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="m9 11 3 3L22 4" /></KpiSvg>,
  overdue: <KpiSvg><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2" /><path d="M5 3 2 6" /><path d="m22 6-3-3" /></KpiSvg>,
  blocked: <KpiSvg><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></KpiSvg>,
} as const

function Kpi({ value, label, icon, color, alert, onClick }: { value: React.ReactNode; label: string; icon: React.ReactNode; color: string; alert?: boolean; onClick?: () => void }) {
  const clickable = !!onClick
  return (
    <div
      className={'kpi' + (alert ? ' alert' : '') + (clickable ? ' clickable' : '')}
      style={{ ['--kc' as any]: color }}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick!() } } : undefined}
    >
      <span className="kpi-icon">{icon}</span>
      <div>
        <div className="kpi-val">{value}</div>
        <div className="kpi-label">{label}</div>
      </div>
      {clickable && <span className="kpi-go" aria-hidden="true">›</span>}
    </div>
  )
}

type RangeKey = 'today' | 'weekly' | 'monthly' | 'all'
// The earliest date we query from for the "All tasks" view — effectively "since the beginning".
const EPOCH_YMD = '2000-01-01'
const RANGE_TABS: { key: RangeKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'weekly', label: 'Week' },
  { key: 'monthly', label: 'Month' },
  { key: 'all', label: 'All tasks' },
]

function ManagerDash({ admin, name }: { admin?: boolean; name: string }) {
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState(false)
  // True while a refetch is in flight with old data still on screen (tab switch,
  // drawer edit). The old view stays visible, slightly dimmed, instead of being
  // torn down to skeletons on every refresh.
  const [refreshing, setRefreshing] = useState(false)
  // Default view is "All tasks" (everything up to today) so the manager lands on
  // the full picture; the Today/Week/Month tabs narrow it down from there.
  const [active, setActive] = useState<RangeKey>('all')
  // "All tasks" is bounded only by an upper "till" date (defaults to today).
  const [to, setTo] = useState(todayYmd())
  const [datePopOpen, setDatePopOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [showAllWorkload, setShowAllWorkload] = useState(false)
  const [showAllOverdue, setShowAllOverdue] = useState(false)
  const datePopRef = React.useRef<HTMLDivElement>(null)
  const d = useDrawer()
  const navigate = useNavigate()
  const { user } = useAuth()
  const unreviewed = useUnreviewedMeetings(user?.id)

  // Close the "till date" popup when clicking anywhere outside it.
  useEffect(() => {
    if (!datePopOpen) return
    const onDown = (e: MouseEvent) => {
      if (datePopRef.current && !datePopRef.current.contains(e.target as Node)) setDatePopOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [datePopOpen])

  // Resolve the selected tab into a concrete date window.
  const range: ReportRange =
    active === 'all' ? { from: EPOCH_YMD, to, label: 'All tasks' }
    : active === 'today' ? presetRange('daily')
    : active === 'weekly' ? presetRange('weekly')
    : presetRange('monthly')

  const loadDash = () => {
    setError(false); setRefreshing(true)
    api.get(`/dashboards/manager?from=${range.from}&to=${range.to}`)
      .then(setData).catch(() => setError(true)).finally(() => setRefreshing(false))
  }
  useEffect(loadDash, [active, range.from, range.to, d.tick])

  // Download a printable report for whichever period is currently selected.
  const download = async () => {
    setDownloading(true)
    try { await downloadManagerReport(range) }
    catch (e: any) { toast.error('Could not generate report: ' + e.message) }
    finally { setDownloading(false) }
  }

  const toolbar = (
    <div className="pbi-filter">
      <Greeting name={name} style={{ marginRight: 'auto' }} />
      <div className="pbi-seg-wrap" ref={datePopRef}>
        <div className="pbi-seg">
          {RANGE_TABS.map((t) => (
            <button
              key={t.key}
              className={'pbi-tab' + (active === t.key ? ' active' : '')}
              onClick={() => { setActive(t.key); setDatePopOpen(t.key === 'all') }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {active === 'all' && datePopOpen && (
          <div className="pbi-datepop">
            <div className="dp-title">Show all tasks till</div>
            <label>Till date<input type="date" value={to} max={todayYmd()} onChange={(e) => { setTo(e.target.value); setDatePopOpen(false) }} /></label>
          </div>
        )}
      </div>
      <button className="btn btn-primary btn-sm pbi-download" disabled={downloading} onClick={download}>
        {downloading ? <span className="spinner" /> : <Ic name="download" size={14} />} Download report
      </button>
    </div>
  )

  if (error) return (
    <div className="pbi">{toolbar}
      <div className="card"><EmptyState icon={<Ic name="warning" size={40} />} title="Couldn't load the dashboard" hint="Check your connection and try again."
        action={<button className="btn btn-primary btn-sm" onClick={loadDash}>Retry</button>} /></div>
    </div>
  )
  if (!data) return (
    <div className="pbi">{toolbar}
      <div className="skel-kpis">{Array.from({ length: 4 }).map((_, i) => <span key={i} className="skeleton skel-kpi" />)}</div>
      <div className="pbi-body">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="pbi-card"><div className="card-pad">{Array.from({ length: 4 }).map((_, j) => <span key={j} className="skeleton skel-row" />)}</div></div>)}
      </div>
    </div>
  )
  const c = data.counts
  // First-run: a brand-new workspace has no tasks yet. Show one clear next action
  // instead of four zeros and empty charts — the first 60s should invite the core
  // workflow (upload a meeting), not congratulate the user on an empty dashboard.
  if (c.total === 0) return (
    <div className="pbi" style={{ height: 'auto' }}>
      {toolbar}
      <div className="card section">
        <div className="empty-state" style={{ padding: '56px 24px' }}>
          <div className="empty-state-icon" style={{ color: 'var(--primary)' }}>
            <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="2" width="6" height="11" rx="3" /><path d="M5 10v1a7 7 0 0 0 14 0v-1" /><line x1="12" y1="18" x2="12" y2="22" /><line x1="8" y1="22" x2="16" y2="22" />
            </svg>
          </div>
          <div className="empty-state-title">Turn your first meeting into tracked work</div>
          <div className="empty-state-hint">Upload a recording or paste a transcript — VoTask extracts the decisions, owners, and deadlines, and you approve them into tasks. Your dashboard fills in from there.</div>
          <div className="empty-state-action">
            <button className="btn btn-primary" onClick={() => navigate('/meetings')}>Upload your first meeting</button>
          </div>
        </div>
      </div>
    </div>
  )
  const maxWl = Math.max(...data.workload.map((w: any) => w.open_count), 1)
  // Open (not Done) tasks per priority — the server already returns the four
  // levels in Critical→Low order, so the ring and legend share one array.
  const donutData = data.by_priority.map((p: any) => ({ label: p.priority, value: p.count, color: PRIORITY_COLORS[p.priority] }))
  // Bars scale against the biggest status, not the total — Done usually dwarfs
  // everything, and against the total the live statuses would be invisible slivers.
  const maxStatus = Math.max(...data.by_status.map((x: any) => x.count), 1)
  // Clicking a slice or a legend row drills into that priority's open tasks.
  const openPriority = (label: string) => navigate(`/tasks?priority=${encodeURIComponent(label)}&view=active`)
  return (
    <div className="pbi" style={refreshing ? { opacity: 0.6, transition: 'opacity .15s' } : { transition: 'opacity .15s' }}>
      {toolbar}
      <UnreviewedBanner meetings={unreviewed.meetings} drafts={unreviewed.drafts} onGo={(id) => navigate('/meetings/' + id)} />
      <AiSuggestBanner overdue={c.overdue} onGo={() => navigate('/tasks?view=overdue')} />
      <div className="pbi-kpis">
        <Kpi value={c.total} label="Total tasks" icon={KPI_ICONS.total} color="#ea580c" onClick={() => navigate('/tasks')} />
        <Kpi value={c.completed} label="Completed" icon={KPI_ICONS.completed} color="#10b981" onClick={() => navigate('/tasks?view=completed')} />
        <Kpi value={c.overdue} label="Overdue" icon={KPI_ICONS.overdue} color="#ef4444" alert={c.overdue > 0} onClick={() => navigate('/tasks?view=overdue')} />
        {/* Pending = everything not Done, the same meaning as the employee
            dashboard's tile of that name. The manager payload calls the count
            `open`, the employee one calls it `pending`. Blocked sat here before:
            one status out of six, usually 0 or 1, so it spent most of its life as
            a dead tile in the most valuable row on the page. Blocked work is still
            a click away through the status filter. */}
        <Kpi value={c.open} label="Pending" icon={KPI_ICONS.pending} color="#3b82f6" onClick={() => navigate('/tasks?view=active')} />
      </div>

      <div className="pbi-body">
        {/* First card: it's the one thing here that's waiting on the manager. */}
        <ReviewQueue items={data.in_review || []} onOpen={d.setOpenId} onDecided={loadDash} />

        <div className="pbi-card pbi-workload">
          <div className="pbi-head"><h3>Team workload</h3><span className="muted" style={{ marginLeft: 'auto', fontSize: 11.5 }}>open tasks per person</span></div>
          <div className="pbi-scroll">
            {/* Show the 5 busiest by default (API sorts by open_count desc); the rest
                expand via "View more". */}
            {(showAllWorkload ? data.workload : data.workload.slice(0, 5)).map((w: any) => {
              const overloaded = w.open_count > (maxWl * 0.66) && w.open_count >= 3
              const pct = Math.round((w.open_count / maxWl) * 100)
              return (
                <div
                  key={w.id}
                  className="hbar-row clickable"
                  title={`Open ${w.name}'s tasks · ${w.open_count} open · ${w.done_count} done${w.overdue_count ? ` · ${w.overdue_count} overdue` : ''}`}
                  onClick={() => navigate(`/tasks?assignee=${w.id}`)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/tasks?assignee=${w.id}`) } }}
                >
                  {/* No role badge here: the label column is only 124px, so an
                      "Admin"/"Manager" pill ate most of it and left names
                      truncated to a letter or two. The name is what identifies
                      the row, so it gets the width. */}
                  <span className="hbar-label">
                    <Avatar name={w.name} color={w.avatar_color} size={22} />
                    <span className="hbar-name">{w.name}</span>
                    {overloaded && <span style={{ color: 'var(--danger)', display: 'inline-flex' }} title="Overloaded"><Ic name="warning" size={12} /></span>}
                  </span>
                  <span className="hbar-track">
                    <span className="hbar-fill" style={{ width: `${pct}%`, background: overloaded ? '#ef4444' : '#ea580c' }} />
                  </span>
                  <span className="hbar-val">{w.open_count}</span>
                </div>
              )
            })}
            {data.workload.length > 5 && (
              <button className="view-more-btn" onClick={() => setShowAllWorkload((s) => !s)}>
                {showAllWorkload ? 'View less' : `View all ${data.workload.length} people`}
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: showAllWorkload ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}><path d="m6 9 6 6 6-6" /></svg>
              </button>
            )}
          </div>
        </div>

        <div className="pbi-card">
          <div className="pbi-head"><h3>Open by priority</h3></div>
          <div className="pbi-scroll pbi-donut-wrap">
            <Donut data={donutData} size={140} onSegmentClick={openPriority} />
            <div className="pbi-legend">
              {donutData.map((p: any) => {
                const clickable = p.value > 0
                return (
                  <div
                    key={p.label}
                    className={'lg' + (clickable ? ' clickable' : '')}
                    onClick={clickable ? () => openPriority(p.label) : undefined}
                    role={clickable ? 'button' : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPriority(p.label) } } : undefined}
                    title={clickable ? `Open ${p.label} tasks (${p.value})` : undefined}
                  >
                    <span className="dot" style={{ background: p.color }} />
                    <span>{p.label}</span>
                    <b>{p.value}</b>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* The employee dashboard has this as "My work by status"; here the same
            breakdown is the whole org's, so it is named for what it shows. The
            server already returned by_status for this endpoint — it was simply
            never rendered. Rows drill into that status, matching the priority
            donut beside it. */}
        <div className="pbi-card">
          <div className="pbi-head"><h3>Tasks by status</h3></div>
          <div className="pbi-scroll">
            {data.by_status.map((s: any) => {
              const clickable = s.count > 0
              const open = () => navigate(`/tasks?status=${encodeURIComponent(s.status)}`)
              return (
                <div key={s.status} className={'st-row' + (clickable ? ' clickable' : '')}
                  onClick={clickable ? open : undefined}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } } : undefined}
                  title={clickable ? `Open ${s.status} tasks (${s.count})` : undefined}
                >
                  <div className="spread" style={{ marginBottom: 5 }}>
                    <span className="row" style={{ gap: 8, fontSize: 13 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: STATUS_COLORS[s.status] || '#94a3b8' }} />
                      {s.status}
                    </span>
                    <strong>{s.count}</strong>
                  </div>
                  <Bar value={s.count} max={maxStatus} color={STATUS_COLORS[s.status] || '#ea580c'} />
                </div>
              )
            })}
          </div>
        </div>

        <div className="pbi-card pbi-overdue">
          <div className="pbi-head"><h3>Overdue tasks</h3>{data.overdue.length > 0 && <span className="badge" style={{ marginLeft: 'auto', background: 'var(--danger-bg)', color: 'var(--danger-ink)' }}>{c.overdue}</span>}</div>
          <div className="pbi-scroll" style={{ padding: 0 }}>
            <table>
              <tbody>
                {data.overdue.length === 0 && <tr><td className="muted">Nothing overdue</td></tr>}
                {/* Top 5 by default — the card sits beside three others and a long
                    list pushed everything below it off the page. */}
                {(showAllOverdue ? data.overdue : data.overdue.slice(0, 5)).map((t: any) => (
                  <tr key={t.id} className="clickable" onClick={() => d.setOpenId(t.id)}
                    role="button" tabIndex={0} aria-label={`Open ${t.title}`}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d.setOpenId(t.id) } }}>
                    <td><div className="clamp-2">{t.title}</div><TaskHandoverLine task={t} /></td>
                    <td className="muted">{t.assignee_name || 'Unassigned'}</td>
                    <td>{dueLabel(t)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.overdue.length > 5 && (
              <button className="view-more-btn" onClick={() => setShowAllOverdue((s) => !s)}>
                {showAllOverdue ? 'View less' : `View all ${data.overdue.length} overdue`}
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: showAllOverdue ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}><path d="m6 9 6 6 6-6" /></svg>
              </button>
            )}
            {/* The API caps this list, so once expanded the count can still fall short
                of the KPI. Say so and point at the full list rather than letting the
                card quietly imply it is showing everything. */}
            {showAllOverdue && c.overdue > data.overdue.length && (
              <button className="view-more-btn" onClick={() => navigate('/tasks?view=overdue')}>
                See all {c.overdue} in Tasks
              </button>
            )}
          </div>
        </div>

        <RecentActivity items={data.recent_activity} />
      </div>
      {d.node}
    </div>
  )
}
