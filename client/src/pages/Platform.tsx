import React, { useEffect, useState } from 'react'
import { api } from '../api'
import { Bar, EmptyState, Ic, STATUS_COLORS, fmtDateTime, dayKeyOf } from '../ui'
import { toast } from '../lib/toast'
import { confirmDialog } from '../lib/confirm'

interface Org {
  id: string; name: string; is_personal: number; allowed_domains: string[]; created_at: string
  user_count: number; task_count: number; last_activity: string | null; owner_email: string | null
  usage_cost: number; usage_calls: number; usage_access: boolean
}

interface Member { id: string; name: string; email: string; role: string; platform_admin: number; created_at: string }
interface UsageRow { provider?: string; feature?: string; calls: number; tokens: number; cost: number }
interface Usage {
  total: { calls: number; input_tokens: number; output_tokens: number; tokens: number; cost: number }
  by_provider: UsageRow[]
  by_feature: UsageRow[]
}
interface OrgDetail {
  org: { id: string; name: string; is_personal: number; allowed_domains: string[]; created_at: string; usage_access: boolean }
  members: Member[]
  by_status: { status: string; count: number }[]
  task_count: number
  usage: Usage
}

// Compact money / number formatting for the usage figures.
export const fmtUsd = (n: number) => '$' + (n || 0).toLocaleString(undefined, { minimumFractionDigits: n < 1 ? 4 : 2, maximumFractionDigits: n < 1 ? 4 : 2 })
export const fmtNum = (n: number) => (n || 0) >= 1000 ? (n / 1000).toFixed(n >= 1e6 ? 2 : 1).replace(/\.0$/, '') + (n >= 1e6 ? 'M' : 'k') : String(n || 0)

