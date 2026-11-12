import React, { useEffect, useRef, useState } from 'react'
import { Routes, Route, NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Capacitor } from '@capacitor/core'
import { useAuth } from './auth'
import { confirmLogout } from './lib/confirm'
import { savedAccounts, SavedAccount } from './accounts'
import { runBackHandlers } from './back'
import { setPushNavigator } from './push'
import { startShareTarget, onShare, hasShare } from './lib/shareTarget'
import { startUpdateCheck } from './lib/appUpdate'
import { useEscape } from './lib/useEscape'
import { webPushSupported, enableWebPush, needsHomeScreen } from './lib/webPush'
import { toast } from './lib/toast'
import { api, getToken, userAvatarUrl } from './api'
import { Avatar, Ic, todayKey, localDateKey } from './ui'
import NotificationBell from './components/NotificationBell'
import ProfileModal, { SECTIONS, SectionId } from './components/ProfileModal'
import FeedbackModal from './components/FeedbackModal'
import VoiceAssistant from './components/VoiceAssistant'
import ToastHost from './components/ToastHost'
import InAppChatAlert from './components/InAppChatAlert'
import ConfirmHost from './components/ConfirmHost'
import CallCenter from './components/CallCenter'
import QuickInvite from './components/QuickInvite'
import EmailCodeEntry from './components/EmailCodeEntry'
import Login from './pages/Login'
import Signup from './pages/Signup'
import AcceptInvite from './pages/AcceptInvite'
import ForgotPassword from './pages/ForgotPassword'
import ResetPassword from './pages/ResetPassword'
import VerifyEmail from './pages/VerifyEmail'
import Dashboard from './pages/Dashboard'
import Meetings from './pages/Meetings'
import MeetingDetail from './pages/MeetingDetail'
import Tasks from './pages/Tasks'
import Assistant from './pages/Assistant'
import Chats from './pages/Chats'
import Leaderboard from './pages/Leaderboard'
import Admin from './pages/Admin'
import Platform from './pages/Platform'
import PrivacyPolicy from './pages/PrivacyPolicy'
import Landing from './pages/Landing'
import JoinWorkspace from './pages/JoinWorkspace'
import InviteTeam from './pages/InviteTeam'

// Clean line-style sidebar icons (inherit currentColor, so they turn white when active).
const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
)
const ICONS = {
  dashboard: <Icon><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></Icon>,
  tasks: <Icon><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m8.5 12 2.5 2.5L16 9" /></Icon>,
  mytasks: <Icon><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="m15 11 2 2 4-4" /></Icon>,
  chats: <Icon><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" /></Icon>,
  meetings: <Icon><rect x="9" y="2" width="6" height="11" rx="3" /><path d="M5 10v1a7 7 0 0 0 14 0v-1" /><line x1="12" y1="19" x2="12" y2="22" /><line x1="8" y1="22" x2="16" y2="22" /></Icon>,
  assistant: <Icon><path d="M12 2.5 14 8l5.5 2-5.5 2-2 5.5L10 12 4.5 10 10 8z" /><path d="M19 14.5 19.8 17l2.5.8-2.5.8L19 21l-.8-2.4-2.5-.8 2.5-.8z" /></Icon>,
  admin: <Icon><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></Icon>,
  platform: <Icon><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18" /><path d="M12 3a14 14 0 0 0 0 18" /></Icon>,
  leaderboard: <Icon><path d="M8 21h8M12 17v4M7 4h10v4a5 5 0 0 1-10 0V4z" /><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 0-3 3" /></Icon>,
} as const

// The Manager is the Admin of the org: it owns the Administration hub
// (org metrics, full user management & audit log).
// `teamOnly` items are hidden in a personal (solo) workspace — there's no team
// to chat with or administer when it's just one person.
const NAV = [
  { to: '/my-tasks', label: 'My Tasks', icon: ICONS.mytasks, roles: ['manager'] },
  { to: '/', label: 'Dashboard', icon: ICONS.dashboard, roles: ['manager', 'employee'] },
  { to: '/tasks', label: 'Tasks', icon: ICONS.tasks, roles: ['manager', 'employee'] },
  { to: '/chats', label: 'Chats', icon: ICONS.chats, roles: ['manager', 'employee'], teamOnly: true },
  { to: '/leaderboard', label: 'Leaderboard', icon: ICONS.leaderboard, roles: ['manager', 'employee'], teamOnly: true },
  { to: '/meetings', label: 'Meetings', icon: ICONS.meetings, roles: ['manager'] },
  { to: '/assistant', label: 'AI Assistant', icon: ICONS.assistant, roles: ['manager'] },
  { to: '/admin', label: 'Administration', icon: ICONS.admin, roles: ['manager'], teamOnly: true },
  { to: '/platform', label: 'Platform', icon: ICONS.platform, roles: ['manager', 'employee'], platformOnly: true },
]

