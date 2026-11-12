// The chat info panel: WhatsApp's "Group info" / "Contact info", opened from
// the chat header. This file is the shell (the head's close / back button, the
// view stack, Escape, Android back and focus) and the info page itself: the
// hero, the media and meetings entry points, settings, members, groups in
// common and the danger zone. The views it pushes come from ChatMedia (media,
// links and docs) and ChatMeetings (calls and meeting summaries); lib/chatInfo
// holds the shapes and endpoints all three share.
import React, { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, API_BASE, getToken, userAvatarUrl, groupAvatarUrl } from '../api'
import { Avatar, Ic, fmtDateTime } from '../ui'
import { toast } from '../lib/toast'
import { confirmDialog, ConfirmOptions } from '../lib/confirm'
import {
  ChatConvLite, ChatInfo, CommonGroup, ContactInfo, InfoMember, InfoView, Me, MediaCounts, MediaKind, RecentMedia, Workload,
  MEDIA_TABS, canReview, chatFileUrl, chatInfoApi, fmtClock, fmtDay, lastSeenText, naturalCompare,
} from '../lib/chatInfo'
import { MediaView } from './ChatMedia'
import { MeetingsView, SummariesView, SummaryView } from './ChatMeetings'

type CallKind = 'audio' | 'video'

// The conversation as Chats holds it: lib/chatInfo's slice, plus its last
// message, which the shell watches so that what the info page counts follows
// what arrives while it is open.
type PanelConv = ChatConvLite & { last_at?: string | null; last_message?: string | null }

interface PanelProps {
  conv: PanelConv
  me: Me
  online: Set<string>
  lastSeen: Record<string, string>
  // Where to open. A new object here while the panel is up (a meeting card
  // tapped in the thread) starts the stack over at [info, start].
  start: InfoView
  // One step back inside the panel — the newest inline editor on the info
  // page, else the view on top — and true when it took one; false on the info
  // page with nothing open, where Back is Chats' to take (it closes the panel
  // through history). Chats calls it for Android's back button and for the
  // browser's Back.
  backRef: React.MutableRefObject<(() => boolean) | null>
  onClose: () => void
  onChanged: () => void
  onLeft: () => void
  onOpenConversation: (convId: string) => void
  onMessageUser: (userId: string) => void
  onShowMessage: (messageId: string) => void
  onCall: (kind: CallKind) => void
  onSearch: () => void
  onMute: () => void
  onClearChat: () => void
  // A direct chat leaves the list (WhatsApp's Delete chat); Chats confirms.
  onDeleteChat: () => void
  onExport: () => void
  // Chats owns the description editor, as it does the mute picker.
  onEditDescription: () => void
  // The Tasks page filtered to one person (managers only; its route is theirs).
  onViewTasks: (userId: string) => void
  // A review in a meeting summary changed that meeting's tasks: its id and how
  // many of its suggestions still wait, so Chats can bring the meeting's card
  // in the thread up to date.
  onMeetingChanged?: (meetingId: string, pending: number) => void
}

// A row of GET /chat/users: someone who could be added to the group.
interface OrgUser { id: string; name: string; email: string; role: string; avatar_color?: string; avatar_file?: string | null }

// One level of the view stack. The id keys that level's DOM: a view replaced by
// another remounts, while the info page (always id 0) never does. A media view
// opened from a thumbnail carries that item, for MediaView to show in its
// viewer; one opened with no tab carries the info request whose counts choose
// its tab (see mediaWait).
interface Entry { id: number; view: InfoView; openId?: string; after?: number }

