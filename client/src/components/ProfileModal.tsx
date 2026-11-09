import React, { useEffect, useRef, useState } from 'react'
import { api, getToken, API_BASE, userAvatarUrl } from '../api'
import { useAuth } from '../auth'
import { Avatar, LANG_LABEL, Ic } from '../ui'
import { WALLPAPERS, getWallpaperId, applyWallpaper } from '../lib/wallpaper'
import { THEME_OPTIONS, ThemeChoice, getThemeChoice, applyTheme, resolveTheme } from '../lib/theme'
import { useEscape } from '../lib/useEscape'
import { confirmDialog, confirmLogout } from '../lib/confirm'
import { savedAccounts } from '../accounts'
import EmailCodeEntry from './EmailCodeEntry'
import { webPushState, enableWebPush, turnOffWebPush, type WebPushState } from '../lib/webPush'

// The profile hub, one concern per screen. It used to be a single column that
// ran photo -> name -> wallpaper -> password -> feedback in one scroll, so
// finding anything meant reading past everything else and nothing looked like it
// had a home. Each area is now its own panel behind a menu: on a phone the menu
// IS the screen and a section opens over it; on a wide window both sit side by
// side.

export type SectionId = 'personal' | 'language' | 'appearance' | 'security' | 'notifications' | 'feedback'

// Typed off Ic itself, so a name the icon set doesn't have fails the build
// rather than rendering an empty square nobody notices.
type IconName = React.ComponentProps<typeof Ic>['name']

// Exported so the sidebar's "More" list is the SAME list, in the same order, with
// the same labels — two hand-kept copies would drift the first time a section is
// added and only one of them noticed.
export const SECTIONS: { id: SectionId; label: string; icon: IconName; hint: string }[] = [
  { id: 'personal', label: 'Personal information', icon: 'user', hint: 'Photo, name, phone, email' },
  { id: 'language', label: 'Language', icon: 'chat', hint: 'The language VoTask speaks to you in' },
  { id: 'appearance', label: 'Appearance', icon: 'image', hint: 'App wallpaper' },
  { id: 'security', label: 'Security', icon: 'lock', hint: 'Password and signed-in devices' },
  { id: 'notifications', label: 'Notifications', icon: 'inbox', hint: 'Choose what reaches you' },
  { id: 'feedback', label: 'Feedback', icon: 'star', hint: 'Rate the app' },
]

const NOTIF_ROWS: { key: string; label: string; hint: string }[] = [
  { key: 'tasks', label: 'Tasks', hint: 'Assigned to you, or moved to someone else' },
  { key: 'approvals', label: 'Approvals', hint: 'Work submitted, completed, approved or reopened' },
  { key: 'comments', label: 'Comments', hint: 'Replies on tasks you are part of' },
  { key: 'chat', label: 'Chat', hint: 'Direct and group messages' },
  { key: 'deadlines', label: 'Deadlines', hint: 'Reminders as a due date approaches' },
]

type Session = { id: string; device: string; ip: string | null; created_at: string; last_seen_at: string; current: boolean }