// The phone tab bar, by role: two tabs, the raised orange centre tab, one more
// tab, then More. Picked by path rather than sliced off NAV, because the bar has
// four slots and the sidebar's order answers a different question — on a phone a
// manager lives in their own and the team's tasks and runs meetings, and an
// employee checks where they stand. Everything else (Dashboard for managers, the
// voice assistant, Admin) is one tap away in the More drawer.
//
// A slot whose page this user can't see (Chats and Leaderboard in a solo
// workspace) is left out rather than backfilled, so the centre tab never shifts
// sideways into a different meaning.
const BOTTOM_TABS: Record<string, [string, string, string, string]> = {
  manager: ['/my-tasks', '/tasks', '/meetings', '/chats'],
  employee: ['/', '/tasks', '/leaderboard', '/chats'],
}

const TITLES: Record<string, { t: string; s: string }> = {
  '/my-tasks': { t: 'My Tasks', s: 'Your private personal tasks — visible only to you' },
  '/': { t: 'Dashboard', s: 'Your meeting-to-task command center' },
  '/tasks': { t: 'Tasks', s: 'Track the full task lifecycle' },
  '/chats': { t: 'Chats', s: 'Message your manager and teammates' },
  '/leaderboard': { t: 'Leaderboard', s: 'Performance scores across the team' },
  '/meetings': { t: 'Meetings', s: 'Upload conversations, get structured work' },
  '/assistant': { t: 'AI Assistant', s: 'Ask anything about your tasks' },
  '/admin': { t: 'Administration', s: 'Users, audit logs & org metrics' },
  '/platform': { t: 'Platform', s: 'Oversee every organization on the platform' },
}

// Coarse "time since last sync" for the sidebar health line. Kept vague on
// purpose — the poll runs every 10s, so "just now" covers the common case.
function syncAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 20) return 'just now'
  if (s < 90) return 'moments ago'
  const m = Math.floor(s / 60)
  return `${m}m ago`
}

