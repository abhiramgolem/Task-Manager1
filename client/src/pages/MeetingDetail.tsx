import React, { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api, Suggestion } from '../api'
import { PriorityBadge, StatusBadge, ConfidenceScore, Evidence, confidenceBand, Avatar, Ic, dueLabel, LANG_LABEL, defaultDueDate, AutoTextarea } from '../ui'
import TaskDrawer from '../components/TaskDrawer'
import { useAuth } from '../auth'
import { confirmDialog } from '../lib/confirm'
import { useDialog } from '../lib/useDialog'
import { ReviewEdit, loadReviewDraft, saveReviewDraft, clearReviewDraft, draftAge } from '../lib/reviewDraft'
import { hideForMeeting } from '../lib/callAnalysis'

// A textarea that grows to fit its content — so a long task wraps and is fully
// readable instead of scrolling word-by-word inside a one-line input.
// Exported, with the summary and review pieces below, because the chat info
// panel shows the same summary and runs the same review in place: a group's
// meetings are reviewed from inside the group, and employees cannot open this
// page at all (its route is manager-only).
export const SUMMARY_SECTIONS: { key: string; label: string; icon: React.ReactNode }[] = [
  { key: 'key_decisions', label: 'Key Decisions', icon: <Ic name="check" /> },
  { key: 'action_items', label: 'Action Items', icon: <Ic name="arrowRight" /> },
  { key: 'risks', label: 'Risks', icon: <Ic name="warning" /> },
  { key: 'blockers', label: 'Blockers', icon: <Ic name="block" /> },
  { key: 'follow_ups', label: 'Follow-ups', icon: <Ic name="refresh" /> },
]

// A summary point is either a bare string (meetings summarised before evidence
// linking existed) or { text, evidence }. Normalising here means the UI never
// has to care which, and old meetings keep rendering.
export interface Cite { quote: string; speaker?: string; seq?: number; language?: string; match?: number }
export interface Point { text: string; evidence?: Cite | null }

export function normalisePoints(raw: any): Point[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((it) => (typeof it === 'string' ? { text: it, evidence: null } : { text: String(it?.text ?? ''), evidence: it?.evidence ?? null }))
    .filter((p) => p.text.trim())
}

// One line of the summary, with the sentence behind it folded away.
//
// Hidden by default on purpose: the summary is what you read, and a quote under
// every line turns five bullets into a wall of transcript. But "where did that
// come from?" is the first question anyone asks of an AI summary, so the answer
// is always one click away rather than a trip to the transcript tab.
export function SummaryPoint({ point }: { point: Point }) {
  const [open, setOpen] = useState(false)
  const ev = point.evidence
  return (
    <div className={'sum-point' + (open ? ' open' : '')}>
      <div className="sum-point-row">
        <span className="sum-bullet" aria-hidden="true" />
        <span className="sum-text">{point.text}</span>
        {ev ? (
          <button className="sum-why" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'Hide' : 'Why?'}
          </button>
        ) : (
          <span className="sum-why muted" title="No single sentence in the transcript accounts for this line">—</span>
        )}
      </div>
      {open && ev && (
        <blockquote className="sum-evidence">
          <span className="evidence-quote-mark" aria-hidden="true">“</span>{ev.quote}”
          <span className="sum-evidence-src">
            {ev.speaker ? `${ev.speaker}` : 'From the transcript'}
            {ev.language ? ` · ${ev.language}` : ''}
            {typeof ev.match === 'number' ? ` · ${ev.match}% match` : ''}
          </span>
        </blockquote>
      )}
    </div>
  )
}

// What this meeting actually was, in the words a person would use. A call and
// an uploaded recording are not the same thing to review, and calling both of
// them "Meeting" loses the one bit of context the reviewer already has in their
// head — they were ON the call ten seconds ago.
export function sourceLabel(m: any): string {
  if (m?.call_kind === 'video') return 'Video Call'
  if (m?.call_kind === 'audio') return 'Audio Call'
  if (m?.source_type === 'call') return 'Call'
  if (m?.source_type === 'audio') return 'Recording'
  return 'Meeting'
}