// Bare timestamps read as UTC; without this every time is off by the viewer's offset.
const when = (raw?: string) => {
  if (!raw) return ''
  const s = /\dT|\dZ|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z'
  const ms = Date.parse(s); if (isNaN(ms)) return ''
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (sec < 60) return 'active now'
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function ProfileModal({ onClose, onFeedback, initialSection }: { onClose: () => void; onFeedback?: () => void; initialSection?: SectionId }) {
  const { user, refresh, logout, switchTo, addAccount } = useAuth()
  // Everyone signed in on this device except whoever is active right now.
  const others = savedAccounts().filter((a) => a.id !== user?.id)
  useEscape(onClose)

  // Opened from the sidebar's "More" list, the section is already chosen — land on
  // it rather than making the reader pick the same thing twice. Otherwise: a wide
  // window shows the menu and a panel together, so one has to be open to begin
  // with; a phone shows the menu alone until something is picked.
  const [section, setSection] = useState<SectionId | null>(() =>
    initialSection ??
    (typeof window !== 'undefined' && window.matchMedia('(min-width: 760px)').matches ? 'personal' : null))

  const fileInput = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(user?.name || '')
  const [phone, setPhone] = useState((user as any)?.phone || '')
  const [lang, setLang] = useState(user?.preferred_language || 'en')
  const [curPw, setCurPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [wallpaper, setWallpaper] = useState(getWallpaperId())
  const [theme, setTheme] = useState<ThemeChoice>(getThemeChoice())
  const [prefs, setPrefs] = useState<Record<string, boolean>>(() => {
    const p = (user as any)?.notif_prefs || {}
    return Object.fromEntries(NOTIF_ROWS.map((r) => [r.key, p[r.key] !== false]))
  })
  const [webPush, setWebPush] = useState<WebPushState>(() => webPushState())
  const [sessions, setSessions] = useState<Session[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  // Messages belong to the panel that raised them, so a wrong-password error can
  // never surface under Appearance.
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; section: SectionId } | null>(null)

  const flash = (kind: 'ok' | 'err', text: string, sec: SectionId) => {
    setMsg({ kind, text, section: sec }); setTimeout(() => setMsg(null), 3500)
  }

  const loadSessions = () => api.get('/auth/sessions').then(setSessions).catch(() => setSessions([]))
  useEffect(() => { if (section === 'security') loadSessions() }, [section])

  if (!user) return null

  const onPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) { flash('err', 'Please choose an image.', 'personal'); return }
    if (file.size > 5 * 1024 * 1024) { flash('err', 'Image too large (max 5 MB).', 'personal'); return }
    setBusy('photo')
    try {
      const form = new FormData(); form.append('file', file)
      const headers: Record<string, string> = {}; const t = getToken(); if (t) headers.authorization = `Bearer ${t}`
      const res = await fetch(`${API_BASE}/api/users/me/avatar`, { method: 'POST', headers, body: form })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Upload failed')
      await refresh()
      flash('ok', 'Profile photo updated.', 'personal')
    } catch (err: any) { flash('err', err.message || 'Could not update photo.', 'personal') }
    finally { setBusy(null) }
  }

  const savePersonal = async () => {
    if (!name.trim()) { flash('err', 'Name cannot be empty.', 'personal'); return }
    setBusy('personal')
    try {
      await api.patch('/users/me', { name: name.trim(), phone: phone.trim() })
      await refresh(); flash('ok', 'Details saved.', 'personal')
    } catch (err: any) { flash('err', err.message || 'Could not save.', 'personal') }
    finally { setBusy(null) }
  }

  const saveLanguage = async () => {
    setBusy('language')
    try {
      await api.patch('/users/me', { preferred_language: lang })
      await refresh(); flash('ok', 'Language saved.', 'language')
    } catch (err: any) { flash('err', err.message || 'Could not save.', 'language') }
    finally { setBusy(null) }
  }

  // Toggles save on the spot - a switch that needs a separate Save button reads
  // as already applied and silently isn't. On failure the switch goes back, so
  // it never shows a setting the server did not take.
  const toggleNotif = async (key: string) => {
    const before = prefs
    const next = { ...prefs, [key]: !prefs[key] }
    setPrefs(next)
    try { await api.patch('/users/me', { notif_prefs: next }); await refresh() }
    catch (err: any) { setPrefs(before); flash('err', err.message || 'Could not save.', 'notifications') }
  }

  const changePassword = async () => {
    if (newPw.length < 8) { flash('err', 'New password must be at least 8 characters.', 'security'); return }
    if (newPw !== confirmPw) { flash('err', 'New passwords do not match.', 'security'); return }
    setBusy('password')
    try {
      await api.patch('/users/me', { current_password: curPw, new_password: newPw })
      setCurPw(''); setNewPw(''); setConfirmPw('')
      flash('ok', 'Password changed.', 'security')
    } catch (err: any) { flash('err', err.message || 'Could not change password.', 'security') }
    finally { setBusy(null) }
  }

  // Signing out the device you are holding ends this session too, so it logs out
  // rather than leaving a dead token in place.
  const revokeSession = async (s: Session) => {
    const ok = await confirmDialog({
      title: s.current ? 'Sign out this device?' : 'Sign out that device?',
      message: s.current
        ? 'You are using this device — you will be signed out here and returned to the login screen.'
        : `${s.device || 'That device'} will be signed out immediately and will need the password to get back in.`,
      confirmText: 'Sign out', danger: true,
    })
    if (!ok) return
    setBusy('sessions')
    try {
      const r = await api.del(`/auth/sessions/${s.id}`)
      if (r?.was_current) { onClose(); logout(); return }
      await loadSessions(); flash('ok', 'Device signed out.', 'security')
    } catch (err: any) { flash('err', err.message || 'Could not sign that device out.', 'security') }
    finally { setBusy(null) }
  }

  const revokeOthers = async () => {
    const ok = await confirmDialog({
      title: 'Sign out everywhere else?',
      message: 'Every other phone, tablet and browser signed in to this account will be signed out. This device stays signed in.',
      confirmText: 'Sign out others', danger: true,
    })
    if (!ok) return
    setBusy('sessions')
    try {
      const r = await api.post('/auth/sessions/revoke-others', {})
      await loadSessions()
      flash('ok', r?.revoked ? `Signed out of ${r.revoked} other device${r.revoked === 1 ? '' : 's'}.` : 'No other devices were signed in.', 'security')
    } catch (err: any) { flash('err', err.message || 'Could not sign the others out.', 'security') }
    finally { setBusy(null) }
  }

  const pickWallpaper = (id: string) => { setWallpaper(id); applyWallpaper(id) }
  // Applies as you pick, like the wallpaper beside it — a theme you have to save
  // is a theme you cannot judge, since the whole point is what it looks like.
  const pickTheme = (id: ThemeChoice) => { setTheme(id); applyTheme(id) }

  const note = (id: SectionId) => msg && msg.section === id
    ? <div className={'profile-msg ' + msg.kind}>{msg.text}</div> : null

  const panel = () => {
    switch (section) {
      case 'personal': return (
        <>
          <div className="pf-id">
            <button className="avatar-edit-btn" onClick={() => fileInput.current?.click()} disabled={busy === 'photo'} title="Change profile photo">
              <Avatar name={user.name} color={user.avatar_color} size={72} src={user.avatar_file ? userAvatarUrl(user.id, user.avatar_file) : undefined} />
              <span className="avatar-edit-icon">{busy === 'photo' ? '…' : <Ic name="edit" size={11} />}</span>
            </button>
            <input ref={fileInput} type="file" accept="image/*" style={{ display: 'none' }} onChange={onPhoto} />
            <div className="pf-id-meta">
              <div className="pf-id-name">{user.name}</div>
              <span className="badge profile-role">{user.role}</span>
              <div className="muted pf-id-hint">Tap the photo to change it — JPG or PNG, up to 5 MB.</div>
            </div>
          </div>
          {note('personal')}
          <div><label htmlFor="pf-name">Full name</label><input id="pf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" /></div>
          <div><label htmlFor="pf-phone">Phone number</label><input id="pf-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. +91 98765 43210" /></div>
          <div>
            <label htmlFor="pf-email">Email address</label>
            <input id="pf-email" value={user.email} readOnly disabled />
            <div className="pf-email-state">
              {(user as any).email_verified
                ? <span className="pf-verified"><Ic name="check" size={13} /> Verified</span>
                : <>
                    <span className="pf-unverified">Not confirmed yet — enter the 6-digit code we emailed you.</span>
                    <EmailCodeEntry />
                  </>}
            </div>
            <div className="muted pf-hint">Your email is your sign-in, so it can't be changed here — ask an admin to move the account.</div>
          </div>
          <button className="btn btn-primary" onClick={savePersonal} disabled={busy === 'personal'}>
            {busy === 'personal' ? <span className="spinner" /> : 'Save changes'}
          </button>
        </>
      )

      case 'language': return (
        <>
          {note('language')}
          <div>
            <label htmlFor="pf-lang">Preferred language</label>
            <select id="pf-lang" value={lang} onChange={(e) => setLang(e.target.value)}>
              {Object.entries(LANG_LABEL).map(([k, v]) => <option key={k} value={k}>{v as string}</option>)}
            </select>
            <div className="muted pf-hint">Used for the assistant's replies and its spoken responses.</div>
          </div>
          <button className="btn btn-primary" onClick={saveLanguage} disabled={busy === 'language'}>
            {busy === 'language' ? <span className="spinner" /> : 'Save language'}
          </button>
        </>
      )

      case 'appearance': return (
        <>
          <div className="pf-sub">Theme</div>
          <div className="muted pf-hint" style={{ marginTop: -4 }}>
            {theme === 'system'
              ? `Following your device, which is currently ${resolveTheme('system')}.`
              : 'Applies on this device.'}
          </div>
          <div className="pf-themes" role="radiogroup" aria-label="Theme">
            {THEME_OPTIONS.map((t) => (
              <button
                key={t.id}
                role="radio"
                aria-checked={theme === t.id}
                className={'pf-theme' + (theme === t.id ? ' on' : '')}
                onClick={() => pickTheme(t.id)}
              >
                <span className={'pf-theme-swatch pf-theme-swatch--' + t.id} aria-hidden="true" />
                <span className="pf-theme-label">{t.label}</span>
                <span className="muted pf-theme-hint">{t.hint}</span>
              </button>
            ))}
          </div>

          <div className="pf-divide" />
          <div className="pf-sub">App wallpaper</div>
          <div className="muted pf-hint" style={{ marginTop: -4 }}>Applies as you pick, on this device.</div>
          <div className="wallpaper-grid">
            {WALLPAPERS.map((w) => (
              <button key={w.id} className={'wallpaper-swatch' + (wallpaper === w.id ? ' active' : '')}
                style={{ background: w.swatch }} onClick={() => pickWallpaper(w.id)} title={w.name} aria-label={w.name}>
                {wallpaper === w.id && <span className="wallpaper-check"><Ic name="check" size={13} /></span>}
              </button>
            ))}
          </div>
        </>
      )

      case 'security': return (
        <>
          {note('security')}
          <div className="pf-sub">Change password</div>
          <div><label htmlFor="pf-cur">Current password</label><input id="pf-cur" type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} autoComplete="current-password" /></div>
          <div><label htmlFor="pf-new">New password</label><input id="pf-new" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" placeholder="At least 8 characters" /></div>
          <div><label htmlFor="pf-conf">Confirm new password</label><input id="pf-conf" type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" /></div>
          <button className="btn" onClick={changePassword} disabled={busy === 'password' || !curPw || !newPw}>
            {busy === 'password' ? <span className="spinner" /> : 'Update password'}
          </button>

          <div className="pf-divide" />
          <div className="pf-sub">Where you're signed in</div>
          <div className="muted pf-hint" style={{ marginTop: -4 }}>Signing a device out takes effect immediately — it has to sign in again.</div>
          {sessions.length === 0
            ? <div className="muted pf-hint">No signed-in devices to show.</div>
            : <div className="pf-devices">
                {sessions.map((s) => (
                  <div key={s.id} className="pf-device">
                    <span className="pf-device-ic"><Ic name="box" size={15} /></span>
                    <div className="pf-device-meta">
                      <div className="pf-device-name">
                        {s.device || 'Unknown device'}
                        {s.current && <span className="pf-device-you">This device</span>}
                      </div>
                      <div className="muted pf-device-sub">{when(s.last_seen_at)}{s.ip ? ` · ${s.ip}` : ''}</div>
                    </div>
                    <button className="btn btn-sm" disabled={busy === 'sessions'} onClick={() => revokeSession(s)}>Sign out</button>
                  </div>
                ))}
              </div>}
          {sessions.filter((s) => !s.current).length > 0 && (
            <button className="btn btn-sm" disabled={busy === 'sessions'} onClick={revokeOthers}>Sign out everywhere else</button>
          )}

        </>
      )

      case 'notifications': return (
        <>
          {note('notifications')}
          <div className="muted pf-hint" style={{ marginTop: 0 }}>Turning a category off stops both the in-app alert and the push on your phone.</div>
          {webPush !== 'unsupported' && (
            <div className="pf-toggles">
              <label className="pf-toggle">
                <span className="pf-toggle-meta">
                  <span className="pf-toggle-label">Notifications in this browser</span>
                  <span className="muted pf-toggle-hint">{webPush === 'blocked'
                    ? 'Blocked by the browser. Allow notifications for this site from the icon left of the address, then switch this on.'
                    : 'Messages, mentions and tasks pop up on this computer, even with VoTask in another tab.'}</span>
                </span>
                <input type="checkbox" checked={webPush === 'on'} disabled={webPush === 'blocked'} onChange={async () => {
                  if (webPush === 'on') { await turnOffWebPush(); setWebPush(webPushState()) }
                  else {
                    const r = await enableWebPush()
                    setWebPush(webPushState())
                    if (r === 'error') flash('err', 'Could not turn browser notifications on.', 'notifications')
                  }
                }} />
                <span className="pf-switch" aria-hidden="true" />
              </label>
            </div>
          )}
          <div className="pf-toggles">
            {NOTIF_ROWS.map((r) => (
              <label key={r.key} className="pf-toggle">
                <span className="pf-toggle-meta">
                  <span className="pf-toggle-label">{r.label}</span>
                  <span className="muted pf-toggle-hint">{r.hint}</span>
                </span>
                <input type="checkbox" checked={!!prefs[r.key]} onChange={() => toggleNotif(r.key)} />
                <span className="pf-switch" aria-hidden="true" />
              </label>
            ))}
          </div>
        </>
      )

      case 'feedback': return (
        <>
          <div className="pf-sub">Rate this app</div>
          <p className="muted pf-hint" style={{ marginTop: -4 }}>
            Tell us how VoTask is working for you — a star rating, a question shaped to it, and anything you want to add.
          </p>
          <button className="btn btn-primary row" style={{ gap: 7 }} onClick={onFeedback}>
            <Ic name="star" size={15} /> Rate &amp; give feedback
          </button>
        </>
      )

      default: return null
    }
  }

  const active = SECTIONS.find((s) => s.id === section)

  return (
    <div className="modal-center" onClick={onClose}>
      <div className={'modal profile-modal pf-shell' + (section ? ' pf-open' : '')} onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread pf-head">
          {section && (
            <button className="btn btn-ghost pf-back" onClick={() => setSection(null)} aria-label="Back to settings">‹</button>
          )}
          <h3>{section ? active?.label : 'Settings'}</h3>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="pf-body">
          <nav className="pf-nav" aria-label="Profile settings">
            <div className="pf-nav-id">
              <Avatar name={user.name} color={user.avatar_color} size={40} src={user.avatar_file ? userAvatarUrl(user.id, user.avatar_file) : undefined} />
              <div style={{ minWidth: 0 }}>
                <div className="pf-nav-name">{user.name}</div>
                <div className="muted pf-nav-mail">{user.email}</div>
              </div>
            </div>
            {SECTIONS.map((s) => (
              <button key={s.id} className={'pf-nav-item' + (section === s.id ? ' active' : '')} onClick={() => setSection(s.id)}>
                <span className="pf-nav-ic"><Ic name={s.icon} size={17} /></span>
                <span className="pf-nav-text">
                  <span className="pf-nav-label">{s.label}</span>
                  <span className="muted pf-nav-hint">{s.hint}</span>
                </span>
                <span className="pf-nav-chev">›</span>
              </button>
            ))}
            {/* At the foot of the MENU rather than inside Security: signing out
                is not a security setting you go looking for, it is the thing you
                want one tap from opening the profile. On a phone the menu is the
                first screen, so it is visible immediately; on desktop the menu is
                always on screen, so it stays reachable from every section. */}
            {/* Accounts already signed in on this device. Shown above Log out
                because "I want to be someone else" is usually what is meant when
                someone reaches for logging out — offering the cheaper action first
                saves a password. */}
            {others.length > 0 && (
              <div className="pf-nav-accounts">
                <div className="pf-nav-accounts-label">Switch account</div>
                {others.map((a) => (
                  <button key={a.id} className="pf-nav-item" onClick={() => { onClose(); switchTo(a.id) }}>
                    <span className="pf-nav-ic">
                      <Avatar name={a.name} color={a.avatar_color} size={22}
                        src={a.avatar_file ? userAvatarUrl(a.id, a.avatar_file) : undefined} />
                    </span>
                    <span className="pf-nav-text">
                      <span className="pf-nav-label">{a.name}</span>
                      <span className="muted pf-nav-hint">{a.email}</span>
                    </span>
                    <span className="pf-nav-chev">›</span>
                  </button>
                ))}
              </div>
            )}
            <button className="pf-nav-item" onClick={() => { onClose(); addAccount() }}>
              <span className="pf-nav-ic"><Ic name="plus" size={17} /></span>
              <span className="pf-nav-text">
                <span className="pf-nav-label">Add another account</span>
                <span className="muted pf-nav-hint">Stay signed in here and sign in as someone else</span>
              </span>
              <span className="pf-nav-chev">›</span>
            </button>
            <button className="pf-nav-item pf-nav-logout" onClick={async () => { if (await confirmLogout(others[0]?.name)) { onClose(); logout() } }}>
              <span className="pf-nav-ic">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v9" />
                  <path d="M6.3 6.3a8 8 0 1 0 11.4 0" />
                </svg>
              </span>
              <span className="pf-nav-text"><span className="pf-nav-label">Log out</span></span>
            </button>
          </nav>

          <section className="pf-panel">
            <div className="pf-panel-title">{active?.label}</div>
            {panel()}
          </section>
        </div>
      </div>
    </div>
  )
}
