import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import { Ic, fmtBytes } from '../ui'
import { toast } from '../lib/toast'
import { saveFile as downloadFile, nativeFiles } from '../lib/saveFile'
import { useDialog } from '../lib/useDialog'
import { pushBackHandler } from '../back'
import VoicePlayer, { mediaLength } from './VoicePlayer'
import ZoomMedia from './ZoomMedia'
import {
  MediaKind, MediaCounts, MediaItem, MediaFileItem, LinkItem, Me,
  MEDIA_TABS, canReview, chatInfoApi, chatFileUrl, fileExt, fmtDay, fmtClock, periodLabel, groupRuns,
} from '../lib/chatInfo'

// "Media, links and docs": the WhatsApp-style browser behind the chat info
// panel's media row. Five tabs over everything this conversation has shared,
// newest first, in period runs, paged from the server as the list scrolls.
//
// Everything opens where it is. Images and videos open in a viewer over the
// page, voice notes and call recordings play in their own row, files open in a
// new tab. Download exists, but only ever as its own button: nothing here saves
// a file to disk unless that is the button that was pressed.

type GridKind = 'images' | 'videos'

interface TabData {
  items: MediaItem[]
  next: string | null
  // The first page has landed, so an empty list now means "nothing shared".
  loaded: boolean
  loading: boolean
  error: string | null
}
type Tabs = Partial<Record<MediaKind, TabData>>
const BLANK: TabData = { items: [], next: null, loaded: false, loading: false, error: null }

const EMPTY: Record<MediaKind, { title: string; hint: string }> = {
  images: { title: 'No images yet', hint: 'Photos shared in this chat will show up here.' },
  videos: { title: 'No videos yet', hint: 'Videos shared in this chat will show up here.' },
  audio: { title: 'No audio yet', hint: 'Voice notes and call recordings from this chat will show up here.' },
  files: { title: 'No files yet', hint: 'Documents, sheets and other files shared in this chat are kept here.' },
  links: { title: 'No links yet', hint: 'Links posted in messages are collected here.' },
}

// Badge colour by the kind of document, so a PDF can be found at a glance in a
// long list, the way it can in a file manager.
const EXT_FAMILY: Record<string, string> = {
  PDF: 'pdf',
  DOC: 'doc', DOCX: 'doc', ODT: 'doc', TXT: 'doc', RTF: 'doc',
  XLS: 'sheet', XLSX: 'sheet', CSV: 'sheet', ODS: 'sheet',
  PPT: 'slide', PPTX: 'slide', KEY: 'slide',
  ZIP: 'zip', RAR: 'zip', '7Z': 'zip',
}

// One colour per site, derived from the domain, so the same site reads the same
// all the way down the list.
const HUES = ['blue', 'green', 'violet', 'amber', 'grey']
function hueOf(host: string) {
  let h = 0
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) >>> 0
  return HUES[h % HUES.length]
}

// What the server says when speech-to-text is not set up depends on the piece
// that is missing: no provider, an unknown one, or a provider without its key.
const NO_SPEECH = /no_provider|provider|api_key is not set/i

