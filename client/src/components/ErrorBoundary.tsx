import React from 'react'
import { API_BASE } from '../api'

// The last line of defence for the whole app. Without it, one component that
// throws while rendering unmounts everything React drew, and the person is left
// looking at a blank white screen — in the Android app, with no address bar to
// reload from. Instead they get a short explanation and a Reload button, and the
// error is sent to the server log (POST /api/client-error) so it can be fixed.
//
// A failed chunk load is special: after a deploy, a tab still running the old
// build asks for code files that no longer exist. Reloading once fetches the new
// build and is all that is needed, so that case reloads by itself.

const RELOADED_KEY = 'votask_chunk_reload'

function report(error: unknown, info?: string) {
  try {
    const e = error as any
    fetch(`${API_BASE}/api/client-error`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: String(e?.message || e).slice(0, 500),
        stack: String(e?.stack || '').slice(0, 2000),
        component: (info || '').slice(0, 1500),
        url: location.pathname,
        version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '',
      }),
      keepalive: true,
    }).catch(() => {})
  } catch { /* reporting must never throw */ }
}

const isChunkError = (e: any) => /Loading chunk|dynamically imported module|Failed to fetch dynamically|Importing a module script failed/i.test(String(e?.message || e))

export default class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: unknown }> {
  state = { error: null as unknown }

  static getDerivedStateFromError(error: unknown) { return { error } }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    if (isChunkError(error)) {
      // Once per session, so a chunk that is genuinely broken can't loop.
      try {
        if (!sessionStorage.getItem(RELOADED_KEY)) { sessionStorage.setItem(RELOADED_KEY, '1'); location.reload(); return }
      } catch { /* storage off: fall through to the screen */ }
    }
    report(error, info?.componentStack || '')
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="eb-wrap" role="alert">
        <div className="eb-card">
          <div className="eb-title">Something went wrong on this screen</div>
          <p className="eb-text">Your messages and tasks are safe. Reloading usually fixes it.</p>
          <div className="eb-actions">
            <button className="btn btn-primary" onClick={() => location.reload()}>Reload</button>
            <button className="btn btn-ghost" onClick={() => { location.href = '/' }}>Go to home</button>
          </div>
        </div>
      </div>
    )
  }
}

// Errors outside React's render (an event handler, a promise nobody caught) are
// reported too; they don't blank the screen, but they are bugs all the same.
export function installGlobalErrorReporting() {
  let sent = 0
  const once = (e: unknown) => { if (sent++ < 5) report(e, 'global') }
  window.addEventListener('error', (ev) => once(ev.error || ev.message))
  window.addEventListener('unhandledrejection', (ev) => {
    if (isChunkError(ev.reason)) {
      try {
        if (!sessionStorage.getItem(RELOADED_KEY)) { sessionStorage.setItem(RELOADED_KEY, '1'); location.reload(); return }
      } catch { /* storage off */ }
    }
    // A request that failed because the network did is not a bug.
    if ((ev.reason as any)?.offline) return
    once(ev.reason)
  })
}
