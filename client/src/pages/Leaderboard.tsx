import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, userAvatarUrl } from '../api'
import { useAuth } from '../auth'
import { Avatar, Ic, EmptyState, Bar, todayKey } from '../ui'
import { toast } from '../lib/toast'

// Points leaderboard. Fixed points per action:
//   complete a task 10 · assign a task 5 · comment on a task 1
// Moving a task between statuses pays nothing — see the note in server/src/scoring.js.
// Complete 10 tasks and you have 100 points. Every period is the same tally over
// a different window: Today / one CALENDAR month (any month, via the picker) /
// all-time / Custom — an org-wide from→to window a manager sets, which becomes
// what everyone lands on while it's active. Clicking a card shows which actions
// earned the points. Everything comes from /api/scores, counted live from the task
// tables — the per-action values are the server's `rules`, never hard-coded here.

const PERIODS = [
  { k: 'day', label: 'Today', hint: 'points earned today' },
  { k: 'month', label: 'Monthly', hint: 'points earned in a calendar month' },
  { k: 'all', label: 'All-time', hint: 'every point ever earned' },
]

// The viewer's month — the UTC one is still last month until 05:30 IST on the 1st.
const currentMonth = () => todayKey().slice(0, 7)
// 'yyyy-mm' → "August 2026". Day 02 dodges any timezone slip off the month.
const monthName = (m: string) => new Date(m + '-02').toLocaleString(undefined, { month: 'long', year: 'numeric' })
// The server's yyyy-mm-dd, shown the way the rest of the app writes dates.
const prettyDay = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

// One colour per rule, reused by the card chips and the detail bars so a rule is
// recognisable at a glance. Concrete values (matches the ui.tsx convention).
const RULE_COLORS: Record<string, string> = {
  assigned: '#3b82f6',
  completed: '#10b981',
  commented: '#8b5cf6',
}
const ruleColor = (k: string) => RULE_COLORS[k] || '#64748b'

// Kept, though every current rule is a past participle ("assigned"/"completed"/
// "commented") that never pluralises: the set is what a future noun-phrase rule
// would be added to, and `plural` is already threaded through the chip rendering.
const PLURALISE = new Set<string>([])
const plural = (word: string, n: number) => (n === 1 || !PLURALISE.has(word) ? word : word + 's')

const medalColor = ['#d4af37', '#a8b3c4', '#c8823c'] // gold / silver / bronze

// Two ways to rank the same people over the same window. Points = volume of
// work (the tally above). On time = how late their deadlines were met, in days
// (server/src/punctuality.js): lowest average delay first. A fast finisher who
// is always a week late tops one and trails the other — that is the point.
const RANK_BY = [
  { k: 'points', label: 'Points', hint: 'Ranked by points earned' },
  { k: 'ontime', label: 'On time', hint: 'Ranked by average days late — fewest days late first' },
] as const
type RankBy = typeof RANK_BY[number]['k']

const daysText = (n: number) => (n === 1 ? '1 day' : `${n} days`)
// Green when deadlines are met, amber when a little late, red past 3 days.
const delayColor = (avg: number | null | undefined) =>
  avg == null ? '#94a3b8' : avg === 0 ? '#10b981' : avg <= 1 ? '#f59e0b' : avg <= 3 ? '#f97316' : '#ef4444'
const prettyDue = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

const Trophy = ({ size = 16, color = '#d4af37' }: { size?: number; color?: string }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4z" /><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 0-3 3" />
  </svg>
)