// The server's link pattern (chat.js LINK_RE), so the links taken out of a
// message here are the ones the server listed.
const LINKS_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+[^\s<>"')\].,;:!?]/gi

// The message a link came in, as the line under it. The row's own URL is on
// the line above, and a message with two links is a row for each, so whole
// URLs here only repeat: each one is cut down to its site, the way the row's
// title names it ("Vendor portal is befach.com and the tracker is trello.com").
// A message that is nothing but links gets no line at all.
function linkSnippet(text: string) {
  if (!/[\p{L}\p{N}]/u.test(text.replace(LINKS_IN_TEXT, ''))) return ''
  return text.replace(LINKS_IN_TEXT, (m) => {
    try { return new URL(/^www\./i.test(m) ? `https://${m}` : m).hostname.replace(/^www\./i, '') } catch { return '' }
  }).replace(/\s+/g, ' ').trim()
}

// --------------------------------------------------------------------- time

// Two timestamp shapes reach the client: the app's ISO ('2026-09-30T06:44:46.490Z',
// once with six fractional digits) and SQLite's datetime('now') ('2026-09-29
// 08:35:17', UTC with no zone). JS reads the second as LOCAL time and Safari
// refuses it outright, so everything becomes ISO-with-a-zone before a Date sees it.
function toIso(ts: string | null | undefined) {
  const s = String(ts || '').trim()
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(s)
  if (!m) return s
  const zone = !m[4] || m[4].toUpperCase() === 'Z' ? 'Z' : m[4].includes(':') ? m[4] : `${m[4].slice(0, 3)}:${m[4].slice(3)}`
  return `${m[1]}T${m[2]}${m[3] ? m[3].slice(0, 4) : ''}${zone}`
}
const valid = (ts: string) => !isNaN(new Date(toIso(ts)).getTime())
const dayOf = (ts: string) => (valid(ts) ? fmtDay(toIso(ts)) : '')
const clockOf = (ts: string) => (valid(ts) ? fmtClock(toIso(ts)) : '')
// A row whose timestamp cannot be read still gets a heading, not "Invalid Date".
const periodOf = (ts: string) => (valid(ts) ? periodLabel(toIso(ts)) : 'Earlier')

// Player time, '0:42' or '1:05:09', the same reading the voice-note player gives.
function playTime(sec: number) {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}

// Tab badges stay short (1.2k, not 1234) so five tabs still fit a phone.
const fmtCount = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '')}k`)

const who = (it: { sender_id: string; sender_name: string }, meId: string) =>
  it.sender_id === meId ? 'You' : it.sender_name || 'Unknown'

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + '…' : s)

// The server sets audio_kind from the file name the uploader gave; read the name
// the same way should the field ever be missing.
function audioKindOf(it: MediaFileItem) {
  if (it.audio_kind) return it.audio_kind
  const n = (it.name || '').toLowerCase()
  return n.startsWith('voice-note') ? 'voice-note' : n.startsWith('call-recording') ? 'call-recording' : 'audio'
}

// ------------------------------------------------------------- file actions

// Viewing never downloads: ?download=1 is only ever added by a Download button.
// In the phone app a new tab is the browser: the file is downloaded and opened
// in the phone's own viewer instead (lib/saveFile).
function openFile(id: string, name: string) {
  if (nativeFiles()) { downloadFile({ url: chatFileUrl(id, true), name, key: 'chat:' + id }); return }
  window.open(chatFileUrl(id), '_blank', 'noopener')
}

// The same route as the chat's own Download: ?download=1 makes the server send
// the file as an attachment, so the browser saves it rather than navigating.
function saveFile(id: string, name: string) {
  downloadFile({ url: chatFileUrl(id, true), name: name || 'file', key: 'chat:' + id })
}

// Only ever hand the browser a web address. The server already keeps links to
// http(s); this is the last line should anything else ever get through.
function openLink(url: string) {
  if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer')
}

// A recording just summarised: its row offers View summary from now on.
function withMeeting(tabs: Tabs, messageId: string, meetingId: string): Tabs {
  const d = tabs.audio
  if (!d) return tabs
  return { ...tabs, audio: { ...d, items: d.items.map((i) => (i.id === messageId && i.kind !== 'links' ? { ...i, meeting_id: meetingId } : i)) } }
}

// What to measure "in view" against. .ci-body is meant to be the bounded box
// that scrolls, and observing against it is what lets a margin reach below its
// visible edge. A layout that lets it grow with its content instead would make
// every row count as in view (every video mounted, every page fetched at once),
// so then fall back to the viewport, which clips correctly either way.
function scrollRoot(el: Element) {
  const box = el.closest('.ci-body')
  return box && box.scrollHeight > box.clientHeight + 1 ? box : null
}

// Whether an element is within `margin` of the panel's visible box. Players
// mount only when they are about to be seen: a page of sixty voice notes would
// otherwise open sixty connections for metadata nobody has asked for yet.
// `stay` keeps it mounted once seen (a voice note playing must survive being
// scrolled away from); without it, it unmounts again when far off.
function useNear<T extends Element>(margin: string, stay: boolean) {
  const ref = useRef<T | null>(null)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') { setNear(true); return }
    const io = new IntersectionObserver((entries) => {
      const hit = entries[entries.length - 1].isIntersecting
      if (!stay) setNear(hit)
      else if (hit) { setNear(true); io.disconnect() }
    }, { root: scrollRoot(el), rootMargin: margin })
    io.observe(el)
    return () => io.disconnect()
  }, [margin, stay])
  return [ref, near] as const
}

// --------------------------------------------------------------------- view

export interface MediaViewProps {
  convId: string
  me: Me
  initialTab: MediaKind
  // From the info call, so the tab badges show before the first page lands.
  counts?: MediaCounts
  // False while another panel view sits on top of this one (the panel keeps
  // it mounted underneath, hidden, so Back returns to the same place).
  active?: boolean
  // An image or video to open in the viewer as soon as the first page of
  // initialTab has it: a thumbnail tapped on the info page.
  openId?: string
  onShowMessage: (messageId: string) => void
  onOpenMeeting: (meetingId: string) => void
}

export function MediaView(props: MediaViewProps): JSX.Element {
  // Keyed by conversation: one chat's pages, scroll and open viewer must never
  // show against another's, however the panel happens to be reused.
  return <MediaBrowser key={props.convId} {...props} />
}

function MediaBrowser({ convId, me, initialTab, counts: infoCounts, active = true, openId, onShowMessage, onOpenMeeting }: MediaViewProps) {
  const uid = useId()
  const start: MediaKind = MEDIA_TABS.some((t) => t.key === initialTab) ? initialTab : 'images'

  const [tab, setTab] = useState<MediaKind>(start)
  const [tabs, setTabs] = useState<Tabs>({})
  const [counts, setCounts] = useState<MediaCounts | null>(infoCounts || null)
  const [viewer, setViewer] = useState<{ kind: GridKind; index: number } | null>(null)
  const [summarising, setSummarising] = useState<string | null>(null)

  const rootRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  // The request in flight per tab. A ref, not state: two observer callbacks in
  // one frame would both read the state from before the first one's update.
  const inflight = useRef<Partial<Record<MediaKind, boolean>>>({})
  const tabsRef = useRef(tabs)
  useLayoutEffect(() => { tabsRef.current = tabs })
  // Read by work that finishes later (a summary landing): whether this view is
  // still the one on screen, with nothing open over it.
  const activeRef = useRef(active)
  const viewerRef = useRef(viewer)
  useLayoutEffect(() => { activeRef.current = active; viewerRef.current = viewer })
  // Where each tab was scrolled to, so switching back finds the same place.
  const scrollAt = useRef<Partial<Record<MediaKind, number>>>({})
  // Set once the person picks a tab; until then the panel's suggestion wins.
  const picked = useRef(false)

  // Toasts sit under the viewer (1000 against its 1250): one that arrives while
  // it is open waits until it closes, or until this view goes.
  const held = useRef<(() => void) | null>(null)
  const notify = (show: () => void) => { if (alive.current && viewerRef.current) held.current = show; else show() }
  const flush = () => { const show = held.current; held.current = null; if (show) show() }
  useEffect(() => { if (!viewer) flush() }, [viewer])

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; flush() }
  }, [])
  // The panel may only learn which tab has anything in it after this view is
  // open (its info call can land later), so follow its pick until they choose.
  useEffect(() => { if (!picked.current) setTab(start) }, [start])
  useEffect(() => { if (infoCounts) setCounts(infoCounts) }, [infoCounts])

  const scroller = () => (rootRef.current ? (rootRef.current.closest('.ci-body') as HTMLElement | null) : null)

  const load = useCallback((kind: MediaKind, more: boolean) => {
    const cursor = more ? (tabsRef.current[kind] || BLANK).next : null
    if (inflight.current[kind] || (more && !cursor)) return
    inflight.current[kind] = true
    setTabs((t) => ({ ...t, [kind]: { ...(t[kind] || BLANK), loading: true, error: null } }))
    chatInfoApi.media(convId, kind, cursor)
      .then((page) => {
        if (!alive.current) return
        setTabs((t) => {
          const base = more ? (t[kind] || BLANK).items : []
          const seen = new Set(base.map((i) => i.id))
          const fresh: MediaItem[] = []
          for (const it of page.items || []) {
            if (it && !seen.has(it.id)) { seen.add(it.id); fresh.push(it) }
          }
          // A follow-on page that adds nothing new, or hands back the cursor it
          // was given, would otherwise have the scroll sentinel asking forever.
          const next = page.next && (!more || (fresh.length > 0 && page.next !== cursor)) ? page.next : null
          return { ...t, [kind]: { items: base.concat(fresh), next, loaded: true, loading: false, error: null } }
        })
        if (page.counts) setCounts(page.counts)
      })
      .catch((e: any) => {
        if (!alive.current) return
        setTabs((t) => ({ ...t, [kind]: { ...(t[kind] || BLANK), loading: false, error: (e && e.message) || 'Something went wrong.' } }))
      })
      .finally(() => { inflight.current[kind] = false })
  }, [convId])

  const cur = tabs[tab] || BLANK
  const grid = tab === 'images' || tab === 'videos'

  // First page of whichever tab is open. An error waits for Retry rather than
  // hammering a server that just said no.
  useEffect(() => {
    if (!cur.loaded && !cur.loading && !cur.error) load(tab, false)
  }, [tab, cur.loaded, cur.loading, cur.error, load])

  // Infinite scroll. Recreated after every page: a new observer reports at once
  // whether the sentinel is still in reach, which is what keeps a short first
  // page (or a tall screen) loading until the list passes the fold.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !cur.next || cur.loading || cur.error || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries[entries.length - 1].isIntersecting) load(tab, true)
    }, { root: scrollRoot(el), rootMargin: '0px 0px 700px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [tab, cur.next, cur.loading, cur.error, load])

  const lbItems = viewer ? ((tabs[viewer.kind] || BLANK).items as MediaFileItem[]) : []
  useEffect(() => {
    if (!viewer) return
    const d = tabs[viewer.kind] || BLANK
    if (!d.items[viewer.index]) { setViewer(null); return }
    // Near the end of what has loaded, fetch on, so → keeps going past the
    // grid's first page instead of stopping at an arbitrary sixtieth photo.
    if (d.next && !d.loading && !d.error && viewer.index >= d.items.length - 3) load(viewer.kind, true)
  }, [viewer, tabs, load])

  // Period headers stick just under the tab bar, so they need its real height,
  // which moves with the font size.
  useLayoutEffect(() => {
    const bar = barRef.current, root = rootRef.current
    if (!bar || !root) return
    const apply = () => root.style.setProperty('--ci-media-top', `${Math.floor(bar.getBoundingClientRect().height)}px`)
    apply()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(apply)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [])

  // Each tab keeps its own place. This also starts a fresh view at the top,
  // whatever the panel's scroller was showing before. The scroller is the
  // panel's, shared with the view on top while this one is hidden: hands off.
  useLayoutEffect(() => {
    const sc = scroller()
    if (sc && activeRef.current) sc.scrollTop = scrollAt.current[tab] || 0
  }, [tab])

  // The bar scrolls sideways on a phone; keep the open tab in sight.
  useEffect(() => {
    const bar = barRef.current
    const btn = bar && bar.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!bar || !btn) return
    const l = btn.offsetLeft, r = l + btn.offsetWidth
    if (l < bar.scrollLeft) bar.scrollLeft = Math.max(0, l - 8)
    else if (r > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = r - bar.clientWidth + 8
  }, [tab])

  const pick = (k: MediaKind) => {
    picked.current = true
    const sc = scroller()
    if (k === tab) {
      // Tapping the open tab again goes back to the top, as tab bars do.
      if (sc) sc.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    if (sc) scrollAt.current[tab] = sc.scrollTop
    setTab(k)
  }

  // Arrow keys move along the tabs and select as they go (the WAI-ARIA tabs
  // pattern); only the selected tab sits in the Tab order.
  const onTabKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const n = MEDIA_TABS.length
    const i = MEDIA_TABS.findIndex((t) => t.key === tab)
    const j = e.key === 'ArrowRight' ? (i + 1) % n
      : e.key === 'ArrowLeft' ? (i + n - 1) % n
        : e.key === 'Home' ? 0
          : e.key === 'End' ? n - 1 : -1
    if (j < 0 || j === i) return
    e.preventDefault()
    pick(MEDIA_TABS[j].key)
    const btns = barRef.current ? barRef.current.querySelectorAll<HTMLElement>('[role="tab"]') : null
    if (btns && btns[j]) btns[j].focus()
  }

  const moveViewer = useCallback((index: number) => setViewer((v) => (v ? { ...v, index } : v)), [])
  const closeViewer = useCallback((lastId?: string) => {
    setViewer(null)
    if (!lastId) return
    // useDialog hands focus back to the tile that opened the viewer. If the
    // arrows moved on, the tile last looked at is where the person now is.
    requestAnimationFrame(() => {
      const root = rootRef.current
      const el = root && Array.from(root.querySelectorAll<HTMLElement>('[data-mid]')).find((n) => n.dataset.mid === lastId)
      if (!el) return
      el.focus({ preventScroll: true })
      el.scrollIntoView({ block: 'nearest' })
    })
  }, [])

  // Something else came on top (the panel pushed a view): a viewer left open
  // over it would cover the new view. Focus and scroll stay where they are;
  // they belong to that view now.
  useEffect(() => { if (!active) setViewer(null) }, [active])

  // Opened on a tapped thumbnail: once the first page of the tab it opened on
  // is in, show that item. Only that first page counts, and only once: a
  // viewer springing open later, after scrolling or a tab change, would come
  // out of nowhere.
  const opened = useRef<string | null>(null)
  useEffect(() => {
    if (!openId || opened.current === openId || !active) return
    if ((start !== 'images' && start !== 'videos') || tab !== start) { opened.current = openId; return }
    const d = tabs[start]
    if (!d || !d.loaded) return
    opened.current = openId
    const i = d.items.findIndex((x) => x.id === openId)
    if (i >= 0) setViewer({ kind: start, index: i })
  }, [openId, active, start, tab, tabs])

  // A recording in the chat becomes a meeting summary with tasks to review:
  // the same request as the thread's own "Summary & tasks" button. One at a
  // time, because each one is a paid transcription.
  const summarise = async (it: MediaFileItem) => {
    if (summarising) return
    setSummarising(it.id)
    try {
      const d = await api.post(`/chat/message/${it.id}/to-meeting`)
      if (!d || !d.id) throw new Error('The server did not say which meeting it made.')
      const n = Number(d.suggestion_count) || 0
      const found = n ? `${n} task${n === 1 ? '' : 's'} found` : 'no tasks found'
      setTabs((t) => withMeeting(t, it.id, d.id))
      // Transcribing takes a while, and meanwhile they may have opened another
      // summary (the panel keeps this view mounted under it) or the viewer.
      // Only someone still looking at this list is taken to the summary; anyone
      // else is told it is ready, and the row now offers View summary.
      if (alive.current && activeRef.current && !viewerRef.current) {
        toast.success(d.existing ? 'Opening the summary' : n ? `${found} — review and assign` : 'Summary ready — no tasks found')
        onOpenMeeting(d.id)
      } else {
        notify(() => toast.success(d.existing
          ? 'That recording already has a summary. Open it with View summary.'
          : `Summary ready: ${found}. Open it with View summary on the recording.`))
      }
    } catch (e: any) {
      const msg = (e && e.message) || ''
      notify(() => toast.error(NO_SPEECH.test(msg)
        ? 'Transcription needs a speech provider key on the server before a recording can be summarised.'
        : 'Could not summarise that recording: ' + (msg || 'unknown error')))
    } finally {
      if (alive.current) setSummarising(null)
    }
  }

  const reviewer = canReview(me)
  const tabMeta = MEDIA_TABS.find((t) => t.key === tab) || MEDIA_TABS[0]
  const runs = useMemo(() => groupRuns(cur.items, (it) => periodOf(it.created_at)), [cur.items])
  const indexOf = useMemo(() => new Map(cur.items.map((it, i) => [it.id, i] as [string, number])), [cur.items])

  // A fully loaded tab knows its exact size; until then, the server's count.
  const countOf = (k: MediaKind) => {
    const d = tabs[k]
    if (d && d.loaded && !d.next && !d.error) return d.items.length
    return counts ? counts[k] : undefined
  }

  const tileLabel = (it: MediaFileItem) => {
    const day = dayOf(it.created_at)
    const from = it.sender_id === me.id ? 'you' : it.sender_name || 'Unknown'
    return `${tab === 'images' ? 'Image' : 'Video'} from ${from}${day ? `, ${day}` : ''}`
  }

  let body: React.ReactNode
  if (!cur.loaded && cur.error) {
    body = (
      <div className="ci-error" role="alert">
        <span>Could not load {tabMeta.label.toLowerCase()}. {cur.error}</span>
        <button type="button" className="btn btn-sm" onClick={() => load(tab, false)}>Retry</button>
      </div>
    )
  } else if (!cur.loaded) {
    body = grid
      ? <div className="ci-media-grid" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <span key={i} className="skeleton ci-media-skel" />)}</div>
      : <div aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton ci-skel" />)}</div>
  } else if (!cur.items.length) {
    body = (
      <div className="ci-empty">
        <span className="ci-empty-ic"><Ic name={tabMeta.icon} size={24} /></span>
        <div className="ci-empty-title">{EMPTY[tab].title}</div>
        <div>{EMPTY[tab].hint}</div>
      </div>
    )
  } else {
    const footer = cur.loading
      ? <div className="ci-media-foot ci-media-loading" role="status"><span className="spinner" /> Loading more…</div>
      : cur.error
        ? (
          <div className="ci-error" role="alert">
            <span>Could not load more. {cur.error}</span>
            <button type="button" className="btn btn-sm" onClick={() => load(tab, true)}>Retry</button>
          </div>
        )
        // The scroll sentinel normally gets here first; this is for browsers
        // without IntersectionObserver, and for anyone who wants to press it.
        : cur.next
          ? <div className="ci-media-foot"><button type="button" className="btn btn-sm" onClick={() => load(tab, true)}>Load more</button></div>
          : null
    body = (
      <>
        {runs.map((r, ri) => (
          <section key={`${ri}:${r.label}`} className="ci-media-run">
            <div className="ci-period" role="heading" aria-level={3}>{r.label}</div>
            {grid
              ? (
                <div className="ci-media-grid">
                  {r.items.map((raw) => {
                    const it = raw as MediaFileItem
                    const open = () => setViewer({ kind: tab as GridKind, index: indexOf.get(it.id) ?? 0 })
                    return tab === 'images'
                      ? <ImageTile key={it.id} it={it} label={tileLabel(it)} onOpen={open} />
                      : <VideoTile key={it.id} it={it} label={tileLabel(it)} onOpen={open} />
                  })}
                </div>
              )
              : (
                <div className="ci-media-list">
                  {r.items.map((raw) => {
                    if (tab === 'links') {
                      const link = raw as LinkItem
                      return <LinkRow key={link.id} it={link} meId={me.id} onShow={() => onShowMessage(link.message_id)} />
                    }
                    const it = raw as MediaFileItem
                    if (tab === 'files') return <FileRow key={it.id} it={it} meId={me.id} onShow={() => onShowMessage(it.id)} />
                    return (
                      <AudioRow key={it.id} it={it} meId={me.id} reviewer={reviewer}
                        busy={summarising === it.id} blocked={!!summarising}
                        onShow={() => onShowMessage(it.id)} onSummarise={() => summarise(it)} onView={onOpenMeeting} />
                    )
                  })}
                </div>
              )}
          </section>
        ))}
        <div ref={sentinelRef} className="ci-media-sentinel" aria-hidden="true" />
        {footer}
      </>
    )
  }

  return (
    <div className="ci-media-view" ref={rootRef}>
      <div className="ci-tabs" role="tablist" aria-label="Shared in this chat" ref={barRef} onKeyDown={onTabKey}>
        {MEDIA_TABS.map((t) => {
          const on = t.key === tab
          const n = countOf(t.key)
          return (
            <button key={t.key} type="button" role="tab" id={`${uid}-tab-${t.key}`} aria-selected={on} aria-controls={`${uid}-panel`}
              tabIndex={on ? 0 : -1} className={'ci-tab' + (on ? ' active' : '')} onClick={() => pick(t.key)}>
              {t.label}
              {typeof n === 'number' && <span className="ci-tab-n">{fmtCount(n)}</span>}
            </button>
          )
        })}
      </div>
      <div id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${tab}`} aria-busy={cur.loading}>
        {body}
      </div>
      {/* Rendered into <body>: inside the panel the viewer would share the
          panel's stacking context (z-index 30) and sit under the bottom nav,
          the voice pill and every modal layer. */}
      {viewer && lbItems[viewer.index] && createPortal(
        <Lightbox
          kind={viewer.kind}
          items={lbItems}
          index={viewer.index}
          total={countOf(viewer.kind) || 0}
          meId={me.id}
          onIndex={moveViewer}
          onClose={closeViewer}
          onShowMessage={(mid) => { closeViewer(); onShowMessage(mid) }}
        />,
        document.body)}
    </div>
  )
}