// Whoever asked for the work, unless it is the owner's own "I'll do it": then
// nobody else asked, and the server keeps the reviewer as the assigner (see
// createTaskFromSuggestion).
function askedBy(sg: Pick<Suggestion, 'suggested_assigner_id' | 'suggested_assigner_name' | 'suggested_assigner_raw' | 'suggested_assignee_id'>) {
  if (sg.suggested_assigner_id && sg.suggested_assigner_id === sg.suggested_assignee_id) return null
  return sg.suggested_assigner_name || sg.suggested_assigner_raw || null
}

// Who asked for the work. Resolved to a real teammate where the name in the
// transcript matched one; otherwise the spoken name, which is still better than
// silently crediting whoever pressed the button. Exported for the chat info
// panel's meeting summary, which lists the same tasks.
export function Assigner({ sg }: { sg: Suggestion }) {
  const name = askedBy(sg)
  if (!name) return null
  return (
    <span className="row asgn" style={{ gap: 5 }} title={sg.suggested_assigner_name
      ? `${sg.suggested_assigner_name} asked for this in the meeting`
      : `Heard "${sg.suggested_assigner_raw}" — not matched to an account`}>
      <Avatar name={name} color={sg.suggested_assigner_color || undefined} size={16} />
      <span>Asked by {name}</span>
      {!sg.suggested_assigner_name && <span className="asgn-unmatched">unmatched</span>}
    </span>
  )
}

