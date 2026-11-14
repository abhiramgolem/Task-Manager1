import React, { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth'
import { api } from '../api'

// "Sign in with VoTask" on the HRMS. The HRMS sends the browser here with a
// nonce in ?state=; we ask our server for a one-minute token carrying that
// nonce and go straight back to the HRMS, which only accepts it in the browser
// holding the matching cookie. The token rides in the URL fragment, so it is
// never sent to any server or written to a log on the way.
//
// Signed out: the nonce waits in sessionStorage while the person signs in to
// VoTask, then useHrmsLoginResume brings them back here to finish.

const KEY = 'votask.hrmsLogin'
const MAX_AGE_MS = 4 * 60_000 // the HRMS's cookie lives 5 minutes
const STATE = /^[A-Za-z0-9_-]{22,128}$/

function savePending(state: string) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ state, at: Date.now() })) } catch { /* private mode: they start again */ }
}
function readPending(): string | null {
  try {
    const p = JSON.parse(sessionStorage.getItem(KEY) || 'null')
    if (p && STATE.test(p.state) && Date.now() - p.at < MAX_AGE_MS) return p.state
  } catch { /* nothing usable */ }
  return null
}
function clearPending() {
  try { sessionStorage.removeItem(KEY) } catch { /* nothing to clear */ }
}

/** After signing in to VoTask, finish a waiting HRMS sign-in. */
export function useHrmsLoginResume(signedIn: boolean) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  useEffect(() => {
    if (!signedIn || pathname === '/hrms-login') return
    const state = readPending()
    if (state) navigate(`/hrms-login?state=${encodeURIComponent(state)}`, { replace: true })
  }, [signedIn, pathname, navigate])
}

export default function HrmsLogin() {
  const { user, loading } = useAuth()
  const [params] = useSearchParams()
  const state = params.get('state') || ''
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)

  useEffect(() => {
    if (!loading && !user && STATE.test(state)) savePending(state)
  }, [loading, user, state])

  useEffect(() => {
    if (loading || !user || started.current) return
    started.current = true
    clearPending()
    if (!STATE.test(state)) { setError('This sign-in link is incomplete. Start again from the HRMS sign-in page.'); return }
    api.post('/attendance/login-token', { state })
      .then((d: { hrmsUrl: string; token: string }) => {
        window.location.replace(`${d.hrmsUrl}/login/votask#token=${encodeURIComponent(d.token)}`)
      })
      .catch((e: any) => setError(e?.message || 'Could not reach VoTask. Check your connection and try again.'))
  }, [loading, user, state])

  if (loading) return <Shell><span className="spinner" /></Shell>
  if (!user) return <Navigate to="/login" replace />
  return (
    <Shell>
      {error ? (
        <>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Couldn’t sign you in to HRMS</div>
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: 13.5, lineHeight: 1.5 }}>{error}</p>
          <Link className="btn btn-primary" to="/">Back to VoTask</Link>
        </>
      ) : (
        <>
          <span className="spinner" />
          <div style={{ fontWeight: 700, fontSize: 15 }}>Signing you in to HRMS as {user.name}…</div>
        </>
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16, background: 'var(--bg)' }}>
      <div className="card" style={{ width: 380, maxWidth: '100%', padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
        {children}
      </div>
    </div>
  )
}