// -------------------------------------------------------------------- tiles

function ImageTile({ it, label, onOpen }: { it: MediaFileItem; label: string; onOpen: () => void }) {
  // A row can outlive its file (a restore from a DB-only backup), and some
  // formats (HEIC from an iPhone) no browser here can draw. A quiet placeholder
  // beats the broken-image glyph; the viewer explains when it is opened.
  const [broken, setBroken] = useState(false)
  return (
    <button type="button" className="ci-media-tile" data-mid={it.id} onClick={onOpen} aria-label={label} title={it.caption || it.name || undefined}>
      {broken
        ? <span className="ci-media-ph"><Ic name="image" size={22} /></span>
        : <img src={chatFileUrl(it.id)} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />}
    </button>
  )
}

function VideoTile({ it, label, onOpen }: { it: MediaFileItem; label: string; onOpen: () => void }) {
  // Mounted while near the visible part of the list and dropped again once far
  // past it: every <video> holds a decoder and a connection, and a long chat
  // scrolled end to end would otherwise keep all of them alive at once.
  const [ref, near] = useNear<HTMLButtonElement>('300px 0px', false)
  const vid = useRef<HTMLVideoElement>(null)
  const [dur, setDur] = useState(0)
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    const v = vid.current
    if (!near || !v) return
    // A detached <video> keeps its resources until garbage collection gets to
    // it; dropping the source frees them now.
    return () => {
      v.removeAttribute('src')
      try { v.load() } catch { /* already released */ }
    }
  }, [near, broken])
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])
  const onMeta = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const d = e.currentTarget.duration
    if (isFinite(d) && d > 0) setDur(d)
    // A clip recorded in a browser has no length in its header (see
    // mediaLength). The tile's own element stays on its first frame.
    else if (d === Infinity && !dur) mediaLength(it.id, chatFileUrl(it.id), { video: true, size: it.size }).then((s) => { if (live.current && s) setDur(s) })
  }
  return (
    <button ref={ref} type="button" className="ci-media-tile" data-mid={it.id} onClick={onOpen} aria-label={label} title={it.caption || it.name || undefined}>
      {near && !broken && (
        // #t=0.1 asks for a real first frame as the poster: at 0 many encoders
        // give a black one, and iOS paints nothing until it has a time to seek to.
        <video ref={vid} src={chatFileUrl(it.id) + '#t=0.1'} preload="metadata" muted playsInline disablePictureInPicture disableRemotePlayback
          tabIndex={-1} aria-hidden="true" onLoadedMetadata={onMeta} onDurationChange={onMeta} onError={() => setBroken(true)} />
      )}
      {broken
        ? <span className="ci-media-ph"><Ic name="video" size={22} /></span>
        : <span className="ci-media-play" aria-hidden="true"><Ic name="play" size={14} /></span>}
      {dur > 0 && <span className="ci-media-dur" aria-hidden="true">{playTime(dur)}</span>}
    </button>
  )
}