function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout, switchTo, addAccount } = useAuth()
  // Everyone signed in on this device except whoever is active.
  const otherAccounts = savedAccounts().filter((a) => a.id !== user?.id)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  // Nothing to choose between on the first run — go straight to signing in.
  const openSwitcher = () => { if (otherAccounts.length === 0) addAccount(); else setSwitcherOpen(true) }
  const [showProfile, setShowProfile] = useState(false)
  // The sidebar's "More" list. `profileSection` is which settings screen a click
  // asked for, so the modal can open straight onto it instead of showing its own
  // menu again — the reader already chose.
  const [moreOpen, setMoreOpen] = useState(false)
  const [profileSection, setProfileSection] = useState<SectionId | undefined>(undefined)
  const openProfileAt = (id: SectionId) => { setProfileSection(id); setShowProfile(true); setOpen(false) }
  const [showFeedback, setShowFeedback] = useState(false)
  const [showInvite, setShowInvite] = useState(false)
  const loc = useLocation()
  const navigate = useNavigate()
  // "Chats" clicked while a chat is open on /chats: step Back to its list. A
  // link to the page you are on REPLACES the entry, which turned the open
  // chat's history entry into a second copy of the list — the next Back then
  // did nothing. (Chats.tsx records `pushed` when a list entry lies underneath.)
  const onChatsNav = (e: React.MouseEvent) => {
    const st = loc.state as { chat?: string; info?: boolean; pushed?: boolean } | null
    if (loc.pathname === '/chats' && st?.chat && st.pushed) { e.preventDefault(); navigate(st.info ? -2 : -1) }
  }
  // No explicit in-app back button: Android handles "back" via the hardware
  // button / swipe gesture (see useAndroidBackButton), and browsers have their own.
  const [open, setOpen] = useState(false)
  const [chatUnread, setChatUnread] = useState(0)
  // Workspace connection health, derived from the existing unread poll: the last
  // successful sync time, and whether we're currently reconnecting. An honest,
  // always-visible signal that the workspace is live (or that it isn't).
  const [lastSync, setLastSync] = useState<number | null>(null)
  const [online, setOnline] = useState(true)
  // Poll the unread chat count so the Chats nav item shows a live badge.
  React.useEffect(() => {
    const load = () => api.get('/chat/unread')
      .then((d) => { setChatUnread(d.unread); setLastSync(Date.now()); setOnline(true) })
      .catch(() => setOnline(false))
    load()
    // Not while the tab is hidden, like the notification bell: every open copy
    // of the app polls, and a background tab has no badge to show. Delivery
    // ticks don't depend on it — CallCenter's chat socket keeps this user
    // online, which marks their messages delivered as they arrive.
    const iv = setInterval(() => { if (!document.hidden) load() }, 10000)
    const onPing = () => load()
    const onVisible = () => { if (!document.hidden) load() }
    window.addEventListener('chat-unread-changed', onPing)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(iv)
      window.removeEventListener('chat-unread-changed', onPing)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  const base = '/' + (loc.pathname.split('/')[1] || '')
  const meta = TITLES[base] || TITLES['/']
  if (!user) return null
  // The nav items this user can see, filtered once and shared by the sidebar
  // (full list) and the mobile bottom bar (the first few, thumb-reachable).
  const visibleNav = NAV.filter((n) => (n as any).platformOnly
    ? !!user.platform_admin
    : n.roles.includes(user.role) && !(user.workspace_personal && (n as any).teamOnly))
  // Resolved against visibleNav, so a role or workspace that can't open a page
  // never gets a tab for it (see BOTTOM_TABS).
  const [tabL1, tabL2, tabMid, tabR1] = (BOTTOM_TABS[user.role] || BOTTOM_TABS.employee)
    .map((to) => visibleNav.find((n) => n.to === to))
  const openVoice = () => { setOpen(false); window.dispatchEvent(new Event('open-voice')) }
  // One bottom-nav tab (shared by the slots on either side of the centre tab).
  const renderBottomTab = (n: typeof NAV[number]) => (
    <NavLink key={n.to} to={n.to} end={n.to === '/'} onClick={n.to === '/chats' ? onChatsNav : undefined} className={({ isActive }) => 'bn-item' + (isActive ? ' active' : '')}>
      <span className="bn-ic">{n.icon}</span>
      <span className="bn-label">{n.label}</span>
      {n.to === '/chats' && chatUnread > 0 && <span className="bn-badge">{chatUnread > 9 ? '9+' : chatUnread}</span>}
    </NavLink>
  )
  return (
    <div className="app">
      <aside className={'sidebar' + (open ? ' open' : '')}>
        <div className="brand">
          <img src="/logo.png" alt="VoTask" className="brand-logo" />
          <div>
            <div className="brand-name">VoTask</div>
            <div className="brand-sub">Execution Platform</div>
          </div>
        </div>
        {/* The voice assistant's way in, on every screen size. First, above the
            pages, because it is the one thing in here that isn't a place you
            go — and it keeps the neon orb so it still reads as the thing that
            listens. Desktop used to have a floating Ask BTM card instead. */}
        <button className="sidebar-ai-m" onClick={openVoice} aria-label="Open voice assistant">
          <span className="sidebar-ai-orb" aria-hidden="true">
            <span className="sidebar-ai-glow" />
            <span className="sidebar-ai-core">
              {/* Both wave groups are identical markup — CSS mirrors the right one
                  so the tall bars sit inward on both sides. */}
              <span className="sidebar-ai-wave"><i /><i /><i /></span>
              <svg className="sidebar-ai-glyph" viewBox="0 0 24 24" width="14" height="14">
                <rect x="9" y="2" width="6" height="11.5" rx="3" fill="currentColor" />
                <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span className="sidebar-ai-wave"><i /><i /><i /></span>
            </span>
          </span>
          <span className="sidebar-ai-text">
            <span className="sidebar-ai-title">Talk to AI</span>
            <span className="sidebar-ai-sub">Create tasks by voice</span>
          </span>
        </button>
        <nav className="nav" onClick={() => setOpen(false)}>
          {visibleNav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} onClick={n.to === '/chats' ? onChatsNav : undefined} className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="nav-icon">{n.icon}</span>{n.label}
              {n.to === '/chats' && chatUnread > 0 && <span className="nav-badge">{chatUnread > 9 ? '9+' : chatUnread}</span>}
            </NavLink>
          ))}

          {/* Invite lives here, not in NAV: every NAV row is a route (a NavLink
              with a TITLES entry), and this opens a modal. Managers only — POST
              /invites refuses employees, and a button that always fails is worse
              than no button. */}
          {user.role !== 'employee' && !user.workspace_personal && (
            <button
              type="button"
              className="nav-invite"
              onClick={(e) => { e.stopPropagation(); setOpen(false); setShowInvite(true) }}
              title="Invite someone to this workspace"
            >
              <span className="nav-icon">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M19 8v6M22 11h-6" />
                </svg>
              </span>Invite people
            </button>
          )}

          {/* Settings live under the nav rather than only behind the avatar: the
              rail had the room, and "where do I change my password" is a question
              the menu should answer without a hunt. Collapsed by default so the
              four places you actually navigate to stay the top of the list.
              stopPropagation because <nav> closes the mobile drawer on any click —
              expanding a submenu is not navigating away. */}
          <button
            className={'nav-more' + (moreOpen ? ' open' : '')}
            aria-expanded={moreOpen}
            onClick={(e) => { e.stopPropagation(); setMoreOpen((o) => !o) }}
          >
            <span className="nav-icon"><Ic name="menu" size={17} /></span>More
            <span className="nav-more-chev" aria-hidden="true">{moreOpen ? '⌄' : '›'}</span>
          </button>
          {moreOpen && (
            <div className="nav-sub">
              {SECTIONS.map((s) => (
                <button key={s.id} className="nav-sub-item" onClick={() => openProfileAt(s.id)}>
                  <span className="nav-icon"><Ic name={s.icon} size={15} /></span>{s.label}
                </button>
              ))}
              <button className="nav-sub-item nav-sub-logout" onClick={async () => { if (await confirmLogout(otherAccounts[0]?.name)) logout() }}>
                <span className="nav-icon">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3v9" /><path d="M6.3 6.3a8 8 0 1 0 11.4 0" />
                  </svg>
                </span>Log out
              </button>
            </div>
          )}
        </nav>
        <div className="sidebar-user">
          <button className="avatar-edit-btn" title="Open profile & settings" onClick={() => setShowProfile(true)}>
            <Avatar name={user.name} color={user.avatar_color} size={36} src={user.avatar_file ? userAvatarUrl(user.id, user.avatar_file) : undefined} />
            <span className="avatar-edit-icon"><Ic name="edit" size={10} /></span>
          </button>
          <button className="meta sidebar-user-meta" onClick={() => setShowProfile(true)} title="Open profile & settings">
            <div className="n">{user.name}</div>
            <div className="r">{user.role}</div>
          </button>
          <button className="btn btn-ghost btn-sm logout-btn" onClick={async () => { if (await confirmLogout()) logout() }} title="Log out" aria-label="Log out">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v9" />
              <path d="M6.3 6.3a8 8 0 1 0 11.4 0" />
            </svg>
          </button>
        </div>
        {/* Phones only. The sidebar profile row above (and the power button in
            it) is hidden on mobile, so the drawer had no way to sign out at all
            — the only route was the top-bar avatar into Profile › Security. The
            drawer stays open behind the confirmation, which sits above it, so a
            cancel leaves you exactly where you were. */}
        {/* Sits directly above Log out, as its own top-level action rather than
            buried in More: it is the same kind of thing as logging out — about
            WHO is using the app, not about a setting.

            One entry, three behaviours, so the label is always honest:
              no other account  → straight to sign-in; there is nothing to switch to
              one or more       → a sheet to pick from, plus adding another
            The sheet rather than an instant switch on a single account is what
            keeps a third account reachable: with an automatic switch, tapping it
            on either account would only ever bounce between the two. */}
        <button className="sidebar-switch-m" onClick={openSwitcher}>
          <Ic name="swap" size={17} />
          Switch accounts
        </button>
        <button className="sidebar-logout-m" onClick={async () => { if (await confirmLogout(otherAccounts[0]?.name)) logout() }}>
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v9" />
            <path d="M6.3 6.3a8 8 0 1 0 11.4 0" />
          </svg>
          Log out
        </button>
        <div className="sidebar-foot">
          <div className={'sidebar-sync' + (online ? '' : ' offline')} title={online ? 'Your workspace is live' : 'Trying to reconnect…'}>
            <span className="sidebar-sync-dot" />
            {online
              ? <span>Synced{lastSync ? ` ${syncAgo(lastSync)}` : ''}</span>
              : <span>Reconnecting…</span>}
          </div>
          <div className="sidebar-legal-row">
            <button className="sidebar-legal sidebar-legal-btn" onClick={() => { setOpen(false); setShowFeedback(true) }}>Rate this app</button>
            <span className="sidebar-legal-sep">·</span>
            <NavLink to="/privacy" className="sidebar-legal" onClick={() => setOpen(false)}>Privacy</NavLink>
          </div>
        </div>
      </aside>
      {open && <div className="sidebar-backdrop" onClick={() => setOpen(false)} />}
      <div className="main">
        <header className="topbar">
          <button className="nav-toggle" onClick={() => setOpen((o) => !o)} aria-label="Open menu">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div>
            <h1>{meta.t}</h1>
            <div className="sub">{meta.s}</div>
          </div>
          <div className="row" style={{ marginLeft: 'auto', gap: 10 }}>
            <NotificationBell key={user.id} />
            <button className="topbar-avatar" onClick={() => setShowProfile(true)} title="Profile & settings" aria-label="Open profile & settings">
              <Avatar name={user.name} color={user.avatar_color} size={33} src={user.avatar_file ? userAvatarUrl(user.id, user.avatar_file) : undefined} />
              <span className="topbar-avatar-dot" />
            </button>
          </div>
        </header>
        <main className="content"><VerifyEmailBanner /><WebPushPrompt /><div>{children}</div></main>
      </div>
      {/* Mobile bottom tab bar: two tabs, the raised orange centre tab, one more
          tab, then "More" (opens the full drawer, where the voice assistant now
          lives). Which pages fill the slots is per role — see BOTTOM_TABS. */}
      <nav className="bottom-nav" aria-label="Primary">
        {tabL1 && renderBottomTab(tabL1)}
        {tabL2 && renderBottomTab(tabL2)}
        {tabMid && (
          <NavLink key={tabMid.to} to={tabMid.to} end={tabMid.to === '/'} className={({ isActive }) => 'bn-center' + (isActive ? ' active' : '')}>
            {/* The halo is its own element, first child, so it paints under the
                button by document order — no z-index that could escape the bar. */}
            <span className="bn-center-glow" aria-hidden="true" />
            <span className="bn-center-btn">{tabMid.icon}</span>
            <span className="bn-center-label">{tabMid.label}</span>
          </NavLink>
        )}
        {tabR1 && renderBottomTab(tabR1)}
        <button className="bn-item" onClick={() => setOpen(true)} aria-label="More menu">
          <span className="bn-ic">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </span>
          <span className="bn-label">More</span>
        </button>
      </nav>
      {/* The section is cleared on close, so opening from the avatar next time
          lands on the menu rather than wherever the sidebar last sent you. */}
      {switcherOpen && (
        <AccountSwitcher
          accounts={otherAccounts}
          onPick={(id) => switchTo(id)}
          onAdd={addAccount}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
      {showProfile && (
        <ProfileModal
          initialSection={profileSection}
          onClose={() => { setShowProfile(false); setProfileSection(undefined) }}
          onFeedback={() => { setShowProfile(false); setProfileSection(undefined); setShowFeedback(true) }}
        />
      )}
      {/* Feedback is asked for from the sidebar's "Rate this app" and from
          Profile, never by a button floating over the page: the corner tab that
          used to sit on every screen was taken out for good (7 Oct 2026). */}
      {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}
      {showInvite && <QuickInvite onClose={() => setShowInvite(false)} />}
      {/* Global hands-free voice assistant — available on every authenticated page. */}
      <VoiceAssistant />
      {/* Calls live here rather than in the Chats page: a ring has to reach you
          wherever you are, and an answered call has to survive walking over to
          Tasks while you talk. */}
      <CallCenter />
    </div>
  )
}