// Platform admin console — oversee ALL organizations (super-admin only).
export default function Platform() {
  const [orgs, setOrgs] = useState<Org[] | null>(null)
  const [stats, setStats] = useState<{ orgs: number; users: number; tasks: number; ai_cost: number; ai_calls: number } | null>(null)
  const [error, setError] = useState(false)
  const [q, setQ] = useState('')
  // Org drill-down: null = closed; { id } while loading; full detail once fetched.
  const [detail, setDetail] = useState<{ id: string; data: OrgDetail | null; error: boolean } | null>(null)

  const load = () => {
    setError(false); setOrgs(null)
    Promise.all([api.get('/platform/stats'), api.get('/platform/orgs')])
      .then(([s, o]) => { setStats(s); setOrgs(o) })
      .catch(() => setError(true))
  }
  useEffect(load, [])

  const openOrg = (id: string) => {
    setDetail({ id, data: null, error: false })
    api.get(`/platform/orgs/${id}`)
      .then((d) => setDetail({ id, data: d, error: false }))
      .catch(() => setDetail({ id, data: null, error: true }))
  }

  const removeOrg = async (o: Org) => {
    const ok = await confirmDialog({
      title: 'Delete organization',
      message: `Permanently delete "${o.name}" and ALL its data — ${o.user_count} user(s), ${o.task_count} task(s), meetings, chats and more? This cannot be undone.`,
      confirmText: 'Delete everything', danger: true,
    })
    if (!ok) return
    try { await api.del(`/platform/orgs/${o.id}`); toast.success(`"${o.name}" deleted.`); load() }
    catch (e: any) { toast.error(e.message) }
  }

  if (error) return (
    <div className="card"><EmptyState icon={<Ic name="warning" size={40} />} title="Couldn't load the platform console" hint="Check your connection and try again."
      action={<button className="btn btn-primary btn-sm" onClick={load}>Retry</button>} /></div>
  )
  if (!orgs || !stats) return <div className="dash-skeleton"><span className="spinner" /></div>

  const filtered = orgs.filter((o) =>
    !q || o.name.toLowerCase().includes(q.toLowerCase()) || (o.owner_email || '').toLowerCase().includes(q.toLowerCase()))

  return (
    <>
      {/* auto-fit wraps the KPIs responsively (4-across on desktop → 2 on phones)
          instead of a hardcoded 4 columns that overflow into a sideways scroll. */}
      <div className="emp-kpis section" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <div className="kpi" style={{ ['--kc' as any]: '#ea580c' }}><div><div className="kpi-val">{stats.orgs}</div><div className="kpi-label">Organizations</div></div></div>
        <div className="kpi" style={{ ['--kc' as any]: '#3b82f6' }}><div><div className="kpi-val">{stats.users}</div><div className="kpi-label">Total users</div></div></div>
        <div className="kpi" style={{ ['--kc' as any]: '#10b981' }}><div><div className="kpi-val">{stats.tasks}</div><div className="kpi-label">Total tasks</div></div></div>
        <div className="kpi" style={{ ['--kc' as any]: '#a855f7' }}><div><div className="kpi-val">{fmtUsd(stats.ai_cost)}</div><div className="kpi-label">AI spend · {fmtNum(stats.ai_calls)} calls</div></div></div>
      </div>

      <AppUpdateCard />

      <div className="toolbar">
        <input placeholder="Search organizations…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 240 }} />
        <div className="muted" style={{ marginLeft: 'auto' }}>{filtered.length} of {orgs.length} orgs</div>
      </div>

      <div className="card table-card-wrap">
        <table className="table-cards">
          <thead><tr>
            <th>Organization</th><th>Type</th><th>Owner</th><th>Users</th><th>Tasks</th><th>AI usage</th><th>Created</th><th>Last activity</th><th></th>
          </tr></thead>
          <tbody>
            {filtered.map((o) => (
              <tr key={o.id}>
                <td className="cell-title">
                  <button style={{ fontWeight: 600, textAlign: 'left', background: 'none', border: 'none', padding: 0, color: 'var(--primary)' }} onClick={() => openOrg(o.id)} title="View members & task breakdown">{o.name}</button>
                  {o.allowed_domains.length > 0 && <div className="muted" style={{ fontSize: 11 }}>{o.allowed_domains.join(', ')}</div>}</td>
                <td data-label="Type">{o.is_personal ? <span className="badge" style={{ background: '#eef2ff', color: '#4f46e5' }}>Personal</span> : <span className="badge" style={{ background: '#ffedd5', color: '#ea580c' }}>Company</span>}</td>
                <td data-label="Owner" className="muted">{o.owner_email || '—'}</td>
                <td data-label="Users"><strong>{o.user_count}</strong></td>
                <td data-label="Tasks">{o.task_count}</td>
                <td data-label="AI usage">
                  <strong>{fmtUsd(o.usage_cost)}</strong>
                  <div className="muted" style={{ fontSize: 11 }}>{fmtNum(o.usage_calls)} calls{o.usage_access ? ' · shared' : ''}</div>
                </td>
                <td data-label="Created">{dayKeyOf(o.created_at)}</td>
                <td data-label="Last activity" className="muted">{o.last_activity ? fmtDateTime(o.last_activity) : '—'}</td>
                <td><button className="btn btn-sm btn-danger row" style={{ gap: 6 }} onClick={() => removeOrg(o)}><Ic name="trash" size={14} /> Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <div className="empty" style={{ padding: 20 }}>No organizations match your search.</div>}
      </div>

      {detail && <OrgDetailModal state={detail} onClose={() => setDetail(null)} onRetry={() => openOrg(detail.id)} onChanged={load} />}
    </>
  )
}

function OrgDetailModal({ state, onClose, onRetry, onChanged }: {
  state: { id: string; data: OrgDetail | null; error: boolean }
  onClose: () => void
  onRetry: () => void
  onChanged: () => void
}) {
  const d = state.data
  const maxStatus = d ? Math.max(...d.by_status.map((s) => s.count), 1) : 1
  const [access, setAccess] = useState(false)
  const [accessBusy, setAccessBusy] = useState(false)
  useEffect(() => { if (d) setAccess(!!d.org.usage_access) }, [d])

  const toggleAccess = async () => {
    if (!d) return
    const next = !access
    setAccessBusy(true)
    try {
      await api.patch(`/platform/orgs/${d.org.id}/usage-access`, { enabled: next })
      setAccess(next)
      toast.success(next ? `${d.org.name}'s admins can now view their usage.` : `Usage access revoked for ${d.org.name}.`)
      onChanged()
    } catch (e: any) { toast.error(e.message) }
    finally { setAccessBusy(false) }
  }
  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="card-head spread">
          <h3>{d ? d.org.name : 'Organization'}</h3>
          <button className="btn btn-ghost" onClick={onClose}>✕</button>
        </div>
        <div className="card-pad grid" style={{ gap: 18 }}>
          {state.error ? (
            <EmptyState icon={<Ic name="warning" size={40} />} title="Couldn't load this organization" hint="Check your connection and try again."
              action={<button className="btn btn-primary btn-sm" onClick={onRetry}>Retry</button>} />
          ) : !d ? (
            <div style={{ textAlign: 'center', padding: 20 }}><span className="spinner" /></div>
          ) : (
            <>
              <div>
                <div className="spread" style={{ marginBottom: 8 }}>
                  <strong>Tasks by status</strong>
                  <span className="muted">{d.task_count} total</span>
                </div>
                {d.by_status.length === 0 ? (
                  <div className="muted" style={{ fontSize: 13 }}>No tasks yet.</div>
                ) : d.by_status.map((s) => (
                  <div key={s.status} style={{ marginBottom: 11 }}>
                    <div className="spread" style={{ marginBottom: 4 }}>
                      <span className="row" style={{ gap: 7, fontSize: 13 }}>
                        <span style={{ width: 10, height: 10, borderRadius: 3, background: STATUS_COLORS[s.status] || '#64748b' }} />
                        {s.status}
                      </span>
                      <strong>{s.count}</strong>
                    </div>
                    <Bar value={s.count} max={maxStatus} color={STATUS_COLORS[s.status] || '#64748b'} />
                  </div>
                ))}
              </div>

              <div>
                <div className="spread" style={{ marginBottom: 8 }}>
                  <strong>AI / API usage</strong>
                  <span className="muted" title="Estimated from public list prices">{fmtUsd(d.usage.total.cost)} est.</span>
                </div>
                <div className="row" style={{ gap: 16, marginBottom: 10, flexWrap: 'wrap' }}>
                  <span className="muted" style={{ fontSize: 13 }}>{fmtNum(d.usage.total.calls)} calls</span>
                  <span className="muted" style={{ fontSize: 13 }}>{fmtNum(d.usage.total.tokens)} tokens</span>
                </div>
                {d.usage.total.calls === 0 ? (
                  <div className="muted" style={{ fontSize: 13 }}>No AI usage recorded yet.</div>
                ) : (
                  <div className="grid grid-2" style={{ gap: 14 }}>
                    <div>
                      <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: .4, marginBottom: 5 }}>By provider</div>
                      {d.usage.by_provider.map((r) => (
                        <div key={r.provider} className="spread" style={{ fontSize: 12.5, padding: '3px 0' }}>
                          <span>{r.provider}</span><span className="muted">{r.calls} · {fmtUsd(r.cost)}</span>
                        </div>
                      ))}
                    </div>
                    <div>
                      <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: .4, marginBottom: 5 }}>By feature</div>
                      {d.usage.by_feature.map((r) => (
                        <div key={r.feature} className="spread" style={{ fontSize: 12.5, padding: '3px 0' }}>
                          <span>{(r.feature || '').replace(/_/g, ' ')}</span><span className="muted">{r.calls} · {fmtUsd(r.cost)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <label className="row" style={{ gap: 8, marginTop: 12, fontSize: 13, cursor: accessBusy ? 'wait' : 'pointer' }}>
                  <input type="checkbox" checked={access} disabled={accessBusy} onChange={toggleAccess} />
                  Let this organization's admins view their own usage
                </label>
              </div>

              <div>
                <div className="spread" style={{ marginBottom: 8 }}>
                  <strong>Members</strong>
                  <span className="muted">{d.members.length}</span>
                </div>
                <div className="card table-card-wrap" style={{ boxShadow: 'none', border: '1px solid var(--border)' }}>
                  <table className="table-cards">
                    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th></tr></thead>
                    <tbody>
                      {d.members.map((m) => (
                        <tr key={m.id}>
                          <td className="cell-title">
                            {m.name || '—'}
                            {m.platform_admin ? <span className="badge" style={{ marginLeft: 6, background: '#fef3c7', color: '#b45309', fontSize: 10 }}>Super admin</span> : null}
                          </td>
                          <td data-label="Email" className="muted">{m.email}</td>
                          <td data-label="Role">{m.role}</td>
                          <td data-label="Joined" className="muted">{dayKeyOf(m.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- phones: tell them a new version is out ----------
// Once a release is live on Google Play, one push to every phone on an older
// build ("VoTask update available"). Phones from 4.5 on report their build and
// a tap opens Play's update screen; older ones just open the app, so the
// message says where to go.
function AppUpdateCard() {
  const [info, setInfo] = useState<{ push: boolean; builds: { build: number | null; devices: number }[] } | null>(null)
  const [build, setBuild] = useState('')
  const [body, setBody] = useState('A new version of VoTask is on the Play Store. Open Play Store, find VoTask and tap Update.')
  const [busy, setBusy] = useState(false)
  const load = () => api.get('/platform/app-update').then((d) => {
    setInfo(d)
    const top = Math.max(0, ...d.builds.map((b: any) => b.build || 0))
    setBuild((cur) => cur || (top ? String(top) : ''))
  }).catch(() => setInfo({ push: false, builds: [] }))
  useEffect(() => { load() }, [])
  const n = Number(build)
  const older = info ? info.builds.filter((b) => b.build == null || b.build < n).reduce((t, b) => t + b.devices, 0) : 0
  const send = async () => {
    const ok = await confirmDialog({
      title: 'Tell phones to update',
      message: `Send "VoTask update available" to ${older} phone${older === 1 ? '' : 's'} on a version older than ${n}? Only do this once version ${n} is live on Google Play.`,
      confirmText: 'Send',
    })
    if (!ok) return
    setBusy(true)
    try {
      const r = await api.post('/platform/app-update', { build: n, body })
      toast.success(`Sent to ${r.sent} of ${r.devices} phone${r.devices === 1 ? '' : 's'}`)
      load()
    } catch (e: any) { toast.error(e.message) }
    finally { setBusy(false) }
  }
  return (
    <div className="card section">
      <div className="card-head spread"><h3 className="row" style={{ gap: 7 }}><Ic name="bell" size={16} /> Phone app update</h3></div>
      <div className="card-pad grid" style={{ gap: 10 }}>
        {!info ? <span className="spinner" /> : (<>
          <div className="muted" style={{ fontSize: 13 }}>
            {info.builds.length === 0 ? 'No phones registered for notifications.' : info.builds.map((b) => `${b.build == null ? 'before 4.5' : `version ${b.build}`}: ${b.devices}`).join(' · ')}
          </div>
          {!info.push && <div className="muted" style={{ fontSize: 13 }}>Push notifications are not set up on this server.</div>}
          <label className="grid" style={{ gap: 4, fontSize: 13 }}>New version code (the versionCode just released)
            <input type="number" min={2} value={build} onChange={(e) => setBuild(e.target.value)} style={{ maxWidth: 160 }} />
          </label>
          <label className="grid" style={{ gap: 4, fontSize: 13 }}>Message
            <textarea rows={2} maxLength={300} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <div className="row" style={{ gap: 10 }}>
            <button className="btn btn-primary btn-sm" disabled={busy || !info.push || !Number.isInteger(n) || n < 2 || !older || !body.trim()} onClick={send}>
              {busy ? 'Sending…' : `Notify ${older} phone${older === 1 ? '' : 's'} on older versions`}
            </button>
          </div>
        </>)}
      </div>
    </div>
  )
}