// Points-per-day bars for the detail view.
function DayBars({ history, w = 320, h = 54 }: { history: { day: string; points: number }[]; w?: number; h?: number }) {
  const max = Math.max(1, ...history.map((d) => d.points))
  const gap = 2
  // The viewBox is DERIVED from the day count rather than fixed at `w`. The series
  // is no longer always 30 days — with a longer history, dividing a fixed width
  // between more columns hit the 2px floor and the bars ran off the right edge.
  // Sizing the canvas to the data and letting preserveAspectRatio="none" stretch
  // it to the card keeps every day visible and evenly spaced at any length.
  const bw = 6
  const vw = Math.max(w, history.length * (bw + gap) - gap)
  const [hot, setHot] = useState<number | null>(null)

  // A bar can be 2px wide and a zero day is a 1px line, so the painted mark is
  // not the hit target — each column gets a full-height transparent rect covering
  // its bar AND the gap beside it. Aim anywhere in the column and it registers.
  const colW = bw + gap
  const barTop = (d: { points: number }) => h - (d.points ? Math.max(2, (d.points / max) * (h - 6)) : 1)
  // Percent, not pixels: preserveAspectRatio="none" stretches the x axis to the
  // card's width, so anything measured in viewBox units would drift as it resizes.
  const centrePct = (i: number) => ((i * colW + bw / 2) / vw) * 100

  const fmtDay = (day: string) => {
    // Bare yyyy-mm-dd parses as UTC and lands on the previous evening in western
    // zones — pin it to local midnight so the label matches the bar.
    const dt = new Date(day + 'T00:00:00')
    return isNaN(dt.getTime()) ? day : dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  }

  const active = hot === null ? null : history[hot]

  return (
    <div className="lb-spark-wrap" onPointerLeave={() => setHot(null)}>
      <svg viewBox={`0 0 ${vw} ${h}`} width="100%" height={h} preserveAspectRatio="none" className="lb-spark"
        role="img" aria-label={`Points per day over the last ${history.length} days`}>
        {history.map((d, i) => (
          <rect key={d.day} className={'lb-bar' + (hot === i ? ' is-hot' : '')}
            x={i * colW} y={barTop(d)} width={bw} height={h - barTop(d)} rx={1.5}
            fill={d.points ? 'var(--primary)' : 'var(--n-300)'} />
        ))}
        {/* Hit layer on top, so a thin bar is never the thing you have to hit. */}
        {history.map((d, i) => (
          <rect key={'hit-' + d.day} x={i * colW} y={0} width={colW} height={h} fill="transparent"
            className="lb-bar-hit"
            // Focusable only where there is something to read, or this is 30 tab
            // stops through mostly empty days.
            tabIndex={d.points ? 0 : -1}
            aria-label={`${fmtDay(d.day)}: ${d.points} ${d.points === 1 ? 'point' : 'points'}`}
            onPointerEnter={() => setHot(i)}
            onFocus={() => setHot(i)}
            onBlur={() => setHot(null)} />
        ))}
      </svg>
      {active && (
        // The value leads and the date follows: the reader already knows roughly
        // which day they are pointing at — the number is what they came for.
        <div className="lb-tip" role="status" style={{
          left: centrePct(hot!) + '%',
          bottom: h - barTop(active) + 8,
          // Keep it inside the card at both ends instead of letting it clip.
          transform: centrePct(hot!) < 15 ? 'translateX(0)'
            : centrePct(hot!) > 85 ? 'translateX(-100%)' : 'translateX(-50%)',
        }}>
          <span className="lb-tip-val">{active.points} {active.points === 1 ? 'point' : 'points'}</span>
          <span className="lb-tip-day">{fmtDay(active.day)}</span>
        </div>
      )}
    </div>
  )
}

