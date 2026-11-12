import React, { createContext, useContext, useEffect, useState } from 'react'
import { api, setToken, getToken, User, ApiError } from './api'
import { registerPush, unregisterPush } from './push'
import { rememberAccount, forgetAccount, accountToken, savedAccounts, syncAccount } from './accounts'

interface SignupInput { company: string; name: string; email: string; password: string; personal?: boolean }
interface AcceptInviteInput { token: string; name: string; password: string }
interface AuthCtx {
  user: User | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  loginWithGoogle: (credential: string) => Promise<void>
  signup: (input: SignupInput) => Promise<void>
  acceptInvite: (input: AcceptInviteInput) => Promise<void>
  logout: () => void
  refresh: () => Promise<void>
  /** Activate another account already signed in on this device. */
  switchTo: (userId: string) => void
  /** Keep the current session, but go to the sign-in screen to add another. */
  addAccount: () => void
}
const Ctx = createContext<AuthCtx>(null as any)
export const useAuth = () => useContext(Ctx)

// The signed-in user as last confirmed by the server, kept so the app can open
// while the server can't be reached (a deploy, a dead network) instead of
// throwing everyone back to the sign-in screen.
const ME_KEY = 'smarttask_me'
const cacheMe = (u: User) => { try { localStorage.setItem(ME_KEY, JSON.stringify(u)) } catch { /* storage off */ } }
// Only the cached user the current token belongs to — never another account's.
function cachedMe(): User | null {
  try {
    const u = JSON.parse(localStorage.getItem(ME_KEY) || 'null')
    const sub = JSON.parse(atob((getToken() || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub
    return u && u.id === sub ? u : null
  } catch { return null }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  // Opening the app checks the token. Only the server saying "not signed in"
  // (401) signs the person out. Every other failure — no network, the server
  // restarting after a deploy, a timeout — used to sign them out too, so a
  // one-minute deploy logged out everyone who opened the app during it, and they
  // all signed back in at once. Now the app opens as the cached user and keeps
  // asking in the background until the server answers.
  useEffect(() => {
    if (!getToken()) { setLoading(false); return }
    let live = true, delay = 2000
    const attempt = () => api.get('/auth/me')
      // syncAccount, not rememberAccount: the switcher should show the current
      // name and photo, but a token rejected below must not be re-saved.
      .then((d) => { if (!live) return; setUser(d.user); cacheMe(d.user); syncAccount(d.user); registerPush() })
      .catch((e) => {
        if (!live) return
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) { setToken(null); setUser(null); return }
        const cached = cachedMe()
        if (cached) setUser((u) => u || cached)
        setTimeout(() => { if (live) attempt() }, delay)
        delay = Math.min(delay * 2, 30_000)
      })
      .finally(() => { if (live) setLoading(false) })
    attempt()
    return () => { live = false }
  }, [])

  // Per-login UI flags. The voice coachmark used to be cleared here so it greeted
  // the user on every sign-in — which on a phone meant a popup over the tab bar
  // after every login, however many times they had pressed "Got it". Once
  // dismissed it now stays dismissed.
  const resetPerLoginUi = () => {}

  const login = async (email: string, password: string) => {
    const d = await api.post('/auth/login', { email, password })
    resetPerLoginUi()
    setToken(d.token)
    setUser(d.user)
    cacheMe(d.user)
    rememberAccount(d.user, d.token)
    registerPush() // ask for notification permission + register this device (native only)
  }
  // Exchange a Google ID token (from GIS on web or the native plugin) for our own
  // session. The backend is login-only, so this fails for unknown emails.
  const loginWithGoogle = async (credential: string) => {
    const d = await api.post('/auth/google', { credential })
    resetPerLoginUi()
    setToken(d.token)
    setUser(d.user)
    cacheMe(d.user)
    rememberAccount(d.user, d.token)
    registerPush()
  }
  // Create a new company + its first account, then log straight in.
  const signup = async (input: SignupInput) => {
    const d = await api.post('/auth/signup', input)
    resetPerLoginUi()
    setToken(d.token)
    setUser(d.user)
    cacheMe(d.user)
    rememberAccount(d.user, d.token)
    registerPush()
  }
  // Accept an emailed invite: creates the account in the inviting org, then logs in.
  const acceptInvite = async (input: AcceptInviteInput) => {
    const d = await api.post('/invites/accept', input)
    resetPerLoginUi()
    setToken(d.token)
    setUser(d.user)
    cacheMe(d.user)
    rememberAccount(d.user, d.token)
    registerPush()
  }
  // Sign out of the CURRENT account, and drop it from the device.
  //
  // Forgetting is the point: leaving the token in the switcher after "log out"
  // would mean signing out did not remove the credential, only hid it. If another
  // account is still signed in here, that one becomes active — with nobody signed
  // in there is no screen the switcher lives on, so the remaining tokens would be
  // stranded and the user would be typing a password they did not need to.
  const logout = () => {
    unregisterPush()
    if (user) forgetAccount(user.id)
    const next = savedAccounts()[0]
    if (next) { setToken(next.token); window.location.href = '/' ; return }
    setToken(null)
    setUser(null)
  }

  // Switching reloads rather than swapping state in place. Every page holds data
  // fetched as the previous user — task lists, unread counts, an open drawer — and
  // a reload is the only way to be sure none of it survives the change.
  const switchTo = (userId: string) => {
    const token = accountToken(userId)
    if (!token) return
    unregisterPush()
    setToken(token)
    window.location.href = '/'
  }

  // Keep every saved account, clear only the active token, and land on sign-in.
  // The account just left stays in the switcher, so this is reversible without a
  // password even if the new sign-in is abandoned.
  const addAccount = () => {
    unregisterPush()
    setToken(null)
    window.location.href = '/login'
  }
  const refresh = async () => { try { const d = await api.get('/auth/me'); setUser(d.user); cacheMe(d.user); syncAccount(d.user) } catch {} }

  return <Ctx.Provider value={{ user, loading, login, loginWithGoogle, signup, acceptInvite, logout, refresh, switchTo, addAccount }}>{children}</Ctx.Provider>
}