// --------------------------------------------------------------------- rows
//
// Each row is a div holding the row's own <button> plus its action buttons
// beside it: a button inside a button is invalid and breaks keyboard focus.

function AudioRow({ it, meId, reviewer, busy, blocked, onShow, onSummarise, onView }: {
  it: MediaFileItem
  meId: string
  reviewer: boolean
  busy: boolean
  blocked: boolean
  onShow: () => void
  onSummarise: () => void
  onView: (meetingId: string) => void
}) {
  const [ref, near] = useNear<HTMLDivElement>('400px 0px', true)
  const kind = audioKindOf(it)
  const title = kind === 'voice-note' ? 'Voice note' : kind === 'call-recording' ? 'Call recording' : it.name || 'Audio'
  const day = dayOf(it.created_at), clock = clockOf(it.created_at)
  const meta = [title, who(it, meId), day && clock ? `${day}, ${clock}` : day].filter(Boolean).join(' · ')
  return (
    <div ref={ref} className="ci-media-li ci-media-li-audio" data-mid={it.id}>
      <div className="ci-media-audio-top">
        {/* The player plays the file in place (a hidden <audio> under its own
            controls). It never offers to save it: that is the button beside it. */}
        {near ? <VoicePlayer src={chatFileUrl(it.id)} id={it.id} size={it.size} /> : <span className="ci-media-vp-ph" />}
        <div className="ci-media-acts">
          <button type="button" className="ci-media-act" onClick={onShow} title="Show in chat" aria-label="Show in chat"><Ic name="chat" size={16} /></button>
          <button type="button" className="ci-media-act" onClick={() => saveFile(it.id, it.name)} title="Download" aria-label={`Download ${title}`}><Ic name="download" size={16} /></button>
        </div>
      </div>
      <div className="ci-media-meta">
        <Ic name={kind === 'voice-note' ? 'mic' : kind === 'call-recording' ? 'record' : 'music'} size={12} />
        <span title={meta}>{meta}</span>
      </div>
      {/* Two lines in the row, a little more on hover. Both are cut short on
          purpose: a call's transcript can run to pages, and every row would
          still lay all of it out just to show two lines. */}
      {it.transcript && (
        <div className="ci-media-transcript" title={clip(it.transcript, 600)}>{clip(it.transcript, 400)}</div>
      )}
      {/* A summary is for everyone in the chat to read; making one (a paid
          transcription, then tasks to assign) is for managers. */}
      {it.meeting_id
        ? (
          <button type="button" className="ci-media-chip" onClick={() => onView(it.meeting_id as string)}>
            <Ic name="ai" size={13} /> View summary
          </button>
        )
        : reviewer && (
          <button type="button" className="ci-media-chip" onClick={onSummarise} disabled={busy || blocked}>
            {busy ? <><span className="spinner" /> Summarising…</> : <><Ic name="ai" size={13} /> Summary &amp; tasks</>}
          </button>
        )}
    </div>
  )
}