// Unverified-email nudge. A small floating popup (NOT a top bar that pushes the
// page down) that appears at most once per calendar day — once shown or dismissed,
// it stays hidden until the next day. It takes the code right here, so confirming
// doesn't mean hunting for the setting in Profile.
//
// It came back every single day with no way to stop it, a tall card covering
// the bottom of the phone screen — the chat box included. Now "Later" puts it
// away for three days and "Don't remind me" for good (Profile still has the
// code entry); it never shows inside an open chat (styles.css), and while it is
// up the voice tip waits (the `verify-pop-open` body class).
const VERIFY_SNOOZE = 'befach_verify_snooze_until'
const VERIFY_NEVER = 'befach_verify_never'
function VerifyEmailBanner() {
  const { user } = useAuth()
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (!user || user.email_verified) { setShow(false); return }
    const today = todayKey()
    try {
      if (localStorage.getItem(VERIFY_NEVER) === user.id) return
      if ((localStorage.getItem(VERIFY_SNOOZE) || '') > today) return
      if (localStorage.getItem('befach_verify_prompt') === today) return // already shown today
      localStorage.setItem('befach_verify_prompt', today)
    } catch { /* storage unavailable — still show it this load */ }
    setShow(true)
  }, [user])
  useEffect(() => {
    document.body.classList.toggle('verify-pop-open', show)
    return () => document.body.classList.remove('verify-pop-open')
  }, [show])
  const later = () => {
    const d = new Date(); d.setDate(d.getDate() + 3)
    try { localStorage.setItem(VERIFY_SNOOZE, localDateKey(d)) } catch { /* storage off */ }
    setShow(false)
  }
  const never = () => {
    try { if (user) localStorage.setItem(VERIFY_NEVER, user.id) } catch { /* storage off */ }
    setShow(false)
  }
  if (!show || !user || user.email_verified) return null
  return (
    <div className="verify-pop" role="status">
      <div className="verify-pop-head">
        <span className="verify-pop-ic"><Ic name="mail" size={18} /></span>
        <div className="verify-pop-body">
          <div className="verify-pop-title">Verify your email</div>
          <div className="verify-pop-sub">Enter the 6-digit code we emailed to {user.email}.</div>
        </div>
        <button className="verify-pop-x" onClick={() => setShow(false)} aria-label="Dismiss">✕</button>
      </div>
      <div className="verify-pop-actions">
        <EmailCodeEntry />
      </div>
      <div className="verify-pop-later">
        <button type="button" onClick={later}>Remind me later</button>
        <button type="button" onClick={never}>Don't remind me</button>
      </div>
    </div>
  )
}