export default function MeetingDetail() {
  const { id } = useParams()
  const [m, setM] = useState<any>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [tab, setTab] = useState<'summary' | 'transcript'>('summary')
  const [review, setReview] = useState(false)
  const [restoringId, setRestoringId] = useState<string | null>(null)
  const [restoreErr, setRestoreErr] = useState('')
  const [loadErr, setLoadErr] = useState(false)
  const { user } = useAuth()
  const load = () => { setLoadErr(false); return api.get('/meetings/' + id).then(setM).catch(() => setLoadErr(true)) }
  useEffect(() => { load() }, [id])

  // Coming back after the app was killed mid-review. The edits are on disk, so
  // reopen the review screen straight onto them instead of dropping the manager
  // on the meeting page to work out for themselves that they were interrupted.
  // Guarded by a ref because `load()` runs again after every assignment —
  // without it, closing the screen would immediately reopen it.
  const resumedRef = React.useRef(false)
  useEffect(() => {
    if (!m || resumedRef.current) return
    if (!loadReviewDraft(user?.id || 'anon', m.id)) return
    resumedRef.current = true
    // Everything they had been editing has since been assigned or deleted by
    // someone else, so there is no review left to come back to.
    if (!(m.suggestions || []).some((x: Suggestion) => x.status === 'pending')) {
      clearReviewDraft(user?.id || 'anon', m.id)
      return
    }
    setReview(true)
  }, [m])

  // Bring a rejected suggestion back into the pending queue, then open the review
  // screen so the manager can edit / reassign it right away.
  const restore = async (sid: string) => {
    setRestoringId(sid); setRestoreErr('')
    try { await api.post(`/meetings/suggestions/${sid}/restore`); await load(); setReview(true) }
    catch (e: any) { setRestoreErr(e.message) }
    finally { setRestoringId(null) }
  }

  if (loadErr) return (
    <div className="card section" style={{ marginTop: 16 }}>
      <div className="empty-state">
        <div className="empty-state-icon"><Ic name="warning" size={40} /></div>
        <div className="empty-state-title">Couldn't load this meeting</div>
        <div className="empty-state-hint">Check your connection and try again.</div>
        <div className="empty-state-action"><button className="btn btn-primary btn-sm" onClick={load}>Retry</button></div>
      </div>
    </div>
  )
  if (!m) return (
    <div style={{ marginTop: 16 }}>
      <span className="skeleton" style={{ height: 30, width: 260, display: 'block', marginBottom: 16 }} />
      <div className="grid grid-2">
        <div className="card section"><div className="card-pad">{Array.from({ length: 4 }).map((_, i) => <span key={i} className="skeleton skel-row" />)}</div></div>
        <div className="card section"><div className="card-pad">{Array.from({ length: 4 }).map((_, i) => <span key={i} className="skeleton skel-row" />)}</div></div>
      </div>
    </div>
  )
  const s = m.summary || {}
  const pending: Suggestion[] = (m.suggestions || []).filter((x: Suggestion) => x.status === 'pending')
  const rejected: Suggestion[] = (m.suggestions || []).filter((x: Suggestion) => x.status === 'rejected')

  return (
    <>
      <Link to="/meetings" className="muted row" style={{ fontSize: 13, gap: 5, display: 'inline-flex' }}><Ic name="arrowLeft" size={14} /> All meetings</Link>
      <div className="spread" style={{ margin: '8px 0 8px' }}>
        <div>
          <h1 style={{ fontSize: 22 }}>{m.title}</h1>
          <div className="muted row" style={{ fontSize: 13, flexWrap: 'wrap' }}>
            <span className="src-tag">{sourceLabel(m)}</span>
            {(m.meeting_date || '').slice(0, 10)}
            {(m.detected_languages || []).length > 0 && <span>· Transcribed from</span>}
            <span className="tag-list">{(m.detected_languages || []).map((l: string) => <span key={l} className="lang-tag">{LANG_LABEL[l] || l}</span>)}</span>
          </div>
        </div>
        <div className="row">
          <button className={'btn btn-sm' + (tab === 'summary' ? ' btn-primary' : '')} onClick={() => setTab('summary')}>Summary & Tasks</button>
          <button className={'btn btn-sm' + (tab === 'transcript' ? ' btn-primary' : '')} onClick={() => setTab('transcript')}>Transcript</button>
        </div>
      </div>

      {m.description && <p className="muted" style={{ marginTop: 0, maxWidth: 760 }}>{m.description}</p>}

      {/* Participants */}
      {(m.participants || []).length > 0 && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>Participants:</span>
          {m.participants.map((p: any) => (
            <span key={p.id} className="row" style={{ gap: 5, fontSize: 12.5 }}><Avatar name={p.name} color={p.avatar_color} size={20} /> {p.name}</span>
          ))}
        </div>
      )}

      {tab === 'summary' ? (
        <div className="grid grid-2">
          <div>
            <div className="card section">
              <div className="card-head"><h3 className="row" style={{ gap: 8 }}><span style={{ color: 'var(--primary)' }}><Ic name="doc" /></span> Executive Summary</h3></div>
              <div className="card-pad">{s.executive_summary || 'No summary generated.'}</div>
            </div>

            {/* AI Review Queue */}
            {pending.length > 0 && (
              <div className="card section">
                <div className="card-head spread">
                  <h3 className="row" style={{ gap: 8 }}><span style={{ color: 'var(--primary)' }}><Ic name="ai" /></span> Tasks found in this {sourceLabel(m).toLowerCase()} — pending review ({pending.length})</h3>
                  <button className="btn btn-primary btn-sm" onClick={() => setReview(true)}>Review &amp; Assign {sourceLabel(m)}</button>
                </div>
                <div className="card-pad grid" style={{ gap: 10 }}>
                  {pending.map((sg) => {
                    const band = confidenceBand(sg.confidence)
                    // The card's tint keys off the SAME confidence band as the score —
                    // no more separate <50 threshold that contradicted the chip.
                    const flagged = band.key !== 'verified'
                    const owner = sg.suggested_assignee_name
                      ? <span className="row" style={{ gap: 6 }}><Avatar name={sg.suggested_assignee_name} color={sg.suggested_assignee_color || undefined} size={18} /> Owner: {sg.suggested_assignee_name}</span>
                      : <span style={{ color: 'var(--warning-ink)' }}>{sg.suggested_assignee_raw ? `Heard “${sg.suggested_assignee_raw}” — not an attendee` : 'No owner suggested'}</span>
                    return (
                      <div key={sg.id} style={{ border: `1px solid ${flagged ? band.border : 'var(--border)'}`, borderRadius: 'var(--r-lg)', padding: 14, background: flagged ? band.bg : 'var(--surface)', display: 'grid', gap: 10 }}>
                        <div className="spread" style={{ alignItems: 'flex-start', gap: 8 }}>
                          <div style={{ fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere' }}>{sg.title}</div>
                          <PriorityBadge p={sg.priority} />
                        </div>
                        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                          <ConfidenceScore score={sg.confidence} />
                          {/* Beside "Asked by", a bare date could be when it was said;
                              say what the date is. */}
                          <span className="muted" style={{ fontSize: 12.5 }}>{(sg.due_date || sg.due_date_raw) && 'Due '}{dueLabel(sg)}</span>
                          <Assigner sg={sg} />
                        </div>
                        <Evidence quote={sg.source_quote} reasoning={sg.assignee_reasoning} score={sg.confidence} ownerLabel={owner} />
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Rejected suggestions — retrievable for editing / reassigning */}
            {rejected.length > 0 && (
              <div className="card section">
                <div className="card-head"><h3>Rejected Suggestions ({rejected.length})</h3></div>
                <div className="card-pad grid" style={{ gap: 8 }}>
                  {restoreErr && <div style={{ color: 'var(--danger-ink)', fontSize: 12.5 }}>{restoreErr}</div>}
                  {rejected.map((sg) => (
                    <div key={sg.id} className="spread" style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', background: 'var(--n-50)' }}>
                      <div>
                        <div style={{ fontWeight: 600, textDecoration: 'line-through', color: 'var(--muted)' }}>{sg.title}</div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          {sg.suggested_assignee_name || sg.suggested_assignee_raw || 'No owner'} · {dueLabel(sg)}
                        </div>
                      </div>
                      <button className="btn btn-sm" disabled={restoringId === sg.id} onClick={() => restore(sg.id)}>
                        {restoringId === sg.id ? <span className="spinner" /> : <span className="row" style={{ gap: 6 }}><Ic name="reply" size={14} /> Restore & edit</span>}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Assigned tasks */}
            <div className="card section">
              <div className="card-head"><h3>Assigned Tasks ({m.tasks.length})</h3></div>
              <table>
                <tbody>
                  {m.tasks.map((t: any) => (
                    <tr key={t.id} className="clickable" onClick={() => setOpenId(t.id)}
                      role="button" tabIndex={0} aria-label={`Open ${t.title}`}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(t.id) } }}>
                      <td>
                        <div className="clamp-2" style={{ fontWeight: 600 }}>{t.title}</div>
                        <div className="muted" style={{ fontSize: 11.5 }}>{t.assignee_name || t.assignee_name_raw || 'Unassigned'} · {dueLabel(t)}</div>
                      </td>
                      <td style={{ textAlign: 'right' }}><PriorityBadge p={t.priority} /><br /><StatusBadge s={t.status} /></td>
                    </tr>
                  ))}
                  {m.tasks.length === 0 && <tr><td className="muted">No tasks assigned yet. Review the AI suggestions above.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            {SUMMARY_SECTIONS.map((sec) => {
              const items = normalisePoints(s[sec.key])
              if (!items.length) return null
              const cited = items.filter((it) => it.evidence).length
              return (
                <div key={sec.key} className="card section">
                  <div className="card-head spread">
                    <h3 className="row" style={{ gap: 8 }}>{sec.icon} {sec.label} ({items.length})</h3>
                    {cited > 0 && <span className="muted" style={{ fontSize: 11.5 }}>{cited} of {items.length} traceable</span>}
                  </div>
                  <div className="card-pad" style={{ display: 'grid', gap: 8 }}>
                    {items.map((it, i) => <SummaryPoint key={i} point={it} />)}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="card-pad">
            {m.segments.map((seg: any) => (
              <div key={seg.id} className="segment">
                <div className="speaker">{seg.speaker}{seg.language && <span className="lang-tag">{seg.language}</span>}</div>
                <div>{seg.text}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {openId && <TaskDrawer taskId={openId} onClose={() => setOpenId(null)} onChange={load} />}
      {review && <ReviewAssignModal meeting={m} pending={pending} onChanged={load} onClose={() => { setReview(false); load() }} />}
    </>
  )
}

const PRIORITIES = ['Critical', 'High', 'Medium', 'Low']

// Manager Review screen: edit each AI suggestion (priority, assignee, due, title)
// and approve them ONE BY ONE — every approval assigns that task & notifies the
// owner immediately, with no need to wait and assign the whole batch at the end.
type RowStatus = 'pending' | 'busy' | 'assigned' | 'rejected' | 'merged'
export function ReviewAssignModal({ meeting, pending, onClose, onChanged }: { meeting: any; pending: Suggestion[]; onClose: () => void; onChanged: () => void }) {
  type Row = Suggestion & { _status: RowStatus; _error: string; _showMerge: boolean; _mergeInto: string }
  const { user } = useAuth()
  const uid = user?.id || 'anon'
  // A call's "Review & assign" card has nothing left to ask once this is open.
  useEffect(() => { hideForMeeting(meeting.id) }, [meeting.id])

  // Pre-fill each due date from priority (matching the server default) when the
  // AI didn't capture a deadline, so the manager sees the date before assigning.
  const rowFields = (p: Suggestion): ReviewEdit => ({
    title: p.title,
    // The extractor rarely has a real description: rules.js builds title and
    // description from the same sentence, and every LLM path falls back to
    // `description || title` server-side. Echoing that copy into its own box
    // just says the same thing twice, so an exact duplicate reads as empty.
    // Nothing is lost — createTaskFromSuggestion falls back to the title again
    // when the assigned task is created.
    description: p.description && p.description !== p.title ? p.description : '',
    suggested_assignee_id: p.suggested_assignee_id || '',
    priority: p.priority,
    due_date: p.due_date || defaultDueDate(p.priority),
  })

  // What the server said when this screen opened, kept for the whole session.
  // The autosave below diffs against THIS rather than against the raw
  // suggestion, so the due date we just filled in for the manager doesn't count
  // as one of their edits — otherwise merely opening the review would register
  // as an unfinished one, and the resume banner would nag about a screen nobody
  // touched. A ref, not state: reloading the meeting in the background must not
  // move the line the edits are measured from.
  const baselineRef = React.useRef<Map<string, ReviewEdit> | null>(null)
  if (!baselineRef.current) baselineRef.current = new Map(pending.map((p) => [p.id, rowFields(p)]))

  // Edits this manager had made when the app was last killed or backgrounded.
  const [saved] = useState(() => loadReviewDraft(uid, meeting.id))

  const [rows, setRows] = useState<Row[]>(() => pending.map((p) => {
    const e = saved?.edits[p.id]
    return {
      ...p,
      ...(e || rowFields(p)),
      suggested_assignee_id: (e ? e.suggested_assignee_id : p.suggested_assignee_id) || null,
      _status: 'pending' as RowStatus, _error: '', _showMerge: false, _mergeInto: '',
    }
  }))
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkErr, setBulkErr] = useState('')
  const participants: any[] = meeting.participants || []

  // The dropdown used to list only recorded attendees. When the transcript named
  // somebody who was not on the attendee list -- which is every pasted transcript
  // and any call somebody dialled into late -- the resolved assignee had no
  // matching <option>, so the browser fell back to displaying "Unassigned" while
  // the row underneath still carried their id. The reviewer was shown one thing
  // and would have assigned another. Offer the whole org, as the task pages do.
  const [assignable, setAssignable] = useState<any[]>(participants)
  useEffect(() => {
    api.get('/users')
      .then((list: any[]) => {
        const byId = new Map<string, any>()
        for (const p of [...(list || []), ...participants]) if (p?.id) byId.set(p.id, p)
        setAssignable([...byId.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '')))
      })
      // An attendee-only list is worse than the full one but still correct for
      // the common case, so a failed fetch must not empty the dropdown.
      .catch(() => setAssignable(participants))
  }, [meeting.id])

  // Only count what actually came back: a suggestion someone else assigned or
  // deleted while this manager was away is no longer in `pending`, and claiming
  // to have restored an edit to it would be a lie.
  const [restored] = useState(() => (saved ? Object.keys(saved.edits).filter((sid) => pending.some((p) => p.id === sid)).length : 0))
  const [showRestored, setShowRestored] = useState(restored > 0)

  // Write the manager's work to disk on every keystroke. Only rows still
  // awaiting a decision are worth keeping — once a row is assigned, rejected or
  // merged the server owns it, and a leftover local edit would reappear as a
  // change to a task that has already gone out.
  useEffect(() => {
    const edits: Record<string, ReviewEdit> = {}
    for (const r of rows) {
      if (r._status !== 'pending') continue
      const base = baselineRef.current!.get(r.id)
      if (!base) continue
      const cur: ReviewEdit = {
        title: r.title,
        description: r.description || '',
        suggested_assignee_id: r.suggested_assignee_id || '',
        priority: r.priority,
        due_date: r.due_date || '',
      }
      const changed = (Object.keys(cur) as (keyof ReviewEdit)[]).some((k) => cur[k] !== base[k])
      if (changed) edits[r.id] = cur
    }
    if (!Object.keys(edits).length) clearReviewDraft(uid, meeting.id)
    else saveReviewDraft(uid, { meetingId: meeting.id, meetingTitle: meeting.title || 'Meeting', savedAt: Date.now(), edits, newTask: null })
  }, [rows, uid, meeting.id, meeting.title])

  // Throw away what was restored and go back to the AI's own wording. The
  // autosave above notices there is nothing left to keep and drops the entry.
  const discardRestored = () => {
    setRows((rs) => rs.map((r) => {
      const base = baselineRef.current!.get(r.id)
      return base && r._status === 'pending' ? { ...r, ...base, suggested_assignee_id: base.suggested_assignee_id || null } : r
    }))
    setShowRestored(false)
  }

  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  // Approve ONE suggestion: save the manager's edits, then assign it right away.
  const approveAssign = async (i: number) => {
    const r = rows[i]
    if (!r.suggested_assignee_id) { set(i, { _error: 'Pick an assignee before approving.' }); return }
    set(i, { _status: 'busy', _error: '' })
    try {
      await api.patch(`/meetings/suggestions/${r.id}`, {
        title: r.title, description: r.description || '', suggested_assignee_id: r.suggested_assignee_id,
        priority: r.priority, due_date: r.due_date || null,
      })
      const res = await api.post(`/meetings/${meeting.id}/assign`, { ids: [r.id] })
      if (!res.assigned) { set(i, { _status: 'pending', _error: 'Could not assign — check the owner.' }); return }
      set(i, { _status: 'assigned' })
      onChanged() // refresh the meeting's "Assigned Tasks" list in the background
    } catch (e: any) { set(i, { _status: 'pending', _error: e.message }) }
  }

  const reject = async (i: number) => {
    const r = rows[i]
    set(i, { _status: 'busy', _error: '' })
    try { await api.post(`/meetings/suggestions/${r.id}/reject`); set(i, { _status: 'rejected' }); onChanged() }
    catch (e: any) { set(i, { _status: 'pending', _error: e.message }) }
  }

  // Undo a reject/merge from within the review screen — the row becomes editable
  // and assignable again.
  const restoreRow = async (i: number) => {
    const r = rows[i]
    set(i, { _error: '' })
    try { await api.post(`/meetings/suggestions/${r.id}/restore`); set(i, { _status: 'pending' }); onChanged() }
    catch (e: any) { set(i, { _error: e.message }) }
  }

  const doMerge = async (i: number) => {
    const r = rows[i]
    if (!r._mergeInto) return
    set(i, { _status: 'busy', _error: '' })
    try { await api.post(`/meetings/suggestions/${r.id}/merge`, { into: r._mergeInto }); set(i, { _status: 'merged' }); onChanged() }
    catch (e: any) { set(i, { _status: 'pending', _error: e.message }) }
  }

  // Batch shortcut: save edits for every still-pending row that has an owner and
  // assign them all at once — so the manager isn't forced to click 20 rows.
  const assignAllRemaining = async () => {
    const targets = rows.filter((r) => r._status === 'pending' && r.suggested_assignee_id)
    if (!targets.length) return
    // Name the consequence BEFORE the click: how many tasks, and exactly which
    // people get notified (with per-person counts). Bulk assignment can't be undone.
    const byPerson = new Map<string, number>()
    for (const t of targets) {
      const name = assignable.find((p: any) => p.id === t.suggested_assignee_id)?.name || 'Unassigned'
      byPerson.set(name, (byPerson.get(name) || 0) + 1)
    }
    const people = [...byPerson.entries()].map(([n, c]) => `${n} (${c})`).join(', ')
    const ok = await confirmDialog({
      title: `Assign ${targets.length} task${targets.length > 1 ? 's' : ''} and notify ${byPerson.size} ${byPerson.size > 1 ? 'people' : 'person'}?`,
      message: `${people}\n\nEach person is notified immediately. This can't be undone in bulk.`,
      confirmText: 'Assign & notify',
    })
    if (!ok) return
    setBulkErr(''); setBulkBusy(true)
    const ids = new Set(targets.map((t) => t.id))
    setRows((rs) => rs.map((r) => (ids.has(r.id) ? { ...r, _status: 'busy', _error: '' } : r)))
    try {
      for (const r of targets) {
        await api.patch(`/meetings/suggestions/${r.id}`, {
          title: r.title, description: r.description || '', suggested_assignee_id: r.suggested_assignee_id,
          priority: r.priority, due_date: r.due_date || null,
        })
      }
      await api.post(`/meetings/${meeting.id}/assign`, { ids: targets.map((t) => t.id) })
      setRows((rs) => rs.map((r) => (ids.has(r.id) ? { ...r, _status: 'assigned' } : r)))
      onChanged()
    } catch (e: any) {
      setBulkErr(e.message)
      setRows((rs) => rs.map((r) => (ids.has(r.id) ? { ...r, _status: 'pending' } : r)))
    } finally { setBulkBusy(false) }
  }

  const done = rows.filter((r) => r._status === 'assigned' || r._status === 'rejected' || r._status === 'merged').length
  const assignedCount = rows.filter((r) => r._status === 'assigned').length
  const remaining = rows.length - done
  const pendingWithOwner = rows.filter((r) => r._status === 'pending' && r.suggested_assignee_id).length
  const noOwnerCount = rows.filter((r) => r._status === 'pending' && !r.suggested_assignee_id).length
  const dialogRef = useDialog<HTMLDivElement>(onClose)

  // Sized by the rv-* rules in styles.css, not inline: the heading and the footer
  // with the bulk action stay put while only the task list scrolls, and on a
  // phone the whole thing becomes a full-screen sheet.
  return (
    <div className="modal-center rv-center" onClick={onClose}>
      <div className="modal rv-modal" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Review and assign tasks" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread rv-head"><h3>Review &amp; Assign {sourceLabel(meeting)}</h3><button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="card-pad grid rv-list" style={{ gap: 12 }}>
          {/* Say so out loud. A manager who was pulled into a call mid-review comes
              back expecting to start over, and silently restoring their edits would
              leave them re-checking every row to work out what the AI said and what
              they had already changed. */}
          {showRestored && (
            <div className="rv-resumed">
              <div style={{ minWidth: 0 }}>
                <b>Picked up where you left off</b> — {restored} unsaved {restored === 1 ? 'change' : 'changes'} from {draftAge(saved!.savedAt)}. Nothing has been assigned yet.
              </div>
              <button className="btn btn-sm" onClick={discardRestored}>Start over</button>
            </div>
          )}
          {rows.map((r, i) => {
            // Once a row is acted on, collapse it into a compact confirmation strip.
            if (r._status === 'assigned' || r._status === 'rejected' || r._status === 'merged') {
              const label = r._status === 'assigned' ? 'Assigned & notified' : r._status === 'rejected' ? 'Rejected' : 'Merged'
              const color = r._status === 'assigned' ? 'var(--success-ink)' : r._status === 'rejected' ? 'var(--danger-ink)' : 'var(--muted)'
              return (
                <div key={r.id} className="spread" style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', background: 'var(--n-50)' }}>
                  <span style={{ fontWeight: 600, textDecoration: r._status === 'assigned' ? 'none' : 'line-through', color: r._status === 'assigned' ? 'inherit' : 'var(--muted)' }}>{r.title}</span>
                  <span className="row" style={{ gap: 10 }}>
                    <span style={{ color, fontWeight: 700, fontSize: 13 }}>{label}</span>
                    {(r._status === 'rejected' || r._status === 'merged') && (
                      <button className="btn btn-ghost btn-sm row" style={{ gap: 6 }} onClick={() => restoreRow(i)}><Ic name="reply" size={14} /> Restore</button>
                    )}
                  </span>
                </div>
              )
            }
            const busy = r._status === 'busy'
            return (
              <div key={r.id} style={{ border: '1px solid ' + (r._error ? 'var(--danger-border)' : 'var(--border)'), borderRadius: 10, padding: 12 }}>
                <div className="grid" style={{ gap: 8 }}>
                  {/* The title is the field being edited, so it gets the width. The
                      confidence chip can't shrink (nowrap, ~190px), which on a phone
                      left the title one word per line — so it moves above the title
                      there rather than beside it. See .rv-title-row. */}
                  <div className="rv-title-row">
                    <div className="rv-title-main">
                      <label>Task title</label>
                      <AutoTextarea value={r.title} onChange={(e) => set(i, { title: e.target.value })} className="rv-title" />
                    </div>
                    <div className="rv-conf"><ConfidenceScore score={r.confidence} /></div>
                  </div>
                  <div>
                    <label>Description <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label>
                    <AutoTextarea
                      value={r.description || ''}
                      onChange={(e) => set(i, { description: e.target.value })}
                      placeholder="Optional — add any detail the title doesn't already carry."
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div className="grid grid-3" style={{ gap: 8 }}>
                    <div>
                      <label>Assignee{askedBy(r) ? <span className="asgn-inline"> · asked by {askedBy(r)}</span> : null}</label>
                      <select value={r.suggested_assignee_id || ''} onChange={(e) => set(i, { suggested_assignee_id: e.target.value || null })}>
                        <option value="">— Unassigned —</option>
                        {assignable.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </div>
                    <div><label>Priority</label><select value={r.priority} onChange={(e) => set(i, { priority: e.target.value, due_date: defaultDueDate(e.target.value) })}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></div>
                    <div><label>Due date</label><input type="date" value={(r.due_date || '').slice(0, 10)} onChange={(e) => set(i, { due_date: e.target.value })} /></div>
                  </div>
                  {(r.source_quote || r.assignee_reasoning) && (
                    <Evidence quote={r.source_quote} reasoning={r.assignee_reasoning} score={r.confidence} compact />
                  )}
                  {r._error && <div style={{ color: 'var(--danger-ink)', fontSize: 12.5, fontWeight: 600 }}>{r._error}</div>}
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => approveAssign(i)}>{busy ? <span className="spinner" /> : '✓ Approve & Assign'}</button>
                    <button className="btn btn-sm" disabled={busy} onClick={() => reject(i)}>✕ Reject</button>
                    {!r._showMerge
                      ? <button className="btn btn-sm row" style={{ gap: 6 }} disabled={busy} onClick={() => set(i, { _showMerge: true })}><Ic name="merge" size={14} /> Merge into…</button>
                      : (
                        <span className="row" style={{ gap: 4 }}>
                          <select value={r._mergeInto} onChange={(e) => set(i, { _mergeInto: e.target.value })}>
                            <option value="">choose task…</option>
                            {rows.filter((o) => o.id !== r.id && o._status === 'pending').map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
                          </select>
                          <button className="btn btn-sm" disabled={busy || !r._mergeInto} onClick={() => doMerge(i)}>Merge</button>
                          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => set(i, { _showMerge: false, _mergeInto: '' })}>↩</button>
                        </span>
                      )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        <div className="card-pad spread rv-foot">
          <div className="muted" style={{ fontSize: 12.5 }}>
            {assignedCount} assigned · {remaining} left{noOwnerCount ? ` · ${noOwnerCount} need an owner` : ''}
            {bulkErr && <span style={{ color: 'var(--danger-ink)', marginLeft: 8 }}>{bulkErr}</span>}
          </div>
          <div className="row">
            <button className="btn" onClick={onClose}>{remaining === 0 ? 'Close' : 'Done'}</button>
            <button className="btn btn-primary" disabled={bulkBusy || !pendingWithOwner} onClick={assignAllRemaining}>
              {bulkBusy ? <span className="spinner" /> : `Assign all remaining (${pendingWithOwner})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