export default function Leaderboard() {
  const { user } = useAuth()
  const isManager = user?.role === 'manager' || user?.role === 'admin'
  // 'auto' = no explicit choice yet: the server answers with the org's custom
  // window if a manager has set one, else the current calendar month — so an
  // active custom range really is what everyone lands on.
  const [sel, setSel] = useState<{ k: string; month?: string }>({ k: 'auto' })
  const [data, setData] = useState<any>(null)
  const [error, setError] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // Remembered per device: a manager who reviews punctuality wants to land on it.
  const [rankBy, setRankByState] = useState<RankBy>(() => {
    try { return localStorage.getItem('lb_rank_by') === 'ontime' ? 'ontime' : 'points' } catch { return 'points' }
  })
  const setRankBy = (k: RankBy) => { setRankByState(k); try { localStorage.setItem('lb_rank_by', k) } catch {} }

  const query = sel.k === 'auto' ? ''
    : sel.k === 'month' && sel.month ? `?period=month&month=${sel.month}`
    : `?period=${sel.k}`
  const load = () => {
    setError(false); setRefreshing(true)
    api.get(`/scores/leaderboard${query}`).then(setData).catch(() => setError(true)).finally(() => setRefreshing(false))
  }
  useEffect(load, [sel.k, sel.month])

  // Which tab lights up: the explicit pick, or whatever the server resolved 'auto' to.
  const activeTab = sel.k === 'auto' ? (data?.period === 'custom' ? 'custom' : 'month') : sel.k
  const shownMonth = sel.month || data?.month || currentMonth()

  // Draft dates for the manager's custom-range editor, seeded from the saved range.
  const [fromD, setFromD] = useState('')
  const [toD, setToD] = useState('')
  useEffect(() => {
    if (data?.custom_range) { setFromD(data.custom_range.from); setToD(data.custom_range.to) }
  }, [data?.custom_range?.from, data?.custom_range?.to])

  const saveRange = async () => {
    if (!fromD || !toD) { toast.error('Pick both dates first'); return }
    try {
      await api.put('/scores/range', { from: fromD, to: toD })
      toast.success('Leaderboard window updated for everyone')
      // Land on the Custom tab; if we're already there the effect won't refire, so reload by hand.
      if (activeTab === 'custom' && sel.k !== 'auto') load(); else setSel({ k: 'custom' })
    } catch (e: any) { toast.error(e.message || 'Could not save the range') }
  }
  const clearRange = async () => {
    try {
      await api.put('/scores/range', {})
      toast.success('Custom window cleared — back to the monthly view')
      setSel({ k: 'month' })
    } catch (e: any) { toast.error(e.message || 'Could not clear the range') }
  }

  if (!user) return null

  // Employees only see the Custom tab while a window is actually set; managers
  // always see it, otherwise there'd be no way to set one in the first place.
  const tabs = [...PERIODS, ...(data?.custom_range || isManager ? [{ k: 'custom', label: 'Custom', hint: 'a date window chosen by a manager' }] : [])]

  return (
    <>
      <div className="lb-toolbar section">
        <div className="muted" style={{ fontSize: 13 }}>
          {/* Read off the server's rules so the legend can't drift from the scoring. */}
          {rankBy === 'ontime' ? 'Who meets deadlines best — fewest days late ranks first.'
            : data?.rules?.length
            ? data.rules.map((r: any) => `${r.points} ${r.points === 1 ? 'pt' : 'pts'} ${r.short || r.label.toLowerCase()}`).join(' · ')
            : 'Points are awarded for assigning, completing and commenting on tasks.'}
        </div>
        <div className="lb-selects">
          <div className="lb-winsel" role="tablist" aria-label="Rank by">
            {RANK_BY.map((b) => (
              <button key={b.k} role="tab" aria-selected={rankBy === b.k} title={b.hint}
                className={'lb-win-btn' + (rankBy === b.k ? ' active' : '')} onClick={() => setRankBy(b.k)}>{b.label}</button>
            ))}
          </div>
          <div className="lb-winsel" role="tablist" aria-label="Time period">
            {tabs.map((p) => (
              <button key={p.k} role="tab" aria-selected={activeTab === p.k} title={p.hint}
                className={'lb-win-btn' + (activeTab === p.k ? ' active' : '')} onClick={() => setSel({ k: p.k })}>{p.label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Month picker — which calendar month the Monthly tab shows. */}
      {activeTab === 'month' && (
        <div className="lb-ctlbar section">
          <span className="muted" style={{ fontSize: 13 }}>Showing {monthName(shownMonth)}</span>
          <input type="month" className="lb-datein" value={shownMonth} max={currentMonth()}
            onChange={(e) => e.target.value && setSel({ k: 'month', month: e.target.value })} aria-label="Pick a month" />
        </div>
      )}

      {/* Custom window — everyone sees the active range; managers can change it. */}
      {activeTab === 'custom' && (
        <div className="lb-ctlbar section">
          <span className="muted" style={{ fontSize: 13 }}>
            {data?.custom_range
              ? <>Window: <b>{prettyDay(data.custom_range.from)}</b> → <b>{prettyDay(data.custom_range.to)}</b>{!isManager && ' (set by a manager)'}</>
              : 'No custom window set yet — pick the dates everyone should see.'}
          </span>
          {isManager && (
            <span className="lb-rangectl">
              <input type="date" className="lb-datein" value={fromD} max={toD || undefined} onChange={(e) => setFromD(e.target.value)} aria-label="From date" />
              <span className="muted">→</span>
              <input type="date" className="lb-datein" value={toD} min={fromD || undefined} onChange={(e) => setToD(e.target.value)} aria-label="To date" />
              <button className="btn btn-primary btn-sm" onClick={saveRange}>Apply</button>
              {data?.custom_range && <button className="btn btn-ghost btn-sm" onClick={clearRange}>Clear</button>}
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="card section"><EmptyState icon={<Ic name="warning" size={40} />} title="Couldn't load the leaderboard"
          hint="Check your connection and try again." action={<button className="btn btn-primary btn-sm" onClick={load}>Retry</button>} /></div>
      )}

      {!error && !data && (
        <div className="lb-list section">{Array.from({ length: 6 }).map((_, i) => <span key={i} className="skeleton skel-row" style={{ height: 64 }} />)}</div>
      )}

      {!error && data && rankBy === 'ontime' && (
        data.delay_ranked_count > 0 ? (
          <>
            <div className="muted lb-note section">
              Average days late per task with a deadline: on-time work counts as 0, overdue work counts the days so far.
              Fewest days late ranks first. Work approved after review counts from when it was submitted.
            </div>
            <div className="lb-list section" style={refreshing ? { opacity: 0.6, transition: 'opacity .15s' } : { transition: 'opacity .15s' }}>
              {[...data.ranked].sort((a: any, b: any) =>
                (a.delay_rank ?? Infinity) - (b.delay_rank ?? Infinity) || a.name.localeCompare(b.name))
                .map((r: any) => <DelayCard key={r.id} row={r} onOpen={() => setDetailId(r.id)} />)}
            </div>
          </>
        ) : (
          <div className="card section"><EmptyState icon={<Ic name="calendar" size={40} />} title="No deadlines in this period"
            hint="This ranking counts tasks with a due date that were delivered, or fell overdue, in the period." /></div>
        )
      )}

      {!error && data && rankBy === 'points' && data.scored_count === 0 && (
        <div className="card section"><EmptyState icon={<Trophy size={40} color="#94a3b8" />} title="No points yet"
          hint="Points appear as soon as someone assigns, completes or comments on a task — or moves one along." /></div>
      )}

      {!error && data && rankBy === 'points' && data.scored_count > 0 && (
        <div className="lb-list section" style={refreshing ? { opacity: 0.6, transition: 'opacity .15s' } : { transition: 'opacity .15s' }}>
          {data.ranked.map((r: any) => (
            <RankCard key={r.id} row={r} rules={data.rules} onOpen={() => setDetailId(r.id)} />
          ))}
        </div>
      )}

      {detailId && (
        <DetailModal userId={detailId} periodQuery={query}
          periodLabel={
            activeTab === 'day' ? 'today'
              : activeTab === 'all' ? 'all-time'
              : activeTab === 'custom' && data?.custom_range ? `${prettyDay(data.custom_range.from)} → ${prettyDay(data.custom_range.to)}`
              : monthName(shownMonth)
          }
          onClose={() => setDetailId(null)} />
      )}
    </>
  )
}

function RankCard({ row, rules, onOpen }: { row: any; rules: any[]; onOpen: () => void }) {
  const ranked = row.score > 0
  const top3 = ranked && row.rank <= 3
  // The actions behind the total, so the card shows WHY without opening the modal.
  const chips = (rules || []).map((r: any) => ({ ...r, count: row.breakdown?.[r.key]?.count || 0 })).filter((r: any) => r.count > 0)
  return (
    <button className={'lb-card' + (row.rank === 1 ? ' champ' : '') + (ranked ? '' : ' idle')} onClick={onOpen}>
      <span className="lb-rank" style={{ color: top3 ? medalColor[row.rank - 1] : undefined }}>
        {row.rank === 1 ? <Trophy size={20} /> : ranked ? `#${row.rank}` : '–'}
      </span>
      <Avatar name={row.name} color={row.avatar_color} size={40} src={row.avatar_file ? userAvatarUrl(row.id, row.avatar_file) : undefined} />
      <div className="lb-who">
        <div className="lb-name">{row.name}</div>
        <div className="lb-sub muted">
          {chips.length === 0
            ? <span style={{ textTransform: 'capitalize' }}>{row.role}</span>
            : chips.map((c: any) => (
              <span key={c.key} className="lb-chip" style={{ ['--bc' as any]: ruleColor(c.key) }}>
                {c.count} {plural(c.short || c.label.toLowerCase(), c.count)}
              </span>
            ))}
        </div>
      </div>
      <div className="lb-winscore">
        <div className="lb-winscore-num" style={{ color: ranked ? '#ea580c' : '#94a3b8' }}>{row.score}</div>
        <div className="muted lb-winscore-lbl">{row.score === 1 ? 'point' : 'points'}</div>
      </div>
    </button>
  )
}

function DelayCard({ row, onOpen }: { row: any; onOpen: () => void }) {
  const d = row.delay
  const ranked = !!row.delay_rank
  const top3 = ranked && row.delay_rank <= 3
  const plural = (n: number) => (n === 1 ? '' : 's')
  return (
    <button className={'lb-card' + (row.delay_rank === 1 ? ' champ' : '') + (ranked ? '' : ' idle')} onClick={onOpen}>
      <span className="lb-rank" style={{ color: top3 ? medalColor[row.delay_rank - 1] : undefined }}>
        {row.delay_rank === 1 ? <Trophy size={20} /> : ranked ? `#${row.delay_rank}` : '–'}
      </span>
      <Avatar name={row.name} color={row.avatar_color} size={40} src={row.avatar_file ? userAvatarUrl(row.id, row.avatar_file) : undefined} />
      <div className="lb-who">
        <div className="lb-name">{row.name}</div>
        <div className="lb-sub muted">
          {!ranked
            ? <span>No deadlines in this period</span>
            : <>
              {d.on_time > 0 && <span className="lb-chip" style={{ ['--bc' as any]: '#10b981' }}>{d.on_time} on time</span>}
              {d.late_done > 0 && <span className="lb-chip" style={{ ['--bc' as any]: '#f97316' }}>{d.late_done} late</span>}
              {d.overdue_open > 0 && <span className="lb-chip" style={{ ['--bc' as any]: '#ef4444' }}>{d.overdue_open} overdue</span>}
            </>}
        </div>
      </div>
      <div className="lb-winscore" title={ranked ? `${d.late_days} days late in total over ${d.tasks} task${plural(d.tasks)} · ${d.on_time_rate}% on time` : undefined}>
        <div className="lb-winscore-num" style={{ color: delayColor(ranked ? d.avg_delay : null) }}>
          {!ranked ? '—' : d.avg_delay === 0 ? 'On time' : `${d.avg_delay}d`}
        </div>
        <div className="muted lb-winscore-lbl">{!ranked ? '' : d.avg_delay === 0 ? `${d.tasks} task${plural(d.tasks)}` : 'avg late'}</div>
      </div>
    </button>
  )
}

// Delivery block in a person's detail: their punctuality over the same window,
// and — for themselves and managers — the tasks behind the number, worst first.
function DelaySection({ delay, periodLabel }: { delay: any; periodLabel: string }) {
  if (!delay) return null
  return (
    <>
      <div className="lb-section-lbl">On-time delivery — {periodLabel}</div>
      {!delay.tasks ? (
        <div className="muted" style={{ fontSize: 12.5 }}>No tasks with a deadline were delivered or fell overdue in this period.</div>
      ) : (
        <>
          <div className="lb-modal-stats lb-delay-stats">
            <div className="lb-stat">
              <div className="lb-stat-num" style={{ color: delayColor(delay.avg_delay) }}>{delay.avg_delay}</div>
              <div className="muted lb-stat-lbl">avg days late</div>
            </div>
            <div className="lb-stat"><div className="lb-stat-num">{delay.on_time_rate}%</div><div className="muted lb-stat-lbl">on time ({delay.on_time}/{delay.tasks})</div></div>
            <div className="lb-stat"><div className="lb-stat-num" style={{ color: delay.late_done ? '#f97316' : undefined }}>{delay.late_done}</div><div className="muted lb-stat-lbl">delivered late</div></div>
            <div className="lb-stat"><div className="lb-stat-num" style={{ color: delay.overdue_open ? '#ef4444' : undefined }}>{delay.overdue_open}</div><div className="muted lb-stat-lbl">overdue now</div></div>
          </div>
          {delay.worst > 0 && <div className="muted" style={{ fontSize: 12 }}>Longest delay {daysText(delay.worst)} · {delay.late_days} days late in total</div>}
          {Array.isArray(delay.items) && delay.items.length > 0 && (
            <ul className="lb-late-list">
              {delay.items.map((t: any) => (
                <li key={t.id}>
                  <Link className="lb-late-title" to={`/tasks?task=${encodeURIComponent(t.id)}`}>{t.title}</Link>
                  <span className="lb-late-meta muted">
                    due {prettyDue(t.due_date)}{t.open ? ' · still open' : ` · delivered ${prettyDue(t.delivered_on)}`}
                  </span>
                  <span className={'lb-late-days' + (t.open ? ' open' : '')}>{t.open ? `${daysText(t.days_late)} overdue` : `${daysText(t.days_late)} late`}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  )
}

function DetailModal({ userId, periodQuery, periodLabel, onClose }: { userId: string; periodQuery: string; periodLabel: string; onClose: () => void }) {
  const [d, setD] = useState<any>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    setD(null); setError(false)
    // Same period params as the board itself, so the numbers can't disagree.
    api.get(`/scores/${userId}${periodQuery}`).then(setD).catch(() => setError(true))
  }, [userId, periodQuery])

  // One row per rule: how many times they did it, and the points that earned.
  const rows = (d?.rules || []).map((r: any) => ({
    key: r.key, label: r.label, hint: r.hint,
    per: d?.breakdown?.[r.key]?.per ?? r.points ?? 1,
    count: d?.breakdown?.[r.key]?.count || 0,
    points: d?.breakdown?.[r.key]?.points || 0,
  }))
  const maxPoints = Math.max(1, ...rows.map((r: any) => r.points))

  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal lb-modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread">
          <h3>Performance</h3>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="card-pad">
        {error && <EmptyState icon={<Ic name="warning" size={36} />} title="Couldn't load this person" />}
        {!error && !d && <div style={{ display: 'grid', placeItems: 'center', height: 200 }}><span className="spinner" /></div>}
        {!error && d && (
          <>
            <div className="lb-modal-head">
              <Avatar name={d.user.name} color={d.user.avatar_color} size={48} src={d.user.avatar_file ? userAvatarUrl(d.user.id, d.user.avatar_file) : undefined} />
              <div style={{ minWidth: 0 }}>
                <div className="lb-modal-name">{d.user.name}</div>
                <div className="muted" style={{ fontSize: 12.5, textTransform: 'capitalize' }}>{d.user.role}</div>
              </div>
              <div className="lb-modal-rating">
                <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1, color: '#ea580c' }}>{d.points}</div>
                <div className="muted" style={{ fontSize: 11 }}>{periodLabel}</div>
              </div>
            </div>

            <div className="lb-modal-stats">
              <div className="lb-stat"><div className="lb-stat-num">{d.points}</div><div className="muted lb-stat-lbl">{periodLabel}</div></div>
              <div className="lb-stat"><div className="lb-stat-num">{d.all_time_points}</div><div className="muted lb-stat-lbl">all-time</div></div>
              <div className="lb-stat"><div className="lb-stat-num">{d.breakdown?.completed?.count ?? 0}</div><div className="muted lb-stat-lbl">tasks completed</div></div>
            </div>

            <DelaySection delay={d.delay} periodLabel={periodLabel} />

            {/* The window is no longer fixed, so the label reports what was
                actually returned rather than asserting 30 days. */}
            <div className="lb-section-lbl">Points per day{d.history?.length ? ` (last ${d.history.length} days)` : ''}</div>
            {d.history?.some((h: any) => h.points > 0)
              ? <div className="lb-trajectory"><DayBars history={d.history} /></div>
              : <div className="muted" style={{ fontSize: 12.5 }}>No points earned yet.</div>}

            <div className="lb-section-lbl">Where the points came from — {periodLabel}</div>
            <div className="lb-comps">
              {rows.map((s: any) => (
                <div key={s.key} className="lb-comp">
                  <div className="lb-comp-top">
                    <span className="lb-comp-key" title={s.hint}>{s.label}</span>
                    <span className="lb-comp-val">{s.count} × {s.per} = <b>{s.points}</b></span>
                  </div>
                  <Bar value={s.points} max={maxPoints} color={ruleColor(s.key)} />
                </div>
              ))}
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  )
}