// ------------------------------------------------------------------ helpers

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`
const cap = (s?: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '')
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name

// Most timestamps arrive as ISO, but some columns still hold SQLite's
// 'YYYY-MM-DD HH:MM:SS': UTC with no zone, which Date would read as local time
// and so place hours off for everyone outside UTC.
const toIso = (s?: string | null) => (s && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s || '')
const msOf = (s?: string | null) => { const t = new Date(toIso(s)).getTime(); return isNaN(t) ? null : t }
// fmtDay mid-sentence: 'today' / 'yesterday' / '29 Sep 2026'.
const dayWord = (iso: string) => { const d = fmtDay(iso); return d === 'Today' || d === 'Yesterday' ? d.toLowerCase() : d }
const untilText = (iso: string) => `${dayWord(iso)} at ${fmtClock(iso)}`

// "Until I turn it back on" is stored as a timer a year out (MuteModal's 525600
// minutes) and the longest timed choice is a week, so anything more than a
// month away can only be the open-ended one. Printing next year's date for it
// would read as if someone had picked that date.
const OPEN_ENDED_MS = 31 * 86400000
function muteText(conv: ChatConvLite) {
  if (!conv.muted) return 'Off'
  const until = msOf(conv.muted_until)
  if (until == null || until - Date.now() > OPEN_ENDED_MS) return 'Muted'
  return `Muted until ${untilText(toIso(conv.muted_until))}`
}

// Where "Media, links and docs" opens: the first tab with something in it, so a
// chat that only ever shared links does not land on an empty image grid.
const firstFilledTab = (c?: MediaCounts | null): MediaKind => (c && MEDIA_TABS.find((t) => (c[t.key] || 0) > 0)?.key) || 'images'
const MEDIA_WORDS: Record<MediaKind, [string, string]> = {
  images: ['image', 'images'], videos: ['video', 'videos'], audio: ['audio', 'audio'], files: ['file', 'files'], links: ['link', 'links'],
}
const mediaSummary = (c: MediaCounts) => MEDIA_TABS.filter((t) => (c[t.key] || 0) > 0).map((t) => plural(c[t.key], ...MEDIA_WORDS[t.key])).join(' · ')

// Changes whenever a message arrives, is edited or deleted, or the chat is
// cleared: every way the info page's counts can move under it.
const lastOf = (c: PanelConv) => `${c.last_at || ''}|${c.last_message || ''}`
// After new messages the info page refetches once they pause for a moment,
// and at least this often while a busy chat keeps them coming.
const FOLLOW_QUIET_MS = 1500
const FOLLOW_MAX_MS = 6000

// Where the floating voice pill rests while a thread is open, measured from
// the viewport's bottom-right corner (styles.css: .va-dock right 20px, bottom
// 98px, 62px tall and up to about 232px wide). Moved aside, it keeps the same
// 20px from the panel's edge.
const FAB_CORNER = { right: 20, width: 232, top: 98 + 62, bottom: 98 }
const FAB_GAP = 20

const VIEW_TITLES = { media: 'Media, links and docs', meetings: 'Meetings', summaries: 'Meeting summaries', summary: 'Meeting summary' }
const titleFor = (v: InfoView, type: ChatConvLite['type']) => (v.view === 'info' ? (type === 'group' ? 'Group info' : 'Contact info') : VIEW_TITLES[v.view])

// Layers that sit above the panel and close on Escape themselves. While one is
// up the key is theirs. ConfirmHost and the emoji picker listen on document in
// the bubble phase as well, so preventDefault alone cannot be relied on.
// .mv-overlay is the thread's own photo viewer and .overlay the task drawer,
// both reachable beside a docked panel.
const ESC_OWNERS = '.confirm-center, .modal-center, .modal-overlay, .ci-lb, .mv-overlay, .overlay, .emoji-pop, .notif-panel, .va-panel'
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

// ConfirmHost does not hand focus back when it closes, so a keyboard user who
// cancels would land on <body> and have to Tab in again from the top.
async function confirmHere(opts: ConfirmOptions) {
  const from = document.activeElement
  const ok = await confirmDialog(opts)
  if (from instanceof HTMLElement && from.isConnected) from.focus({ preventScroll: true })
  return ok
}

// Something opened near the bottom edge (a member's actions, the add picker)
// would otherwise sit out of view.
const reveal = (el: HTMLElement | null) => { el?.scrollIntoView({ block: 'nearest' }) }

// Inline things on the info page (the rename field, member search, the add
// picker, a member's actions) register here, so Escape and Android back close
// the newest of them before leaving the page, the way back dismisses a search
// before it leaves the screen.
const Dismiss = createContext<(fn: () => void) => () => void>(() => () => {})
function useDismiss(open: boolean, close: () => void) {
  const register = useContext(Dismiss)
  const closeRef = useRef(close)
  useEffect(() => { closeRef.current = close })
  useEffect(() => (open ? register(() => closeRef.current()) : undefined), [open, register])
}

// -------------------------------------------------------------------- panel

export default function ChatInfoPanel(props: PanelProps): JSX.Element {
  const { conv, me, start, backRef } = props
  const rootRef = useRef<HTMLElement>(null)
  const headRef = useRef<HTMLButtonElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  // Read during the first render, before anything in the panel can take focus:
  // this is what gets focus back when the panel closes.
  const openerRef = useRef(document.activeElement)

  // ---- data: GET /info. Refetched after the panel's own changes, whenever a
  // conversation field it shows changes underneath it, and as messages arrive.
  const [info, setInfo] = useState<ChatInfo | null>(null)
  const [infoErr, setInfoErr] = useState('')
  // The newest request that has finished, either way. A media view opened with
  // no tab waits for a request by its number.
  const [doneN, setDoneN] = useState(0)
  const reqRef = useRef(0)
  const aliveRef = useRef(true)
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false } }, [])
  // The conversation's last message now, when the newest request went out, and
  // when the info on screen was requested. The counts on screen include every
  // message so far only while the last two match the first.
  const last = lastOf(conv)
  const lastRef = useRef(last)
  useLayoutEffect(() => { lastRef.current = last }, [last])
  const askedRef = useRef('')
  const landedRef = useRef('')
  const followRef = useRef({ timer: 0, since: 0 })
  const loadInfo = useCallback(() => {
    // Whatever this request returns counts what a pending follow-up waited for.
    window.clearTimeout(followRef.current.timer)
    followRef.current = { timer: 0, since: 0 }
    // Only the newest request may land, so a slow first load cannot overwrite
    // the refresh that followed a rename.
    const n = ++reqRef.current
    const asked = lastRef.current
    askedRef.current = asked
    chatInfoApi.info(conv.id).then(
      (d) => { if (aliveRef.current && n === reqRef.current) { landedRef.current = asked; setInfo(d); setInfoErr(''); setDoneN(n) } },
      (e) => { if (aliveRef.current && n === reqRef.current) { setInfoErr(e?.message || 'Request failed'); setDoneN(n) } },
    )
  }, [conv.id])
  useEffect(() => { loadInfo() }, [loadInfo, conv.name, conv.avatar_file, conv.member_count, conv.visibility, conv.muted, conv.role])
  // A link, a photo or a call posted while the panel is open changes the counts
  // and the strip here. Chats reloads the conversation on every message, so its
  // last message is the signal: refetch once the chat pauses for a moment.
  const followedRef = useRef(last)
  useEffect(() => {
    if (last === followedRef.current) return
    followedRef.current = last
    const f = followRef.current
    const now = Date.now()
    if (!f.since) f.since = now
    window.clearTimeout(f.timer)
    f.timer = window.setTimeout(loadInfo, Math.min(FOLLOW_QUIET_MS, Math.max(0, f.since + FOLLOW_MAX_MS - now)))
  }, [last, loadInfo])
  useEffect(() => () => window.clearTimeout(followRef.current.timer), [])
  const retry = useCallback(() => { setInfoErr(''); loadInfo() }, [loadInfo])
  const onChangedRef = useRef(props.onChanged)
  useEffect(() => { onChangedRef.current = props.onChanged }, [props.onChanged])
  // After a change the panel made: Chats reloads its list (the header's name,
  // photo and member count) and the panel refetches what it shows.
  const changed = useCallback(() => { onChangedRef.current(); loadInfo() }, [loadInfo])
  const patchInfo = useCallback((fn: (i: ChatInfo) => ChatInfo) => setInfo((i) => (i ? fn(i) : i)), [])
  const onMeetingChangedRef = useRef(props.onMeetingChanged)
  useEffect(() => { onMeetingChangedRef.current = props.onMeetingChanged }, [props.onMeetingChanged])
  // A review in a summary: the review counts here follow, and so does that
  // meeting's card in the thread, which Chats draws.
  const meetingChanged = useCallback((meetingId: string, pending: number) => {
    loadInfo()
    onMeetingChangedRef.current?.(meetingId, pending)
  }, [loadInfo])
  // A media view opened with no tab lands on the first tab with something in
  // it, so it needs counts that include every message posted before it opened.
  // 0 when the counts on screen already do; else the number of the request to
  // wait for: the one in flight if it went out after the newest message, else
  // the next one.
  const mediaWait = () => {
    if (info && landedRef.current === lastRef.current) return 0
    return askedRef.current === lastRef.current ? reqRef.current : reqRef.current + 1
  }

  // ---- the view stack
  const idRef = useRef(1)
  const build = (s: InfoView): Entry[] => (s.view === 'info'
    ? [{ id: 0, view: s }]
    : [{ id: 0, view: { view: 'info' } }, { id: idRef.current++, view: s, ...(s.view === 'media' && !s.tab ? { after: mediaWait() } : {}) }])
  const [stack, setStack] = useState<Entry[]>(() => build(start))
  const [startSeen, setStartSeen] = useState(start)
  if (start !== startSeen) {
    // Adjusted during render, React's pattern for state that follows a prop, so
    // the old view never paints for a frame before the new one.
    setStartSeen(start)
    setStack(build(start))
  }
  const stackRef = useRef(stack)
  useEffect(() => { stackRef.current = stack }, [stack])
  // Also written at once, so a second Escape in quick succession sees the
  // result of the first.
  const commit = useCallback((next: Entry[]) => { stackRef.current = next; setStack(next) }, [])
  const top = stack[stack.length - 1]

  // Scroll position and focus of every view something was pushed over. Views
  // underneath stay mounted, only hidden, so Back lands exactly where you left:
  // same tab, same loaded pages, same row focused.
  const savedRef = useRef(new Map<number, { scroll: number; focus: Element | null }>())
  const push = useCallback((view: InfoView, extra?: Pick<Entry, 'openId' | 'after'>) => {
    const s = stackRef.current
    savedRef.current.set(s[s.length - 1].id, { scroll: bodyRef.current?.scrollTop || 0, focus: document.activeElement })
    commit([...s, { id: idRef.current++, view, ...extra }])
  }, [commit])
  // "Media, links and docs" opens on the first tab with something in it, from
  // counts that include the newest messages; a thumbnail opens its own tab with
  // that item in the viewer.
  const openMedia = (tab?: MediaKind, openId?: string) => {
    if (tab) { push({ view: 'media', tab }, openId ? { openId } : undefined); return }
    const after = mediaWait()
    if (!after && info) push({ view: 'media', tab: firstFilledTab(info.counts) })
    else push({ view: 'media' }, { after })
  }
  // Waiting on a request nobody has sent yet: send it now, not at the end of
  // the follow-up's pause.
  useEffect(() => { if ((top.after || 0) > reqRef.current) loadInfo() }, [top, loadInfo])
  const onCloseRef = useRef(props.onClose)
  useEffect(() => { onCloseRef.current = props.onClose }, [props.onClose])
  // The head button: back one view, or close from the info page.
  const headAction = useCallback(() => {
    const s = stackRef.current
    if (s.length > 1) commit(s.slice(0, -1))
    else onCloseRef.current()
  }, [commit])
  const dismissers = useRef<(() => void)[]>([])
  const registerDismiss = useCallback((fn: () => void) => {
    dismissers.current.push(fn)
    return () => { const i = dismissers.current.lastIndexOf(fn); if (i >= 0) dismissers.current.splice(i, 1) }
  }, [])
  // Back, one step: the newest inline editor on the info page first, then the
  // view on top. False when there is nothing to step out of.
  const stepBack = useCallback(() => {
    const d = dismissers.current
    const s = stackRef.current
    if (s.length === 1 && d.length) { d[d.length - 1](); return true }
    if (s.length > 1) { commit(s.slice(0, -1)); return true }
    return false
  }, [commit])
  // Escape: a step back, or close from the info page.
  const goBack = useCallback(() => { if (!stepBack()) onCloseRef.current() }, [stepBack])

  useEffect(() => {
    backRef.current = stepBack
    return () => { if (backRef.current === stepBack) backRef.current = null }
  }, [backRef, stepBack])

  // Read by the key handler below, which is attached once per goBack.
  const dockedRef = useRef(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || e.repeat) return
      if (document.querySelector(ESC_OWNERS)) return
      // Docked beside the thread, Escape pressed with focus over there (the
      // composer, a menu, a message) belongs to the thread, not to a panel it
      // is not using. Covering the thread, the panel is all there is.
      const t = document.activeElement
      if (dockedRef.current && t && t !== document.body && !rootRef.current?.contains(t)) return
      // Typed into a field outside the panel: that field's.
      if (e.target instanceof Element && !rootRef.current?.contains(e.target) && e.target.closest(EDITABLE)) return
      e.preventDefault()
      goBack()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [goBack])

  // How the CSS laid the panel out, read from its computed position so this
  // follows the breakpoints instead of restating them: docked beside the
  // conversation from 1400px ('relative'), covering it like a page below that
  // ('absolute'), and on a phone a page over the whole app ('fixed').
  const [docked, setDocked] = useState(false)
  useLayoutEffect(() => {
    const panel = rootRef.current
    if (!panel) return
    const chat = panel.parentElement?.querySelector<HTMLElement>(':scope > .chat') || null
    const topbar = document.querySelector<HTMLElement>('.topbar')
    const body = document.body
    const sync = () => {
      const pos = getComputedStyle(panel).position
      const covers = pos === 'absolute' || pos === 'fixed'
      // What the panel covers is still in the DOM under it: without inert, Tab
      // walks into a composer nobody can see and screen readers read the
      // thread behind. A phone's page covers the app's top bar too.
      chat?.toggleAttribute('inert', covers)
      topbar?.toggleAttribute('inert', pos === 'fixed')
      setDocked(!covers)
      dockedRef.current = !covers
      // Docked, the panel takes the right edge where the floating voice pill
      // rests, over its lower rows. While the pill's corner overlaps it, the CSS
      // moves the pill to just left of it. A pill the user dragged keeps its
      // own inline spot.
      const r = panel.getBoundingClientRect()
      const vw = document.documentElement.clientWidth
      const vh = document.documentElement.clientHeight
      const shift = !covers && r.width > 0
        && r.left < vw - FAB_CORNER.right && r.right > vw - FAB_CORNER.right - FAB_CORNER.width
        && r.top < vh - FAB_CORNER.bottom && r.bottom > vh - FAB_CORNER.top
      body.classList.toggle('ci-shift-fabs', shift)
      if (shift) body.style.setProperty('--ci-fab-right', `${Math.round(vw - r.left + FAB_GAP)}px`)
      else body.style.removeProperty('--ci-fab-right')
    }
    sync()
    // The panel's box moves with the window and with the card around it.
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null
    ro?.observe(panel)
    window.addEventListener('resize', sync)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', sync)
      chat?.removeAttribute('inert')
      topbar?.removeAttribute('inert')
      body.classList.remove('ci-shift-fabs')
      body.style.removeProperty('--ci-fab-right')
    }
  }, [])

  useEffect(() => {
    headRef.current?.focus({ preventScroll: true })
    return () => {
      // Give focus back to what opened the panel, but only if closing left it
      // stranded on <body>: someone who already clicked into another chat keeps
      // their place.
      const opener = openerRef.current
      const now = document.activeElement
      if ((!now || now === document.body) && opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])

  // Moving between views: a new view starts at its top with focus on the head
  // button (now Back); going back restores the scroll and focus saved when that
  // view was left.
  const shownRef = useRef({ id: top.id, depth: stack.length })
  useLayoutEffect(() => {
    const prev = shownRef.current
    shownRef.current = { id: top.id, depth: stack.length }
    if (prev.id === top.id) return
    const saved = stack.length < prev.depth ? savedRef.current.get(top.id) : undefined
    if (bodyRef.current) bodyRef.current.scrollTop = saved ? saved.scroll : 0
    const el = saved?.focus
    if (el instanceof HTMLElement && el.isConnected && rootRef.current?.contains(el)) el.focus({ preventScroll: true })
    else headRef.current?.focus({ preventScroll: true })
    for (const id of Array.from(savedRef.current.keys())) {
      if (id === top.id || !stack.some((x) => x.id === id)) savedRef.current.delete(id)
    }
  }, [top.id, stack])

  const depthRef = useRef(stack.length)
  useEffect(() => {
    // Back on the info page after a sub-view: what happened there (a recording
    // summarised, tasks assigned) changes the counts shown here.
    if (stack.length === 1 && depthRef.current > 1) loadInfo()
    depthRef.current = stack.length
  }, [stack.length, loadInfo])

  const openMeeting = useCallback((meetingId: string) => push({ view: 'summary', meetingId }), [push])
  const openSummary = useCallback((meetingId: string, review?: boolean) => push(review ? { view: 'summary', meetingId, review: true } : { view: 'summary', meetingId }), [push])
  // The tab each media view opened on, settled once: MediaView reads initialTab
  // when it mounts, and a later refresh with different counts must not read as
  // a request to switch tabs.
  const mediaTabs = useRef(new Map<number, MediaKind>())

  const renderView = (e: Entry, isTop: boolean) => {
    const v = e.view
    switch (v.view) {
      case 'info':
        return <InfoPage panel={props} info={info} infoErr={infoErr} retry={retry} push={push} openMedia={openMedia} changed={changed} reload={loadInfo} patchInfo={patchInfo} />
      case 'media': {
        let tab = mediaTabs.current.get(e.id) || v.tab
        // Opened with no tab named (the header menu, or the Media row while new
        // messages were still uncounted): wait for counts that include them, so
        // it opens on a tab that has something in it.
        if (!tab && (info || infoErr) && doneN >= (e.after || 0)) tab = firstFilledTab(info?.counts)
        if (!tab) return <InfoSkeleton />
        mediaTabs.current.set(e.id, tab)
        return <MediaView convId={conv.id} me={me} initialTab={tab} counts={info?.counts} openId={e.openId} active={isTop}
          onShowMessage={props.onShowMessage} onOpenMeeting={openMeeting} />
      }
      case 'meetings':
        return <MeetingsView convId={conv.id} me={me} onOpenSummary={openMeeting} onJoinCall={props.onCall} />
      case 'summaries':
        return <SummariesView convId={conv.id} me={me} onOpenSummary={openSummary} />
      case 'summary':
        return <SummaryView key={v.meetingId} convId={conv.id} meetingId={v.meetingId} me={me} autoReview={v.review} onChanged={meetingChanged} />
    }
  }

  const title = titleFor(top.view, conv.type)
  const deep = stack.length > 1
  // Docked beside the conversation the panel is a side sheet, closed with ✕.
  // Covering it (below 1400px, and the whole screen on a phone) it is a page
  // pushed over the chat, so even its first view goes back to the chat with ←.
  const headLabel = deep ? 'Back' : docked ? 'Close' : 'Back to chat'
  return (
    <aside className="ci-panel" aria-label={title} ref={rootRef}>
      <div className="ci-head">
        <button type="button" ref={headRef} className="ci-head-btn" onClick={headAction} aria-label={headLabel} title={headLabel}>
          <Ic name={deep || !docked ? 'arrowLeft' : 'close'} size={20} />
        </button>
        <h2 className="ci-head-title ci-p-title" aria-live="polite">{title}</h2>
      </div>
      <div className="ci-body" ref={bodyRef}>
        <Dismiss.Provider value={registerDismiss}>
          {stack.map((e, i) => {
            const isTop = i === stack.length - 1
            return <div key={e.id} className="ci-p-view" hidden={!isTop}>{renderView(e, isTop)}</div>
          })}
        </Dismiss.Provider>
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------- info page

function InfoPage({ panel: p, info, infoErr, retry, push, openMedia, changed, reload, patchInfo }: {
  panel: PanelProps
  info: ChatInfo | null
  infoErr: string
  retry: () => void
  push: (v: InfoView) => void
  openMedia: (tab?: MediaKind, openId?: string) => void
  changed: () => void
  reload: () => void
  patchInfo: (fn: (i: ChatInfo) => ChatInfo) => void
}) {
  const { conv, me } = p
  const isGroup = conv.type === 'group'
  // Group management goes by the CHAT role (whoever created the group), not the
  // org role: a manager who was only added is a member here.
  const isAdmin = isGroup && conv.role === 'admin'
  // What the panel itself just changed, shown until Chats' reload brings the
  // same value back through props, so nothing flips back for a moment.
  const [nameNow, setNameNow] = useState<string | null>(null)
  const [visNow, setVisNow] = useState<'public' | 'private' | null>(null)
  useEffect(() => { setNameNow(null) }, [conv.name])
  useEffect(() => { setVisNow(null) }, [conv.visibility])
  const name = nameNow ?? conv.name
  const visibility = visNow ?? (conv.visibility === 'public' ? 'public' : 'private')
  const memberCount = info ? info.members.length : conv.member_count
  // Settings and the danger zone need nothing from /info, so they stay usable
  // when it fails: you can still mute, clear or leave.
  const ready = !!info || !!infoErr
  return (
    <div className="ci-p-info">
      {isGroup ? (
        <GroupHero conv={conv} name={name} visibility={visibility} memberCount={memberCount} isAdmin={isAdmin}
          onRenamed={(n) => { setNameNow(n); changed() }} changed={changed} onCall={p.onCall} onSearch={p.onSearch} />
      ) : (
        <ContactHero conv={conv} contact={info?.contact ?? null} loaded={!!info} online={p.online} lastSeen={p.lastSeen} onCall={p.onCall} onSearch={p.onSearch} />
      )}
      {!ready && <InfoSkeleton />}
      {!info && infoErr && (
        <div className="ci-error" role="alert">
          <Ic name="warning" size={16} />
          <span>Could not load the details. {infoErr}</span>
          <button type="button" className="btn btn-sm" onClick={retry}>Retry</button>
        </div>
      )}
      {info && (isGroup
        ? <GroupAbout info={info} me={me} isAdmin={isAdmin} description={conv.description || ''} onEdit={p.onEditDescription} />
        : <ContactDetails contact={info.contact} canOpenTasks={canReview(me)} onViewTasks={p.onViewTasks} />)}
      {info && <MediaSection counts={info.counts} recent={info.recent_media || []} openMedia={openMedia} />}
      {info && <MeetingsSection info={info} me={me} push={push} />}
      {info && !isGroup && <CommonGroups groups={info.common_groups || []} onOpen={p.onOpenConversation} />}
      {ready && (
        <SettingsSection conv={conv} isAdmin={isAdmin} name={name} visibility={visibility}
          onVisibility={(v) => { setVisNow(v); changed() }} onMute={p.onMute} onExport={p.onExport} changed={changed} />
      )}
      {info && isGroup && (
        <MembersSection convId={conv.id} members={info.members} isAdmin={isAdmin} online={p.online} groupName={name}
          changed={changed} patchInfo={patchInfo} onMessageUser={p.onMessageUser} />
      )}
      {ready && (
        <DangerSection conv={conv} me={me} name={name} isGroup={isGroup} isAdmin={isAdmin} visibility={visibility}
          onClearChat={p.onClearChat} onDeleteChat={p.onDeleteChat} onLeft={p.onLeft} reload={reload} />
      )}
    </div>
  )
}

// The chat upload limit (multer in routes/chat.js), checked here so a large
// photo fails with a reason instead of a server error after the upload.
const MAX_PHOTO = 15 * 1024 * 1024

function GroupHero({ conv, name, visibility, memberCount, isAdmin, onRenamed, changed, onCall, onSearch }: {
  conv: ChatConvLite
  name: string
  visibility: 'public' | 'private'
  memberCount: number
  isAdmin: boolean
  onRenamed: (name: string) => void
  changed: () => void
  onCall: (kind: CallKind) => void
  onSearch: () => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  // Separate flags: a rename saved while a photo is still uploading must go
  // through, and neither may clear the other's spinner.
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  // The new photo from the moment its upload succeeds until Chats' reload
  // brings the new file name through props; the old one never flashes back.
  const [preview, setPreview] = useState<string | null>(null)
  useEffect(() => { setPreview(null) }, [conv.avatar_file])
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])
  const fileRef = useRef<HTMLInputElement>(null)
  const editRef = useRef<HTMLButtonElement>(null)
  const wasRenaming = useRef(false)
  useEffect(() => {
    // The pencil comes back when the field closes; give it focus rather than
    // dropping a keyboard user onto <body>.
    if (wasRenaming.current && !renaming) editRef.current?.focus({ preventScroll: true })
    wasRenaming.current = renaming
  }, [renaming])
  useDismiss(renaming, () => setRenaming(false))

  const saveName = async () => {
    const next = draft.trim()
    if (!next || saving) return
    if (next === name) { setRenaming(false); return }
    setSaving(true)
    try {
      await api.patch(`/chat/conversations/${conv.id}`, { name: next })
      setRenaming(false)
      onRenamed(next)
    } catch (e: any) { toast.error(e.message) }
    finally { setSaving(false) }
  }

  const uploadPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // so picking the same file again still fires
    if (!file) return
    if (!file.type.startsWith('image/')) { toast.error('Please choose an image.'); return }
    if (file.size > MAX_PHOTO) { toast.error('That photo is over 15 MB. Please choose a smaller one.'); return }
    setUploading(true)
    try {
      // The request the old Group info sent: multipart `file`, bearer token. Not
      // api.upload, which parses every reply as JSON, so a proxy's HTML error
      // page would surface as a syntax error instead of a reason.
      const form = new FormData()
      form.append('file', file)
      const headers: Record<string, string> = {}
      const token = getToken()
      if (token) headers.authorization = `Bearer ${token}`
      const res = await fetch(`${API_BASE}/api/chat/conversations/${conv.id}/avatar`, { method: 'POST', headers, body: form, cache: 'no-store' })
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `Upload failed (${res.status})`)
      setPreview(URL.createObjectURL(file))
      changed()
    } catch (err: any) { toast.error('Could not set the photo: ' + (err?.message || 'upload failed')) }
    finally { setUploading(false) }
  }

  return (
    <div className="ci-section ci-hero">
      {isAdmin ? (
        <>
          <button type="button" className="ci-p-photo" onClick={() => fileRef.current?.click()} disabled={uploading} aria-label="Change group photo" title="Change group photo">
            <GroupPhoto id={conv.id} file={conv.avatar_file} color={conv.avatar_color} size={96} src={preview} />
            <span className="ci-p-photo-badge" aria-hidden="true">{uploading ? <span className="spinner" /> : <Ic name="image" size={14} />}</span>
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={uploadPhoto} />
        </>
      ) : <GroupPhoto id={conv.id} file={conv.avatar_file} color={conv.avatar_color} size={96} />}
      {renaming ? (
        <form className="ci-p-rename" onSubmit={(e) => { e.preventDefault(); saveName() }}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Group name" maxLength={100}
            autoFocus onFocus={(e) => e.currentTarget.select()} readOnly={saving} />
          <button type="submit" className="btn btn-primary btn-sm" disabled={saving || !draft.trim()}>{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn btn-sm" onClick={() => setRenaming(false)} disabled={saving}>Cancel</button>
        </form>
      ) : (
        <div className={'ci-p-name-row' + (isAdmin ? ' editable' : '')}>
          <h3 className="ci-hero-name">{name}</h3>
          {isAdmin && (
            <button type="button" ref={editRef} className="ci-p-edit" onClick={() => { setDraft(name); setRenaming(true) }} aria-label="Edit group name" title="Edit group name">
              <Ic name="edit" size={15} />
            </button>
          )}
        </div>
      )}
      <div className="ci-hero-sub">{visibility === 'public' ? 'Channel' : 'Group'} · {plural(memberCount, 'member')}</div>
      <QuickActions onCall={onCall} onSearch={onSearch} />
    </div>
  )
}

function ContactHero({ conv, contact, loaded, online, lastSeen, onCall, onSearch }: {
  conv: ChatConvLite
  contact: ContactInfo | null
  loaded: boolean
  online: Set<string>
  lastSeen: Record<string, string>
  onCall: (kind: CallKind) => void
  onSearch: () => void
}) {
  const uid = contact?.id || conv.other_user_id || ''
  const isOnline = !!uid && online.has(uid)
  // Live presence from the chat socket first, then what the server last saw.
  const seenRaw = isOnline ? '' : toIso(lastSeen[uid] || contact?.last_seen || '')
  const seen = seenRaw && msOf(seenRaw) != null ? seenRaw : ''
  // "last seen 4 min ago" is relative to now, so it has to move on its own.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!seen) return
    const t = window.setInterval(() => setTick((n) => n + 1), 60000)
    return () => window.clearInterval(t)
  }, [seen])
  const name = contact?.name || conv.name
  const file = contact ? contact.avatar_file : conv.avatar_file
  const meta = contact ? [cap(contact.org_role), contact.department].filter(Boolean).join(' · ') : ''
  // The other person has left the chat or the workspace: nobody to call.
  const gone = loaded && !contact
  return (
    <div className="ci-section ci-hero">
      <span className="avatar-wrap">
        <Avatar name={name} color={contact?.avatar_color || conv.avatar_color} size={96} src={file && uid ? userAvatarUrl(uid, file) : undefined} />
        {isOnline && <span className="online-dot ci-p-hero-dot" role="img" aria-label="Online" />}
      </span>
      <div className="ci-p-name-row"><h3 className="ci-hero-name">{name}</h3></div>
      {isOnline
        ? <div className="ci-hero-sub"><span className="online-text">online</span></div>
        : seen ? <div className="ci-hero-sub">{lastSeenText(seen)}</div> : null}
      {meta && <div className="ci-hero-sub">{meta}</div>}
      {contact?.email && <a className="ci-hero-sub ci-p-mail" href={`mailto:${contact.email}`}>{contact.email}</a>}
      {gone && <div className="ci-hero-sub">No longer in this chat</div>}
      <QuickActions onCall={onCall} onSearch={onSearch} noCalls={gone} />
    </div>
  )
}

function QuickActions({ onCall, onSearch, noCalls }: { onCall: (kind: CallKind) => void; onSearch: () => void; noCalls?: boolean }) {
  return (
    <div className="ci-quick">
      <button type="button" className="ci-quick-btn" onClick={() => onCall('audio')} disabled={noCalls} title="Audio call" aria-label="Audio call"><Ic name="phone" size={20} />Audio</button>
      <button type="button" className="ci-quick-btn" onClick={() => onCall('video')} disabled={noCalls} title="Video call" aria-label="Video call"><Ic name="video" size={20} />Video</button>
      <button type="button" className="ci-quick-btn" onClick={onSearch} title="Search messages" aria-label="Search messages"><Ic name="search" size={20} />Search</button>
    </div>
  )
}

// A group's photo, or a tile in its colour with a people glyph. Not Chats'
// GroupAvatar: its '#' does not scale, so at 96px it would be a 14px mark.
function GroupPhoto({ id, file, color, size, src }: { id: string; file?: string | null; color?: string; size: number; src?: string | null }) {
  const url = src || (file ? groupAvatarUrl(id, file) : '')
  const [broken, setBroken] = useState(false)
  useEffect(() => { setBroken(false) }, [url])
  if (url && !broken) return <img className="avatar" src={url} alt="" onError={() => setBroken(true)} style={{ width: size, height: size, objectFit: 'cover' }} />
  // The server gives every group a colour. Should one arrive without, the brand
  // fill stands in, with the surface as its ink: white on the light theme's
  // deep orange, near-black on the dark theme's light one.
  const fill = color ? { background: color } : { background: 'var(--primary)', color: 'var(--surface)' }
  return (
    <span className="avatar" style={{ ...fill, width: size, height: size }} aria-hidden="true">
      <Ic name="users" size={Math.round(size * 0.42)} />
    </span>
  )
}

// The chat header's workload chip, same classes and wording: what this person
// is already holding. Silent when they are clear.
function LoadChip({ load }: { load?: Workload | null }) {
  if (!load || !load.open) return null
  const late = load.overdue > 0
  return (
    <span className={'load-chip' + (late ? ' late' : '')} title={`${plural(load.open, 'open task')}${late ? `, ${load.overdue} overdue` : ''}`}>
      <Ic name={late ? 'warning' : 'check'} size={10} />
      {load.open} open{late ? ` · ${load.overdue} late` : ''}
    </span>
  )
}

function InfoSkeleton() {
  return (
    <div className="ci-section" aria-busy="true">
      {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton ci-skel" />)}
    </div>
  )
}

// ------------------------------------------------------------------ sections

// WhatsApp's second band on a group: what the group is for, and who started it
// when. Admins write the description; Chats opens the editor.
function GroupAbout({ info, me, isAdmin, description, onEdit }: { info: ChatInfo; me: Me; isAdmin: boolean; description: string; onEdit: () => void }) {
  const { created_at: at, created_by: by } = info.conversation
  const created = !!at && msOf(at) != null
  const text = description.trim()
  if (!text && !isAdmin && !created) return null
  return (
    <div className="ci-section">
      {text ? (
        <div className="ci-p-desc">
          <div className="ci-p-desc-text">{text}</div>
          {isAdmin && (
            <button type="button" className="ci-p-edit" onClick={onEdit} aria-label="Edit group description" title="Edit group description">
              <Ic name="edit" size={15} />
            </button>
          )}
        </div>
      ) : isAdmin ? (
        <button type="button" className="ci-row" onClick={onEdit}>
          <span className="ci-row-ic"><Ic name="edit" size={18} /></span>
          <span className="ci-row-main"><span className="ci-row-title ci-p-link">Add group description</span></span>
        </button>
      ) : null}
      {created && (
        <div className="ci-row static">
          <span className="ci-row-ic ci-p-ac-muted"><Ic name="calendar" size={18} /></span>
          <span className="ci-row-main">
            {/* Just "Created" once the creator's account is gone. */}
            <span className="ci-row-title">{!by ? 'Created' : by.id === me.id ? 'Created by you' : `Created by ${by.name}`}</span>
            <span className="ci-row-sub">{fmtDateTime(toIso(at))}</span>
          </span>
        </div>
      )}
    </div>
  )
}

// A direct chat's About (their status, and do-not-disturb while it lasts) and
// what they are already holding.
function ContactDetails({ contact, canOpenTasks, onViewTasks }: { contact: ContactInfo | null; canOpenTasks: boolean; onViewTasks: (userId: string) => void }) {
  if (!contact) return null
  const text = (contact.status_text || '').trim()
  const emoji = (contact.status_emoji || '').trim()
  const dndAt = msOf(contact.dnd_until)
  const dnd = dndAt != null && dndAt > Date.now() ? `Do not disturb until ${untilText(toIso(contact.dnd_until))}` : ''
  const load = contact.workload
  return (
    <>
      {(text || emoji || dnd) && (
        <div className="ci-section">
          <div className="ci-section-title">About</div>
          <div className="ci-row static">
            <span className="ci-row-ic ci-p-ac-muted">{text && emoji ? <span className="ci-p-emoji">{emoji}</span> : <Ic name={text || emoji ? 'smile' : 'muteBell'} size={18} />}</span>
            <span className="ci-row-main">
              <span className="ci-row-title ci-p-wrap">{text || emoji || dnd}</span>
              {(text || emoji) && dnd && <span className="ci-row-sub ci-p-wrap">{dnd}</span>}
            </span>
          </div>
        </div>
      )}
      {load && load.open > 0 && (
        <div className="ci-section">
          <div className="ci-row static">
            <span className={'ci-row-ic ' + (load.overdue ? 'ci-ac-red' : 'ci-ac-green')}><Ic name={load.overdue ? 'warning' : 'check'} size={18} /></span>
            <span className="ci-row-main">
              <span className="ci-row-title">Tasks</span>
              <span className="ci-row-sub">Open tasks assigned to {contact.name}</span>
            </span>
            <span className="ci-row-end">
              <LoadChip load={load} />
              {canOpenTasks && <button type="button" className="btn btn-sm" onClick={() => onViewTasks(contact.id)}>View tasks</button>}
            </span>
          </div>
        </div>
      )}
      <OnTimeRow userId={contact.id} />
    </>
  )
}

// How late this person's deadlines ran this month (server/src/punctuality.js,
// the Leaderboard's "On time" ranking) — the profile view of the same number.
// Its own component so the fetch has hooks of its own; nothing shows until it
// answers, and nothing at all for someone with no deadline this month.
function OnTimeRow({ userId }: { userId: string }) {
  const [d, setD] = useState<any>(null)
  useEffect(() => {
    let live = true
    setD(null)
    api.get(`/scores/${userId}?period=month`).then((r) => { if (live) setD(r?.delay || null) }).catch(() => {})
    return () => { live = false }
  }, [userId])
  if (!d?.tasks) return null
  const good = d.avg_delay === 0
  const days = (n: number) => (n === 1 ? '1 day' : `${n} days`)
  return (
    <div className="ci-section">
      <div className="ci-row static">
        <span className={'ci-row-ic ' + (good ? 'ci-ac-green' : 'ci-ac-red')}><Ic name={good ? 'check' : 'calendar'} size={18} /></span>
        <span className="ci-row-main">
          <span className="ci-row-title">{good ? 'Every deadline met this month' : `${days(d.avg_delay)} late on average this month`}</span>
          <span className="ci-row-sub">
            {d.on_time_rate}% on time ({d.on_time}/{d.tasks}){d.late_done ? ` · ${d.late_done} delivered late` : ''}{d.overdue_open ? ` · ${d.overdue_open} overdue now` : ''}
          </span>
        </span>
      </div>
    </div>
  )
}

function MediaSection({ counts, recent, openMedia }: { counts: MediaCounts; recent: RecentMedia[]; openMedia: (tab?: MediaKind, openId?: string) => void }) {
  const total = MEDIA_TABS.reduce((n, t) => n + (counts[t.key] || 0), 0)
  const strip = recent.slice(0, 6)
  return (
    <div className="ci-section">
      <button type="button" className="ci-row" onClick={() => openMedia()}>
        <span className="ci-row-ic ci-ac-green"><Ic name="image" size={18} /></span>
        <span className="ci-row-main">
          <span className="ci-row-title">Media, links and docs</span>
          <span className="ci-row-sub">{total ? mediaSummary(counts) : 'Nothing shared yet'}</span>
        </span>
        <span className="ci-row-end">{total > 0 && <span>{total}</span>}<Ic name="chevronRight" size={16} /></span>
      </button>
      {strip.length > 0 && (
        <div className="ci-p-strip">
          {/* Like WhatsApp, a tapped thumbnail opens that photo or video. */}
          {strip.map((m) => <Thumb key={m.id} item={m} onOpen={() => openMedia(m.kind, m.id)} />)}
        </div>
      )}
    </div>
  )
}

// One square of the strip. An image loads the file itself (the server keeps no
// thumbnails), lazily; a video is a dark tile with a play mark, since a first
// frame would cost a request per tile for a 54px picture.
function Thumb({ item, onOpen }: { item: RecentMedia; onOpen: () => void }) {
  const [broken, setBroken] = useState(false)
  const video = item.kind === 'videos'
  return (
    <button type="button" className={'ci-p-thumb' + (video ? ' video' : '')} onClick={onOpen}
      aria-label={`${video ? 'Video' : 'Image'}${item.name ? `: ${item.name}` : ''}`} title={item.name || undefined}>
      {!video && !broken
        ? <img src={chatFileUrl(item.id)} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
        : <Ic name={video ? 'play' : 'image'} size={video ? 18 : 20} />}
    </button>
  )
}

function MeetingsSection({ info, me, push }: { info: ChatInfo; me: Me; push: (v: InfoView) => void }) {
  const { calls, summaries, pending_review: pending } = info.counts
  // Waiting tasks are a to-do only for someone who can review them; everyone
  // else sees the summaries without an alert they cannot act on.
  const toReview = pending || 0
  return (
    <div className="ci-section">
      <div className="ci-section-title">Meetings</div>
      <button type="button" className="ci-row" onClick={() => push({ view: 'meetings' })}>
        <span className="ci-row-ic ci-ac-blue"><Ic name="video" size={18} /></span>
        <span className="ci-row-main">
          <span className="ci-row-title">All meetings</span>
          <span className="ci-row-sub">{calls ? `${plural(calls, 'call')}${info.last_call_at ? ` · last ${dayWord(toIso(info.last_call_at))}` : ''}` : 'No calls yet'}</span>
        </span>
        <span className="ci-row-end"><Ic name="chevronRight" size={16} /></span>
      </button>
      <button type="button" className="ci-row" onClick={() => push({ view: 'summaries' })}>
        <span className="ci-row-ic ci-ac-violet"><Ic name="ai" size={18} /></span>
        <span className="ci-row-main">
          <span className="ci-row-title">Meeting summaries</span>
          <span className="ci-row-sub">{summaries ? plural(summaries, 'summary', 'summaries') : 'No summaries yet'}{toReview > 0 ? ` · ${plural(toReview, 'task')} to review` : ''}</span>
        </span>
        <span className="ci-row-end">
          {toReview > 0 && <span className="ci-count alert" aria-hidden="true">{toReview}</span>}
          <Ic name="chevronRight" size={16} />
        </span>
      </button>
    </div>
  )
}

// Long lists show this many rows, then "View all".
const PREVIEW = 10

function ViewAll({ n, onClick }: { n: number; onClick: () => void }) {
  return (
    <button type="button" className="ci-row ci-mem-more" onClick={onClick}>
      <span className="ci-row-ic ci-p-ac-muted"><Ic name="users" size={18} /></span>
      <span className="ci-row-main"><span className="ci-row-title">View all ({n})</span></span>
    </button>
  )
}

function CommonGroups({ groups, onOpen }: { groups: CommonGroup[]; onOpen: (convId: string) => void }) {
  const [all, setAll] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  // "View all" disappears as it is used; its focus goes to the first row it revealed.
  useEffect(() => { if (all) listRef.current?.querySelectorAll<HTMLElement>('.ci-row')[PREVIEW]?.focus({ preventScroll: true }) }, [all])
  if (!groups.length) return null
  const shown = all ? groups : groups.slice(0, PREVIEW)
  return (
    <div className="ci-section" ref={listRef}>
      <div className="ci-section-title">{plural(groups.length, 'group')} in common</div>
      {shown.map((g) => (
        <button key={g.id} type="button" className="ci-row" onClick={() => onOpen(g.id)}>
          <GroupPhoto id={g.id} file={g.avatar_file} color={g.avatar_color} size={40} />
          <span className="ci-row-main">
            <span className="ci-row-title">{g.name}</span>
            <span className="ci-row-sub">{plural(g.member_count, 'member')}</span>
          </span>
          <span className="ci-row-end"><Ic name="chevronRight" size={16} /></span>
        </button>
      ))}
      {shown.length < groups.length && <ViewAll n={groups.length} onClick={() => setAll(true)} />}
    </div>
  )
}

function SettingsSection({ conv, isAdmin, name, visibility, onVisibility, onMute, onExport, changed }: {
  conv: ChatConvLite
  isAdmin: boolean
  name: string
  visibility: 'public' | 'private'
  onVisibility: (v: 'public' | 'private') => void
  onMute: () => void
  onExport: () => void
  changed: () => void
}) {
  const [busy, setBusy] = useState(false)
  // What the panel just set, until Chats' reload brings the same value back.
  const [onlyNow, setOnlyNow] = useState<boolean | null>(null)
  useEffect(() => { setOnlyNow(null) }, [conv.admins_only])
  const adminsOnly = onlyNow ?? !!conv.admins_only
  const isPublic = visibility === 'public'
  const isGroup = conv.type === 'group'
  const setAdminsOnly = async (on: boolean) => {
    setBusy(true)
    try { await api.post(`/chat/conversations/${conv.id}/settings`, { admins_only: on }); setOnlyNow(on); changed() }
    catch (e: any) { toast.error(e.message) }
    finally { setBusy(false) }
  }
  const toggleVisibility = async () => {
    const next = isPublic ? 'private' : 'public'
    if (next === 'public' && !(await confirmHere({
      title: 'Open this to everyone?',
      message: `Anyone in the workspace will be able to find "${name}" and read everything in it, including what was said before they joined.`,
      confirmText: 'Open it',
    }))) return
    setBusy(true)
    try { await api.post(`/chat/conversations/${conv.id}/visibility`, { visibility: next }); onVisibility(next) }
    catch (e: any) { toast.error(e.message) }
    finally { setBusy(false) }
  }
  return (
    <div className="ci-section">
      {/* Chats decides what a tap means: unmute at once, or ask for how long. */}
      <button type="button" className="ci-row" onClick={onMute}>
        <span className="ci-row-ic ci-ac-amber"><Ic name="muteBell" size={18} /></span>
        <span className="ci-row-main">
          <span className="ci-row-title">Mute notifications</span>
          <span className="ci-row-sub">{muteText(conv)}</span>
        </span>
        <span className={'ci-p-switch' + (conv.muted ? ' on' : '')} aria-hidden="true" />
      </button>
      {/* WhatsApp's "Send messages": admins choose, members are told. */}
      {isGroup && isAdmin && (
        <div className="ci-row static">
          <span className="ci-row-ic ci-p-ac-muted"><Ic name="chat" size={18} /></span>
          <span className="ci-row-main">
            <span className="ci-row-title">Send messages</span>
            <span className="ci-row-sub ci-p-wrap">{adminsOnly ? 'Only admins can send messages here.' : 'All members can send messages.'}</span>
          </span>
          <button type="button" className="btn btn-sm ci-p-vis-btn" onClick={() => setAdminsOnly(!adminsOnly)} disabled={busy}>{adminsOnly ? 'Allow everyone' : 'Only admins'}</button>
        </div>
      )}
      {isGroup && !isAdmin && adminsOnly && (
        <div className="ci-row static">
          <span className="ci-row-ic ci-p-ac-muted"><Ic name="lock" size={18} /></span>
          <span className="ci-row-main"><span className="ci-row-title ci-p-wrap">Only admins can send messages</span></span>
        </div>
      )}
      <button type="button" className="ci-row" onClick={onExport}>
        <span className="ci-row-ic ci-p-ac-muted"><Ic name="download" size={18} /></span>
        <span className="ci-row-main">
          <span className="ci-row-title">Export chat</span>
          <span className="ci-row-sub">Every message, as a text file</span>
        </span>
      </button>
      {isAdmin && (
        <div className="ci-row static">
          <span className="ci-row-ic ci-p-ac-muted"><Ic name={isPublic ? 'hash' : 'lock'} size={18} /></span>
          <span className="ci-row-main">
            <span className="ci-row-title">{isPublic ? 'Open channel' : 'Private group'}</span>
            <span className="ci-row-sub ci-p-wrap">{isPublic ? 'Anyone in the workspace can find and join this.' : 'Only people added here can see it.'}</span>
          </span>
          <button type="button" className="btn btn-sm ci-p-vis-btn" onClick={toggleVisibility} disabled={busy}>{isPublic ? 'Make private' : 'Open to everyone'}</button>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------- members

// Under a member's name: the status they set, else who they are in the
// workspace, else how to reach them.
function memberSub(m: InfoMember) {
  const status = [m.status_emoji, m.status_text].map((s) => (s || '').trim()).filter(Boolean).join(' ')
  if (status) return status
  return [cap(m.org_role), m.department].filter(Boolean).join(' · ') || m.email
}

function MembersSection({ convId, members, isAdmin, online, groupName, changed, patchInfo, onMessageUser }: {
  convId: string
  members: InfoMember[]
  isAdmin: boolean
  online: Set<string>
  groupName: string
  changed: () => void
  patchInfo: (fn: (i: ChatInfo) => ChatInfo) => void
  onMessageUser: (userId: string) => void
}) {
  const uid = useId()
  const sectionRef = useRef<HTMLDivElement>(null)
  const searchBtnRef = useRef<HTMLButtonElement>(null)
  const addBtnRef = useRef<HTMLButtonElement>(null)
  const [searching, setSearching] = useState(false)
  const [q, setQ] = useState('')
  const [all, setAll] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  // A row to focus once the render that shows it has landed: the neighbour of a
  // removed member, or the first row "View all" revealed.
  const focusNext = useRef<string | null>(null)
  const focusRow = (id: string) => sectionRef.current?.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`)?.focus({ preventScroll: true })
  useEffect(() => {
    const id = focusNext.current
    if (id) { focusNext.current = null; focusRow(id) }
  })

  const needle = q.trim().toLowerCase()
  const matches = needle ? members.filter((m) => m.name.toLowerCase().includes(needle) || (m.email || '').toLowerCase().includes(needle)) : members
  const shown = needle || all ? matches : matches.slice(0, PREVIEW)
  // Closes by itself when its member leaves the list (removed, or filtered out).
  const open = openId && shown.some((m) => m.id === openId) ? openId : null

  const closeSearch = () => { setSearching(false); setQ(''); searchBtnRef.current?.focus({ preventScroll: true }) }
  const closeActions = () => { setOpenId(null); if (open) focusRow(open) }
  const closeAdd = () => { setAdding(false); addBtnRef.current?.focus({ preventScroll: true }) }
  useDismiss(searching, closeSearch)
  useDismiss(!!open, closeActions)
  useDismiss(adding, closeAdd)

  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members])
  // "Message Priya" while she is the only Priya; the full name once two people
  // would answer to it, which in a team of Employee 1 … Employee 30 is everyone.
  const firstNames = useMemo(() => {
    const n = new Map<string, number>()
    for (const m of members) { const f = firstName(m.name).toLowerCase(); n.set(f, (n.get(f) || 0) + 1) }
    return n
  }, [members])
  const callName = (name: string) => ((firstNames.get(firstName(name).toLowerCase()) || 0) > 1 ? name : firstName(name))

  const remove = async (m: InfoMember) => {
    if (!(await confirmHere({ title: 'Remove member?', message: `Remove ${m.name} from "${groupName}"?`, confirmText: 'Remove', danger: true }))) return
    setBusyId(m.id)
    try {
      await api.del(`/chat/conversations/${convId}/members/${m.id}`)
      const i = shown.findIndex((x) => x.id === m.id)
      focusNext.current = [shown[i + 1], shown[i - 1]].find((x) => x && !x.is_me)?.id || null
      setOpenId(null)
      patchInfo((inf) => ({ ...inf, members: inf.members.filter((x) => x.id !== m.id) }))
      changed()
    } catch (e: any) { toast.error(e.message) }
    finally { setBusyId(null) }
  }
  // Make a member an admin, or dismiss one. The server keeps at least one
  // admin in every group and says so when this would leave none.
  const setAdmin = async (m: InfoMember, on: boolean) => {
    setBusyId(m.id)
    try {
      await api.post(`/chat/conversations/${convId}/members/${m.id}/role`, { role: on ? 'admin' : 'member' })
      setOpenId(null)
      focusNext.current = m.id
      patchInfo((inf) => ({ ...inf, members: inf.members.map((x) => (x.id === m.id ? { ...x, chat_role: on ? 'admin' : 'member' } : x)) }))
      changed()
    } catch (e: any) { toast.error(e.message) }
    finally { setBusyId(null) }
  }
  const added = (n: number) => {
    closeAdd()
    toast.success(`Added ${plural(n, 'member')}`)
    changed()
  }
  const viewAll = () => {
    const first = matches[PREVIEW]
    if (first && !first.is_me) focusNext.current = first.id
    setAll(true)
  }

  return (
    <div className="ci-section" ref={sectionRef}>
      <div className="ci-section-title">
        <span>{plural(members.length, 'member')}</span>
        {members.length > 6 && (
          <button type="button" ref={searchBtnRef} className="ci-mem-search-btn" onClick={() => (searching ? closeSearch() : setSearching(true))}
            aria-expanded={searching} aria-label={searching ? 'Close member search' : 'Search members'} title={searching ? 'Close search' : 'Search members'}>
            <Ic name={searching ? 'close' : 'search'} size={16} />
          </button>
        )}
      </div>
      {searching && (
        <div className="ci-mem-search">
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email" aria-label="Search members" autoFocus />
        </div>
      )}
      {isAdmin && (
        <button type="button" ref={addBtnRef} className="ci-row" onClick={() => (adding ? closeAdd() : setAdding(true))} aria-expanded={adding}>
          <span className="ci-row-ic ci-ac-green"><Ic name="userPlus" size={18} /></span>
          <span className="ci-row-main"><span className="ci-row-title">Add members</span></span>
        </button>
      )}
      {isAdmin && adding && <AddMembers convId={convId} memberIds={memberIds} onAdded={added} onCancel={closeAdd} />}
      {shown.map((m) => (
        <MemberRow key={m.id} m={m} online={online.has(m.id)} open={open === m.id} actionsId={`${uid}-${m.id}`}
          callName={callName(m.name)} canRemove={isAdmin} busy={busyId === m.id}
          onToggle={() => setOpenId((o) => (o === m.id ? null : m.id))} onMessage={() => onMessageUser(m.id)} onRemove={() => remove(m)}
          onSetAdmin={(on) => setAdmin(m, on)} />
      ))}
      {needle && !matches.length && <div className="ci-mem-empty">No members match "{q.trim()}"</div>}
      {shown.length < matches.length && <ViewAll n={matches.length} onClick={viewAll} />}
    </div>
  )
}