// Browser notifications, offered once on the website: a new message or task
// then reaches this computer with VoTask's tab in the background, as WhatsApp
// Web does (lib/webPush.ts). The browser asks for permission only inside a
// click, so this is a button, not an automatic prompt. Shown only while the
// browser has not been asked, and never together with the email card, which
// uses the same corner: it waits until that one is closed. "Not now" puts it
// away for a week. Profile → Notifications has the switch.
const WEBPUSH_LATER = 'votask_webpush_later'
function WebPushPrompt() {
  const { user } = useAuth()
  const [show, setShow] = useState(false)
  // An iPhone in Safari cannot be asked yet: it shows how to add VoTask to
  // the Home Screen, where the same card then offers notifications.
  const [ios] = useState(() => needsHomeScreen())
  useEffect(() => {
    if (!user || (!ios && (!webPushSupported() || Notification.permission !== 'default'))) { setShow(false); return }
    let later = 0
    try { later = Number(localStorage.getItem(WEBPUSH_LATER) || 0) } catch {}
    if (later > Date.now()) return
    // After the page has drawn, not over it; and not while the email card is up.
    const t = setInterval(() => { if (!document.querySelector('.verify-pop:not(.wp-pop)')) { clearInterval(t); setShow(true) } }, 4000)
    return () => clearInterval(t)
  }, [user?.id])
  if (!show) return null
  if (ios) {
    const later = () => { try { localStorage.setItem(WEBPUSH_LATER, String(Date.now() + 14 * 86400000)) } catch {} setShow(false) }
    return (
      <div className="verify-pop wp-pop" role="dialog" aria-label="Get notifications on your iPhone">
        <div className="verify-pop-head">
          <span className="verify-pop-ic wp-ic"><Ic name="bell" size={18} /></span>
          <div className="verify-pop-body">
            <div className="verify-pop-title">Get notifications on your iPhone</div>
            <div className="verify-pop-sub">
              Add VoTask to your Home Screen: tap <b>Share</b> <span aria-hidden="true">(the square with an arrow)</span>, then <b>Add to Home Screen</b>.
              Open VoTask from its new icon and sign in once; it will offer notifications there.
            </div>
          </div>
          <button className="verify-pop-x" onClick={later} aria-label="Close">✕</button>
        </div>
        <div className="verify-pop-actions">
          <button className="btn btn-ghost btn-sm" onClick={later}>Got it</button>
        </div>
      </div>
    )
  }
  const notNow = () => { try { localStorage.setItem(WEBPUSH_LATER, String(Date.now() + 7 * 86400000)) } catch {} setShow(false) }
  const turnOn = async () => {
    setShow(false)
    const r = await enableWebPush()
    if (r === 'on') toast.success('Notifications are on for this browser')
    else if (r === 'blocked') toast.info('The browser blocked them. Allow notifications for this site from the icon left of the address, then turn them on in Profile → Notifications.', 8000)
    else if (r === 'error') toast.error('Could not turn notifications on. Try again from Profile → Notifications.')
    else notNow()
  }
  return (
    <div className="verify-pop wp-pop" role="dialog" aria-label="Turn on notifications">
      <div className="verify-pop-head">
        <span className="verify-pop-ic wp-ic"><Ic name="bell" size={18} /></span>
        <div className="verify-pop-body">
          <div className="verify-pop-title">Get notified on this computer</div>
          <div className="verify-pop-sub">New messages, mentions and tasks pop up even when VoTask is in another tab.</div>
        </div>
        <button className="verify-pop-x" onClick={notNow} aria-label="Not now">✕</button>
      </div>
      <div className="verify-pop-actions">
        <button className="btn btn-primary btn-sm" onClick={turnOn}>Turn on</button>
        <button className="btn btn-ghost btn-sm" onClick={notNow}>Not now</button>
      </div>
    </div>
  )
}