function FileRow({ it, meId, onShow }: { it: MediaFileItem; meId: string; onShow: () => void }) {
  const ext = fileExt(it.name)
  const name = it.name || 'File'
  // 'FILE' is fileExt's stand-in for "no extension": fine on the badge, noise in the line.
  const sub = [fmtBytes(it.size), ext === 'FILE' ? '' : ext, who(it, meId), dayOf(it.created_at)].filter(Boolean).join(' · ')
  return (
    <div className="ci-media-li" data-mid={it.id}>
      <button type="button" className="ci-row" onClick={() => openFile(it.id, name)} title={`Open ${name}`}>
        <span className={'ci-media-ext ci-media-ext-' + (EXT_FAMILY[ext] || 'other')} aria-hidden="true">{ext}</span>
        <span className="ci-row-main">
          <span className="ci-row-title">{name}</span>
          <span className="ci-row-sub">{sub}</span>
        </span>
      </button>
      <div className="ci-media-acts">
        <button type="button" className="ci-media-act" onClick={onShow} title="Show in chat" aria-label="Show in chat"><Ic name="chat" size={16} /></button>
        <button type="button" className="ci-media-act" onClick={() => saveFile(it.id, name)} title="Download" aria-label={`Download ${name}`}><Ic name="download" size={16} /></button>
      </div>
    </div>
  )
}

