import React, { useEffect, useState } from 'react'
import { api, API_BASE } from '../api'
import { useAuth } from '../auth'
import { Stat, Badge } from '../ui'
import UserManagement from '../components/UserManagement'
import DepartmentsPanel from '../components/DepartmentsPanel'
import JoinLink from '../components/JoinLink'
import FeedbackReviews from '../components/FeedbackReviews'
import { toast } from '../lib/toast'
import { confirmDialog } from '../lib/confirm'
import { useSurface } from '../voice/uiRegistry'
import { flashPress, pause, findVaEl } from '../voice/uiController'

// Manage which email domains may join this organization. Empty = any domain.
// Who is allowed into this workspace.
//
// This was a bare list of domains with "leave empty to allow any" as the only
// hint — so the real question (is this workspace open or closed?) was implied by
// whether a box happened to be empty. Worse, signup used to seed the list with
// the founder's own email domain, so a workspace arrived locked to a domain
// nobody chose and the first invite failed with a message about a rule the
// manager never set. New workspaces now start on "Anyone"; ones created before
// that may still carry the seeded domain until an admin switches it here.
//
// It is now the either/or it always was, stated outright, with the domain list
// as detail of the closed option rather than the whole interface.
function AllowedDomains() {
  const { user } = useAuth()
  const [domains, setDomains] = useState<string[]>([])
  const [mode, setMode] = useState<'any' | 'restricted'>('any')
  const [input, setInput] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.get('/users/meta/org').then((d) => {
      const list = d.allowed_domains || []
      setDomains(list)
      setMode(list.length ? 'restricted' : 'any')
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [])

  const add = () => {
    const d = input.trim().toLowerCase().replace(/^@/, '')
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) { toast.error('Enter a valid domain, e.g. acme.com'); return }
    if (!domains.includes(d)) setDomains([...domains, d])
    setInput('')
  }

  // Switching to "restricted" with nothing listed would save an empty list and
  // silently mean the opposite, so seed it with the signed-in manager's own
  // domain — the one they almost certainly mean.
  const pick = (m: 'any' | 'restricted') => {
    setMode(m)
    if (m === 'restricted' && domains.length === 0) {
      const own = (user?.email || '').split('@')[1]
      if (own) setDomains([own.toLowerCase()])
    }
  }

  const save = async () => {
    if (mode === 'restricted' && domains.length === 0) {
      toast.error('Add at least one domain, or choose "Anyone".')
      return
    }
    setSaving(true)
    try {
      // "any" sends an empty list — that IS how the server stores no restriction.
      const r = await api.patch('/users/meta/org', { allowed_domains: mode === 'any' ? [] : domains })
      const list = r.allowed_domains || []
      setDomains(list)
      setMode(list.length ? 'restricted' : 'any')
      toast.success(list.length ? `Only ${list.join(', ')} can join.` : 'Anyone can be invited now.')
    } catch (e: any) { toast.error(e.message) } finally { setSaving(false) }
  }

  if (!loaded) return null

  return (
    <div className="card section">
      <div className="card-head"><h3>Who can join this workspace</h3></div>
      <div className="card-pad" style={{ display: 'grid', gap: 14 }}>
        <label className={'dom-opt' + (mode === 'any' ? ' on' : '')}>
          <input type="radio" name="domain-policy" checked={mode === 'any'} onChange={() => pick('any')} />
          <span>
            <b>Anyone you invite</b>
            <span className="dom-hint">Any email address can be invited or use the join link. Best when your team uses personal addresses.</span>
          </span>
        </label>

        <label className={'dom-opt' + (mode === 'restricted' ? ' on' : '')}>
          <input type="radio" name="domain-policy" checked={mode === 'restricted'} onChange={() => pick('restricted')} />
          <span>
            <b>Only our own email domains</b>
            <span className="dom-hint">Everyone else is refused, even with a valid invite or join code.</span>
          </span>
        </label>

        {mode === 'restricted' && (
          <div className="dom-detail">
            <div className="domain-chips">
              {domains.map((d) => (
                <span key={d} className="domain-chip">{d}<button onClick={() => setDomains(domains.filter((x) => x !== d))} aria-label={`Remove ${d}`}>✕</button></span>
              ))}
              {domains.length === 0 && <span className="muted" style={{ fontSize: 13 }}>Add at least one domain below.</span>}
            </div>
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <input placeholder="acme.com" value={input} onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} style={{ maxWidth: 240 }} />
              <button className="btn btn-sm" onClick={add}>+ Add domain</button>
            </div>
          </div>
        )}

        <div className="row">
          <button className="btn btn-primary btn-sm" onClick={save} disabled={saving} style={{ marginLeft: 'auto' }}>
            {saving ? <span className="spinner" /> : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

type AdminTab = 'overview' | 'users' | 'departments' | 'audit' | 'keys' | 'usage' | 'feedback'

export default function Admin() {
  // The feedback modal deep-links here with ?tab=feedback, so the initial tab
  // comes from the URL when it names a real one.
  const [tab, setTab] = useState<AdminTab>(() => {
    const want = new URLSearchParams(window.location.search).get('tab')
    return (['overview', 'users', 'departments', 'audit', 'keys', 'usage', 'feedback'] as const).includes(want as AdminTab)
      ? (want as AdminTab) : 'overview'
  })
  // The Usage tab appears only if the platform admin granted this org access.
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [usageAllowed, setUsageAllowed] = useState(false)
  useEffect(() => {
    api.get('/usage').then((d) => { setUsage(d); setUsageAllowed(true) }).catch(() => setUsageAllowed(false))
  }, [])

  // ---- Agent surface -------------------------------------------------------
  // Administration opens on Overview, but every voice request that lands here
  // ("add an employee", "remove someone") is about User Management. Landing the
  // user on the wrong tab and telling them to go and find the right one is the
  // kind of half-help this whole stage exists to remove.
  useSurface('admin', {
    openTab: async ({ tab: want }: { tab: AdminTab }) => {
      await flashPress(findVaEl(`admin.tab.${want}`))
      setTab(want)
      await pause(360)
    },
  })
  return (
    <>
      <div className="toolbar">
        <button className={'btn btn-sm' + (tab === 'overview' ? ' btn-primary' : '')} data-va="admin.tab.overview" onClick={() => setTab('overview')}>Overview</button>
        <button className={'btn btn-sm' + (tab === 'users' ? ' btn-primary' : '')} data-va="admin.tab.users" onClick={() => setTab('users')}>User Management</button>
        <button className={'btn btn-sm' + (tab === 'departments' ? ' btn-primary' : '')} data-va="admin.tab.departments" onClick={() => setTab('departments')}>Departments</button>
        <button className={'btn btn-sm' + (tab === 'audit' ? ' btn-primary' : '')} data-va="admin.tab.audit" onClick={() => setTab('audit')}>Audit Log</button>
        <button className={'btn btn-sm' + (tab === 'keys' ? ' btn-primary' : '')} data-va="admin.tab.keys" onClick={() => setTab('keys')}>API Keys</button>
        <button className={'btn btn-sm' + (tab === 'feedback' ? ' btn-primary' : '')} data-va="admin.tab.feedback" onClick={() => setTab('feedback')}>Feedback</button>
        {usageAllowed && <button className={'btn btn-sm' + (tab === 'usage' ? ' btn-primary' : '')} data-va="admin.tab.usage" onClick={() => setTab('usage')}>AI Usage</button>}
      </div>
      {tab === 'overview' && <Overview />}
      {tab === 'users' && <><AllowedDomains /><JoinLink /><UserManagement /></>}
      {tab === 'departments' && <DepartmentsPanel />}
      {tab === 'audit' && <Audit />}
      {tab === 'keys' && <ApiKeys />}
      {tab === 'feedback' && <Feedback />}
      {tab === 'usage' && usageAllowed && <UsagePanel data={usage} />}
    </>
  )
}

const fmtUsd = (n: number) => '$' + (n || 0).toLocaleString(undefined, { minimumFractionDigits: n < 1 ? 4 : 2, maximumFractionDigits: n < 1 ? 4 : 2 })
const fmtNum = (n: number) => (n || 0) >= 1000 ? (n / 1000).toFixed(n >= 1e6 ? 2 : 1).replace(/\.0$/, '') + (n >= 1e6 ? 'M' : 'k') : String(n || 0)

interface UsageRow { provider?: string; feature?: string; calls: number; tokens: number; cost: number }
interface UsageData {
  org_name: string
  total: { calls: number; tokens: number; cost: number }
  by_provider: UsageRow[]
  by_feature: UsageRow[]
}

// This organization's own AI/API usage. Only rendered when access has been granted.
function UsagePanel({ data }: { data: UsageData | null }) {
  if (!data) return <div className="card section"><div className="card-pad"><span className="spinner" /></div></div>
  return (
    <>
      <div className="grid grid-stats section">
        <Stat label="AI spend (est.)" value={fmtUsd(data.total.cost)} accent="#a855f7" />
        <Stat label="API calls" value={fmtNum(data.total.calls)} accent="#3b82f6" />
        <Stat label="Tokens" value={fmtNum(data.total.tokens)} accent="#10b981" />
      </div>
      <div className="grid grid-2 section" style={{ gap: 16 }}>
        <div className="card">
          <div className="card-head"><h3>By provider</h3></div>
          <div className="card-pad">
            {data.by_provider.length === 0 ? <span className="muted" style={{ fontSize: 13 }}>No usage yet.</span>
              : data.by_provider.map((r) => (
                <div key={r.provider} className="spread" style={{ padding: '5px 0' }}>
                  <span>{r.provider}</span><span className="muted">{fmtNum(r.calls)} calls · {fmtUsd(r.cost)}</span>
                </div>
              ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>By feature</h3></div>
          <div className="card-pad">
            {data.by_feature.length === 0 ? <span className="muted" style={{ fontSize: 13 }}>No usage yet.</span>
              : data.by_feature.map((r) => (
                <div key={r.feature} className="spread" style={{ padding: '5px 0' }}>
                  <span style={{ textTransform: 'capitalize' }}>{(r.feature || '').replace(/_/g, ' ')}</span>
                  <span className="muted">{fmtNum(r.calls)} calls · {fmtUsd(r.cost)}</span>
                </div>
              ))}
          </div>
        </div>
      </div>
      <div className="muted section" style={{ fontSize: 12 }}>Costs are estimates based on public list prices and are indicative, not an invoice.</div>
    </>
  )
}

function Overview() {
  const [d, setD] = useState<any>(null)
  useEffect(() => { api.get('/dashboards/admin').then(setD) }, [])
  if (!d) return <span className="spinner" />
  return (
    <>
      <div className="grid grid-stats section">
        <Stat label="Users" value={d.totals.users} />
        <Stat label="Tasks" value={d.totals.tasks} accent="#3b82f6" />
        <Stat label="Meetings" value={d.totals.meetings} accent="#f59e0b" />
        <Stat label="Projects" value={d.totals.projects} accent="#10b981" />
      </div>
      <div className="grid grid-2">
        <div className="card section">
          <div className="card-head"><h3>Users by role</h3></div>
          <div className="card-pad">
            {d.users_by_role.map((r: any) => (
              <div key={r.role} className="spread" style={{ padding: '6px 0' }}><span style={{ textTransform: 'capitalize' }}>{r.role}</span><strong>{r.c}</strong></div>
            ))}
          </div>
        </div>
        <div className="card section">
          <div className="card-head"><h3>Tasks by status</h3></div>
          <div className="card-pad">
            {d.tasks_by_status.map((r: any) => (
              <div key={r.status} className="spread" style={{ padding: '6px 0' }}><span>{r.status}</span><strong>{r.c}</strong></div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}


// App feedback for the whole org. The same view also sits under the corner
// Feedback tab (next to your own rating form) — here it gets a full page, which
// is what the submission trail actually needs to be readable.
function Feedback() {
  return (
    <div className="card section">
      <div className="card-head"><h3>App feedback</h3></div>
      <div className="card-pad fb-admin">
        <FeedbackReviews />
      </div>
    </div>
  )
}

// API keys — the credential something that is not a browser uses to reach the API.
//
// The plaintext exists in exactly one place for a few seconds: this component's
// state, right after creation. It is never fetched again, because the server only
// keeps a hash — so the copy box is not a convenience, it is the only chance.
function ApiKeys() {
  const [keys, setKeys] = useState<any[]>([])
  const [name, setName] = useState('')
  const [expiry, setExpiry] = useState('')
  const [scope, setScope] = useState<'full' | 'mcp'>('mcp')
  const [busy, setBusy] = useState(false)
  const [fresh, setFresh] = useState<string>('')   // shown once, never re-fetchable
  const [copied, setCopied] = useState(false)
  const [copiedUrl, setCopiedUrl] = useState(false)
  const [freshScope, setFreshScope] = useState<'full' | 'mcp'>('mcp')
  // In dev API_BASE is empty (Vite proxies), but a connector is reached from
  // Anthropic's cloud — so it must be an absolute, publicly resolvable origin.
  const connectorUrl = `${API_BASE || window.location.origin}/mcp/${fresh}`

  const load = () => api.get('/keys').then((d) => setKeys(d.keys)).catch((e) => toast.error(e.message))
  useEffect(() => { load() }, [])

  const create = async () => {
    if (!name.trim()) { toast.error('Give the key a name so you can recognise it later.'); return }
    setBusy(true)
    try {
      const days = Number(expiry)
      const r = await api.post('/keys', { name: name.trim(), scope, ...(days > 0 ? { expires_in_days: days } : {}) })
      setFresh(r.token); setFreshScope(scope); setCopied(false); setCopiedUrl(false); setName(''); setExpiry('')
      await load()
    } catch (e: any) { toast.error(e.message) } finally { setBusy(false) }
  }

  const revoke = async (k: any) => {
    if (!(await confirmDialog({
      title: 'Revoke this key?',
      message: `Anything using “${k.name}” stops working immediately. This cannot be undone — issue a new key instead.`,
      confirmText: 'Revoke', danger: true,
    }))) return
    try { await api.del(`/keys/${k.id}`); await load(); toast.success('Key revoked.') }
    catch (e: any) { toast.error(e.message) }
  }

  const copy = async () => {
    try { await navigator.clipboard.writeText(fresh); setCopied(true) }
    catch { toast.error('Copy failed — select the key and copy it by hand.') }
  }
  const copyUrl = async () => {
    try { await navigator.clipboard.writeText(connectorUrl); setCopiedUrl(true) }
    catch { toast.error('Copy failed — select the URL and copy it by hand.') }
  }

  return (
    <div className="card section">
      <div className="card-head"><h3>API keys</h3></div>
      <div className="card-pad" style={{ display: 'grid', gap: 14 }}>
        <div className="muted" style={{ fontSize: 12.5, maxWidth: 720 }}>
          A key lets a script, an agent or a CI job call this API without signing in. It acts as
          <strong> you</strong> — same organization, same role, same permissions — so give one only to a tool
          you would hand your own login to. Send it as <code>Authorization: Bearer &lt;key&gt;</code>.
          <br />
          To use VoTask from <strong>claude.ai or Claude Desktop</strong>, don't paste the key anywhere — the
          connector form has no field for one. Add the <em>connector URL</em> shown when you create a key,
          under Customize &rarr; Connectors &rarr; Add custom connector. Give that connector its own key and
          nothing else, because the key travels inside that URL.
        </div>

        {/* The one and only sighting of the plaintext. */}
        {fresh && (
          <div style={{ border: '1px solid var(--primary)', borderRadius: 'var(--r-lg)', padding: 12, display: 'grid', gap: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 12.5 }}>Copy this now — it cannot be shown again.</div>
            <code style={{ wordBreak: 'break-all', fontSize: 12.5, background: 'var(--n-50)', padding: '8px 10px', borderRadius: 8 }}>{fresh}</code>
            {freshScope === 'mcp' && (<>
              <div style={{ fontWeight: 700, fontSize: 12.5, marginTop: 4 }}>Connector URL — paste this into Claude</div>
              <code style={{ wordBreak: 'break-all', fontSize: 12.5, background: 'var(--n-50)', padding: '8px 10px', borderRadius: 8 }}>{connectorUrl}</code>
              <div className="muted" style={{ fontSize: 12 }}>
                Customize &rarr; Connectors &rarr; + &rarr; Add custom connector. This key works ONLY here — it is
                refused by the rest of the API, so the URL leaking does not hand over a general credential.
              </div>
            </>)}
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-primary btn-sm" onClick={copy}>{copied ? '✓ Copied' : 'Copy key'}</button>
              {freshScope === 'mcp' && <button className="btn btn-sm" onClick={copyUrl}>{copiedUrl ? '✓ Copied' : 'Copy connector URL'}</button>}
              <button className="btn btn-ghost btn-sm" onClick={() => setFresh('')}>I've saved it</button>
            </div>
          </div>
        )}

        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 240px' }}>
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude Code on my laptop"
              onKeyDown={(e) => { if (e.key === 'Enter') create() }} />
          </div>
          <div style={{ width: 210 }}>
            <label>Used for</label>
            <select value={scope} onChange={(e) => setScope(e.target.value as 'full' | 'mcp')}>
              <option value="mcp">Claude connector (claude.ai)</option>
              <option value="full">API access (scripts, Claude Code)</option>
            </select>
          </div>
          <div style={{ width: 150 }}>
            <label>Expires in</label>
            <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              <option value="">Never</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">1 year</option>
            </select>
          </div>
          <button className="btn btn-primary" disabled={busy} onClick={create}>{busy ? <span className="spinner" /> : 'Create key'}</button>
        </div>

        <table>
          <thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th></th></tr></thead>
          <tbody>
            {keys.map((k) => {
              const dead = !!k.revoked_at || (k.expires_at && k.expires_at <= new Date().toISOString())
              return (
                <tr key={k.id} style={dead ? { opacity: 0.55 } : undefined}>
                  <td style={{ fontWeight: 600 }}>{k.name}</td>
                  <td className="muted" style={{ fontSize: 12 }}><code>{k.prefix}…</code>{k.scope === 'mcp' && <><br /><span style={{ fontSize: 11 }}>Claude connector</span></>}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{new Date(k.created_at).toLocaleDateString()}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {k.revoked_at
                      ? <Badge color="#64748b" soft>Revoked</Badge>
                      : k.expires_at && k.expires_at <= new Date().toISOString()
                        ? <Badge color="#64748b" soft>Expired</Badge>
                        : <button className="btn btn-sm btn-danger" onClick={() => revoke(k)}>Revoke</button>}
                  </td>
                </tr>
              )
            })}
            {keys.length === 0 && <tr><td colSpan={5} className="empty">No API keys yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Audit() {
  const [logs, setLogs] = useState<any[]>([])
  useEffect(() => { api.get('/dashboards/admin').then((d) => setLogs(d.recent_audit)) }, [])
  return (
    <div className="card table-card-wrap">
      <div className="card-head"><h3>Recent activity (audit trail)</h3></div>
      <table className="table-cards">
        <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Detail</th></tr></thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id}>
              <td className="cell-title muted" style={{ whiteSpace: 'nowrap' }}>{new Date(l.created_at).toLocaleString()}</td>
              <td data-label="Actor">{l.actor_name || '—'}</td>
              <td data-label="Action"><Badge color="#ea580c" soft>{l.action}</Badge></td>
              <td className="muted" data-label="Entity">{l.entity_type}</td>
              <td className="muted audit-detail" data-label="Detail" style={{ fontSize: 12 }}>{l.detail}</td>
            </tr>
          ))}
          {logs.length === 0 && <tr><td colSpan={5} className="empty">No activity yet.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}