function Protected({ children, roles, platform }: { children: React.ReactNode; roles?: string[]; platform?: boolean }) {
  const { user, loading } = useAuth()
  if (loading) return <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}><span className="spinner" /></div>
  if (!user) return <Navigate to="/login" replace />
  if (platform && !user.platform_admin) return <Navigate to="/" replace />
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />
  return <Layout>{children}</Layout>
}

// Home renders the role-aware Dashboard: employees see their personal overview,
// the manager (admin) sees the org-wide command center. (Dashboard branches internally.)
function Home() {
  return <Dashboard />
}

const RouteSpinner = () => (
  <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }}><span className="spinner" /></div>
)

// "/" is two different pages depending on who is asking. Signed in, it's the
// dashboard. Signed OUT it is the public welcome page — not a bounce to the login
// form, because a first-time visitor arriving at the bare domain has no idea what
// VoTask is yet, and a password box doesn't tell them. Deep links into the app
// (/tasks, /chats, …) still go to /login via Protected: those visitors already
// know where they were headed.
//
// Both gates wait for `loading` rather than reading `user` alone, or a returning
// user with a stored token would see the marketing page flash before /auth/me
// resolves them into the app.
function HomeRoute() {
  const { user, loading } = useAuth()
  if (loading) return <RouteSpinner />
  if (!user) return <Landing />
  return <Protected><Home /></Protected>
}