function MemberRow({ m, online, open, actionsId, callName, canRemove, busy, onToggle, onMessage, onRemove, onSetAdmin }: {
  m: InfoMember
  online: boolean
  open: boolean
  actionsId: string
  callName: string
  // The viewer is a group admin: they manage who is in it and who else runs it.
  canRemove: boolean
  busy: boolean
  onToggle: () => void
  onMessage: () => void
  onRemove: () => void
  onSetAdmin: (on: boolean) => void
}) {
  const load = m.workload
  const body = (
    <>
      <span className="avatar-wrap">
        <Avatar name={m.name} color={m.avatar_color} size={40} src={m.avatar_file ? userAvatarUrl(m.id, m.avatar_file) : undefined} />
        {online && <span className="online-dot" role="img" aria-label="Online" />}
      </span>
      <span className="ci-row-main">
        <span className="ci-row-title">{m.name}{m.is_me && <span className="ci-mem-you">You</span>}</span>
        <span className="ci-row-sub">{memberSub(m)}</span>
      </span>
      {(m.chat_role === 'admin' || (load && load.open > 0)) && (
        <span className="ci-row-end ci-mem-end">
          {m.chat_role === 'admin' && <span className="ci-pill">Group admin</span>}
          <LoadChip load={load} />
        </span>
      )}
    </>
  )
  // Your own row offers you nothing: no messaging yourself, and leaving is Exit
  // group, further down.
  if (m.is_me) return <div className="ci-row static">{body}</div>
  return (
    <div className={'ci-mem' + (open ? ' open' : '')}>
      <button type="button" className="ci-row" data-mid={m.id} onClick={onToggle} aria-expanded={open} aria-controls={open ? actionsId : undefined}>{body}</button>
      {open && (
        <div className="ci-mem-actions" id={actionsId} ref={reveal}>
          <button type="button" className="ci-mem-act" onClick={onMessage}><Ic name="chat" size={16} /><span>Message {callName}</span></button>
          {canRemove && (
            <button type="button" className="ci-mem-act" onClick={() => onSetAdmin(m.chat_role !== 'admin')} disabled={busy}>
              <Ic name="user" size={16} /><span>{m.chat_role === 'admin' ? 'Dismiss as admin' : 'Make group admin'}</span>
            </button>
          )}
          {canRemove && (
            <button type="button" className="ci-mem-act danger" onClick={onRemove} disabled={busy}>
              <Ic name="trash" size={16} /><span>{busy ? 'Removing…' : 'Remove from group'}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function AddMembers({ convId, memberIds, onAdded, onCancel }: { convId: string; memberIds: Set<string>; onAdded: (n: number) => void; onCancel: () => void }) {
  const [users, setUsers] = useState<OrgUser[] | null>(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  // A touch screen raises its keyboard for a focused field, over most of the
  // list; there the search waits to be tapped.
  const [touch] = useState(() => window.matchMedia('(pointer: coarse)').matches)
  const load = useCallback(() => {
    setErr('')
    api.get('/chat/users').then((d) => setUsers(d?.users || []), (e) => setErr(e?.message || 'Request failed'))
  }, [])
  useEffect(() => { load() }, [load])
  // The picker opens under its row, often past the fold with Add out of sight.
  // Brought into view as it opens, and again once the people arrive, since
  // they are what make it tall.
  const loaded = users !== null
  useLayoutEffect(() => { reveal(rootRef.current) }, [loaded])
  const candidates = useMemo(() => (users || []).filter((u) => !memberIds.has(u.id)).sort((a, b) => naturalCompare(a.name, b.name)), [users, memberIds])
  const needle = q.trim().toLowerCase()
  const list = needle ? candidates.filter((u) => u.name.toLowerCase().includes(needle) || (u.email || '').toLowerCase().includes(needle)) : candidates
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  // Someone picked here who joined meanwhile (another admin added them, or they
  // walked into an open channel) drops out of the count; the server would
  // ignore them anyway.
  const picked = Array.from(sel).filter((id) => !memberIds.has(id))
  const add = async () => {
    if (!picked.length || busy) return
    setBusy(true)
    try { await api.post(`/chat/conversations/${convId}/members`, { userIds: picked }); onAdded(picked.length) }
    catch (e: any) { toast.error(e.message); setBusy(false) }
  }
  return (
    <div className="ci-mem-add" role="group" aria-label="Add members" ref={rootRef}>
      <div className="ci-mem-add-search">
        <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" aria-label="Search people to add" autoFocus={!touch} />
      </div>
      <div className="ci-mem-add-list">
        {!users && !err && [0, 1, 2].map((i) => <div key={i} className="skeleton ci-skel" />)}
        {err && (
          <div className="ci-error" role="alert">
            <span>Could not load people. {err}</span>
            <button type="button" className="btn btn-sm" onClick={load}>Retry</button>
          </div>
        )}
        {users && !candidates.length && <div className="ci-mem-add-note">Everyone in the workspace is already in this group.</div>}
        {candidates.length > 0 && !list.length && <div className="ci-mem-add-note">Nobody matches "{q.trim()}"</div>}
        {list.map((u) => (
          <label key={u.id} className="ci-mem-add-row">
            <input type="checkbox" checked={sel.has(u.id)} onChange={() => toggle(u.id)} />
            <Avatar name={u.name} color={u.avatar_color} size={32} src={u.avatar_file ? userAvatarUrl(u.id, u.avatar_file) : undefined} />
            <span className="ci-mem-add-main">
              <span className="ci-mem-add-name">{u.name}</span>
              <span className="ci-mem-add-sub">{[cap(u.role), u.email].filter(Boolean).join(' · ')}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="ci-mem-add-foot">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={add} disabled={!picked.length || busy}>{busy ? 'Adding…' : `Add (${picked.length})`}</button>
      </div>
    </div>
  )
}

// --------------------------------------------------------------- danger zone

// What leaving costs, said before it happens. The last admin out hands the
// group to whoever has been in it longest (the server does it, as WhatsApp
// does), so that is said rather than discovered afterwards.
function exitMessage(conv: ChatConvLite, me: Me, name: string, isAdmin: boolean, visibility: 'public' | 'private') {
  const others = conv.members.filter((m) => m.id !== me.id)
  const adminStays = others.some((m) => m.role === 'admin')
  const isPublic = visibility === 'public'
  const after = !others.length
    ? `Nobody else is in it, so it will be left empty.${isAdmin ? ' Delete it instead if it is no longer needed.' : ''}`
    : isAdmin && !adminStays
      ? `You are its only admin, so whoever has been in it longest becomes admin. ${isPublic ? 'You can join it again from Browse channels.' : 'Only an admin can add you back.'}`
      : isPublic ? 'You can join it again from Browse channels.' : 'Only a group admin can add you back.'
  return `You will stop getting messages from "${name}". ${after}`
}

function DangerSection({ conv, me, name, isGroup, isAdmin, visibility, onClearChat, onDeleteChat, onLeft, reload }: {
  conv: ChatConvLite
  me: Me
  name: string
  isGroup: boolean
  isAdmin: boolean
  visibility: 'public' | 'private'
  onClearChat: () => void
  onDeleteChat: () => void
  onLeft: () => void
  reload: () => void
}) {
  const [busy, setBusy] = useState<'' | 'exit' | 'delete'>('')
  const clear = () => {
    // Chats owns the confirm and the request. If its handler hands that promise
    // back, refresh once the clear has gone through: the media and counts shown
    // here drop with it.
    const r: unknown = onClearChat()
    if (r && typeof (r as PromiseLike<unknown>).then === 'function') (r as PromiseLike<unknown>).then(reload, () => {})
  }
  const exit = async () => {
    if (!(await confirmHere({ title: 'Exit group?', message: exitMessage(conv, me, name, isAdmin, visibility), confirmText: 'Exit group', danger: true }))) return
    setBusy('exit')
    try { await api.del(`/chat/conversations/${conv.id}/members/${me.id}`); onLeft() }
    catch (e: any) { toast.error(e.message); setBusy('') }
  }
  const deleteGroup = async () => {
    if (!(await confirmHere({
      title: 'Delete group?',
      message: `Delete "${name}" for everyone? Every message, file and call record in it is removed for all its members. This cannot be undone.`,
      confirmText: 'Delete group',
      danger: true,
    }))) return
    setBusy('delete')
    try { await api.del(`/chat/conversations/${conv.id}`); onLeft() }
    catch (e: any) { toast.error(e.message); setBusy('') }
  }
  return (
    <div className="ci-section">
      <button type="button" className="ci-row" onClick={clear}>
        <span className="ci-row-ic ci-p-ac-muted"><Ic name="trash" size={18} /></span>
        <span className="ci-row-main">
          <span className="ci-row-title">Clear chat</span>
          <span className="ci-row-sub">Clears the messages for you only</span>
        </span>
      </button>
      {!isGroup && (
        <button type="button" className="ci-row danger" onClick={onDeleteChat}>
          <span className="ci-row-ic"><Ic name="trash" size={18} /></span>
          <span className="ci-row-main">
            <span className="ci-row-title">Delete chat</span>
            <span className="ci-row-sub">Takes it off your list until a new message arrives</span>
          </span>
        </button>
      )}
      {isGroup && (
        <button type="button" className="ci-row danger" onClick={exit} disabled={!!busy}>
          <span className="ci-row-ic"><Ic name="logout" size={18} /></span>
          <span className="ci-row-main"><span className="ci-row-title">{busy === 'exit' ? 'Exiting…' : 'Exit group'}</span></span>
        </button>
      )}
      {isAdmin && (
        <button type="button" className="ci-row danger" onClick={deleteGroup} disabled={!!busy}>
          <span className="ci-row-ic"><Ic name="trash" size={18} /></span>
          <span className="ci-row-main"><span className="ci-row-title">{busy === 'delete' ? 'Deleting…' : 'Delete group'}</span></span>
        </button>
      )}
    </div>
  )
}