function LinkRow({ it, meId, onShow }: { it: LinkItem; meId: string; onShow: () => void }) {
  const host = (it.domain || '').replace(/^www\./i, '')
  const letter = /^[a-z0-9]/i.test(host) ? host[0].toUpperCase() : ''
  const snippet = linkSnippet(it.text || '')
  return (
    <div className="ci-media-li ci-media-li-top" data-mid={it.id}>
      <button type="button" className="ci-row" onClick={() => openLink(it.url)} title={it.url}>
        <span className={'ci-media-letter ci-media-hue-' + hueOf(host)} aria-hidden="true">{letter || <Ic name="link" size={18} />}</span>
        <span className="ci-row-main">
          <span className="ci-row-title">{host || it.url}</span>
          <span className="ci-media-url">{it.url}</span>
          {snippet && <span className="ci-media-snippet">{snippet}</span>}
          <span className="ci-row-sub">{[who(it, meId), dayOf(it.created_at)].filter(Boolean).join(' · ')}</span>
        </span>
      </button>
      <div className="ci-media-acts">
        <button type="button" className="ci-media-act" onClick={onShow} title="Show in chat" aria-label="Show in chat"><Ic name="chat" size={16} /></button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------- viewer

// Images and videos, one at a time over the whole page. ←/→ (buttons, arrow
// keys or a swipe) walk the loaded items of the tab; a picture zooms (see
// ZoomMedia); Escape, the close button, a click on the dark ground, a pull
// down and Android's back button all close it.
function Lightbox({ kind, items, index, total, meId, onIndex, onClose, onShowMessage }: {
  kind: GridKind
  items: MediaFileItem[]
  index: number
  total: number
  meId: string
  onIndex: (index: number) => void
  onClose: (lastId?: string) => void
  onShowMessage: (messageId: string) => void
}) {
  const it = items[index]
  const close = () => onClose(it.id)
  // A quick double-tap on a thumbnail opens the viewer on the first tap and
  // lands the second on its dark ground, which would close it again at once.
  // Ground taps count only once the double-tap window and the open animation
  // are over. Kept here, not in ZoomMedia, which remounts on every swipe.
  const armedAt = useRef(Date.now() + 350)
  // Escape (capture phase, so the panel's own Escape leaves it alone), the
  // focus trap and the page scroll lock.
  const ref = useDialog<HTMLDivElement>(close)
  const closeRef = useRef(close)
  useEffect(() => { closeRef.current = close })
  const noun = kind === 'images' ? 'Image' : 'Video'
  const go = (step: number) => {
    const j = index + step
    if (j >= 0 && j < items.length) onIndex(j)
  }

  // useDialog has just focused the first button ("Show in chat"). Start on the
  // viewer itself instead: the arrow keys work at once, and a stray Enter cannot
  // send the person off into the chat.
  useEffect(() => { if (ref.current) ref.current.focus({ preventScroll: true }) }, [])

  // Android's back button closes the viewer, not the media page under it.
  useEffect(() => pushBackHandler(() => { closeRef.current(); return true }), [])

  // Resubscribed every render, so it always steps from the current item.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
      const t = e.target as HTMLElement | null
      if (e.key === 'Tab' && e.shiftKey && ref.current && t === ref.current) {
        // useDialog's trap wraps from its first button; from the viewer itself
        // Shift+Tab would otherwise walk out to the page behind.
        const btns = ref.current.querySelectorAll<HTMLElement>('button')
        if (btns.length) { e.preventDefault(); btns[btns.length - 1].focus() }
        return
      }
      // A focused video uses the arrow keys to seek.
      if (t && t.tagName === 'VIDEO') return
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  // The neighbours start loading now, so stepping to them is instant.
  useEffect(() => {
    if (kind !== 'images') return
    for (const n of [items[index + 1], items[index - 1]]) {
      if (!n) continue
      const img = new Image()
      img.decoding = 'async'
      img.src = chatFileUrl(n.id)
    }
  }, [kind, items, index])

  const count = Math.max(total, items.length)
  const when = [dayOf(it.created_at), clockOf(it.created_at), count > 1 ? `${index + 1} of ${count}` : ''].filter(Boolean).join(' · ')
  const atStart = index <= 0, atEnd = index >= items.length - 1

  return (
    <div className="ci-lb" ref={ref} role="dialog" aria-modal="true" aria-label={`${noun} viewer`} tabIndex={-1}>
      <div className="ci-lb-bar">
        <div className="ci-lb-who" aria-live="polite">
          <div className="ci-lb-name">{who(it, meId)}</div>
          <div className="ci-lb-when">{when}</div>
        </div>
        <div className="ci-lb-acts">
          <button type="button" className="ci-lb-btn" onClick={() => onShowMessage(it.id)} title="Show in chat" aria-label="Show in chat"><Ic name="chat" size={19} /></button>
          <button type="button" className="ci-lb-btn" onClick={() => openFile(it.id, it.name)} title="Open in a new tab" aria-label="Open in a new tab"><Ic name="external" size={19} /></button>
          <button type="button" className="ci-lb-btn" onClick={() => saveFile(it.id, it.name)} title="Download" aria-label="Download"><Ic name="download" size={19} /></button>
          <button type="button" className="ci-lb-btn" onClick={close} title="Close" aria-label="Close"><Ic name="close" size={21} /></button>
        </div>
      </div>
      <div className="ci-lb-stage">
        <ZoomMedia key={it.id} src={chatFileUrl(it.id)} video={kind === 'videos'} alt={it.caption || it.name || (kind === 'images' ? 'Image' : 'Video')}
          canPrev={!atStart} canNext={!atEnd} onStep={go} onClose={close} armedAt={armedAt.current} />
        {items.length > 1 && (
          <>
            {/* aria-disabled rather than disabled at either end: a disabled
                button drops keyboard focus to the page behind the viewer. */}
            <button type="button" className={'ci-lb-nav ci-lb-prev' + (atStart ? ' ci-lb-nav-off' : '')} aria-disabled={atStart}
              onClick={() => go(-1)} title="Previous" aria-label={`Previous ${noun.toLowerCase()}`}><Ic name="chevronRight" size={24} /></button>
            <button type="button" className={'ci-lb-nav ci-lb-next' + (atEnd ? ' ci-lb-nav-off' : '')} aria-disabled={atEnd}
              onClick={() => go(1)} title="Next" aria-label={`Next ${noun.toLowerCase()}`}><Ic name="chevronRight" size={24} /></button>
          </>
        )}
      </div>
      {it.caption && <div className="ci-lb-caption">{it.caption}</div>}
    </div>
  )
}