// The step shown straight after creating a company workspace.
//
// Gated on the TOKEN rather than the resolved user, because two separate races
// otherwise bounce it to /login and from there to "/": a cold load starts with
// user=null while /auth/me is still in flight, and arriving from signup can
// render once with the new location before the new user has propagated. The
// token is written synchronously by signup() and login(), so it is true the
// instant either succeeds and needs no React state to have settled.
function InviteTeamRoute() {
  const { loading } = useAuth()
  if (loading) return <RouteSpinner />
  if (!getToken()) return <Navigate to="/login" replace />
  return <InviteTeam />
}

// The same page under its own stable URL, so the login/signup screens (and any
// link someone shares) have something to point back at.
function WelcomeRoute() {
  const { user, loading } = useAuth()
  if (loading) return <RouteSpinner />
  return user ? <Navigate to="/" replace /> : <Landing />
}

// Make the Android hardware back button step back through the app (close an open
// panel/modal, then go back a screen) instead of quitting the app outright.
function useAndroidBackButton() {
  const navigate = useNavigate()
  const loc = useLocation()
  const pathRef = useRef(loc.pathname)
  useEffect(() => { pathRef.current = loc.pathname }, [loc.pathname])
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let handle: { remove: () => void } | undefined
    import('@capacitor/app').then(({ App: CapApp }) => {
      CapApp.addListener('backButton', () => {
        if (runBackHandlers()) return        // a page closed a modal/panel
        if (pathRef.current !== '/') navigate(-1) // step back a screen
        else CapApp.exitApp()                // already home → leave the app
      }).then((h) => { handle = h })
    }).catch(() => {})
    return () => { handle?.remove() }
  }, [navigate])
}

// A tapped push notification opens its screen through the router (see push.ts).
function usePushNavigator() {
  const navigate = useNavigate()
  useEffect(() => {
    setPushNavigator((to, opts) => navigate(to, opts))
    return () => setPushNavigator(null)
  }, [navigate])
}

