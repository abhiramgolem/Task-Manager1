import React, { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api'

// Step two of signup ("/invite-team"): bring the team in. Every invite goes through the existing
// POST /invites, so each person still gets their own tokenised link — nothing
// here is a second, weaker path into the org.
//
// Skippable on purpose. Blocking the dashboard behind "invite someone" on a
// product you have not seen yet is how onboarding gets abandoned.
export default function InviteTeam() {
  const navigate = useNavigate()
  // Carried in the URL rather than router state, because Signup arrives here via
  // a full location replace. Absent if someone opens the URL directly, which is
  // fine — the heading just drops the workspace name.
  const company = useSearchParams()[0].get('company') || ''
  const onDone = () => navigate('/', { replace: true })
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('employee')
  const [sent, setSent] = useState<{ email: string; link: string; emailed: boolean }[]>([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    const addr = email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) { setErr('Please enter a valid email address.'); return }
    setBusy(true)
    try {
      const r = await api.post('/invites', { email: addr, role })
      setSent((s) => [{ email: addr, link: r.link, emailed: !!r.emailed }, ...s])
      setEmail('')
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="login-wrap login-wrap--panda">
      <div className="login-stage">
        <div className="login-card login-card--panda">
          <div className="brand" style={{ padding: 0, marginBottom: 14, marginTop: 20, justifyContent: 'space-between', width: '100%' }}>
            <div>
              <div className="brand-name" style={{ color: 'var(--text)' }}>Bring your team</div>
              <div className="muted" style={{ fontSize: 12 }}>{company ? `${company} is ready.` : 'Your workspace is ready.'} Invite the people you work with.</div>
            </div>
            <img src="/logo.png" alt="VoTask" className="brand-logo-img" />
          </div>

          <form onSubmit={add} className="inv-row">
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" inputMode="email"
              placeholder="teammate@company.com" autoFocus style={{ flex: 1 }} />
            <select value={role} onChange={(e) => setRole(e.target.value)} style={{ width: 116 }}>
              <option value="employee">Employee</option>
              <option value="manager">Manager</option>
            </select>
            <button className="btn btn-primary" disabled={busy}>{busy ? <span className="spinner" /> : 'Invite'}</button>
          </form>

          {err && <div className="login-err" role="alert">{err}</div>}

          {sent.length > 0 && (
            <div className="inv-sent">
              {sent.map((s) => (
                <div className="inv-sent-row" key={s.email}>
                  <span className="inv-tick">✓</span>
                  <span className="inv-mail">{s.email}</span>
                  {/* The invite is emailed; when that fails the copied link is the
                      only way it reaches them, so say which happened. */}
                  <span className="muted" style={{ fontSize: 12, flexShrink: 0 }}>{s.emailed ? 'Emailed' : 'Not emailed'}</span>
                  <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(s.link)}>Copy link</button>
                </div>
              ))}
            </div>
          )}

          <button className="btn btn-primary login-btn" style={{ marginTop: 18 }} onClick={onDone}>
            {sent.length ? 'Done — go to my workspace' : 'Skip for now'}
          </button>
          <div className="muted" style={{ fontSize: 12, marginTop: 10, textAlign: 'center' }}>
            You can invite people any time from Administration → Users.
          </div>
        </div>
      </div>
    </div>
  )
}