// Something shared to VoTask from another app goes to Chats, which asks which
// chat it is for (lib/shareTarget). Signed out, it waits for the sign-in.
function useShareTarget(signedIn: boolean) {
  const navigate = useNavigate()
  const location = useLocation()
  const pathRef = useRef(location.pathname)
  pathRef.current = location.pathname
  const signedInRef = useRef(signedIn)
  signedInRef.current = signedIn
  useEffect(() => {
    startShareTarget()
    return onShare(() => { if (signedInRef.current && pathRef.current !== '/chats') navigate('/chats') })
  }, [navigate])
  useEffect(() => { if (signedIn && hasShare() && pathRef.current !== '/chats') navigate('/chats') }, [signedIn])
}

export default function App() {
  const { user } = useAuth()
  useAndroidBackButton()
  usePushNavigator()
  useShareTarget(!!user)
  // Play has a newer build for this phone: offer it (lib/appUpdate).
  useEffect(() => { startUpdateCheck() }, [])
  return (
    <>
    <ToastHost />
    <InAppChatAlert />
    <ConfirmHost />
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/signup" element={user ? <Navigate to="/" replace /> : <Signup />} />
      <Route path="/accept-invite" element={user ? <Navigate to="/" replace /> : <AcceptInvite />} />
      <Route path="/forgot-password" element={user ? <Navigate to="/" replace /> : <ForgotPassword />} />
      <Route path="/reset-password" element={user ? <Navigate to="/" replace /> : <ResetPassword />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/privacy" element={<PrivacyPolicy />} />
      <Route path="/welcome" element={<WelcomeRoute />} />
      <Route path="/join" element={<JoinWorkspace />} />
      <Route path="/join/:code" element={<JoinWorkspace />} />
      {/* Signed IN, but outside Layout: the step right after signup should be a
          focused screen, not the app chrome with an empty dashboard behind it. */}
      <Route path="/invite-team" element={<InviteTeamRoute />} />
      <Route path="/" element={<HomeRoute />} />
      <Route path="/my-tasks" element={<Protected roles={['manager']}><Tasks personal /></Protected>} />
      <Route path="/tasks" element={<Protected><Tasks /></Protected>} />
      <Route path="/chats" element={<Protected><Chats /></Protected>} />
      <Route path="/leaderboard" element={<Protected><Leaderboard /></Protected>} />
      <Route path="/meetings" element={<Protected roles={['manager']}><Meetings /></Protected>} />
      <Route path="/meetings/:id" element={<Protected roles={['manager']}><MeetingDetail /></Protected>} />
      <Route path="/assistant" element={<Protected roles={['manager']}><Assistant /></Protected>} />
      <Route path="/admin" element={<Protected roles={['manager']}><Admin /></Protected>} />
      <Route path="/platform" element={<Protected platform><Platform /></Protected>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  )
}

// The account chooser behind "Switch accounts".
//
// Deliberately a sheet even when there is only one other account, rather than an
// instant switch. An instant switch reads better for exactly two accounts and then
// traps you: tapping it from either side only ever bounces between the pair, and
// there is no way left to add a third. The sheet costs one tap and keeps the door
// open — with three accounts it lists three, with four, four.
function AccountSwitcher({ accounts, onPick, onAdd, onClose }: {
  accounts: SavedAccount[]
  onPick: (id: string) => void
  onAdd: () => void
  onClose: () => void
}) {
  useEscape(onClose)
  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal acct-switch" role="dialog" aria-modal="true" aria-label="Switch accounts"
        onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread">
          <h3 style={{ fontSize: 16 }}>Switch accounts</h3>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="card-pad" style={{ display: 'grid', gap: 6 }}>
          {accounts.map((a) => (
            <button key={a.id} className="acct-switch-row" onClick={() => onPick(a.id)}>
              <Avatar name={a.name} color={a.avatar_color} size={34}
                src={a.avatar_file ? userAvatarUrl(a.id, a.avatar_file) : undefined} />
              <span className="acct-switch-meta">
                <span className="acct-switch-name">{a.name}</span>
                <span className="muted acct-switch-mail">{a.email}</span>
              </span>
              <span className="acct-switch-chev">›</span>
            </button>
          ))}
          <button className="acct-switch-row acct-switch-add" onClick={onAdd}>
            <span className="acct-switch-plus"><Ic name="plus" size={17} /></span>
            <span className="acct-switch-meta">
              <span className="acct-switch-name">Add another account</span>
              <span className="muted acct-switch-mail">Stay signed in here and sign in as someone else</span>
            </span>
            <span className="acct-switch-chev">›</span>
          </button>
        </div>
      </div>
    </div>
  )
}
