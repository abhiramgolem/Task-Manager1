import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom'
import { api, getToken, userAvatarUrl, groupAvatarUrl, API_BASE, wsUrl } from '../api'
import { useAuth } from '../auth'
import { Avatar, EmptyState, Ic } from '../ui'
import { pushBackHandler } from '../back'
import { clearChatNotifications } from '../push'
import { toast } from '../lib/toast'
import { confirmDialog, resolveConfirm } from '../lib/confirm'
import { useDialog } from '../lib/useDialog'
import { clipboardFiles, droppedFiles, dragHasFiles, canReadClipboardImages, readClipboardImages } from '../lib/pasteFiles'
import { stashTaskDraft } from '../lib/taskDraft'
import { startCall } from '../lib/call'
import { useCallAnalyses, inProgress } from '../lib/callAnalysis'
import EmojiPicker, { rememberEmoji } from '../components/EmojiPicker'
import VoicePlayer from '../components/VoicePlayer'
import { audioFilename } from '../lib/audioFile'
import { startLiveSpeech, isSupported as speechSupported, LiveSpeech } from '../lib/liveSpeech'
import { useSurface } from '../voice/uiRegistry'
import { typeInto, flashPress, pause, settle, findVaEl } from '../voice/uiController'
import TaskDrawer from '../components/TaskDrawer'
import type { Member, Conversation, MentionRef, ChatFile, Msg, OrgUser, LocationRef, Poll } from '../components/chat/types'
import { fileUrl, isAudio, isEditable, isForwardable, isRecordLine, isVideo } from '../components/chat/types'
import {
  CopyGlyph, Ticks, PollGlyph, PinDropGlyph, ContactGlyph, CameraGlyph, GalleryGlyph, DocGlyph, TaskGlyph,
  ArchiveGlyph, InfoGlyph, SelectGlyph, ExportGlyph, PencilGlyph, ChevronDown, DotsV, SparkGlyph,
} from '../components/chat/glyphs'
import TaskAssignSheet, { Draft } from '../components/chat/TaskAssignSheet'
import { TaskCard, PollCard, PollVotesSheet, LocationCard, ContactCard, LinkPreview, CallSummaryCard } from '../components/chat/MessageCards'
import { MessageInfoSheet, DeleteDialog, PollComposer, LocationPicker, ContactPicker, CallsSheet, DescriptionEditor } from '../components/chat/ChatDialogs'
import MediaViewer from '../components/chat/MediaViewer'
import ActionMenu, { type ActionItem } from '../components/chat/ActionMenu'
import ChatInfoPanel from '../components/ChatInfoPanel'
import type { InfoView, Me } from '../lib/chatInfo'

const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏']
const MAX_FILE = 1024 * 1024 * 1024 // 1 GB — the server's limit for a chat file

// ---- selecting a message on a touch screen (see selectMessage) ----
// How long a finger has to stay put for a press to become a long-press. Under
// half a second, like the platforms' own (Android's is 400ms).
const LONG_PRESS_MS = 420
// Room the floating reactions need inside the thread: the 52px tray, its 6px
// gap, and the 3px the selected row's tint reaches past the message.
const TRAY_ROOM = 62
// Room the mouse screen's quick-reaction row needs under a message's hover
// buttons (36px tall, and a little air) before it opens above them instead.
const REACT_ROOM = 48
// What inside a bubble keeps its own taps (TAP_SKIP) and its own presses
// (PRESS_SKIP). Links, images, the voice player and buttons open or play on a
// tap, but a long-press on any of them still selects the message, as in
// WhatsApp — the player row alone is a third of a voice note's bubble. Only
// fields (and native media controls) keep their presses.
const PRESS_SKIP = 'audio, video, input, textarea'
const TAP_SKIP = 'a, button, .vp, ' + PRESS_SKIP
// menuId's value while the action bar's own ⋮ menu is open (not a message id).
const SEL_MENU = '__selection__'
// One action a message offers — shared by the desktop menu and the phone bar.
interface MsgAction { key: string; label: string; icon?: React.ComponentProps<typeof Ic>['name']; glyph?: 'copy' | 'pencil'; bar?: boolean; on?: boolean; danger?: boolean; run: () => void }
// The mouse screen's ⋯ menu (deskMenu): what it leaves to the hover buttons
// beside it, the groups it shows the rest in, and an icon for every row —
// msgActions only carries icons for the phone bar's few.
const ON_HOVER_TOOLS = new Set(['reply', 'edit', 'task'])
const DESK_MENU_GROUPS = [
  ['private', 'forward', 'copy', 'share', 'download'],
  ['star', 'pin', 'remind', 'unread'],
  ['fork', 'select', 'info'],
  ['delete'],
]
const DESK_MENU_ICONS: Record<string, React.ReactNode> = {
  private: <Ic name="user" size={16} />,
  share: <Ic name="upload" size={16} />,
  download: <Ic name="download" size={16} />,
  pin: <Ic name="pin" size={16} />,
  remind: <Ic name="clock" size={16} />,
  unread: <Ic name="chat" size={16} />,
  fork: <Ic name="merge" size={16} />,
  select: <SelectGlyph size={16} />,
  info: <InfoGlyph size={16} />,
}
// A file waiting above the composer for Send; `url` is a preview for pictures.
interface StagedFile { id: string; file: File; url: string | null }
// How many files can wait for one Send.
const MAX_STAGED = 10
// A message longer than this folds behind "Read more", as on WhatsApp — one
// pasted log should not push a whole conversation off the screen.
// Messages from one person this close together read as one turn (see `cont`).
const RUN_GAP_MS = 5 * 60_000
// A held voice note: slide this far left to cancel, this far up to lock; a
// press shorter than HOLD_TAP_MS is a tap.
const SLIDE_CANCEL_PX = 110
const SLIDE_LOCK_PX = 70
const HOLD_TAP_MS = 400
const FOLD_CHARS = 700
const FOLD_LINES = 14
// The folded part: whole lines up to the limit, then whole words, then "…".
function foldText(text: string) {
  let t = text.split('\n').slice(0, FOLD_LINES).join('\n')
  if (t.length > FOLD_CHARS) {
    t = t.slice(0, FOLD_CHARS)
    const sp = t.lastIndexOf(' ')
    if (sp > FOLD_CHARS * 0.7) t = t.slice(0, sp)
  }
  return t.replace(/\s+$/, '') + '…'
}
// How far a finger drags a message right before letting go replies to it.
const SWIPE_REPLY_PX = 56
// Unsent text per chat, kept on this device (WhatsApp's "Draft:" in the list).
const DRAFTS_KEY = 'chatDrafts'
const readDrafts = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) || '{}') || {} } catch { return {} } }
const writeDrafts = (d: Record<string, string>) => { try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(d)) } catch { /* private mode: just not kept */ } }

function relTime(iso: string | null) {
  if (!iso) return ''
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  return Math.floor(s / 86400) + 'd'
}
function fmtSize(n?: number) {
  if (!n) return ''
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB'
  return (n / 1048576).toFixed(1) + ' MB'
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })
}
// Local calendar day as YYYY-MM-DD. toISOString() would shift the day for
// anyone east or west of UTC, which is the whole user base here.
function isoDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function dayLabel(iso: string) {
  const d = new Date(iso), today = new Date(), yest = new Date()
  yest.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yest.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function lastSeenLabel(iso?: string | null) {
  if (!iso) return ''
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'last seen just now'
  if (s < 3600) return `last seen ${Math.floor(s / 60)}m ago`
  if (s < 86400) return `last seen ${Math.floor(s / 3600)}h ago`
  const d = new Date(iso)
  const isYesterday = (Date.now() - new Date(iso).getTime()) < 172800000
  return `last seen ${isYesterday ? 'yesterday' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}

// Avatar with an "online" green dot (and optional photo).
function PresenceAvatar({ name, color, size, online, src }: { name?: string; color?: string; size: number; online?: boolean; src?: string }) {
  return <span className="avatar-wrap"><Avatar name={name} color={color} size={size} src={src} />{online && <span className="online-dot" />}</span>
}

// ---------- slash commands ----------
// Cliq's /commands, minus the developer platform behind them. These are the ones
// that save a real trip through the UI; a command that just opens a dialog you
// could have clicked is noise, so there are only seven.
interface SlashCmd { name: string; args?: string; help: string; manager?: boolean }
const SLASH: SlashCmd[] = [
  { name: 'task', args: '<what needs doing>', help: 'Turn the rest of the line into a task' },
  { name: 'call', help: 'Start an audio call here' },
  { name: 'video', help: 'Start a video call here' },
  { name: 'status', args: '<message>', help: 'Set your status' },
  { name: 'dnd', args: '<minutes>', help: 'Do not disturb — 0 turns it off' },
  { name: 'search', args: '<words>', help: 'Search every conversation' },
  { name: 'shrug', help: String.fromCharCode(175) + '\\_(' + String.fromCharCode(12484) + ')_/' + String.fromCharCode(175) },
]

// The half-typed command at the caret, if the line starts with one.
function slashQueryAt(value: string) {
  const m = /^\/([a-z]*)$/i.exec(value)
  return m ? m[1].toLowerCase() : null
}

// ---------- workload chip ----------
// What a chat app normally cannot tell you: what this person is already holding.
// Silent when they are clear — a chip on everyone teaches people to ignore it.
// It names what it counts ("open tasks", "overdue"): the bare "107 open · 104
// late" it used to show under a group's name read as a riddle, not a workload.
// Given onClick it is a button that opens the explanation (see LoadPop).
function LoadChip({ load, compact, onClick }: { load?: { open: number; overdue: number }; compact?: boolean; onClick?: (e: React.MouseEvent) => void }) {
  if (!load || !load.open) return null
  const late = load.overdue > 0
  const tasks = `${load.open} open task${load.open === 1 ? '' : 's'}`
  const title = `${tasks}${late ? `, ${load.overdue} overdue` : ''}`
  const body = (
    <>
      {late ? <Ic name="warning" size={10} /> : <Ic name="check" size={10} />}
      <span className="load-chip-text">
        {compact
          ? `${load.open} open${late ? ` · ${load.overdue} late` : ''}`
          : `${tasks}${late ? ` · ${load.overdue} overdue` : ''}`}
      </span>
    </>
  )
  const cls = 'load-chip' + (late ? ' late' : '')
  return onClick
    ? <button type="button" className={cls + ' load-chip-btn'} title={title} aria-label={`${title}. What does this mean?`} onClick={onClick}>{body}</button>
    : <span className={cls} title={title}>{body}</span>
}

// Tapping the chip says what the numbers are, in a sentence, and (for managers,
// who can open anyone's list) offers the tasks behind them.
function LoadPop({ name, load, canOpen, onOpen }: { name: string; load: { open: number; overdue: number }; canOpen: boolean; onOpen: () => void }) {
  const first = name.split(' ')[0]
  const tasks = `${load.open} open task${load.open === 1 ? '' : 's'}`
  return (
    <div className="load-pop" role="dialog" aria-label={`${first}'s workload`} onClick={(e) => e.stopPropagation()}>
      <div className="load-pop-title"><Ic name="check" size={14} /> {first}'s workload</div>
      <p>
        {first} has <b>{tasks}</b> in VoTask{load.overdue > 0
          ? <>, and <b>{load.overdue} {load.overdue === 1 ? 'is' : 'are'} past the due date</b>.</>
          : '. None are overdue.'}
      </p>
      <p className="muted">Shown here so you can see what someone is already carrying before you hand them more.</p>
      {canOpen && <button className="btn btn-sm" onClick={onOpen}>View {first}'s tasks</button>}
    </div>
  )
}

// The list's views, WhatsApp's filter chips. "Personal" is the one-to-one
// chats (type 'direct'); "Unread" is anything with new messages or marked
// unread by hand.
type ListTab = 'all' | 'unread' | 'group' | 'direct'
const LIST_TABS: { id: ListTab; label: string; empty: string }[] = [
  { id: 'all', label: 'All', empty: 'No chats yet' },
  { id: 'unread', label: 'Unread', empty: 'You are all caught up' },
  { id: 'group', label: 'Groups', empty: 'No group chats yet' },
  { id: 'direct', label: 'Personal', empty: 'No personal chats yet' },
]
const LIST_TAB_KEY = 'chatsListTab'

// ---------- @mentions ----------
const ALL_TOKENS = ['all', 'everyone']
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The @-token being typed, if the caret sits at the end of one. Allows a single
// space so "@Ravi Kumar" keeps matching while it's typed; two spaces ends it,
// which is what stops an ordinary sentence after a mention from re-opening the
// picker.
function mentionQueryAt(value: string, caret: number): { q: string; start: number } | null {
  const upto = value.slice(0, caret)
  const m = /(?:^|\s)@([^@\s]{0,24}(?:\s[^@\s]{0,24})?)$/.exec(upto)
  if (!m) return null
  return { q: m[1], start: upto.length - m[1].length - 1 }
}

// Which teammates a body still names. The text is the source of truth, not the
// picker: deleting "@Ravi" out of the draft has to un-mention Ravi, or people get
// pinged by a name that is no longer in the message.
function resolveMentions(text: string, picked: MentionRef[], members: Member[], meId: string): string[] {
  const ids = new Set<string>()
  if (new RegExp(`@(${ALL_TOKENS.join('|')})\\b`, 'i').test(text)) {
    for (const m of members) if (m.id !== meId) ids.add(m.id)
  }
  for (const p of picked) if (text.includes('@' + p.name)) ids.add(p.id)
  ids.delete(meId)
  return [...ids]
}

// Render a message body: fenced code, inline code, *bold*, _italic_, ~strike~,
// links, and the @names.
//
// Deliberately a hand-rolled subset rather than a markdown library. A full
// markdown renderer on chat input is a liability — it turns a lone asterisk or an
// underscore in a filename into formatting, swallows indentation as a code block,
// and (with anything that emits HTML) hands us an injection surface for free.
// This handles the five things people actually type in a work chat and leaves
// every other character alone. Nothing here produces HTML: it is all React nodes,
// so message text can never be interpreted as markup.
const CODE_FENCE = /```([\s\S]*?)```/g
// A conservative URL matcher — stops at whitespace and trailing punctuation so a
// link at the end of a sentence doesn't swallow the full stop.
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g

function renderInline(text: string, mentionNames: string[], meNames: Set<string>, keyBase: string): React.ReactNode[] {
  // One pass, longest-first so `@Ravi Kumar` never matches as `@Ravi`, and so
  // ``` has already been taken out by the caller.
  const names = [...mentionNames].sort((a, b) => b.length - a.length).map(reEsc)
  const parts: string[] = ['`[^`\\n]+`', '\\*[^*\\n]+\\*', '_[^_\\n]+_', '~[^~\\n]+~', URL_RE.source]
  if (names.length) parts.push('@(?:' + names.join('|') + ')\\b')
  parts.push('@(?:all|everyone)\\b')
  const re = new RegExp(parts.join('|'), 'gi')

  const out: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    const k = `${keyBase}-${i++}`
    if (tok.startsWith('`') && tok.endsWith('`')) out.push(<code key={k} className="msg-code">{tok.slice(1, -1)}</code>)
    else if (tok.startsWith('*') && tok.endsWith('*')) out.push(<b key={k}>{tok.slice(1, -1)}</b>)
    else if (tok.startsWith('_') && tok.endsWith('_')) out.push(<i key={k}>{tok.slice(1, -1)}</i>)
    else if (tok.startsWith('~') && tok.endsWith('~')) out.push(<s key={k}>{tok.slice(1, -1)}</s>)
    else if (/^https?:\/\//i.test(tok)) out.push(<a key={k} href={tok} target="_blank" rel="noopener noreferrer" className="msg-link">{tok}</a>)
    else {
      const who = tok.slice(1)
      out.push(<span key={k} className={'mention-chip' + (meNames.has(who.toLowerCase()) ? ' me' : '')}>{tok}</span>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// Mark every place the in-chat search matches, inside plain text only (a link
// or a mention chip keeps its own look).
function markMatches(nodes: React.ReactNode[], q: string): React.ReactNode[] {
  const needle = q.trim().toLowerCase()
  if (!needle) return nodes
  return nodes.flatMap((n, i) => {
    if (typeof n !== 'string') return [n]
    const out: React.ReactNode[] = []
    const low = n.toLowerCase()
    let at = 0
    for (let hit = low.indexOf(needle); hit >= 0; hit = low.indexOf(needle, at)) {
      if (hit > at) out.push(n.slice(at, hit))
      out.push(<mark key={`h${i}-${hit}`} className="msg-hit">{n.slice(hit, hit + needle.length)}</mark>)
      at = hit + needle.length
    }
    if (at < n.length) out.push(n.slice(at))
    return out
  })
}

function MessageText({ body, mentions, meId, fromMe, highlight }: { body: string; mentions?: MentionRef[]; meId: string; fromMe: boolean; highlight?: string }) {
  const refs = mentions || []
  const names = refs.map((r) => r.name)
  // Which @names refer to ME — drives the stronger chip. @all counts, but not in
  // my own message, where I am the one doing the summoning.
  const meNames = new Set<string>()
  for (const r of refs) if (r.id === meId) meNames.add(r.name.toLowerCase())
  if (!fromMe) { meNames.add('all'); meNames.add('everyone') }

  const nodes: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  CODE_FENCE.lastIndex = 0
  while ((m = CODE_FENCE.exec(body)) !== null) {
    if (m.index > last) nodes.push(...renderInline(body.slice(last, m.index), names, meNames, `t${i}`))
    nodes.push(<pre key={`c${i}`} className="msg-pre"><code>{m[1].replace(/^\n/, '').replace(/\n$/, '')}</code></pre>)
    last = m.index + m[0].length
    i++
  }
  if (last < body.length) nodes.push(...renderInline(body.slice(last), names, meNames, `t${i}`))

  return <span className="bubble-text">{highlight ? markMatches(nodes, highlight) : nodes}</span>
}

// Group avatar: uploaded photo if present, else a '#' tile.
function GroupAvatar({ conv, size }: { conv: { id: string; avatar_file?: string | null; avatar_color?: string }; size: number }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => { setBroken(false) }, [conv.avatar_file])
  if (conv.avatar_file && !broken) return <img className="avatar" src={groupAvatarUrl(conv.id, conv.avatar_file)} onError={() => setBroken(true)} style={{ width: size, height: size, objectFit: 'cover' }} />
  return <span className="avatar group-avatar" style={{ background: conv.avatar_color, width: size, height: size }}>#</span>
}

export default function Chats() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const loc = useLocation()
  // The open chat (and whether its info panel is open) as the current history
  // entry records it (see the history effects below). Read first so a Back into
  // Chats lands on the chat it left.
  const navState = loc.state as { chat?: string; info?: boolean; pushed?: boolean } | null
  const navChat = navState?.chat || ''
  const navInfo = !!navChat && !!navState?.info
  // Whether this page pushed the chat's entry onto a /chats list entry (see the
  // history effects): then closing the chat can step Back instead of replacing.
  const navPushed = !!navChat && !!navState?.pushed
  const [convos, setConvos] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState(navChat)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [search, setSearch] = useState('')       // sidebar people search
  const [inSearch, setInSearch] = useState('')   // in-conversation message search
  const [inSearchOpen, setInSearchOpen] = useState(false)
  // The search's matches over the chat's whole history, newest first, and the
  // one on screen — WhatsApp's "3 of 12" with ⌃ ⌄ to step between them.
  const [searchHits, setSearchHits] = useState<string[] | null>(null)
  const [hitAt, setHitAt] = useState(0)
  const [replyTo, setReplyTo] = useState<Msg | null>(null)
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  // The ⋯ a mouse-screen menu hangs from (ActionMenu is fixed to the window,
  // so it needs the button itself, not just which message it belongs to).
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  // Stable, so the menu's scroll and resize listeners are not re-attached on
  // every render of this page.
  const closeMsgMenu = useCallback(() => setMenuId(null), [])
  const [reactFor, setReactFor] = useState<string | null>(null)
  const [reactUp, setReactUp] = useState(false)
  const [typingName, setTypingName] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
  // Starts open when the entry being shown is an info entry (a reload with the
  // panel up, Back from a page opened from it).
  const [showInfo, setShowInfo] = useState(navInfo)
  const [showStarred, setShowStarred] = useState(false)
  const [showMentions, setShowMentions] = useState(false)
  const [jumpOpen, setJumpOpen] = useState(false)
  const [pinned, setPinned] = useState<Msg[]>([])
  const [pinsOpen, setPinsOpen] = useState(false)
  const [remindFor, setRemindFor] = useState<Msg | null>(null)
  const [showLater, setShowLater] = useState(false)
  const [showStatus, setShowStatus] = useState(false)
  const [muteFor, setMuteFor] = useState<Conversation | null>(null)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  // Files waiting to go with the next Send — pasted (Ctrl+V, or a phone's
  // clipboard), dropped on the thread, or picked with the clip — shown above the
  // box with a preview first, as WhatsApp does before it sends a picture; the
  // text in the box goes with them as the caption. A screenshot pasted by
  // accident is one ✕ away rather than already in front of the whole team.
  const [staged, setStaged] = useState<StagedFile[]>([])
  const stagedRef = useRef<StagedFile[]>([])
  stagedRef.current = staged
  const [dropping, setDropping] = useState(false)
  const dragDepthRef = useRef(0)
  const [attachMenu, setAttachMenu] = useState(false)
  // Press-and-hold on Send opens "Send later", as in Telegram. It is the only way
  // to it on a phone under 400px, where the clock button gives its room to the
  // text. `heldRef` swallows the click that ends the hold, so it doesn't send.
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heldRef = useRef(false)
  const endHold = () => { if (holdTimerRef.current) clearTimeout(holdTimerRef.current); holdTimerRef.current = null }
  const [myStatus, setMyStatus] = useState<{ status_text: string; status_emoji: string; dnd_until: string | null }>({ status_text: '', status_emoji: '', dnd_until: null })
  // Global message search: null = not searching, [] = searched and found nothing.
  const [hits, setHits] = useState<(Msg & { sender_name: string; conversation_name: string })[] | null>(null)
  const [hitsBusy, setHitsBusy] = useState(false)
  // open/overdue per teammate. The point of the whole feature: you see what
  // someone is already carrying at the moment you are about to hand them more.
  const [workload, setWorkload] = useState<Record<string, { open: number; overdue: number }>>({})
  const isManager = user?.role === 'manager' || user?.role === 'admin'
  const [emojiFor, setEmojiFor] = useState<string | null>(null)   // message id, or '__composer__'
  const [showChannels, setShowChannels] = useState(false)
  // Where the info panel opens: its main page, or a view inside it that what
  // opened it asked for (media, a meeting summary). A new object restarts the
  // panel's own stack of views, which the panel walks itself; infoStepRef is
  // its one step back (a view, or an inline editor on the main page), false
  // when there is nothing left to step out of. The history effects use it so
  // Back leaves a sub-view before it closes the panel.
  const [infoStart, setInfoStart] = useState<InfoView>({ view: 'info' })
  const infoStepRef = useRef<(() => boolean) | null>(null)
  // "Open that chat AND its info" (a list avatar): the info entry goes on top
  // of the chat's own history entry, so it waits for that entry to land.
  const pendingInfoRef = useRef<InfoView | null>(null)
  // Docked beside the thread (from 1400px, the CSS breakpoint) rather than
  // covering it: the thread stays usable, so its own keys and pickers do too.
  const [infoDocks, setInfoDocks] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 1400px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1400px)')
    const sync = () => setInfoDocks(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  const [headMenu, setHeadMenu] = useState(false)
  const [loadOpen, setLoadOpen] = useState(false)
  // WhatsApp's long-press, for touch screens (which have no hover to show the
  // desktop's per-message tools): a tap or a long-press on a bubble selects the
  // message. The selected message is highlighted, the six quick reactions float
  // over it, and the thread header turns into its action bar (reply, task, star,
  // copy, forward, delete, ⋮). One more tap reacts. `trayPlace` is where the
  // reactions fit: above the message, below it, or over its top edge when it is
  // too tall to have room on either side.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [trayPlace, setTrayPlace] = useState<'above' | 'below' | 'inside'>('above')
  // For 'inside' (a message taller than the room left around it): how far down
  // the message the tray sits, so it lands on the part that is on screen.
  const [trayTop, setTrayTop] = useState(8)
  // Touch screen or mouse, by the same test the stylesheet uses for the hover
  // tools — the two must agree, or a phone would get neither the hover row nor
  // the selection.
  const [touchUI, setTouchUI] = useState(() => typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(hover: none)')
    const sync = () => setTouchUI(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  // The press being timed for a long-press, and whether one just fired — the
  // click that ends a long-press must not toggle the selection straight back off.
  const pressRef = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const longPressedRef = useRef(false)
  // The message whose "who reacted" sheet is open.
  const [reactionsOf, setReactionsOf] = useState<string | null>(null)
  const [listTab, setListTab] = useState<ListTab>(() => {
    try { const v = localStorage.getItem(LIST_TAB_KEY); return v === 'group' || v === 'direct' || v === 'unread' ? v : 'all' } catch { return 'all' }
  })
  useEffect(() => { try { localStorage.setItem(LIST_TAB_KEY, listTab) } catch { /* private mode: just not remembered */ } }, [listTab])
  const [slashQ, setSlashQ] = useState<string | null>(null)
  const [slashIdx, setSlashIdx] = useState(0)
  const [forkFrom, setForkFrom] = useState<Msg | null>(null)
  const [recording, setRecording] = useState(false)
  const [recSecs, setRecSecs] = useState(0)
  // A voice note held down on a touch screen, as in WhatsApp: how far the finger
  // has slid left (null when nothing is held). Release sends, slide left
  // cancels, slide up locks it to carry on hands-free. A quick tap still starts
  // a hands-free note, which is how it worked before and what a mouse gets.
  const [holdDx, setHoldDx] = useState<number | null>(null)
  const holdRef = useRef<{ x: number; y: number; t: number } | null>(null)
  const touchPressRef = useRef(false)
  // Cancelled before the microphone had opened (a quick slide on a slow start).
  const pendingCancelRef = useRef(false)
  const [transcribing, setTranscribing] = useState<string | null>(null)
  const [summarising, setSummarising] = useState<string | null>(null)
  const [flashId, setFlashId] = useState<string | null>(null)
  // Forward takes a list: one message from its menu, several from a selection.
  const [forwardMsgs, setForwardMsgs] = useState<Msg[] | null>(null)
  // Assign a task without leaving the chat (TaskAssignSheet): the message it
  // came from, if any, and the server's pre-filled draft.
  const [assignFor, setAssignFor] = useState<{ source: Msg | null; draft: Draft } | null>(null)
  // A task opened from a card in the thread, over the chat.
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [infoFor, setInfoFor] = useState<Msg | null>(null)
  // Delete asks "for me, or for everyone?" — for one message or a selection.
  const [deleteFor, setDeleteFor] = useState<Msg[] | null>(null)
  // WhatsApp's multi-select: null when off; otherwise the ids picked, in the
  // order they were picked. Entered from a message's "Select", from ⋮, or (on a
  // touch screen) by tapping a second message while one is selected.
  const [multi, setMulti] = useState<string[] | null>(null)
  const [pollOpen, setPollOpen] = useState(false)
  const [votesFor, setVotesFor] = useState<string | null>(null)
  const [locOpen, setLocOpen] = useState(false)
  const [contactOpen, setContactOpen] = useState(false)
  const [callsOpen, setCallsOpen] = useState(false)
  const [viewerAt, setViewerAt] = useState<string | null>(null)
  const [descOpen, setDescOpen] = useState(false)
  // Older pages of a long chat, fetched on scrolling to the top.
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  // Calls that just ended being written up (lib/callAnalysis, fed by
  // CallCenter's socket) — for the line in their chat's thread.
  const analyses = useCallAnalyses()
  // Who is typing (or recording a voice note) in each chat, for the list rows.
  const [typingIn, setTypingIn] = useState<Record<string, { name: string; mode: string }>>({})
  const [typingMode, setTypingMode] = useState<'typing' | 'recording'>('typing')
  const [showArchived, setShowArchived] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>(readDrafts)
  // Messages opened past "Read more".
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set())
  // The thread scrolled away from the bottom: the ⌄ button, and how many new
  // messages arrived below while it was.
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const [newBelow, setNewBelow] = useState(0)
  const [threadLoading, setThreadLoading] = useState(false)
  // The message "Reply privately" is answering, carried across the switch to
  // the direct chat (switching chats otherwise drops a pending reply).
  const pendingReplyRef = useRef<Msg | null>(null)
  // @mention composer state: the open picker, its keyboard cursor, and everyone
  // picked so far in this draft (filtered against the text again at send time).
  const [mentionQ, setMentionQ] = useState<{ q: string; start: number } | null>(null)
  const [mentionIdx, setMentionIdx] = useState(0)
  const [picked, setPicked] = useState<MentionRef[]>([])
  const [online, setOnline] = useState<Set<string>>(new Set())
  const [lastSeen, setLastSeen] = useState<Record<string, string>>({})
  const [threadLastRead, setThreadLastRead] = useState<string | null>(null)
  const [convoMenu, setConvoMenu] = useState<string | null>(null)
  const closeConvoMenu = useCallback(() => setConvoMenu(null), [])
  const logRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const mediaRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const voiceRecRef = useRef<MediaRecorder | null>(null)
  const voiceChunksRef = useRef<BlobPart[]>([])
  const voiceStreamRef = useRef<MediaStream | null>(null)
  const voiceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const voiceCancelRef = useRef(false)
  // Recognised on this device while the note is being spoken, so the text is
  // ready the moment it sends — no server key, no second pass, no cost.
  const voiceSpeechRef = useRef<LiveSpeech | null>(null)
  const voiceTextRef = useRef<string[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const activeIdRef = useRef('')
  const typingClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const typingSentRef = useRef(0)
  const listTypingTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const awayRef = useRef(false)
  // Text that was in the box when an edit began, put back when the edit ends.
  const editStashRef = useRef('')
  useEffect(() => { activeIdRef.current = activeId }, [activeId])
  // The open chat's phone notification goes once you can see it — on opening
  // it, and on coming back to the app with it still open.
  useEffect(() => {
    if (!activeId) return
    const clear = () => { if (!document.hidden) void clearChatNotifications(activeId) }
    clear()
    document.addEventListener('visibilitychange', clear)
    return () => document.removeEventListener('visibilitychange', clear)
  }, [activeId])

  const active = useMemo(() => convos.find((c) => c.id === activeId) || null, [convos, activeId])
  // The signed-in user as the info panel reads them (the ORG role: it gates
  // reviewing meeting tasks). One object per account rather than one per
  // render, so nothing in the panel keyed on it re-runs on every keystroke.
  const infoMe = useMemo<Me | null>(() => (user ? { id: user.id, name: user.name, role: user.role } : null), [user?.id, user?.name, user?.role])

  // Opening a chat is a step Back should undo, as in WhatsApp: Back from a thread
  // (browser, phone gesture, Android button) lands on the chat list, not on
  // whatever page came before Chats. So an opened chat gets its own history
  // entry, carrying the chat in the entry's state. State, not a query param: the
  // ?c= and ?with= handlers below wipe the query string, and a shared /chats link
  // must never open a chat by itself.
  //
  // Opening from the list pushes; switching straight to another chat (the
  // desktop list sits beside the thread) replaces, so Back is one step to the
  // list however many chats were visited. Closing with the in-app arrow goes
  // Back through the entry it pushed rather than adding a "list" entry on top,
  // or the next Back would land on a second copy of the same list.
  //
  // The info panel is one more step on top, as WhatsApp's Group info is: Back
  // from it lands on the chat, not the list. Closing it in the app goes Back
  // through its entry; leaving the chat from inside it (Exit group) goes Back
  // through both in one move. Moving to another chat from it (Message someone)
  // replaces the panel's entry, so Back from that chat returns to this one.
  //
  // What lies under an entry is recorded IN the entry ({chat, pushed}), not in
  // this page's memory: Chats unmounts on every trip to another page and on a
  // reload, and a ref forgot that the list was under the chat — closing then
  // replaced the entry instead of stepping Back through it, and the next Back
  // did nothing. An info entry is only ever pushed straight onto its chat's
  // entry, so closing one is always one step Back.
  const navRef = useRef({ chat: navChat, info: navInfo, pushed: navPushed })
  navRef.current = { chat: navChat, info: navInfo, pushed: navPushed }
  const wantInfo = !!activeId && showInfo
  useEffect(() => {
    // A move to another page is under way (View tasks, Assign as task…): this
    // page is about to unmount and that page owns history now. Writing here
    // would pop the very entry the move just pushed.
    if (window.location.pathname !== loc.pathname) return
    const cur = navRef.current
    const path = loc.pathname
    if (cur.chat === activeId && cur.info === wantInfo) return
    if (cur.chat === activeId) {
      if (wantInfo) navigate(path, { state: { chat: activeId, info: true, pushed: cur.pushed } })
      else navigate(-1)
      return
    }
    if (activeId && !cur.chat) { navigate(path, { state: { chat: activeId, pushed: true } }); return }
    if (activeId) { navigate(path, { state: { chat: activeId, pushed: cur.pushed }, replace: true }); return }
    // Leaving the chat: Back through what this page put there when the list is
    // underneath it; otherwise just say "no chat".
    if (cur.pushed) navigate(cur.info ? -2 : -1)
    else navigate(path, { state: null, replace: true })
  }, [activeId, wantInfo])
  // ...and Back / Forward moving through those entries moves the chat (and the
  // panel) with them — after two smaller steps that Back takes first, the way
  // the panel's arrow and Android's back button already do: a view inside the
  // panel (media, meetings, a summary) goes back one view, and a selected
  // message (touch) is let go while the chat stays. Neither has an entry of its
  // own (a tap selects, often by accident), so the entry Back just took is put
  // back.
  const navType = useNavigationType()
  const showInfoRef = useRef(showInfo)
  showInfoRef.current = showInfo
  const selRef = useRef(selectedId)
  selRef.current = selectedId
  useEffect(() => {
    const was = activeIdRef.current
    if (navType === 'POP' && was) {
      if (!navInfo && showInfoRef.current && navChat === was && infoStepRef.current?.()) {
        navigate(loc.pathname, { state: { chat: was, info: true, pushed: navPushed } })
        return
      }
      if (selRef.current && navChat !== was && !showInfoRef.current) {
        setSelectedId(null); setEmojiFor(null)
        navigate(loc.pathname, { state: { chat: was, pushed: true } })
        return
      }
    }
    if (navChat !== activeIdRef.current) setActiveId(navChat)
    if (navInfo !== showInfoRef.current) { if (navInfo) setInfoStart({ view: 'info' }); setShowInfo(navInfo) }
    else if (pendingInfoRef.current && navChat && navChat === activeIdRef.current && !navInfo) {
      // The chat a list avatar opened has its entry now: its info goes on top.
      setInfoStart(pendingInfoRef.current)
      pendingInfoRef.current = null
      setShowInfo(true)
    }
  }, [navChat, navInfo])

  const pingNav = () => window.dispatchEvent(new Event('chat-unread-changed'))
  const loadConvos = () => api.get('/chat/conversations').then((d) => { setConvos(d.conversations); pingNav() }).catch(() => {})

  const mergeIncoming = (m: Msg) => setMessages((prev) => {
    if (prev.some((x) => x.id === m.id)) return prev
    const ti = prev.findIndex((x) => x.id.startsWith('tmp_') && x.sender_id === m.sender_id && x.body === m.body && !!x.file === !!m.file)
    if (ti >= 0) { const c = prev.slice(); c[ti] = m; return c }
    return [...prev, m]
  })

  useEffect(() => { api.get('/chat/status').then(setMyStatus).catch(() => {}) }, [])
  const loadWorkload = () => api.get('/chat/workload').then((d) => setWorkload(d.byUser || {})).catch(() => {})
  useEffect(() => { loadWorkload() }, [])
  // Re-read it when the window comes back: tasks get closed elsewhere in the app
  // and a stale "4 overdue" chip is worse than none.
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') loadWorkload() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  const loadPins = (cid: string) => api.get(`/chat/conversations/${cid}/pinned`).then((d) => setPinned(d.items)).catch(() => setPinned([]))
  const loadThread = (cid: string) => api.get(`/chat/conversations/${cid}`).then((d) => {
    // The answer to a chat we have since left must not overwrite the one now open.
    if (cid !== activeIdRef.current) return
    if (linkedRef.current === cid) linkedRef.current = null
    setMessages(d.messages)
    setHasMore(!!d.has_more)
    setThreadLastRead(d.last_read_at || null)
    if (d.conversation.type === 'direct' && d.conversation.other_user_id && d.conversation.other_last_seen) {
      setLastSeen((s) => ({ ...s, [d.conversation.other_user_id]: d.conversation.other_last_seen }))
    }
    setConvos((cs) => cs.map((c) => (c.id === cid ? { ...c, ...d.conversation, unread: 0, marked_unread: false } : c)))
    pingNav()
    // Arrived via a message link or a notification — land on that line rather
    // than the bottom, once it is on screen (see landOn).
    const want = deepMsgRef.current
    if (want) {
      deepMsgRef.current = null
      setLandOn(want)
    }
    // "Assign as task" from the Mentions inbox: the chat it lives in is open
    // now, so the sheet can offer its people.
    const assignId = pendingAssignRef.current
    if (assignId) {
      pendingAssignRef.current = null
      // Older than the page that loaded: the sheet still opens, just without
      // the quote of the message on screen.
      const src = (d.messages as Msg[]).find((x) => x.id === assignId) || null
      void toTask({ messageId: assignId }, src)
    }
  }).catch((e) => {
    // A notification or link into a chat this person has since left (removed
    // from the group, chat deleted): say so and show the list, instead of an
    // empty pane that looks like the app broke.
    if (cid !== activeIdRef.current || linkedRef.current !== cid) return
    linkedRef.current = null
    deepMsgRef.current = null
    if (/not found/i.test(String(e?.message))) { toast.info("That chat isn't available to you any more"); setActiveId('') }
  })
  const pendingAssignRef = useRef<string | null>(null)
  // The chat a link or notification just opened, until its thread has loaded.
  const linkedRef = useRef<string | null>(null)

  // The page before the oldest message on screen, kept in place: the thread is
  // re-anchored by the height it grew, so what you were reading does not jump.
  const keepScrollRef = useRef<number | null>(null)
  const loadOlder = () => {
    const cid = activeIdRef.current
    const first = messages.find((m) => !m.id.startsWith('tmp_'))
    if (!cid || !first || loadingOlder || !hasMore) return
    setLoadingOlder(true)
    api.get(`/chat/conversations/${cid}?before=${encodeURIComponent(first.created_at)}`).then((d) => {
      if (cid !== activeIdRef.current) return
      keepScrollRef.current = logRef.current ? logRef.current.scrollHeight - logRef.current.scrollTop : null
      setMessages((cur) => [...(d.messages as Msg[]).filter((x) => !cur.some((y) => y.id === x.id)), ...cur])
      setHasMore(!!d.has_more)
    }).catch(() => {}).finally(() => setLoadingOlder(false))
  }
  React.useLayoutEffect(() => {
    const el = logRef.current
    if (el && keepScrollRef.current !== null) { el.scrollTop = el.scrollHeight - keepScrollRef.current; keepScrollRef.current = null }
  }, [messages])

  // Open a conversation and land on a specific message. The same-thread case has
  // to be handled explicitly: setActiveId to the value it already holds does not
  // re-run the load effect, so a search hit inside the thread you are already in
  // would otherwise do nothing at all.
  const openMessage = (convId: string, messageId?: string | null) => {
    if (messageId && convId === activeIdRef.current) { scrollToMessage(messageId); return }
    deepMsgRef.current = messageId || null
    setActiveId(convId)
  }

  // Bring a message into view and flash it. Shared by the date jump, message
  // links, the pinned bar and the info panel's "Show in chat" — all of them mean
  // "show me that line". Says whether the line was there to show: the thread
  // loads only part of a long chat, and the info panel lists all of it.
  const scrollToMessage = (id: string): boolean => {
    const el = logRef.current?.querySelector(`[data-msg="${id}"]`) as HTMLElement | null
    if (!el) return false
    // More than a couple of screens away, jump there, as WhatsApp does. A smooth
    // scroll across hundreds of lines (a notification for an older message
    // starts from the bottom) took 1.5 s even on a desktop, and the flash below,
    // which starts now, was nearly over by the time the line arrived.
    const r = el.getBoundingClientRect()
    const far = Math.abs(r.top + r.height / 2 - innerHeight / 2) > innerHeight * 2
    el.scrollIntoView({ behavior: far ? 'auto' : 'smooth', block: 'center' })
    setFlashId(id)
    setTimeout(() => setFlashId((f) => (f === id ? null : f)), 1800)
    return true
  }
  // Tapping a quote shows what it quotes — in this chat, or (a private reply
  // to a group message) in the group it came from.
  const jumpToReply = (rep: { id: string; conversation_id?: string }) => {
    if (rep.conversation_id && rep.conversation_id !== activeIdRef.current) {
      if (convos.some((c) => c.id === rep.conversation_id)) openMessage(rep.conversation_id, rep.id)
      return
    }
    if (inSearch) { setInSearch(''); setInSearchOpen(false) }
    requestAnimationFrame(() => { if (!scrollToMessage(rep.id)) toast.info(hasMore ? 'That message is further back — scroll up to load earlier messages' : 'That message is no longer in this chat') })
  }

  useEffect(() => {
    let cancel = false
    loadConvos().then(() => { if (!cancel) setLoading(false) })
    api.get('/chat/presence').then((d) => { if (!cancel) setOnline(new Set(d.online)) }).catch(() => {})
    return () => { cancel = true }
  }, [user?.id])

  // `/chats?with=<userId>` opens (or creates) that person's direct thread — the
  // one deliberate exception to "never auto-open a chat" below, because the user
  // asked for a specific conversation by name ("open Ravi's chat"). The param is
  // stripped straight away with replace:true so Back doesn't bounce them into the
  // same thread, and so a refresh doesn't reopen a chat they've since left.
  const [params, setParams] = useSearchParams()
  // A pasted message link or a tapped notification (?c=…&msg=…): open that
  // thread and land on the line.
  const deepMsgRef = useRef<string | null>(null)
  useEffect(() => {
    const c = params.get('c')
    const msg = params.get('msg')
    // ?review=<meeting>: "Review & assign" on the card a finished call puts up
    // (CallAnalysisCard) — the chat, with that call's summary open on its
    // review, exactly as the summary card's own button in the thread does.
    const review = params.get('review')
    const reviewView: InfoView | null = review ? { view: 'summary', meetingId: review, review: true } : null
    if (!c || !user) return
    if (c === activeIdRef.current) {
      // Already open (a notification for the chat on screen). The thread will
      // not reload, so land on the line from here. The link arrived as an
      // entry with no chat in it, which the history effect above has just
      // read as "close the chat": keep it open, and give the entry its chat.
      navigate(loc.pathname, { state: { chat: c }, replace: true })
      setActiveId(c)
      if (msg) { setInSearch(''); setInSearchOpen(false); setLandOn(msg) } // a search filter could be hiding it
      if (reviewView) openInfo(reviewView)
      return
    }
    setParams(new URLSearchParams(), { replace: true })
    linkedRef.current = c
    deepMsgRef.current = msg
    // Opened on top of the chat once the chat has its history entry, as a
    // list avatar's info is (see the history effects).
    if (reviewView) pendingInfoRef.current = reviewView
    setActiveId(c)
  }, [params, user?.id])

  useEffect(() => {
    const withUser = params.get('with')
    if (!withUser || !user) return
    setParams(new URLSearchParams(), { replace: true })
    api.post('/chat/conversations', { type: 'direct', userId: withUser })
      .then((conv: any) => { loadConvos(); setActiveId(conv.id) })
      .catch(() => toast.error("I couldn't open that conversation."))
  }, [params, user?.id])

  // WhatsApp-style: do NOT auto-open a chat. The list is shown first; the user
  // taps a conversation to open it (and the back arrow returns to the list).
  useEffect(() => {
    setLoadOpen(false); setSelectedId(null); setReactionsOf(null); setHeadMenu(false); setJumpOpen(false); setAttachMenu(false)
    setMulti(null); setUnfolded(new Set()); setAwayFromBottom(false); setNewBelow(0); setHasMore(false); setTypingName(null)
    // Files staged for one chat do not follow you into the next.
    if (stagedRef.current.length) { stagedRef.current.forEach((s) => s.url && URL.revokeObjectURL(s.url)); setStaged([]) }
    // ...but what you were typing does: each chat keeps its own unsent text.
    setInput(activeId ? (readDrafts()[activeId] || '') : '')
    setPicked([]); setMentionQ(null); setSlashQ(null)
    // The thread of the chat being left does not linger behind the list.
    setMessages([])
    if (activeId) {
      setThreadLoading(true)
      loadThread(activeId).finally(() => setThreadLoading(false)); loadPins(activeId); setEditing(null); setInSearch(''); setInSearchOpen(false); setPinsOpen(false)
      // "Reply privately" opened this chat to answer a message from a group.
      const priv = pendingReplyRef.current
      pendingReplyRef.current = null
      setReplyTo(priv)
      if (priv) requestAnimationFrame(() => inputRef.current?.focus())
      // A switch closes the info panel — unless the entry being shown is this
      // chat's own info entry (a reload with it open, Back or Forward onto it).
      if (!(navRef.current.chat === activeId && navRef.current.info)) setShowInfo(false)
    } else setPinned([])
  }, [activeId])
  // Auto-scroll only when the reader is already at (or near) the bottom, or the
  // last message is their own — an incoming message must not yank someone who
  // scrolled up to read history. Opening a thread always starts at the bottom.
  const forceScrollRef = useRef(true)
  useEffect(() => { forceScrollRef.current = true }, [activeId])
  // Only a NEW last message of mine pulls the thread down — an older page
  // arriving above, or a reaction on my last message, is not me sending.
  const lastIdRef = useRef<string | null>(null)
  useEffect(() => {
    const el = logRef.current
    if (!el || inSearchOpen) return
    const last = messages[messages.length - 1]
    const fresh = !!last && last.id !== lastIdRef.current
    lastIdRef.current = last?.id || null
    const mine = fresh && last.sender_id === user?.id
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (forceScrollRef.current || mine || nearBottom) {
      el.scrollTo(0, el.scrollHeight)
      if (messages.length) forceScrollRef.current = false
    }
  }, [messages, busy, typingName, inSearchOpen])
  // The line a link or notification asked for, landed on once it is on screen.
  // Not a requestAnimationFrame after the load: the thread is only drawn once
  // the chat list has loaded too (`active`), which a notification tapped from
  // another page can be still waiting on — the frame came and went with nothing
  // to scroll to, and the chat opened at the bottom. Declared after the
  // auto-scroll above so that, in the same render, it moves second.
  const [landOn, setLandOn] = useState<string | null>(null)
  useEffect(() => {
    if (!landOn || !active) return
    const id = landOn
    setLandOn(null)
    // Landing is a scroll of its own: the opening jump to the bottom must not
    // fire later (someone starts typing) and drag the reader off it.
    forceScrollRef.current = false
    if (!scrollToMessage(id)) void seekOlder(activeId, id, messages, hasMore)
  }, [landOn, active?.id, messages])
  // In-chat search asks the server, which sees the whole history rather than
  // the page loaded, a moment after typing stops — then lands on the newest match.
  useEffect(() => {
    const q = inSearch.trim()
    if (!inSearchOpen || q.length < 2 || !activeId) { setSearchHits(null); setHitAt(0); return }
    let live = true
    const t = setTimeout(() => {
      api.get(`/chat/search?conversationId=${encodeURIComponent(activeId)}&q=${encodeURIComponent(q)}`).then((d) => {
        if (!live) return
        const ids: string[] = d.ids || []
        setSearchHits(ids)
        setHitAt(0)
        if (ids.length) setLandOn(ids[0])
      }).catch(() => {})
    }, 250)
    return () => { live = false; clearTimeout(t) }
  }, [inSearch, inSearchOpen, activeId])
  // ⌃ goes back in time (the hits run newest first), ⌄ forward; both wrap.
  const stepHit = (older: boolean) => {
    if (!searchHits?.length) return
    const n = (hitAt + (older ? 1 : searchHits.length - 1)) % searchHits.length
    setHitAt(n)
    setLandOn(searchHits[n])
  }
  // The line is older than the page that loaded — a busy group can bury a
  // notification under hundreds of newer messages. Fetch back a page at a time
  // until it is there. Bounded: a line deleted or cleared from this chat is
  // never coming, and paging the whole history to learn that would be slow.
  const seekOlder = async (cid: string, id: string, have: Msg[], more: boolean) => {
    let before = have.find((m) => !m.id.startsWith('tmp_'))?.created_at
    const older: Msg[] = []
    let hit = false
    for (let i = 0; i < 5 && more && before && !hit; i++) {
      const d = await api.get(`/chat/conversations/${cid}?before=${encodeURIComponent(before)}`).catch(() => null)
      if (!d || cid !== activeIdRef.current) return
      older.unshift(...(d.messages as Msg[]))
      more = !!d.has_more
      before = d.messages[0]?.created_at
      hit = (d.messages as Msg[]).some((m) => m.id === id)
    }
    if (older.length) {
      setMessages((cur) => [...older.filter((x) => !cur.some((y) => y.id === x.id)), ...cur])
      setHasMore(more)
    }
    if (hit) setLandOn(id)
    else toast.info(more ? 'That message is further back — scroll up to load earlier messages' : 'That message is no longer in this chat')
  }
  // Watching the scroll: the ⌄ button once you are away from the bottom, and
  // the next page of history once you reach the top.
  const onLogScroll = () => {
    const el = logRef.current
    if (!el) return
    const away = el.scrollHeight - el.scrollTop - el.clientHeight > 300
    if (away !== awayRef.current) { awayRef.current = away; setAwayFromBottom(away); if (!away) setNewBelow(0) }
    if (el.scrollTop < 120 && hasMore && !loadingOlder) loadOlder()
  }
  // From far back in a long chat, a jump (as WhatsApp does) — gliding past
  // hundreds of messages takes long enough to look like nothing happened.
  const toBottom = () => {
    const el = logRef.current
    if (!el) return
    const far = el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * 3
    el.scrollTo({ top: el.scrollHeight, behavior: far ? 'auto' : 'smooth' })
    setNewBelow(0)
  }
  useEffect(() => { const h = () => { setMenuId(null); setReactFor(null); setConvoMenu(null); setJumpOpen(false); setEmojiFor(null); setHeadMenu(false); setLoadOpen(false); setSelectedId(null); setAttachMenu(false) }; document.addEventListener('click', h); return () => document.removeEventListener('click', h) }, [])

  // An open thread is a full-screen surface on a phone: the app's top bar (title,
  // bell, profile) and the bottom tab bar both stand down, and the thread covers
  // the screen edge to edge. Measured at 430px the tab bar sat over the composer,
  // and the top bar cost 70px of a thread that already had its own header. The
  // flag goes on <body>, not on this page's root, because both are rendered by
  // Layout in App.tsx — outside this component. The mobile block in styles.css is what acts on it; on desktop it
  // means nothing. Keyed on the chat actually being on screen, not just on
  // activeId: a chat restored from history that no longer exists must leave the
  // list (and the way out) visible.
  const threadOpen = !!active
  useEffect(() => {
    document.body.classList.toggle('chat-thread-open', threadOpen)
    return () => document.body.classList.remove('chat-thread-open')
  }, [threadOpen])
  // Chats is the one page that wants the whole width of a big screen: the list
  // and the thread side by side read better wide than capped at 1240px.
  useEffect(() => {
    document.body.classList.add('chats-page')
    return () => document.body.classList.remove('chats-page')
  }, [])

  // The placeholder says as much as fits on one line. The composer box gets
  // ~250px on a 430px phone, where "@ to mention" fits and the Shift+Enter tip
  // (no use on a phone keyboard anyway) does not; below 400px only "Message…"
  // does. The full hint needs ~360px of box, which only a 1280px window leaves
  // once the sidebar and the chat list have theirs.
  const hintFor = () => typeof window === 'undefined' || window.matchMedia('(min-width: 1280px)').matches ? 2
    : window.matchMedia('(min-width: 400px)').matches ? 1 : 0
  const [hintLevel, setHintLevel] = useState(hintFor)
  useEffect(() => {
    const mqs = [window.matchMedia('(min-width: 1280px)'), window.matchMedia('(min-width: 400px)')]
    const sync = () => setHintLevel(hintFor())
    sync()
    mqs.forEach((mq) => mq.addEventListener('change', sync))
    return () => mqs.forEach((mq) => mq.removeEventListener('change', sync))
  }, [])
  const placeholder = ['Message…', 'Message…  @ to mention', 'Message…  @ to mention  ·  Shift+Enter for a new line'][hintLevel]

  // Android back button: close the top-most open layer (menu → modal → search →
  // conversation list) instead of leaving Chats / quitting the app.
  useEffect(() => pushBackHandler(() => {
    // A confirm is the top-most layer (the info panel raises several: exit,
    // remove, delete), and ConfirmHost has no back handler of its own — without
    // this, back would step the panel and leave the question hanging.
    if (document.querySelector('.confirm-center')) { resolveConfirm(false); return true }
    if (viewerAt) { setViewerAt(null); return true }
    if (openTaskId) { setOpenTaskId(null); return true }
    if (emojiFor) { setEmojiFor(null); return true }
    if (attachMenu) { setAttachMenu(false); return true }
    if (recording) { finishVoiceNote(true); return true }
    if (mentionQ) { setMentionQ(null); return true }
    if (reactionsOf) { setReactionsOf(null); return true }
    if (assignFor || infoFor || deleteFor || pollOpen || votesFor || locOpen || contactOpen || callsOpen || descOpen) {
      setAssignFor(null); setInfoFor(null); setDeleteFor(null); setPollOpen(false); setVotesFor(null); setLocOpen(false); setContactOpen(false); setCallsOpen(false); setDescOpen(false)
      return true
    }
    if (menuId || reactFor || convoMenu || headMenu || jumpOpen || loadOpen) { setMenuId(null); setReactFor(null); setConvoMenu(null); setHeadMenu(false); setJumpOpen(false); setLoadOpen(false); return true }
    if (multi) { setMulti(null); return true }
    if (selectedId) { setSelectedId(null); return true }
    if (forwardMsgs) { setForwardMsgs(null); return true }
    if (showMentions) { setShowMentions(false); return true }
    if (showStarred) { setShowStarred(false); return true }
    // The mute picker opens over the info panel (its Mute row), so it goes first.
    if (muteFor) { setMuteFor(null); return true }
    // The panel walks its own views (summary → meetings → info) before it closes.
    if (showInfo) { if (!infoStepRef.current?.()) setShowInfo(false); return true }
    if (showNew) { setShowNew(false); return true }
    if (inSearchOpen) { setInSearchOpen(false); setInSearch(''); return true }
    if (activeId) { setActiveId(''); return true } // open chat → back to the list
    if (showArchived) { setShowArchived(false); return true }
    return false
  }), [viewerAt, openTaskId, emojiFor, attachMenu, recording, mentionQ, reactionsOf, assignFor, infoFor, deleteFor, pollOpen, votesFor, locOpen, contactOpen, callsOpen, descOpen, menuId, reactFor, convoMenu, headMenu, jumpOpen, loadOpen, multi, selectedId, forwardMsgs, showMentions, showStarred, muteFor, showInfo, showNew, inSearchOpen, activeId, showArchived])

  // Escape closes the top-most of this page's own popups — a menu or picker,
  // then the selected message — one layer per press. Dialogs, the emoji picker
  // and the composer's pickers handle Escape themselves, so they are left to it.
  // Focus that was inside a closing menu goes back to the button that opened it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || emojiFor || reactionsOf) return
      // The info panel handles its own Escape: always while it covers the
      // thread, and while docked beside it whenever focus is in the panel.
      if (showInfo && (!infoDocks || (document.activeElement as HTMLElement | null)?.closest('.ci-panel'))) return
      if (document.querySelector('.confirm-center, .modal-overlay, .mv-overlay, .ci-lb')) return
      if (attachMenu) { setAttachMenu(false); inputRef.current?.focus(); return }
      if (menuId || reactFor || convoMenu || headMenu || jumpOpen || loadOpen) {
        const inPopup = (document.activeElement as HTMLElement | null)?.closest('.msg-menu-wrap, .msg-tools, .convo-menu-wrap')
        setMenuId(null); setReactFor(null); setConvoMenu(null); setHeadMenu(false); setJumpOpen(false); setLoadOpen(false)
        inPopup?.querySelector<HTMLElement>('button')?.focus()
        return
      }
      if (multi) { setMulti(null); return }
      if (selectedId) setSelectedId(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [emojiFor, attachMenu, reactionsOf, showInfo, infoDocks, menuId, reactFor, convoMenu, headMenu, jumpOpen, loadOpen, selectedId, multi])
  // When a selection ends with focus nowhere (the bar or tray button that had it
  // went away with the selection), hand focus back to the message itself rather
  // than to the top of the page. After the frame, so an action that moves focus
  // on purpose (Reply → the composer) has already done so.
  const lastSelRef = useRef<string | null>(null)
  useEffect(() => {
    const was = lastSelRef.current
    lastSelRef.current = selectedId
    if (!was || selectedId) return
    // The tray's full emoji picker belongs to the selection: it closes with it,
    // or it would still react to a message no longer selected.
    setEmojiFor((f) => (f === was ? null : f))
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return
      // An action opened a dialog (Forward, Remind me, Fork): focus is its.
      if (document.querySelector('.confirm-center, .modal-overlay, .modal-center')) return
      logRef.current?.querySelector<HTMLElement>(`[data-msg="${was}"] .bubble`)?.focus({ preventScroll: true })
    })
  }, [selectedId])

  // WebSocket: messages, edits, reactions, deletes, reads, typing, membership changes.
  useEffect(() => {
    if (!user) return
    let retry: ReturnType<typeof setTimeout> | null = null
    let closed = false
    const connect = () => {
      const ws = new WebSocket(wsUrl(`/api/chat/ws?token=${getToken()}`))
      wsRef.current = ws
      ws.onmessage = (ev) => {
        let d: any
        try { d = JSON.parse(ev.data) } catch { return }
        const inActive = d.conversationId === activeIdRef.current
        if (d.type === 'message' && d.message) {
          if (inActive) {
            mergeIncoming(d.message)
            if (d.message.sender_id !== user.id && d.message.kind !== 'system') {
              // Read only if it is actually on screen: a tab in the background,
              // or a reader scrolled up into history, has not seen it yet.
              if (!document.hidden) api.post(`/chat/conversations/${activeIdRef.current}/read`).catch(() => {})
              if (awayRef.current) setNewBelow((n) => n + 1)
            }
          }
          // A message ends that person's "typing…" in the list.
          setTypingIn((t) => { if (!t[d.conversationId]) return t; const n = { ...t }; delete n[d.conversationId]; return n })
          loadConvos()
        } else if (d.type === 'edit') {
          if (inActive) setMessages((p) => p.map((m) => (m.id === d.id ? { ...m, body: d.body, edited_at: d.edited_at, mentions: d.mentions || m.mentions } : m)))
          loadConvos()
        } else if (d.type === 'receipts') {
          // Where everyone else has got to: my messages up to there turn grey
          // (delivered) or blue (read).
          if (inActive) setMessages((p) => p.map((m) => {
            if (m.sender_id !== user.id || m.id.startsWith('tmp_')) return m
            const seen = !!d.read_upto && m.created_at <= d.read_upto
            const delivered = seen || (!!d.delivered_upto && m.created_at <= d.delivered_upto)
            return seen === m.seen && delivered === !!m.delivered ? m : { ...m, seen, delivered }
          }))
          setConvos((cs) => cs.map((c) => (c.id === d.conversationId && c.last_from_me && c.last_at
            ? { ...c, last_seen: !!d.read_upto && c.last_at <= d.read_upto, last_delivered: (!!d.delivered_upto && c.last_at <= d.delivered_upto) || (!!d.read_upto && c.last_at <= d.read_upto) }
            : c)))
        } else if (d.type === 'poll') {
          if (inActive) setMessages((p) => p.map((m) => (m.id === d.id ? { ...m, poll: d.poll } : m)))
        } else if (d.type === 'reaction') {
          if (inActive) setMessages((p) => p.map((m) => (m.id === d.id ? { ...m, reactions: d.reactions } : m)))
        } else if (d.type === 'delete') {
          if (inActive) {
            if (d.scope === 'all') setMessages((p) => p.map((m) => (m.id === d.id ? { ...m, deleted: true, body: '', file: null, reactions: [] } : m)))
            else setMessages((p) => p.filter((m) => m.id !== d.id))
          }
          loadConvos()
        } else if (d.type === 'read') {
          // Superseded by 'receipts', which knows whether EVERYONE has read it —
          // one reader in a group used to turn the ticks blue for all.
        } else if (d.type === 'typing') {
          if (d.userId === user.id) return
          if (inActive) {
            setTypingName(d.isTyping ? d.name : null)
            setTypingMode(d.mode === 'recording' ? 'recording' : 'typing')
            if (typingClearRef.current) clearTimeout(typingClearRef.current)
            if (d.isTyping) typingClearRef.current = setTimeout(() => setTypingName(null), d.mode === 'recording' ? 8000 : 4000)
          }
          // ...and in the list, where WhatsApp says "typing…" in place of the preview.
          const cid = d.conversationId
          setTypingIn((t) => {
            const n = { ...t }
            if (d.isTyping) n[cid] = { name: d.name, mode: d.mode || 'typing' }; else delete n[cid]
            return n
          })
          clearTimeout(listTypingTimers.current[cid])
          if (d.isTyping) listTypingTimers.current[cid] = setTimeout(() => setTypingIn((t) => { const n = { ...t }; delete n[cid]; return n }), d.mode === 'recording' ? 8000 : 4500)
        } else if (d.type === 'conversation') {
          if (d.action === 'removed' && d.conversationId === activeIdRef.current) { setActiveId(''); setMessages([]) }
          loadConvos()
        } else if (d.type === 'cleared') {
          if (d.conversationId === activeIdRef.current) setMessages([])
          loadConvos()
        } else if (d.type === 'presence') {
          setOnline((s) => { const n = new Set(s); d.online ? n.add(d.userId) : n.delete(d.userId); return n })
          if (!d.online && d.last_seen) setLastSeen((s) => ({ ...s, [d.userId]: d.last_seen }))
        } else if (d.type === 'presence-list') {
          setOnline(new Set(d.online))
        } else if (d.type === 'transcript') {
          if (inActive) setMessages((p) => p.map((m) => (m.id === d.id ? { ...m, transcript: d.transcript } : m)))
        } else if (d.type === 'pin') {
          if (inActive) {
            setMessages((p) => p.map((m) => (m.id === d.id ? { ...m, pinned_at: d.pinned ? new Date().toISOString() : null } : m)))
            loadPins(d.conversationId)
          }
        } else if (d.type === 'status') {
          // Someone set a custom status or flipped DND — patch them wherever
          // they appear rather than refetching every conversation.
          setConvos((cs) => cs.map((c) => ({
            ...c,
            members: c.members.map((mm) => (mm.id === d.userId ? { ...mm, status_text: d.status_text, status_emoji: d.status_emoji, dnd_until: d.dnd_until } : mm)),
          })))
        } else if (d.type === 'reminder') {
          toast.info(`Reminder: ${String(d.preview || '').slice(0, 60)}`)
        }
      }
      ws.onclose = () => { if (!closed) retry = setTimeout(connect, 3000) }
      ws.onerror = () => { try { ws.close() } catch {} }
    }
    connect()
    return () => { closed = true; if (retry) clearTimeout(retry); try { wsRef.current?.close() } catch {} }
  }, [user?.id])

  // Fallback refresh ONLY: the WebSocket above already pushes every change, so
  // poll just when it's down — and never while the tab is hidden (battery/network).
  // The old unconditional 25s wholesale refetch also flickered the thread and
  // could momentarily drop in-flight optimistic messages.
  useEffect(() => {
    const iv = setInterval(() => {
      if (document.hidden) return
      if (wsRef.current?.readyState === WebSocket.OPEN) return
      loadConvos(); if (activeIdRef.current) loadThread(activeIdRef.current)
    }, 25000)
    // Catch up once when the user returns to the tab.
    const onVisible = () => {
      if (document.hidden) return
      loadConvos(); if (activeIdRef.current) loadThread(activeIdRef.current)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVisible) }
  }, [])

  // ---- composer actions ----
  // mode 'recording' is "recording audio…", sent while a voice note is held open.
  const sendTyping = (isTyping: boolean, mode: 'typing' | 'recording' = 'typing') => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !activeId) return
    const nowMs = Date.now()
    if (isTyping && mode === 'typing' && nowMs - typingSentRef.current < 1500) return
    typingSentRef.current = nowMs
    try { ws.send(JSON.stringify({ type: 'typing', conversationId: activeId, isTyping, mode })) } catch {}
  }

  // ---- files: pasted, dropped or picked ----------------------------------
  // Into the tray above the box, never straight to the room (see `staged`).
  const stageFiles = (files: File[]) => {
    if (!files.length || !activeIdRef.current) return
    if (editing) { toast.info('Finish editing the message first'); return }
    const tooBig = files.filter((f) => f.size > MAX_FILE)
    if (tooBig.length) toast.error(tooBig.length === 1 ? `"${tooBig[0].name}" is over 1 GB, too big to send` : `${tooBig.length} files are over 1 GB, too big to send`)
    let ok = files.filter((f) => f.size > 0 && f.size <= MAX_FILE)
    const room = MAX_STAGED - stagedRef.current.length
    if (ok.length > room) { toast.info(`Up to ${MAX_STAGED} files at a time`); ok = ok.slice(0, Math.max(0, room)) }
    if (!ok.length) return
    setStaged((cur) => [...cur, ...ok.map((file) => ({
      id: Math.random().toString(36).slice(2), file,
      url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
    }))])
    setAttachMenu(false)
    // Straight back to the box, where the caption goes.
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  const unstage = (id: string) => {
    const gone = stagedRef.current.find((s) => s.id === id)
    if (gone?.url) URL.revokeObjectURL(gone.url)
    setStaged((cur) => cur.filter((s) => s.id !== id))
    requestAnimationFrame(() => inputRef.current?.focus())
  }
  useEffect(() => () => stagedRef.current.forEach((s) => s.url && URL.revokeObjectURL(s.url)), [])

  // One file to the thread, with an optimistic "Sending…" line until it lands.
  // XHR rather than fetch for the upload progress: a file can be 1 GB, minutes
  // on a phone, and a "Sending…" line that never moves reads as stuck.
  const uploadOne = async (conv: Conversation, file: File, caption: string, rep: Msg | null, capMentions: string[]) => {
    const tmpId = 'tmp_' + Date.now() + Math.random().toString(36).slice(2, 6)
    setMessages((m) => [...m, { id: tmpId, conversation_id: conv.id, sender_id: user!.id, body: caption, created_at: new Date().toISOString(), reactions: [], starred: false, seen: false, file: { name: file.name, type: file.type, size: file.size }, uploading: true }])
    try {
      // A big file asks first whether the server has room for it: a refusal
      // sent mid-upload never reaches us (the browser reads no answer until it
      // has sent everything) and would surface as a dropped connection.
      if (file.size > 10 * 1024 * 1024) await api.get(`/chat/upload-room?size=${file.size}`)
      const form = new FormData(); form.append('file', file)
      if (caption) form.append('body', caption)
      if (rep) form.append('replyTo', rep.id)
      if (capMentions.length) form.append('mentions', JSON.stringify(capMentions))
      const data = await new Promise<Msg>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `${API_BASE}/api/chat/conversations/${conv.id}/upload`)
        const t = getToken(); if (t) xhr.setRequestHeader('authorization', `Bearer ${t}`)
        let shown = -1
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return
          const pct = Math.floor((e.loaded / e.total) * 100)
          if (pct === shown) return
          shown = pct
          setMessages((prev) => prev.map((x) => (x.id === tmpId ? { ...x, progress: pct } : x)))
        }
        xhr.onload = () => {
          let body: any = null
          try { body = JSON.parse(xhr.responseText) } catch {}
          if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body)
          else reject(new Error(body?.error || `Upload failed (${xhr.status})`))
        }
        xhr.onerror = () => reject(new Error('the connection was lost'))
        xhr.send(form)
      })
      setMessages((prev) => prev.map((x) => (x.id === tmpId ? data : x)))
      return true
    } catch (err: any) {
      setMessages((m) => m.filter((x) => x.id !== tmpId)); toast.error(`Could not send ${file.name}: ${err.message}`)
      return false
    }
  }

  // Send what is staged: one message per file, in order, the caption (and the
  // reply, and its @mentions) on the first. A file that fails goes back into
  // the tray to try again, and the caption with it if it was riding on that one.
  const sendStaged = async () => {
    const conv = active
    if (!conv || busy) return
    const items = stagedRef.current
    const caption = input.trim(); const rep = replyTo
    const capMentions = caption ? resolveMentions(caption, picked, conv.members, user!.id) : []
    setStaged([]); setInput(''); setBusy(true); sendTyping(false); setReplyTo(null); setPicked([]); setMentionQ(null)
    const failed: StagedFile[] = []
    try {
      for (let i = 0; i < items.length; i++) {
        const first = i === 0
        if (await uploadOne(conv, items[i].file, first ? caption : '', first ? rep : null, first ? capMentions : [])) {
          if (items[i].url) URL.revokeObjectURL(items[i].url!)
        } else {
          failed.push(items[i])
          if (first && caption) setInput((cur) => cur || caption)
        }
      }
      loadConvos()
    } finally {
      if (failed.length && activeIdRef.current === conv.id) setStaged((cur) => [...failed, ...cur])
      setBusy(false)
    }
  }

  // Phones have no Ctrl+V: the clip's "Paste from clipboard" reads the picture
  // on request (it has to happen inside the tap). Where the browser will not
  // share the clipboard (some phones, the Android app's web view), say so and
  // open the picker instead, where the latest screenshot is first anyway.
  const pasteFromClipboard = async () => {
    setAttachMenu(false)
    try {
      const files = await readClipboardImages()
      if (files.length) stageFiles(files)
      else toast.info('There is no picture on the clipboard. Copy one, or take a screenshot, first.')
    } catch {
      toast.info('This browser would not share the clipboard. Pick the picture instead.')
      fileRef.current?.click()
    }
  }

  const send = async () => {
    const body = input.trim()
    if (busy || !active) return
    if (editing) return saveEdit()
    if (stagedRef.current.length) return sendStaged()
    if (!body) return
    // A slash command is an instruction to the app, not a message to the room.
    if (body.startsWith('/') && await runSlash(body)) { setSlashQ(null); return }
    const mentions = resolveMentions(body, picked, active.members, user!.id)
    const mentionRefs = picked.filter((p) => mentions.includes(p.id))
    setInput(''); setBusy(true); sendTyping(false); setPicked([]); setMentionQ(null)
    const rep = replyTo
    const optimistic: Msg = { id: 'tmp_' + Date.now(), conversation_id: active.id, sender_id: user!.id, body, created_at: new Date().toISOString(), reactions: [], mentions: mentionRefs, starred: false, seen: false, reply: rep ? { id: rep.id, sender_id: rep.sender_id, sender_name: senderName(rep.sender_id), text: rep.file ? rep.file.name : rep.body, image: !!rep.file && (rep.file.type || '').startsWith('image/'), conversation_id: rep.conversation_id } : null, reply_to: rep?.id || null }
    setMessages((m) => [...m, optimistic]); setReplyTo(null)
    try {
      const saved = await api.post(`/chat/conversations/${active.id}/messages`, { body, replyTo: rep?.id, mentions })
      mergeIncoming(saved); loadConvos()
    } catch (e: any) {
      setMessages((m) => m.filter((x) => x.id !== optimistic.id)); setInput(body); toast.error('Could not send: ' + e.message)
    } finally { setBusy(false) }
  }

  // ---- voice notes --------------------------------------------------------
  // Speech is the fastest way to say something complicated, and this team works
  // across Telugu, Hindi and English — so a voice note is often the honest form
  // of a message. It is sent as an ordinary audio attachment, which means every
  // existing path (storage, forward, delete, search by filename) already works;
  // only the player and the transcribe button are new.
  const stopVoiceTimer = () => { if (voiceTimerRef.current) { clearInterval(voiceTimerRef.current); voiceTimerRef.current = null } }

  const releaseVoice = () => {
    if (voiceRecRef.current) sendTyping(false, 'recording')
    stopVoiceTimer()
    try { voiceSpeechRef.current?.stop() } catch {}
    voiceSpeechRef.current = null
    try { voiceStreamRef.current?.getTracks().forEach((t) => t.stop()) } catch {}
    voiceStreamRef.current = null
    voiceRecRef.current = null
    setRecording(false)
    setRecSecs(0)
  }
  useEffect(() => releaseVoice, [])

  const startVoiceNote = async () => {
    if (recording || busy || !active) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      voiceStreamRef.current = stream
      const rec = new MediaRecorder(stream)
      voiceChunksRef.current = []
      voiceCancelRef.current = false
      rec.ondataavailable = (e) => { if (e.data && e.data.size) voiceChunksRef.current.push(e.data) }
      rec.onstop = async () => {
        const chunks = voiceChunksRef.current
        voiceChunksRef.current = []
        const cancelled = voiceCancelRef.current
        // Grab the recognised text before releaseVoice() clears it.
        const spoken = voiceTextRef.current.join(' ').trim()
        releaseVoice()
        if (cancelled || !chunks.length) return
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
        if (blob.size < 1200) { toast.info('That was too short to send'); return }
        await sendVoiceNote(blob, spoken)
      }
      rec.start()
      voiceRecRef.current = rec
      if (pendingCancelRef.current) { pendingCancelRef.current = false; voiceCancelRef.current = true; rec.stop(); return }
      voiceTextRef.current = []
      // Listen alongside the recorder. The two are independent: if speech
      // recognition is unavailable the note still sends, just without text.
      voiceSpeechRef.current = speechSupported()
        ? startLiveSpeech((t) => { voiceTextRef.current.push(t) })
        : null
      setRecording(true)
      setRecSecs(0)
      sendTyping(true, 'recording')
      voiceTimerRef.current = setInterval(() => setRecSecs((n) => {
        // Hard stop at two minutes: past that it is a call, not a note.
        if (n >= 119) { try { voiceRecRef.current?.stop() } catch {} }
        // Keep "recording audio…" alive on the other end (it lapses after 8s).
        if (n % 5 === 4) sendTyping(true, 'recording')
        return n + 1
      }), 1000)
    } catch {
      toast.error('No microphone available')
    }
  }

  const finishVoiceNote = (cancel = false) => {
    voiceCancelRef.current = cancel
    const rec = voiceRecRef.current
    if (rec && rec.state !== 'inactive') { try { rec.stop() } catch { releaseVoice() } }
    else releaseVoice()
  }

  const cancelHeldNote = () => {
    if (voiceRecRef.current) finishVoiceNote(true)
    else pendingCancelRef.current = true
  }
  const micPress = {
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.pointerType === 'mouse' || busy || recording) return
      e.preventDefault()
      touchPressRef.current = true
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
      holdRef.current = { x: e.clientX, y: e.clientY, t: Date.now() }
      pendingCancelRef.current = false
      setHoldDx(0)
      void startVoiceNote()
    },
    onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
      const h = holdRef.current
      if (!h) return
      const dx = Math.min(0, e.clientX - h.x)
      if (dx < -SLIDE_CANCEL_PX) { holdRef.current = null; setHoldDx(null); cancelHeldNote(); return }
      // Locked: the bar's discard and send buttons take over, as for a tap.
      if (e.clientY - h.y < -SLIDE_LOCK_PX) { holdRef.current = null; setHoldDx(null); return }
      setHoldDx(dx)
    },
    onPointerUp: () => {
      const h = holdRef.current
      if (!h) return
      holdRef.current = null
      setHoldDx(null)
      // A tap, or a release before the microphone opened (the first-time
      // permission prompt): leave it recording hands-free rather than drop it.
      if (Date.now() - h.t < HOLD_TAP_MS || !voiceRecRef.current) return
      finishVoiceNote(false)
    },
    // The press was taken away (a system gesture): keep what was recorded,
    // hands-free — losing a note to a stray swipe is worse than one more tap.
    onPointerCancel: () => { holdRef.current = null; setHoldDx(null) },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onClick: () => {
      if (touchPressRef.current) { touchPressRef.current = false; return }
      void startVoiceNote()
    },
  }

  const sendVoiceNote = async (blob: Blob, spoken = '') => {
    if (!active) return
    setBusy(true)
    const tmpId = 'tmp_' + Date.now()
    const name = audioFilename(blob, 'voice-note')
    setMessages((m) => [...m, { id: tmpId, conversation_id: active.id, sender_id: user!.id, body: '', created_at: new Date().toISOString(), reactions: [], starred: false, seen: false, transcript: spoken || null, file: { name, type: blob.type, size: blob.size }, uploading: true }])
    try {
      const form = new FormData()
      form.append('file', new File([blob], name, { type: blob.type || 'audio/webm' }))
      if (spoken) form.append('transcript', spoken)
      const headers: Record<string, string> = {}
      const t = getToken(); if (t) headers.authorization = `Bearer ${t}`
      const res = await fetch(`${API_BASE}/api/chat/conversations/${active.id}/upload`, { method: 'POST', headers, body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Upload failed')
      setMessages((prev) => prev.map((x) => (x.id === tmpId ? data : x)))
      loadConvos()
    } catch (e: any) {
      setMessages((m) => m.filter((x) => x.id !== tmpId))
      toast.error('Could not send the voice note: ' + e.message)
    } finally { setBusy(false) }
  }

  // Read a voice note out loud into text. Cached server-side, so the second
  // person to press it pays nothing.
  const transcribeNote = async (m: Msg) => {
    if (m.transcript || transcribing) return
    setTranscribing(m.id)
    try {
      const d = await api.post(`/chat/message/${m.id}/transcribe`)
      setMessages((p) => p.map((x) => (x.id === m.id ? { ...x, transcript: d.text } : x)))
    } catch (e: any) {
      toast.error(e.message.includes('NO_PROVIDER') || /provider/i.test(e.message)
        ? 'Transcription needs a speech provider key on the server.'
        : 'Could not transcribe: ' + e.message)
    } finally { setTranscribing(null) }
  }

  // Turn a recording sitting in the thread into a meeting summary with
  // reviewable tasks. This is the path when speech could not be recognised live
  // — and the retry once a transcription provider is configured, so recordings
  // already in the chat are not lost just because the key arrived later.
  const recordingToMeeting = async (m: Msg) => {
    if (summarising) return
    setSummarising(m.id)
    try {
      const d = await api.post(`/chat/message/${m.id}/to-meeting`)
      const found = Number(d.suggestion_count) || 0
      const tasks = `${found} task${found === 1 ? '' : 's'}`
      // Transcribing takes seconds to minutes, and the reader may have moved on.
      // The summary belongs to the chat the recording is in, so it opens only if
      // that chat is still the one on screen and nothing sits over it — not a
      // dialog, and not the info panel, where whatever they opened meanwhile
      // stays put. Otherwise it waits under that chat's Meeting summaries.
      const busy = !!document.querySelector('.ci-panel, .modal-center, .confirm-center, .modal-overlay, .ci-lb')
      if (activeIdRef.current !== m.conversation_id || busy) {
        const where = convos.find((c) => c.id === m.conversation_id)?.name
        toast.success(`Summary ready${where ? ` in ${where}` : ''}${!d.existing && found ? ` — ${tasks} to review` : ''} — under Meeting summaries in its info`)
        return
      }
      toast.success(d.existing ? 'Opening the summary' : found ? `${tasks} found — review and assign` : 'Summary ready — no tasks were found in this recording')
      // Opened in this chat's info panel, where the chat's meetings live:
      // freshly summarised with something to assign goes straight to the review.
      openInfo({ view: 'summary', meetingId: d.id, review: !d.existing && found > 0 })
    } catch (e: any) {
      toast.error(/provider|NO_PROVIDER/i.test(e.message)
        ? 'Transcription needs a speech provider key on the server before a recording can be summarised.'
        : 'Could not summarise that recording: ' + e.message)
    } finally { setSummarising(null) }
  }

  // ---- chat → task --------------------------------------------------------
  // Turn the message (or the line still in the composer) into an assigned task
  // without leaving the chat: TaskAssignSheet opens over the thread, filled in
  // from a draft built server-side with the same due-date, priority and "who
  // was named" rules as the rest of the app. Nothing is created until Assign is
  // pressed, because handing someone work should stay a deliberate act — the
  // same reason the voice assistant never submits a form either.
  const toTask = async (payload: { messageId?: string; text?: string; mentions?: string[] }, source: Msg | null = null) => {
    setMenuId(null); setSelectedId(null); setMulti(null)
    try {
      const draft = await api.post('/chat/task-draft', payload)
      // A group only its admins may write to cannot take the task's card, so
      // the task is made on the full form instead of half-made here.
      if (readOnly) { openFullTaskForm(draft); return }
      setAssignFor({ source, draft })
    } catch (e: any) { toast.error('Could not build the task: ' + e.message) }
  }
  // The full New task form, for the task that needs a project or a category.
  const openFullTaskForm = (d: Draft) => {
    setAssignFor(null)
    stashTaskDraft({ ...d, assignee_name: d.assignee_name || null })
    navigate('/tasks?new=1')
  }
  // From the Mentions inbox: the message may live in another chat, which has
  // to be open for the sheet to offer its people.
  const taskFromAnywhere = (convId: string, messageId: string) => {
    if (convId === activeIdRef.current) {
      const src = messages.find((x) => x.id === messageId) || null
      void toTask({ messageId }, src)
      return
    }
    pendingAssignRef.current = messageId
    openMessage(convId, messageId)
  }
  const draftFromComposer = () => {
    const text = input.trim()
    if (!text || !active) return
    toTask({ text, mentions: resolveMentions(text, picked, active.members, user!.id) })
  }

  // Print the conversation. Opens a plain, self-contained document rather than
  // printing the app: the real page is a fixed-height flex column with its own
  // scroller, which a printer turns into one page of whatever happened to be in
  // view. This is the transcript, which is what anyone printing a chat wants.
  const printConversation = () => {
    if (!active) return
    const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as any)[c])
    const rows = messages.filter((m) => !m.deleted).map((m) => {
      const who = m.sender_id === user!.id ? 'You' : senderName(m.sender_id)
      const when = `${dayLabel(m.created_at)} ${fmtTime(m.created_at)}`
      const what = m.call ? m.body : (m.body || (m.file ? `[file] ${m.file.name}` : ''))
      return `<tr><td class="w">${esc(who)}</td><td class="b">${esc(what)}</td><td class="t">${esc(when)}</td></tr>`
    }).join('')
    const win = window.open('', '_blank', 'width=820,height=900')
    if (!win) { toast.error('Your browser blocked the print window'); return }
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(active.name)} — VoTask</title>
      <style>
        body { font: 13px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; color: #111; margin: 32px; }
        h1 { font-size: 17px; margin: 0 0 2px; } .sub { color: #666; font-size: 12px; margin-bottom: 18px; }
        table { border-collapse: collapse; width: 100%; }
        td { vertical-align: top; padding: 5px 8px; border-bottom: 1px solid #eee; }
        .w { font-weight: 700; white-space: nowrap; width: 1%; }
        .t { color: #888; font-size: 11px; white-space: nowrap; width: 1%; text-align: right; }
        .b { white-space: pre-wrap; word-break: break-word; }
      </style></head><body>
      <h1>${esc(active.name)}</h1>
      <div class="sub">${messages.length} messages · printed ${esc(new Date().toLocaleString())}</div>
      <table>${rows}</table></body></html>`)
    win.document.close()
    win.focus()
    setTimeout(() => win.print(), 250)
  }

  // ---- slash commands -----------------------------------------------------
  const slashOptions = useMemo(() => {
    if (slashQ === null) return []
    return SLASH.filter((c) => c.name.startsWith(slashQ)).slice(0, 7)
  }, [slashQ])

  // Returns true if the line was a command and has been dealt with, so send()
  // knows not to post it as a message.
  const runSlash = async (line: string): Promise<boolean> => {
    const m = /^\/([a-z]+)\s*([\s\S]*)$/i.exec(line.trim())
    if (!m) return false
    const cmd = m[1].toLowerCase()
    const rest = m[2].trim()
    const known = SLASH.some((c) => c.name === cmd)
    if (!known) return false

    switch (cmd) {
      case 'task':
        if (!rest) { toast.info('Try /task followed by what needs doing'); return true }
        setInput('')
        await toTask({ text: rest, mentions: active ? resolveMentions(rest, picked, active.members, user!.id) : [] })
        return true
      case 'call':
      case 'video':
        if (!active) return true
        setInput('')
        startCall(active.id, cmd === 'video' ? 'video' : 'audio', active.name)
        return true
      case 'status':
        setInput('')
        try {
          const saved = await api.post('/chat/status', { status_text: rest, status_emoji: myStatus.status_emoji || '', dnd_minutes: 0 })
          setMyStatus(saved)
          toast.success(rest ? `Status set: ${rest}` : 'Status cleared')
        } catch (e: any) { toast.error(e.message) }
        return true
      case 'dnd': {
        setInput('')
        const mins = Number(rest || 60)
        if (!Number.isFinite(mins) || mins < 0) { toast.error('Try /dnd 60'); return true }
        try {
          const saved = await api.post('/chat/status', { status_text: myStatus.status_text || '', status_emoji: myStatus.status_emoji || '', dnd_minutes: mins })
          setMyStatus(saved)
          toast.success(mins > 0 ? `Do not disturb for ${mins} min` : 'Do not disturb off')
        } catch (e: any) { toast.error(e.message) }
        return true
      }
      case 'search':
        setInput('')
        if (!rest) { toast.info('Try /search followed by what to look for'); return true }
        setSearch(rest)
        setTimeout(() => { void runGlobalSearch(rest) }, 0)
        return true
      case 'shrug':
        // Not a command so much as a shortcut — it becomes the message.
        setInput((rest ? rest + ' ' : '') + '¯\\_(ツ)_/¯')
        requestAnimationFrame(() => inputRef.current?.focus())
        return true
    }
    return false
  }

  // ---- @mention picker ----------------------------------------------------
  // Candidates for the open @-token: teammates in this conversation, plus @All in
  // a group. Filtered on the typed fragment, ranked prefix-first.
  const mentionOptions: MentionRef[] = useMemo(() => {
    if (!mentionQ || !active) return []
    const q = mentionQ.q.trim().toLowerCase()
    const people = active.members.filter((m) => m.id !== user?.id).map((m) => ({ id: m.id, name: m.name }))
    const pool: MentionRef[] = active.type === 'group' ? [{ id: '__all__', name: 'All' }, ...people] : people
    if (!q) return pool.slice(0, 6)
    // Exact beats prefix beats substring, and a shorter name breaks the tie. With
    // names like "Employee 1" and "Employee 17" a plain prefix sort leaves the
    // typed-in-full name sitting under its longer neighbour, and Enter then pings
    // the wrong person — which, unlike a filter, is a message to a real human.
    const rank = (name: string) => { const n = name.toLowerCase(); return n === q ? 3 : n.startsWith(q) ? 2 : 1 }
    return pool
      .filter((p) => p.name.toLowerCase().includes(q))
      .sort((a, b) => rank(b.name) - rank(a.name) || a.name.length - b.name.length || a.name.localeCompare(b.name))
      .slice(0, 6)
  }, [mentionQ, active, user?.id])

  // Swap the half-typed @token for the chosen name and put the caret after it.
  const applyMention = (opt: MentionRef) => {
    if (!mentionQ) return
    const before = input.slice(0, mentionQ.start)
    const after = input.slice(mentionQ.start + 1 + mentionQ.q.length)
    const next = `${before}@${opt.name} ${after.startsWith(' ') ? after.slice(1) : after}`
    setInput(next)
    if (opt.id !== '__all__') setPicked((p) => (p.some((x) => x.id === opt.id) ? p : [...p, opt]))
    setMentionQ(null); setMentionIdx(0)
    const caret = before.length + opt.name.length + 2
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(caret, caret) })
  }

  const pickSlash = (c: SlashCmd) => {
    setInput('/' + c.name + ' ')
    setSlashQ(null)
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  // Grow with the content up to a ceiling, then scroll. Done here rather than in
  // CSS because a textarea has no content-driven height.
  const autoGrow = (el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    // Empty, scrollHeight is the placeholder's — a wrapped hint kept the box two
    // or three rows tall after every send. One row is right for an empty box.
    if (el.value) el.style.height = Math.min(el.scrollHeight, 132) + 'px'
  }
  useEffect(() => { autoGrow(inputRef.current) }, [input])
  // Each chat's unsent text, saved as it is typed — never an edit in progress,
  // which is a different message's words.
  useEffect(() => {
    const cid = activeIdRef.current
    if (!cid || editing) return
    setDrafts((d) => {
      const keep = input.trim() ? input : ''
      if ((d[cid] || '') === keep) return d
      const n = { ...d }
      if (keep) n[cid] = keep; else delete n[cid]
      writeDrafts(n)
      return n
    })
  }, [input])

  const onComposerChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setInput(value)
    if (!editing) sendTyping(true)
    const found = active ? mentionQueryAt(value, e.target.selectionStart ?? value.length) : null
    setMentionQ(found)
    setMentionIdx(0)
    setSlashQ(slashQueryAt(value))
    setSlashIdx(0)
  }

  // Enter/Tab take the highlighted name instead of sending — the picker is open,
  // so that keystroke belongs to it.
  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashQ !== null && slashOptions.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx((i) => (i + 1) % slashOptions.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx((i) => (i - 1 + slashOptions.length) % slashOptions.length); return }
      if (e.key === 'Tab') { e.preventDefault(); pickSlash(slashOptions[slashIdx]); return }
      if (e.key === 'Escape') { e.preventDefault(); setSlashQ(null); return }
      // Enter on a command that needs no argument runs it; one that takes an
      // argument completes first, so you don't fire /task with nothing after it.
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault()
        const hit = slashOptions[slashIdx]
        if (hit?.args) pickSlash(hit)
        else { setSlashQ(null); void runSlash('/' + (hit?.name || slashQ)) }
        return
      }
    }
    if (mentionQ && mentionOptions.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx((i) => (i + 1) % mentionOptions.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx((i) => (i - 1 + mentionOptions.length) % mentionOptions.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyMention(mentionOptions[mentionIdx]); return }
      if (e.key === 'Escape') { e.preventDefault(); setMentionQ(null); return }
    }
    // ↑ in an empty box: edit your last message (WhatsApp Web). Escape while
    // editing: leave the message as it was.
    if (e.key === 'ArrowUp' && !input && !editing && !stagedRef.current.length) {
      const m = lastEditable()
      if (m) { e.preventDefault(); startEdit(m) }
      return
    }
    if (e.key === 'Escape' && editing) { e.preventDefault(); e.stopPropagation(); endEdit(); return }
    // Shift+Enter is a newline — which is what makes multi-line messages and
    // ``` code blocks typable at all. Plain Enter still sends, because that is
    // what every chat app does and muscle memory is not negotiable.
    //
    // isComposing guard: with Indic (Telugu/Hindi) and other IME keyboards,
    // Enter first COMMITS the composition — that keystroke must not send.
    //
    // On a touch screen Enter is the newline, as in WhatsApp and Cliq on a
    // phone: a soft keyboard has no Shift+Enter, so sending on Enter left no way
    // at all to write a second line. The send button is how a phone sends.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !touchUI) {
      e.preventDefault()
      send()
    }
  }

  // ---- Agent surface -------------------------------------------------------
  // Sending a message by voice used to POST straight to the chat API and then
  // navigate to /chats, so the user saw a thread that already contained a message
  // they never watched being written. Now the agent opens the conversation, types
  // into the real composer and presses the real Send — which matters more here than
  // anywhere else in the app, because this is the one action that is visible to
  // ANOTHER PERSON and cannot be taken back.
  useSurface('chats', {
    // Find or create the direct thread with someone, then open it.
    openDirect: async ({ userId }: { userId: string }) => {
      const conv: any = await api.post('/chat/conversations', { type: 'direct', userId })
      loadConvos()
      setActiveId(conv.id)
      await pause(420)                 // let the thread render before typing into it
      return { id: conv.id }
    },
    typeMessage: ({ value }: { value: string }) =>
      typeInto(findVaEl('chats.composer'), value, setInput),
    send: async () => {
      // settle() before reading state: typeInto set `input` through React, and the
      // real send() closes over it. Without a commit the message would post empty.
      await settle()
      await flashPress(findVaEl('chats.send'))
      await send()
    },
  })

  // Picked with the clip: into the same tray as a paste, so every way of adding
  // a file ends at one preview and one Send.
  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []); e.target.value = ''
    stageFiles(files)
  }

  // Ctrl+V with the focus anywhere in an open chat — on a message, on the
  // thread, nowhere in particular — is meant for the chat, as on WhatsApp Web.
  // A paste into some other field (the chat search, a dialog's input) stays
  // that field's, and the composer handles its own (onPaste on the textarea).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || !activeIdRef.current) return
      const t = e.target as HTMLElement | null
      if (t?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
      if (document.querySelector('.modal-overlay, .modal-center, .ci-lb')) return
      // The info panel: pasted into it, or while it covers the thread (it makes
      // the thread inert then), the paste is not for the composer.
      if (t?.closest?.('.ci-panel') || document.querySelector('.chat-pane > .chat[inert]')) return
      const files = clipboardFiles(e.clipboardData)
      if (!files.length) return
      e.preventDefault()
      stageFilesRef.current(files)
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [])
  const stageFilesRef = useRef(stageFiles)
  stageFilesRef.current = stageFiles

  // Drag files onto the thread to attach them (wide screens; harmless on phones).
  // dragenter/leave fire for every child crossed, so a depth count decides when
  // the drag has really left the pane.
  const paneDrop = {
    onDragEnter: (e: React.DragEvent) => {
      if (!active || !dragHasFiles(e.dataTransfer)) return
      e.preventDefault(); dragDepthRef.current++; setDropping(true)
    },
    onDragOver: (e: React.DragEvent) => {
      if (!active || !dragHasFiles(e.dataTransfer)) return
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: () => {
      if (!dropping) return
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (!dragDepthRef.current) setDropping(false)
    },
    onDrop: (e: React.DragEvent) => {
      if (!active || !dragHasFiles(e.dataTransfer)) return
      e.preventDefault(); dragDepthRef.current = 0; setDropping(false)
      stageFiles(droppedFiles(e.dataTransfer))
    },
  }

  // Leave edit mode, giving the box back whatever was being typed before.
  const endEdit = () => {
    setEditing(null); setInput(editStashRef.current); editStashRef.current = ''; setPicked([]); setMentionQ(null)
  }
  const saveEdit = async () => {
    if (!editing) return
    const target = messages.find((m) => m.id === editing.id)
    const body = input.trim()
    // A photo's caption may be emptied; a text message may not.
    if (!body && !target?.file) return
    if (body === (target?.body || '').trim()) { endEdit(); return }
    setBusy(true)
    try {
      const mentions = active ? resolveMentions(body, [...picked, ...(target?.mentions || [])], active.members, user!.id) : []
      const d = await api.patch(`/chat/message/${editing.id}`, { body, mentions })
      setMessages((p) => p.map((m) => (m.id === editing.id ? { ...m, body: d.body, edited_at: d.edited_at, mentions: d.mentions } : m)))
      endEdit()
      loadConvos()
    } catch (e: any) { toast.error('Could not edit: ' + e.message) } finally { setBusy(false) }
  }

  // ---- message actions ----
  const react = async (m: Msg, emoji: string) => {
    setReactFor(null); setMenuId(null); setSelectedId(null)
    try { const d = await api.post(`/chat/message/${m.id}/reactions`, { emoji }); setMessages((p) => p.map((x) => (x.id === m.id ? { ...x, reactions: d.reactions } : x))) } catch {}
  }
  const toggleStar = async (m: Msg) => {
    setMenuId(null)
    const next = !m.starred
    setMessages((p) => p.map((x) => (x.id === m.id ? { ...x, starred: next } : x)))
    try { if (next) await api.post(`/chat/message/${m.id}/star`); else await api.del(`/chat/message/${m.id}/star`) } catch {}
  }
  // Delete asks first: "for everyone" (your own, still there) or "for me".
  const del = (m: Msg) => { setMenuId(null); setDeleteFor([m]) }
  const canDeleteForAll = (list: Msg[]) => list.length > 0 && list.every((m) => m.sender_id === user!.id && !m.deleted && !isRecordLine(m) && !m.id.startsWith('tmp_'))
  const doDelete = async (list: Msg[], scope: 'me' | 'all') => {
    setDeleteFor(null); setMulti(null); setSelectedId(null)
    const snap = messages
    const ids = new Set(list.map((m) => m.id))
    if (scope === 'all') setMessages((p) => p.map((x) => (ids.has(x.id) ? { ...x, deleted: true, body: '', file: null, reactions: [], poll: null, task: null, location: null, contact: null, kind: null } : x)))
    else setMessages((p) => p.filter((x) => !ids.has(x.id)))
    try {
      for (const m of list) await api.del(`/chat/message/${m.id}${scope === 'me' ? '?scope=me' : ''}`)
      loadConvos()
      if (scope === 'all') loadPins(activeIdRef.current)
    } catch (e: any) { setMessages(snap); toast.error('Could not delete: ' + e.message) }
  }

  // ---- several messages at once (WhatsApp's select mode) ----
  const startMulti = (m: Msg) => { setMenuId(null); setSelectedId(null); setMulti([m.id]) }
  const toggleMulti = (id: string) => setMulti((cur) => {
    const next = !cur ? [id] : cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    return next.length ? next : null
  })
  const multiMsgs = (multi || []).map((id) => messages.find((m) => m.id === id)).filter((m): m is Msg => !!m && !m.deleted)
  // In thread order, so a copy or a forward reads the way it was said.
  const inOrder = (list: Msg[]) => list.slice().sort((a, b) => a.created_at.localeCompare(b.created_at))
  const copyMany = async (list: Msg[]) => {
    const lines = inOrder(list).map((m) => `[${fmtTime(m.created_at)}, ${new Date(m.created_at).toLocaleDateString()}] ${m.sender_id === user!.id ? user!.name : senderName(m.sender_id)}: ${m.body || m.transcript || m.file?.name || ''}`)
    const text = list.length === 1 ? (list[0].body || list[0].transcript || '') : lines.join('\n')
    try { await navigator.clipboard.writeText(text); toast.success(list.length === 1 ? 'Copied' : `${list.length} messages copied`) } catch { window.prompt('Copy:', text) }
    setMulti(null)
  }
  const starMany = async (list: Msg[]) => {
    const next = !list.every((m) => m.starred)
    const ids = new Set(list.map((m) => m.id))
    setMessages((p) => p.map((x) => (ids.has(x.id) ? { ...x, starred: next } : x)))
    setMulti(null)
    for (const m of list) { try { if (next) await api.post(`/chat/message/${m.id}/star`); else await api.del(`/chat/message/${m.id}/star`) } catch {} }
  }

  // WhatsApp's "Reply privately": answer a group message in a one-to-one with
  // whoever wrote it, quoting it there.
  const replyPrivately = (m: Msg) => {
    setMenuId(null); setSelectedId(null)
    api.post('/chat/conversations', { type: 'direct', userId: m.sender_id })
      .then((conv: any) => { pendingReplyRef.current = m; loadConvos(); setActiveId(conv.id) })
      .catch(() => toast.error("I couldn't open that conversation."))
  }
  const copy = async (m: Msg) => {
    setMenuId(null)
    const text = m.file ? `${location.origin}${fileUrl(m)}` : m.body
    // Said out loud: from the phone's action bar there is nothing else to show
    // that the tap did anything.
    try { await navigator.clipboard.writeText(text); toast.success('Copied') } catch { window.prompt('Copy:', text) }
  }
  const share = async (m: Msg) => {
    setMenuId(null)
    const url = m.file ? `${location.origin}${fileUrl(m)}` : undefined
    const shareData: any = m.file ? { title: m.file.name, url } : { text: m.body }
    if (navigator.share) { try { await navigator.share(shareData) } catch {} }
    else { try { await navigator.clipboard.writeText(url || m.body); toast.success('Link copied to clipboard') } catch {} }
  }
  const download = (m: Msg) => {
    setMenuId(null)
    const a = document.createElement('a'); a.href = fileUrl(m, true); a.download = m.file?.name || 'file'
    document.body.appendChild(a); a.click(); a.remove()
  }
  const togglePin = async (m: Msg) => {
    setMenuId(null)
    const next = !m.pinned_at
    try {
      if (next) await api.post(`/chat/message/${m.id}/pin`)
      else await api.del(`/chat/message/${m.id}/pin`)
      setMessages((p) => p.map((x) => (x.id === m.id ? { ...x, pinned_at: next ? new Date().toISOString() : null } : x)))
      if (activeId) loadPins(activeId)
    } catch (e: any) { toast.error('Could not pin: ' + e.message) }
  }

  // Cliq's "leave this for later": rewind the read cursor and drop back to the
  // list, because staying in the thread would mark it read again on the spot.
  const markUnread = async (m: Msg) => {
    setMenuId(null)
    try {
      await api.post(`/chat/conversations/${m.conversation_id}/unread`, { messageId: m.id })
      setActiveId('')
      loadConvos()
      toast.success('Marked unread')
    } catch (e: any) { toast.error('Could not mark unread: ' + e.message) }
  }

  // Straight into the box with the caret at the end: choosing Edit means typing
  // next. Whatever was half-typed is set aside and comes back afterwards.
  const startEdit = (m: Msg) => {
    if (!isEditable(m) || m.sender_id !== user!.id) return
    setMenuId(null); setSelectedId(null); setMulti(null)
    if (!editing) editStashRef.current = input
    setEditing({ id: m.id, body: m.body }); setInput(m.body); setReplyTo(null)
    setPicked(m.mentions || [])
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(m.body.length, m.body.length) })
  }
  // Straight into the box: choosing Reply means the next thing is typing.
  const startReply = (m: Msg) => { setMenuId(null); if (editing) endEdit(); setReplyTo(m); requestAnimationFrame(() => inputRef.current?.focus()) }

  // Every action a message offers, in one list, so the desktop's hover menu and
  // the phone's action bar cannot drift apart. `bar` marks the ones the phone
  // bar shows as icons; its ⋮ lists the rest, in this order. The desktop's ⋯
  // regroups the same list (deskMenu).
  //
  // Edit is on the bar, not under ⋮: it was in the menu, fourteenth of fifteen,
  // and "there is no edit option" was the result. Copy gives up its place when
  // Edit takes it, so the bar fits a 360px phone either way.
  const msgActions = (m: Msg): MsgAction[] => {
    const mine = m.sender_id === user!.id
    const record = isRecordLine(m)
    const editable = mine && isEditable(m)
    const fromGroupPeer = active?.type === 'group' && !mine && !record && active.members.some((x) => x.id === m.sender_id)
    const list: (MsgAction | false)[] = [
      !record && { key: 'reply', label: 'Reply', icon: 'reply', bar: true, run: () => startReply(m) },
      editable && { key: 'edit', label: 'Edit', glyph: 'pencil', bar: true, run: () => startEdit(m) },
      !record && m.kind !== 'task' && { key: 'task', label: readOnly ? 'Make a task' : 'Assign as task', icon: 'taskAdd', bar: true, run: () => toTask({ messageId: m.id }, m) },
      { key: 'star', label: m.starred ? 'Unstar' : 'Star', icon: 'star', bar: true, on: m.starred, run: () => toggleStar(m) },
      isForwardable(m) && { key: 'forward', label: 'Forward', icon: 'forward', bar: true, run: () => setForwardMsgs([m]) },
      // The only copy. A "Copy link" (to this message) used to follow it and
      // read as the same action twice, so it was taken out on request.
      !record && { key: 'copy', label: 'Copy', glyph: 'copy', bar: !editable, run: () => copy(m) },
      mine && !record && { key: 'info', label: 'Message info', run: () => setInfoFor(m) },
      fromGroupPeer && { key: 'private', label: 'Reply privately', run: () => replyPrivately(m) },
      { key: 'select', label: 'Select', run: () => startMulti(m) },
      !record && { key: 'pin', label: m.pinned_at ? 'Unpin' : 'Pin', run: () => togglePin(m) },
      !record && { key: 'remind', label: 'Remind me', run: () => setRemindFor(m) },
      isManager && !record && { key: 'fork', label: 'Fork to new chat', run: () => setForkFrom(m) },
      { key: 'unread', label: 'Mark unread', run: () => markUnread(m) },
      !!m.file && { key: 'download', label: 'Download', run: () => download(m) },
      !record && { key: 'share', label: 'Share', run: () => share(m) },
      { key: 'delete', label: 'Delete', icon: 'trash', bar: true, danger: true, run: () => del(m) },
    ]
    return list.filter(Boolean) as MsgAction[]
  }
  const actionIcon = (a: MsgAction, size = 20) =>
    a.glyph === 'copy' ? <CopyGlyph size={size} /> : a.glyph === 'pencil' ? <PencilGlyph size={size} /> : <Ic name={a.icon!} size={size} />
  // The same actions as the ⋯ menu of a mouse screen. The phone's ⋮ keeps
  // msgActions' order as it is; this is a reading of it for a pointer menu:
  // - React, Reply, Edit and Assign as task are the buttons beside the ⋯ on
  //   hover, so they are not repeated under it. With them it was a column of
  //   fourteen plain rows or more, the first three a copy of what the mouse
  //   had just passed.
  // - The rest go in groups with a rule between them (pass it on / keep track /
  //   the rest / Delete), each with its icon, so a long list can be scanned.
  //   An action with no group here (a new one) lands just above Delete.
  const deskMenu = (m: Msg): ActionItem[][] => {
    const acts = msgActions(m).filter((a) => !ON_HOVER_TOOLS.has(a.key))
    const groups = DESK_MENU_GROUPS.map((keys) => keys.flatMap((k) => acts.filter((a) => a.key === k)))
    const placed = new Set(DESK_MENU_GROUPS.flat())
    const rest = acts.filter((a) => !placed.has(a.key))
    if (rest.length) groups.splice(groups.length - 1, 0, rest)
    return groups.filter((g) => g.length).map((g) => g.map((a) => ({
      key: a.key, label: a.label, on: a.on, danger: a.danger, run: a.run,
      icon: DESK_MENU_ICONS[a.key] || (a.icon || a.glyph ? actionIcon(a, 16) : null),
    })))
  }
  // ↑ in an empty box edits your last message, as on WhatsApp Web.
  const lastEditable = () => [...messages].reverse().find((m) => m.sender_id === user!.id && isEditable(m))

  // Select a message (touch screens): highlight it, float the reactions where
  // they fit, and hand the header to its actions. The reactions need ~58px
  // above or below the message inside the scrolling thread, which clips
  // anything that pokes out of it. A message with room on neither side (a long
  // one) is scrolled down to make room above when the thread can scroll that
  // far, and otherwise gets them over its own top edge.
  // `pressY`: where the finger was (a tap or a long-press), so the tray never
  // lands under it — the next tap there means the message (deselect), and a
  // reaction it posted would be a reaction nobody chose.
  const selectMessage = (id: string, bubble: HTMLElement, pressY?: number) => {
    const log = logRef.current
    const wrap = bubble.closest('.msg-wrap') as HTMLElement | null
    let place: 'above' | 'below' | 'inside' = 'above'
    let top = 8
    if (log && wrap) {
      const L = log.getBoundingClientRect()
      const W = wrap.getBoundingClientRect()
      const above = W.top - L.top
      const below = L.bottom - W.bottom
      if (above >= TRAY_ROOM) place = 'above'
      else if (below >= TRAY_ROOM) place = 'below'
      else {
        // A message with no room on either side: over the part of it that is on
        // screen, at the end away from the finger. Never scrolled — that slid the
        // tray under a finger still down, and threw a reader of a long message
        // back to its first line. +3: the selected row's -3px margin lifts the
        // box the tray hangs from.
        place = 'inside'
        const first = Math.max(W.top, L.top) + 8
        const last = Math.max(first, Math.min(W.bottom, L.bottom) - TRAY_ROOM)
        const nearTop = pressY != null && pressY < (first + last) / 2 + TRAY_ROOM / 2
        top = (nearTop ? last : first) - W.top + 3
      }
    }
    setTrayPlace(place); setTrayTop(top)
    setSelectedId(id)
    setMenuId(null); setReactFor(null); setEmojiFor(null); setHeadMenu(false); setJumpOpen(false); setLoadOpen(false)
  }
  // The chat's info panel — from the header's photo or name, or from ⋮. It
  // remembers what opened it, to hand focus back on close; an item in ⋮'s menu
  // goes away with the menu, so for those it is ⋮ itself.
  const infoOpenerRef = useRef<HTMLElement | null>(null)
  const openInfo = (view: InfoView = { view: 'info' }) => {
    const from = document.activeElement as HTMLElement | null
    infoOpenerRef.current = from?.closest('.head-menu')
      ? document.querySelector<HTMLElement>('.chat-peer-actions [aria-label="More options"]')
      : from
    setInfoStart(view); setShowInfo(true)
    setHeadMenu(false); setJumpOpen(false); setLoadOpen(false); setSelectedId(null)
  }
  // The header's photo and name, and ⓘ: open the panel, or close it again —
  // docked beside the thread, the header stays in reach while it is open.
  const toggleInfo = () => { if (showInfo) setShowInfo(false); else openInfo() }
  // A list row's avatar opens that chat with its info already up, as
  // WhatsApp's list does; the rest of the row opens just the chat.
  const openInfoFor = (cid: string) => {
    setShowArchived(false)
    if (cid === activeIdRef.current) { openInfo(); return }
    pendingInfoRef.current = { view: 'info' }
    setActiveId(cid)
  }
  // "Show in chat" from media, links and docs. Docked, the thread is in view
  // beside the panel; covering it, the panel steps aside first. A search would
  // hide the very line asked for, so it goes too (as Jump to a date does).
  const showMessage = (mid: string) => {
    if (!infoDocks) setShowInfo(false)
    setViewerAt(null)
    if (inSearch || inSearchOpen) { setInSearch(''); setInSearchOpen(false) }
    // After the re-render that brings the whole thread back.
    setTimeout(() => { if (!scrollToMessage(mid)) toast.info('That message is further back than this chat has loaded') }, 60)
  }
  // A review in the panel changes how many of a meeting's tasks still wait.
  // The card the meeting left in the thread counted them when the thread
  // loaded, so it is handed the new number rather than the thread reloaded.
  const patchMeetingCard = (meetingId: string, pending: number) => setMessages((p) => (
    p.some((m) => m.meeting?.id === meetingId && m.meeting.tasks !== pending)
      ? p.map((m) => (m.meeting?.id === meetingId ? { ...m, meeting: { ...m.meeting, tasks: pending } } : m))
      : p
  ))
  // Below 1400px the panel covers the thread, but the composer's slash,
  // @mention and emoji pop-ups sit above it and would float over the panel,
  // unreachable, until it closed. However it opens — a tap, or a summary
  // finishing — they close first, before that frame is painted.
  const infoCovers = showInfo && !!active && !infoDocks
  useLayoutEffect(() => {
    if (!infoCovers) return
    setSlashQ(null); setMentionQ(null); setEmojiFor(null); setAttachMenu(false)
  }, [infoCovers])
  useEffect(() => {
    if (showInfo) return
    const el = infoOpenerRef.current
    infoOpenerRef.current = null
    if (!el) return
    requestAnimationFrame(() => {
      if ((!document.activeElement || document.activeElement === document.body) && el.isConnected) el.focus()
    })
  }, [showInfo])
  const cancelPress = () => { if (pressRef.current) { clearTimeout(pressRef.current.timer); pressRef.current = null } }
  // Swipe right to reply. A drag that starts sideways is a swipe (the thread
  // does not scroll sideways, so nothing is taken from scrolling); one that
  // starts up or down is left to the scroll. The row follows the finger, and
  // past SWIPE_REPLY_PX letting go replies.
  const swipeRef = useRef<{ x: number; y: number; dx: number; on: boolean; wrap: HTMLElement | null } | null>(null)
  const endSwipe = (m: Msg | null) => {
    const s = swipeRef.current
    swipeRef.current = null
    if (!s?.on) return
    s.wrap?.classList.remove('swiping', 'swipe-armed')
    s.wrap?.style.removeProperty('--swipe')
    longPressedRef.current = true // the click that ends a drag is not a tap
    if (m && s.dx >= SWIPE_REPLY_PX) { try { navigator.vibrate?.(10) } catch { /* the reply banner says it */ } startReply(m) }
  }
  // While messages are being picked (touch), a tap adds or removes one; a tap
  // on a second message while one is selected starts picking, as in WhatsApp.
  const tapPick = (m: Msg, bubble: HTMLElement, y: number) => {
    if (multi) { toggleMulti(m.id); return }
    if (selectedId && selectedId !== m.id) { setMulti([selectedId, m.id]); setSelectedId(null); return }
    if (selectedId === m.id) setSelectedId(null)
    else selectMessage(m.id, bubble, y)
  }
  // A bubble's handlers on a touch screen: a tap selects (or, on the selected
  // message, deselects); holding still for LONG_PRESS_MS selects too, with a
  // buzz, the way WhatsApp does. A finger that moves is scrolling, not
  // pressing. Things inside the bubble with their own job — the voice player,
  // Download, the transcribe buttons — keep their taps. A tap on a link or an
  // image opens it, but a long-press on one selects the message, and the
  // phone's own long-press menu is kept out of the way. Mouse devices get none
  // of this: they have the hover tools.
  const bubbleTouch = (m: Msg) => (!touchUI || m.id.startsWith('tmp_') ? {} : {
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      longPressedRef.current = false
      if ((e.target as HTMLElement).closest(PRESS_SKIP)) return
      cancelPress()
      const bubble = e.currentTarget
      const y = e.clientY
      // Swiping is for replying, which a picked selection or a deleted message is not.
      swipeRef.current = !multi && !selectedId && !m.deleted && !isRecordLine(m)
        ? { x: e.clientX, y, dx: 0, on: false, wrap: bubble.closest('.msg-wrap') as HTMLElement | null }
        : null
      pressRef.current = {
        x: e.clientX, y,
        timer: setTimeout(() => {
          pressRef.current = null
          swipeRef.current = null
          longPressedRef.current = true
          try { navigator.vibrate?.(12) } catch { /* not allowed here; the highlight says it */ }
          if (multi) toggleMulti(m.id)
          else if (selectedId && selectedId !== m.id) { setMulti([selectedId, m.id]); setSelectedId(null) }
          else selectMessage(m.id, bubble, y)
        }, LONG_PRESS_MS),
      }
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      const p = pressRef.current
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancelPress()
      const s = swipeRef.current
      if (!s) return
      const dx = e.clientX - s.x, dy = e.clientY - s.y
      if (!s.on) {
        if (dx > 14 && dx > Math.abs(dy) * 1.5) { s.on = true; cancelPress(); try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* fine without */ } }
        else if (Math.abs(dy) > 12 || dx < -14) { swipeRef.current = null; return }
      }
      if (s.on) {
        s.dx = Math.max(0, Math.min(96, dx))
        s.wrap?.classList.add('swiping')
        s.wrap?.classList.toggle('swipe-armed', s.dx >= SWIPE_REPLY_PX)
        s.wrap?.style.setProperty('--swipe', `${s.dx}px`)
      }
    },
    onPointerUp: () => { cancelPress(); endSwipe(m) },
    onPointerCancel: () => { cancelPress(); endSwipe(null) },
    onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => e.preventDefault(),
    // The click a long-press ends with (where the browser sends one) is the
    // same gesture: caught on the way down, before a link, the voice player or a
    // button inside the bubble can act on it.
    onClickCapture: (e: React.MouseEvent<HTMLDivElement>) => {
      if (longPressedRef.current) { longPressedRef.current = false; e.preventDefault(); e.stopPropagation(); return }
      // Picking messages: every tap picks, even one on a link, a picture or
      // the voice player — caught here, before any of them can act on it.
      if (multi) { e.preventDefault(); e.stopPropagation(); toggleMulti(m.id) }
    },
    onClick: (e: React.MouseEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest(TAP_SKIP)) return
      e.stopPropagation()
      tapPick(m, e.currentTarget, e.clientY)
    },
    // Without a finger to tap with — a keyboard on a tablet, Switch Access —
    // the bubble takes focus and Enter, Space or the menu key select it, then
    // focus moves into the action bar. Being focusable is also what makes
    // TalkBack announce it as something that can be activated. Not a button
    // role: a bubble can hold links and buttons of its own.
    tabIndex: 0,
    'aria-describedby': 'msg-select-hint',
    onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget) return
      if (!(e.key === 'Enter' || e.key === ' ' || e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) return
      e.preventDefault()
      if (multi) { toggleMulti(m.id); return }
      if (selectedId === m.id) { setSelectedId(null); return }
      selectMessage(m.id, e.currentTarget)
      requestAnimationFrame(() => document.querySelector<HTMLElement>('.sel-bar .chat-peer-actions button')?.focus())
    },
  })

  // minutes = 0 unmutes. A timed mute wears off by itself server-side, which is
  // the difference between "quiet for this meeting" and accidentally going dark
  // on a channel for a month.
  const muteConversation = async (c: Conversation, minutes: number) => {
    setMuteFor(null)
    setConvos((cs) => cs.map((x) => (x.id === c.id ? { ...x, muted: minutes > 0 } : x)))
    try { await api.post(`/chat/conversations/${c.id}/prefs`, { mute_minutes: minutes }); loadConvos() }
    catch (e: any) { toast.error('Could not change mute: ' + e.message); loadConvos() }
  }

  const setPref = async (c: Conversation, pref: 'muted' | 'pinned') => {
    setConvoMenu(null)
    const next = !c[pref]
    setConvos((cs) => cs.map((x) => (x.id === c.id ? { ...x, [pref]: next } : x)))
    try { await api.post(`/chat/conversations/${c.id}/prefs`, { [pref]: next }); loadConvos() } catch { loadConvos() }
  }

  const clearChat = async (c: Conversation) => {
    setConvoMenu(null)
    if (!(await confirmDialog({ title: 'Clear chat', message: 'Clear all messages in this chat? This only clears them for you.', confirmText: 'Clear chat', danger: true }))) return
    try { await api.post(`/chat/conversations/${c.id}/clear`); if (c.id === activeId) setMessages([]); loadConvos() }
    catch (e: any) { toast.error('Could not clear: ' + e.message) }
  }

  // Archive: out of the list (and out of the unread badge) until brought back.
  const archive = async (c: Conversation, on: boolean) => {
    setConvoMenu(null)
    setConvos((cs) => cs.map((x) => (x.id === c.id ? { ...x, archived: on } : x)))
    if (on && c.id === activeIdRef.current) setActiveId('')
    try { await api.post(`/chat/conversations/${c.id}/prefs`, { archived: on }); toast.success(on ? 'Chat archived' : 'Chat unarchived'); loadConvos() }
    catch (e: any) { toast.error(e.message); loadConvos() }
  }
  // "Mark as unread" leaves a dot; "Mark as read" clears the count and the dot.
  const markChat = async (c: Conversation, unread: boolean) => {
    setConvoMenu(null)
    setConvos((cs) => cs.map((x) => (x.id === c.id ? { ...x, marked_unread: unread, unread: unread ? x.unread : 0 } : x)))
    try {
      if (unread) await api.post(`/chat/conversations/${c.id}/prefs`, { marked_unread: true })
      else await api.post(`/chat/conversations/${c.id}/read`)
      loadConvos()
    } catch { loadConvos() }
  }
  // WhatsApp's "Delete chat" (one-to-one): gone from the list, cleared for you,
  // back by itself with the next message.
  const deleteChat = async (c: Conversation) => {
    setConvoMenu(null)
    if (!(await confirmDialog({ title: `Delete chat with ${c.name}?`, message: 'Messages are deleted for you only. The chat comes back if either of you writes again.', confirmText: 'Delete chat', danger: true }))) return
    try {
      await api.post(`/chat/conversations/${c.id}/remove`)
      if (c.id === activeIdRef.current) { setShowInfo(false); setActiveId('') }
      setDrafts((d) => { if (!d[c.id]) return d; const n = { ...d }; delete n[c.id]; writeDrafts(n); return n })
      loadConvos()
    } catch (e: any) { toast.error('Could not delete: ' + e.message) }
  }
  const exitGroup = async (c: Conversation) => {
    setConvoMenu(null)
    if (!(await confirmDialog({ title: 'Exit group?', message: `You will stop getting messages from "${c.name}".`, confirmText: 'Exit', danger: true }))) return
    try { await api.del(`/chat/conversations/${c.id}/members/${user!.id}`); if (c.id === activeIdRef.current) setActiveId(''); loadConvos() }
    catch (e: any) { toast.error(e.message) }
  }

  // Export chat: the whole conversation as a .txt in WhatsApp's own layout
  // ("21/10/26, 4:05 pm - Priya: …"), in this device's time zone.
  const exportChat = async (c: Conversation) => {
    setHeadMenu(false)
    try {
      const d = await api.get(`/chat/conversations/${c.id}/export`)
      const stamp = (iso: string) => {
        const t = new Date(iso)
        const dd = String(t.getDate()).padStart(2, '0'), mm = String(t.getMonth() + 1).padStart(2, '0'), yy = String(t.getFullYear()).slice(2)
        return `${dd}/${mm}/${yy}, ${t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
      }
      const lines = (d.items as { at: string; sender: string; text: string; event: boolean }[])
        .map((i) => `${stamp(i.at)} - ${i.event ? '' : i.sender + ': '}${i.text}`)
      const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `VoTask chat with ${c.name.replace(/[\\/:*?"<>|]/g, '')}.txt`
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(a.href), 4000)
      toast.success(`Exported ${lines.length} messages`)
    } catch (e: any) { toast.error('Could not export: ' + e.message) }
  }

  // ---- polls, places, people: messages that are not just text ----
  const sendPoll = async (question: string, options: string[], multiAnswers: boolean) => {
    if (!active) return false
    try {
      const m = await api.post(`/chat/conversations/${active.id}/poll`, { question, options, multi: multiAnswers })
      mergeIncoming(m); setPollOpen(false); loadConvos()
      return true
    } catch (e: any) { toast.error('Could not send the poll: ' + e.message); return false }
  }
  const vote = async (m: Msg, picks: number[]) => {
    // Shown at once, put right by the server's answer (and everyone else's votes).
    const prev = m.poll
    if (prev) setMessages((p) => p.map((x) => (x.id === m.id ? { ...x, poll: { ...prev, options: prev.options.map((o, i) => ({ ...o, voters: picks.includes(i) ? [...o.voters.filter((u) => u !== user!.id), user!.id] : o.voters.filter((u) => u !== user!.id) })) } as Poll } : x)))
    try {
      const d = await api.post(`/chat/message/${m.id}/vote`, { options: picks })
      setMessages((p) => p.map((x) => (x.id === m.id ? { ...x, poll: d.poll } : x)))
    } catch (e: any) {
      setMessages((p) => p.map((x) => (x.id === m.id ? { ...x, poll: prev } : x)))
      toast.error('Could not vote: ' + e.message)
    }
  }
  const sendLocation = async (loc: LocationRef) => {
    if (!active) return false
    try {
      const m = await api.post(`/chat/conversations/${active.id}/messages`, { kind: 'location', meta: loc, replyTo: replyTo?.id })
      mergeIncoming(m); setLocOpen(false); setReplyTo(null); loadConvos()
      return true
    } catch (e: any) { toast.error('Could not send your location: ' + e.message); return false }
  }
  const sendContact = async (u: OrgUser) => {
    if (!active) return
    setContactOpen(false)
    try {
      const m = await api.post(`/chat/conversations/${active.id}/messages`, { kind: 'contact', meta: { user_id: u.id }, replyTo: replyTo?.id })
      mergeIncoming(m); setReplyTo(null); loadConvos()
    } catch (e: any) { toast.error('Could not share the contact: ' + e.message) }
  }
  const messageUser = (uid: string) => {
    api.post('/chat/conversations', { type: 'direct', userId: uid })
      .then((conv: any) => { setShowInfo(false); loadConvos(); setActiveId(conv.id) })
      .catch(() => toast.error("I couldn't open that conversation."))
  }

  const senderName = (uid: string) => (active?.members.find((mm) => mm.id === uid)?.name) || (uid === user?.id ? 'You' : 'Unknown')
  const senderColor = (uid: string) => active?.members.find((mm) => mm.id === uid)?.avatar_color

  // Every day the loaded thread actually contains, newest first, each pointing at
  // its first message. Built from what's on screen rather than asked of the
  // server: the thread loads whole (800 messages), so the index is already here.
  const dayIndex = useMemo(() => {
    const out: { key: string; iso: string; label: string; id: string; count: number }[] = []
    for (const m of messages) {
      if (m.deleted) continue
      const d = new Date(m.created_at)
      const key = d.toDateString()
      const hit = out.find((x) => x.key === key)
      if (hit) hit.count++
      else out.push({ key, iso: isoDay(d), label: dayLabel(m.created_at), id: m.id, count: 1 })
    }
    return out.reverse() // newest day first, which is the order people look for
  }, [messages])

  // Scroll to the first message of a day and flash it, so the jump is visible
  // rather than the thread just silently being somewhere else.
  const jumpToDay = (iso: string) => {
    setJumpOpen(false)
    let target = dayIndex.find((d) => d.iso === iso)
    if (!target) {
      // A date with no messages: land on the first day AFTER it, which is what
      // someone scrubbing for "around the 3rd" actually wants.
      const want = new Date(iso + 'T00:00:00').getTime()
      target = [...dayIndex].reverse().find((d) => new Date(d.key).getTime() >= want)
    }
    if (!target) { toast.info('No messages on or after that date'); return }
    if (inSearch) { setInSearch(''); setInSearchOpen(false) }
    const id = target.id
    requestAnimationFrame(() => scrollToMessage(id))
  }

  const runGlobalSearch = async (override?: string) => {
    const q = (override ?? search).trim()
    if (q.length < 2) return
    setHitsBusy(true)
    try { const d = await api.get(`/chat/search?q=${encodeURIComponent(q)}`); setHits(d.items) }
    catch (e: any) { toast.error('Search failed: ' + e.message) }
    finally { setHitsBusy(false) }
  }
  useEffect(() => { if (search.trim().length < 2) setHits(null) }, [search])

  const hasUnread = (c: Conversation) => c.unread > 0 || !!c.marked_unread
  // A list row's ⋯ on a mouse screen (ActionMenu): the same rows as the touch
  // menu below in the list, in the same order, with icons and the two
  // destructive ones set apart at the bottom.
  const convoMenuGroups = (c: Conversation): ActionItem[][] => [
    [
      { key: 'archive', label: c.archived ? 'Unarchive chat' : 'Archive chat', icon: <ArchiveGlyph size={16} />, run: () => archive(c, !c.archived) },
      { key: 'pin', label: c.pinned ? 'Unpin chat' : 'Pin chat', icon: <Ic name="pin" size={16} />, on: c.pinned, run: () => setPref(c, 'pinned') },
      { key: 'mute', label: c.muted ? 'Unmute notifications' : 'Mute notifications', icon: <Ic name={c.muted ? 'bell' : 'muteBell'} size={16} />, run: () => { if (c.muted) muteConversation(c, 0); else setMuteFor(c) } },
      { key: 'mark', label: hasUnread(c) ? 'Mark as read' : 'Mark as unread', icon: <Ic name="chat" size={16} />, run: () => markChat(c, !hasUnread(c)) },
      { key: 'export', label: 'Export chat', icon: <ExportGlyph size={16} />, run: () => exportChat(c) },
    ],
    [
      { key: 'clear', label: 'Clear chat', icon: <Ic name="block" size={16} />, danger: true, run: () => clearChat(c) },
      c.type === 'direct'
        ? { key: 'delete', label: 'Delete chat', icon: <Ic name="trash" size={16} />, danger: true, run: () => deleteChat(c) }
        : { key: 'exit', label: 'Exit group', icon: <Ic name="logout" size={16} />, danger: true, run: () => exitGroup(c) },
    ],
  ]
  // The open chat stays under "Unread" while it is open, though opening it
  // just read it — otherwise it would vanish from under your finger.
  const inTab = (c: Conversation, tab: ListTab) => tab === 'all' || (tab === 'unread' ? hasUnread(c) || c.id === activeId : c.type === tab)
  const archivedConvos = convos.filter((c) => c.archived)
  // A search looks everywhere, archived chats included; otherwise the archive
  // is its own list.
  const filteredConvos = convos.filter((c) => (search.trim()
    ? c.name.toLowerCase().includes(search.trim().toLowerCase())
    : showArchived ? !!c.archived : !c.archived && inTab(c, listTab)))
  // Per tab, how many chats have something unread — the number WhatsApp puts on
  // its filters. Muted chats are left out: muting means "don't call me over".
  const tabUnread = (tab: ListTab) => convos.filter((c) => !c.archived && inTab(c, tab) && hasUnread(c) && !c.muted).length
  const archivedUnread = archivedConvos.filter(hasUnread).length
  const listEmpty = search.trim()
    ? `No chats match “${search.trim()}”`
    : showArchived ? 'No archived chats' : LIST_TABS.find((t) => t.id === listTab)!.empty
  // Every photo and video loaded in the thread, oldest first: what the viewer steps through.
  const mediaMsgs = messages.filter((m) => !m.deleted && !m.uploading && !!m.file && ((m.file.type || '').startsWith('image/') || isVideo(m.file)))
  // The person a direct chat is with, and what they are holding (for the header chip).
  const peerLoad = active?.type === 'direct' && active.other_user_id ? workload[active.other_user_id] : undefined
  const reactionsMsg = reactionsOf ? messages.find((x) => x.id === reactionsOf) || null : null
  // The message the header's action bar acts on (touch screens). A message
  // deleted while selected — here or over the socket — ends the selection.
  const selMsg = touchUI && selectedId ? messages.find((x) => x.id === selectedId && !x.deleted) || null : null
  // ...and the selection itself ends then (deleted for everyone, removed for
  // me, chat cleared, touch turned off), or the next Escape or Back would be
  // spent letting go of a message no longer there.
  useEffect(() => { if (selectedId && !selMsg) setSelectedId(null) }, [selectedId, selMsg])
  // Searching no longer filters the thread: matches are highlighted in place and
  // stepped through (searchHits), so each one is read with what was said around it.
  const shownMessages = messages
  // Interleave date separators (Today / Yesterday / date) + an "unread" divider,
  // which says how many, as WhatsApp's does.
  const isUnreadForMe = (m: Msg) => !!threadLastRead && m.created_at > threadLastRead && m.sender_id !== user?.id && m.kind !== 'system'
  const unreadCount = inSearch ? 0 : messages.filter(isUnreadForMe).length
  const logItems: ({ sep: string } | { unread: number } | { m: Msg })[] = []
  let lastDay = ''
  let unreadShown = false
  for (const m of shownMessages) {
    const day = new Date(m.created_at).toDateString()
    if (day !== lastDay) { logItems.push({ sep: dayLabel(m.created_at) }); lastDay = day }
    if (!unreadShown && !inSearch && isUnreadForMe(m)) {
      logItems.push({ unread: unreadCount }); unreadShown = true
    }
    logItems.push({ m })
  }
  // Group: "Send messages — only admins" and I am not one.
  const readOnly = !!active && active.type === 'group' && !!active.admins_only && active.role !== 'admin'

  if (loading) return <div className="card" style={{ display: 'grid', placeItems: 'center', height: 'calc(100vh - 160px)' }}><span className="spinner" /></div>

  return (
    <div className={'assistant-layout chat-layout' + (threadOpen ? ' chat-open' : '')}>
      {/* ---- sidebar: conversations ---- */}
      <aside className="chat-history">
        <div className="chat-history-head">
          {showArchived ? (
            <span className="ch-title row" style={{ gap: 4 }}>
              <button className="ic-btn" style={{ width: 30, height: 30 }} onClick={() => setShowArchived(false)} aria-label="Back to chats" title="Back to chats">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
              </button>
              Archived
            </span>
          ) : <span className="ch-title">Chats</span>}
          <div className="row" style={{ gap: 2 }}>
            <button className="ic-btn" onClick={() => setCallsOpen(true)} title="Calls" aria-label="Calls"><Ic name="phone" size={18} /></button>
            <button className="ic-btn" onClick={() => setShowMentions(true)} title="Messages that mention me" aria-label="Messages that mention me"><Ic name="at" size={18} /></button>
            <button className="ic-btn" onClick={() => setShowStarred(true)} title="Starred messages" aria-label="Starred messages"><Ic name="star" size={18} /></button>
            <button className="ic-btn" onClick={() => setShowLater(true)} title="Reminders & scheduled messages" aria-label="Reminders and scheduled messages"><Ic name="clock" size={18} /></button>
            <button className="btn btn-primary btn-sm row" style={{ gap: 5, marginLeft: 4 }} onClick={() => setShowNew(true)} title="New chat / group"><Ic name="plus" size={15} /> New</button>
          </div>
        </div>
        <input className="chat-contact-search" placeholder="Search chats…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {/* Your own status, spelled out rather than hidden behind an icon — an
            unlabelled smiley is the kind of control nobody ever finds. */}
        <button className="status-row" onClick={() => setShowStatus(true)}>
          <span className="status-dot-lg" data-dnd={myStatus.dnd_until && myStatus.dnd_until > new Date().toISOString() ? '1' : '0'} />
          <span className="status-row-text">
            {myStatus.dnd_until && myStatus.dnd_until > new Date().toISOString()
              ? 'Do not disturb'
              : (myStatus.status_text ? `${myStatus.status_emoji || ''} ${myStatus.status_text}`.trim() : 'Set a status')}
          </span>
          <Ic name="edit" size={12} />
        </button>
        {search.trim().length >= 2 && (
          <button className="search-all" onClick={() => runGlobalSearch()} disabled={hitsBusy}>
            <Ic name="search" size={13} /> {hitsBusy ? 'Searching…' : `Search all messages for "${search.trim()}"`}
          </button>
        )}
        {hits !== null ? (
          <div className="convo-list">
            <div className="ch-title" style={{ padding: '6px 4px' }}>{hits.length} message{hits.length === 1 ? '' : 's'}</div>
            {hits.length === 0 && <div className="empty" style={{ padding: 16, fontSize: 13 }}>Nothing found</div>}
            {hits.map((h) => (
              <button key={h.id} className="hit-row" onClick={() => { setHits(null); setSearch(''); openMessage(h.conversation_id, h.id) }}>
                <div className="hit-meta">{h.sender_name} · {h.conversation_name}</div>
                <div className="hit-body">{h.body || h.file?.name || ''}</div>
                <div className="hit-when">{dayLabel(h.created_at)} · {fmtTime(h.created_at)}</div>
              </button>
            ))}
          </div>
        ) : (<>
        {/* All / Unread / Groups / Personal: one list, four ways to read it.
            Sits right above the list it filters. The archive is its own list. */}
        {!showArchived && (
          <div className="chat-tabs" role="tablist" aria-label="Which chats to show">
            {LIST_TABS.map((t) => {
              const n = tabUnread(t.id)
              return (
                <button key={t.id} role="tab" aria-selected={listTab === t.id} className={'chat-tab' + (listTab === t.id ? ' active' : '')} onClick={() => setListTab(t.id)}>
                  {t.label}
                  {n > 0 && <span className="chat-tab-badge" aria-label={`${n} with unread messages`}>{n > 9 ? '9+' : n}</span>}
                </button>
              )
            })}
          </div>
        )}
        <div className="convo-list">
          {!showArchived && !search.trim() && archivedConvos.length > 0 && (
            <button className="archived-row" onClick={() => setShowArchived(true)}>
              <span className="archived-ic" aria-hidden="true"><ArchiveGlyph size={18} /></span>
              <span className="archived-label">Archived</span>
              <span className={'archived-count' + (archivedUnread ? ' on' : '')}>{archivedUnread || archivedConvos.length}</span>
            </button>
          )}
          {filteredConvos.length === 0 && <div className="empty" style={{ padding: 16, fontSize: 13 }}>{listEmpty}</div>}
          {filteredConvos.map((c) => {
            const typing = typingIn[c.id]
            const draft = c.id !== activeId ? drafts[c.id] : ''
            // Ticks belong to something I sent — not to a call line or a call's summary.
            const lastTicks = c.last_from_me && c.last_kind !== 'system' && c.last_kind !== 'call' && c.last_kind !== 'meeting' && c.last_message && !/deleted this message$/.test(c.last_message)
              ? <Ticks state={c.last_seen ? 'read' : c.last_delivered ? 'delivered' : 'sent'} /> : null
            return (
              <div key={c.id} className={'convo-item chat-contact' + (c.id === activeId ? ' active' : '') + (hasUnread(c) && !c.muted ? ' has-unread' : '')} onClick={() => setActiveId(c.id)}>
                {/* The avatar is its own button, as on WhatsApp: it opens the
                    chat with its info already up, where the row opens just the chat. */}
                <button type="button" className="ci-list-avatar" title={c.type === 'group' ? 'Group info' : 'Contact info'}
                  aria-label={`${c.name}: ${c.type === 'group' ? 'group' : 'contact'} info`}
                  onClick={(e) => { e.stopPropagation(); openInfoFor(c.id) }}>
                  {c.type === 'group'
                    ? <GroupAvatar conv={c} size={38} />
                    : <PresenceAvatar name={c.name} color={c.avatar_color} size={38} online={!!c.other_user_id && online.has(c.other_user_id)} src={c.avatar_file && c.other_user_id ? userAvatarUrl(c.other_user_id, c.avatar_file) : undefined} />}
                </button>
                <div className="convo-meta" style={{ minWidth: 0, flex: 1 }}>
                  <div className="row spread" style={{ gap: 6 }}>
                    <div className="convo-title row" style={{ gap: 5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.pinned && <span title="Pinned" style={{ display: 'inline-flex', color: 'var(--muted)' }}><Ic name="pin" size={12} /></span>}{c.name}</div>
                    {c.last_at && <span className={'convo-time' + (hasUnread(c) && !c.muted ? ' fresh' : '')} style={{ flexShrink: 0 }}>{relTime(c.last_at)}</span>}
                  </div>
                  <div className="chat-contact-preview">
                    {typing ? (
                      <span className="typing-text">{c.type === 'group' ? `${typing.name.split(' ')[0]} is ` : ''}{typing.mode === 'recording' ? 'recording audio…' : 'typing…'}</span>
                    ) : draft ? (
                      <><span className="draft-tag">Draft:</span> {draft}</>
                    ) : c.last_message ? (
                      <>
                        {lastTicks}
                        {c.last_kind === 'system' ? '' : c.type === 'group' && c.last_sender_name ? `${c.last_from_me ? 'You' : c.last_sender_name.split(' ')[0]}: ` : ''}
                        {c.last_message}
                      </>
                    ) : <span className="muted">{c.type === 'group' ? `${c.member_count} members` : 'Start a conversation'}</span>}
                  </div>
                </div>
                <div className="convo-trailing">
                  {c.muted && <span title="Muted" style={{ display: 'inline-flex', opacity: .6, color: 'var(--muted)' }}><Ic name="muteBell" size={13} /></span>}
                  {c.unread > 0
                    ? <span className={'chat-unread-badge' + (c.muted ? ' dim' : '')}>{c.unread > 9 ? '9+' : c.unread}</span>
                    : c.marked_unread && <span className={'chat-unread-dot' + (c.muted ? ' dim' : '')} aria-label="Marked unread" />}
                  <div className="convo-menu-wrap">
                    <button className="convo-menu-btn" title="Options" aria-label={`Options for ${c.name}`} aria-haspopup="menu" aria-expanded={convoMenu === c.id}
                      onClick={(e) => { e.stopPropagation(); setMenuAnchor(e.currentTarget); setConvoMenu(convoMenu === c.id ? null : c.id) }}>⋯</button>
                    {/* Mouse screens: the same menu as a message's, for the
                        same reason — the list scrolls, and a menu inside it was
                        cut to a sliver on the last rows of a laptop's list. */}
                    {convoMenu === c.id && !touchUI && (
                      <ActionMenu anchor={menuAnchor} alignEnd groups={convoMenuGroups(c)} label={`Options for ${c.name}`} onClose={closeConvoMenu} />
                    )}
                    {convoMenu === c.id && touchUI && (
                      <div className="msg-menu mine" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => archive(c, !c.archived)}>{c.archived ? 'Unarchive chat' : 'Archive chat'}</button>
                        <button onClick={() => setPref(c, 'pinned')}>{c.pinned ? 'Unpin chat' : 'Pin chat'}</button>
                        <button onClick={() => { setConvoMenu(null); if (c.muted) muteConversation(c, 0); else setMuteFor(c) }}>{c.muted ? 'Unmute notifications' : 'Mute notifications'}</button>
                        <button onClick={() => markChat(c, !hasUnread(c))}>{hasUnread(c) ? 'Mark as read' : 'Mark as unread'}</button>
                        <button onClick={() => { setConvoMenu(null); exportChat(c) }}>Export chat</button>
                        <button className="danger" onClick={() => clearChat(c)}>Clear chat</button>
                        {c.type === 'direct'
                          ? <button className="danger" onClick={() => deleteChat(c)}>Delete chat</button>
                          : <button className="danger" onClick={() => exitGroup(c)}>Exit group</button>}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
        </>)}
      </aside>

      {/* ---- conversation pane ---- */}
      <div className={'card chat-pane' + (showInfo && active ? ' ci-on' : '')} {...paneDrop}>
        {dropping && (
          <div className="drop-veil" aria-hidden="true">
            <Ic name="attach" size={28} />
            <span>Drop to attach</span>
            <span className="drop-veil-sub">You can add a caption before it is sent</span>
          </div>
        )}
        <div className="chat">
          {/* Touch screens, a message selected: the header becomes its action
              bar, as in WhatsApp — ✕ to let go, the everyday actions as icons,
              the rest under ⋮. Every action ends the selection. */}
          {/* Picking several messages (WhatsApp's select mode): how many, and
              what can be done to all of them at once. */}
          {active && multi && (() => {
            const list = inOrder(multiMsgs)
            const one = list.length === 1 ? list[0] : null
            const allStarred = list.length > 0 && list.every((m) => m.starred)
            return (
              <div className="chat-peer-head sel-bar multi-bar" role="group" aria-label={`${list.length} messages selected`}>
                <button className="ic-btn" title="Cancel" aria-label="Cancel selection" onClick={(e) => { e.stopPropagation(); setMulti(null) }}>
                  <Ic name="close" size={21} />
                </button>
                <span className="sel-count" aria-live="polite">{list.length} selected</span>
                <div className="chat-peer-actions">
                  {one && !isRecordLine(one) && <button className="ic-btn" title="Reply" aria-label="Reply" onClick={(e) => { e.stopPropagation(); setMulti(null); startReply(one) }}><Ic name="reply" size={20} /></button>}
                  {one && one.sender_id === user!.id && isEditable(one) && <button className="ic-btn" title="Edit" aria-label="Edit" onClick={(e) => { e.stopPropagation(); startEdit(one) }}><PencilGlyph size={20} /></button>}
                  <button className={'ic-btn' + (allStarred ? ' on' : '')} title={allStarred ? 'Unstar' : 'Star'} aria-label={allStarred ? 'Unstar' : 'Star'} disabled={!list.length} onClick={(e) => { e.stopPropagation(); starMany(list) }}><Ic name="star" size={20} /></button>
                  <button className="ic-btn" title="Copy" aria-label="Copy" disabled={!list.length || list.some(isRecordLine)} onClick={(e) => { e.stopPropagation(); copyMany(list) }}><CopyGlyph size={20} /></button>
                  <button className="ic-btn" title="Forward" aria-label="Forward" disabled={!list.length || !list.every(isForwardable)} onClick={(e) => { e.stopPropagation(); setForwardMsgs(list); setMulti(null) }}><Ic name="forward" size={20} /></button>
                  <button className="ic-btn danger" title="Delete" aria-label="Delete" disabled={!list.length} onClick={(e) => { e.stopPropagation(); setDeleteFor(list) }}><Ic name="trash" size={20} /></button>
                </div>
              </div>
            )
          })()}
          {active && selMsg && !multi && (
            <div className="chat-peer-head sel-bar" role="group" aria-label="Actions for the selected message">
              <button className="ic-btn" title="Cancel" aria-label="Cancel selection" onClick={(e) => { e.stopPropagation(); setSelectedId(null) }}>
                <Ic name="close" size={21} />
              </button>
              <div className="chat-peer-actions">
                {msgActions(selMsg).filter((a) => a.bar).map((a) => (
                  <button
                    key={a.key}
                    className={'ic-btn' + (a.on ? ' on' : '') + (a.danger ? ' danger' : '')}
                    title={a.label}
                    aria-label={a.label}
                    onClick={(e) => { e.stopPropagation(); setSelectedId(null); a.run() }}
                  >
                    {actionIcon(a)}
                  </button>
                ))}
                <div className="msg-menu-wrap">
                  <button className="ic-btn" title="More" aria-label="More actions" aria-expanded={menuId === SEL_MENU} onClick={(e) => { e.stopPropagation(); setMenuId(menuId === SEL_MENU ? null : SEL_MENU) }}>
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="12" cy="19" r="1.9" /></svg>
                  </button>
                  {menuId === SEL_MENU && (
                    <div className="msg-menu mine head-menu" onClick={(e) => e.stopPropagation()}>
                      {msgActions(selMsg).filter((a) => !a.bar).map((a) => (
                        <button key={a.key} className={a.danger ? 'danger' : undefined} onClick={() => { setMenuId(null); setSelectedId(null); a.run() }}>{a.label}</button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
          {active && !selMsg && !multi && (() => { const otherOnline = active.type === 'direct' && !!active.other_user_id && online.has(active.other_user_id); return (
            <div className="chat-peer-head">
              {/* Mobile-only: back to the conversation list (WhatsApp-style). */}
              <button className="chat-list-btn" onClick={() => setActiveId('')} title="Back to chats" aria-label="Back to chats">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
              </button>
              {/* The photo and the name both open the chat's info, as on
                  WhatsApp — for a person as much as for a group. The name is
                  not a <button>: the workload chip inside it is one. */}
              <button className="chat-peer-photo" onClick={toggleInfo} aria-expanded={showInfo} aria-label={`${active.type === 'group' ? 'Group' : 'Contact'} info for ${active.name}`}>
                {active.type === 'group'
                  ? <GroupAvatar conv={active} size={38} />
                  : <PresenceAvatar name={active.name} color={active.avatar_color} size={38} online={otherOnline} src={active.avatar_file && active.other_user_id ? userAvatarUrl(active.other_user_id, active.avatar_file) : undefined} />}
              </button>
              <div
                className="chat-peer-who"
                role="button"
                tabIndex={0}
                aria-label={`${active.name}. ${active.type === 'group' ? 'Group' : 'Contact'} info`}
                aria-expanded={showInfo}
                onClick={toggleInfo}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleInfo() } }}
              >
                <div className="chat-peer-name">{active.name}</div>
                <div className="muted chat-peer-sub">
                  {typingName ? <span className="typing-text">{active.type === 'group' ? `${typingName.split(' ')[0]} is ` : ''}{typingMode === 'recording' ? 'recording audio…' : 'typing…'}</span>
                    : active.type === 'group' ? <span>{active.members.map((m) => m.name.split(' ')[0]).join(', ')}</span>
                      : otherOnline ? <span className="online-text">online</span>
                        : (active.other_user_id && lastSeen[active.other_user_id]) ? <span>{lastSeenLabel(lastSeen[active.other_user_id])}</span>
                          : (() => {
                              // Not "Member" (their role in this chat, true of everyone in
                              // it): their own status if they set one, else their job role.
                              const peer = active.members.find((m) => m.id !== user!.id)
                              return peer?.status_text
                                ? <span>{`${peer.status_emoji || ''} ${peer.status_text}`.trim()}</span>
                                : <span style={{ textTransform: 'capitalize' }}>{peer?.job_role || ''}</span>
                            })()}
                  {/* What the person you are talking to is already holding, at
                      the moment you might hand them more. One-to-one chats only:
                      summed over a group it was the whole team's backlog ("107
                      open · 104 late"), which says nothing about anyone here. */}
                  <LoadChip load={peerLoad} onClick={(e) => { e.stopPropagation(); setLoadOpen((o) => !o); setHeadMenu(false) }} />
                </div>
              </div>
              <div className="chat-peer-actions">
                <button className="ic-btn" title="Audio call" aria-label="Start an audio call" onClick={() => startCall(active.id, 'audio', active.name)}>
                  <Ic name="phone" size={19} />
                </button>
                <button className="ic-btn" title="Video call" aria-label="Start a video call" onClick={() => startCall(active.id, 'video', active.name)}>
                  <Ic name="video" size={21} />
                </button>
                <button className="ic-btn wide-only" title="Search in chat" aria-label="Search in chat" onClick={() => setInSearchOpen((o) => !o)}>
                  <Ic name="search" size={19} />
                </button>
                {/* ⓘ opens and closes the info panel. Phones have no room for it
                    in this row; the photo and the name do the same job there. */}
                <button className={'ic-btn wide-only chat-peer-info-btn' + (showInfo ? ' on' : '')} title={active.type === 'group' ? 'Group info' : 'Contact info'}
                  aria-label={active.type === 'group' ? 'Group info' : 'Contact info'} aria-expanded={showInfo} onClick={toggleInfo}>
                  <Ic name="info" size={19} />
                </button>
                {/* Everything else lives behind ⋮. Six boxed buttons in a row left a
                    phone ~120px for the chat's own name. */}
                <div className="msg-menu-wrap jump-wrap">
                  <button className="ic-btn" title="More" aria-label="More options" aria-expanded={headMenu} onClick={(e) => { e.stopPropagation(); setHeadMenu((o) => !o); setJumpOpen(false); setLoadOpen(false) }}>
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="12" cy="19" r="1.9" /></svg>
                  </button>
                  {headMenu && (
                    <div className="msg-menu mine head-menu" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => openInfo()}><Ic name="user" size={15} /> {active.type === 'group' ? 'Group info' : 'Contact info'}</button>
                      <button className="phone-only" onClick={() => { setHeadMenu(false); setInSearchOpen(true) }}><Ic name="search" size={15} /> Search in chat</button>
                      <button onClick={() => { setHeadMenu(false); setSelectedId(null); setMulti([]) }}><SelectGlyph size={15} /> Select messages</button>
                      {!readOnly && <button onClick={() => { setHeadMenu(false); setAssignFor({ source: null, draft: { title: '' } }) }}><TaskGlyph size={15} /> Assign a task</button>}
                      <button onClick={() => openInfo({ view: 'media' })}><Ic name="attach" size={15} /> Media, links and docs</button>
                      <button onClick={() => openInfo({ view: 'meetings' })}><Ic name="video" size={15} /> All meetings</button>
                      <button onClick={() => { setHeadMenu(false); setJumpOpen(true) }}><Ic name="calendar" size={15} /> Jump to a date</button>
                      <button onClick={() => { setHeadMenu(false); if (active.muted) muteConversation(active, 0); else setMuteFor(active) }}><Ic name={active.muted ? 'bell' : 'muteBell'} size={15} /> {active.muted ? 'Unmute notifications' : 'Mute notifications'}</button>
                      <button onClick={() => { setHeadMenu(false); archive(active, !active.archived) }}><ArchiveGlyph size={15} /> {active.archived ? 'Unarchive chat' : 'Archive chat'}</button>
                      <button onClick={() => exportChat(active)}><ExportGlyph size={15} /> Export chat</button>
                      <button onClick={() => { setHeadMenu(false); printConversation() }}><Ic name="doc" size={15} /> Print conversation</button>
                      <button onClick={() => { setHeadMenu(false); setShowChannels(true) }}><Ic name="hash" size={15} /> Browse channels</button>
                    </div>
                  )}
                  {jumpOpen && <JumpToDate days={dayIndex} onPick={jumpToDay} onClose={() => setJumpOpen(false)} />}
                </div>
              </div>
              {loadOpen && peerLoad && (
                <LoadPop
                  name={active.name}
                  load={peerLoad}
                  canOpen={isManager}
                  onOpen={() => { setLoadOpen(false); navigate(`/tasks?assignee=${active.other_user_id}`) }}
                />
              )}
            </div>
          ) })()}

          {active && pinned.length > 0 && (
            <div className="pin-bar">
              <button className="pin-bar-main" onClick={() => { if (pinned.length === 1) scrollToMessage(pinned[0].id); else setPinsOpen((o) => !o) }}>
                <Ic name="pin" size={13} />
                <span className="pin-bar-text">{pinned[0].body || pinned[0].file?.name || 'Pinned message'}</span>
                {pinned.length > 1 && <span className="pin-bar-count">+{pinned.length - 1}</span>}
              </button>
              <button className="btn btn-ghost btn-sm" title="Unpin" aria-label="Unpin" onClick={() => togglePin(pinned[0])}>✕</button>
            </div>
          )}
          {pinsOpen && pinned.length > 1 && (
            <div className="pin-list">
              {pinned.map((pm) => (
                <div key={pm.id} className="pin-row">
                  <button className="pin-row-main" onClick={() => { setPinsOpen(false); scrollToMessage(pm.id) }}>
                    <span className="pin-row-who">{senderName(pm.sender_id)}</span>
                    <span className="pin-row-text">{pm.body || pm.file?.name || ''}</span>
                  </button>
                  <button className="btn btn-ghost btn-sm" aria-label="Unpin" onClick={() => togglePin(pm)}>✕</button>
                </div>
              ))}
            </div>
          )}

          {inSearchOpen && (
            <div className="in-search">
              <input autoFocus placeholder="Search messages…" value={inSearch} onChange={(e) => setInSearch(e.target.value)}
                enterKeyHint="search"
                // Enter steps to the next older match, Shift+Enter back — the
                // keyboard's search key on a phone does the same.
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); stepHit(!e.shiftKey) } }} />
              {searchHits && (
                <span className="in-search-count" aria-live="polite">
                  {searchHits.length ? `${hitAt + 1} of ${searchHits.length}${searchHits.length >= 300 ? '+' : ''}` : 'No results'}
                </span>
              )}
              <button className="ic-btn" aria-label="Older match" title="Older match" disabled={!searchHits?.length} onClick={() => stepHit(true)}><Ic name="chevronUp" size={16} /></button>
              <button className="ic-btn" aria-label="Newer match" title="Newer match" disabled={!searchHits?.length} onClick={() => stepHit(false)}><Ic name="chevronDown" size={16} /></button>
              <button className="btn btn-ghost btn-sm" aria-label="Close search" onClick={() => { setInSearch(''); setInSearchOpen(false) }}>✕</button>
            </div>
          )}

          {/* For screen readers on touch screens: what activating a message
              does (each bubble points here), and a word when one is selected —
              its actions appear at the top, out of the reader's way. */}
          {touchUI && <span id="msg-select-hint" className="sr-only">Select to react, reply or forward</span>}
          <div className="sr-only" aria-live="polite">{selMsg ? `Message from ${selMsg.sender_id === user!.id ? 'you' : senderName(selMsg.sender_id)} selected. Reactions are next to it; reply, forward and more are at the top.` : ''}</div>

          <div className="chat-log-wrap">
          <div className={'chat-log' + (multi ? ' picking' : '')} ref={logRef} onScroll={onLogScroll}>
            {/* The New chat button is offered whether or not there are existing
                chats. Gating it on an empty list meant the one screen with room
                for it lost the button the moment you had a single conversation,
                leaving this panel blank with nothing to act on. */}
            {!active && (
              <div style={{ margin: 'auto' }}>
                <EmptyState
                  icon={<Ic name="chat" size={40} />}
                  title={convos.length ? 'Select a conversation' : 'No conversations yet'}
                  hint={convos.length
                    ? 'Choose a chat from the list to read and reply to messages — or start a new one.'
                    : 'Start a new chat with a teammate or create a group to begin messaging.'}
                  action={<button className="btn btn-primary btn-sm row" style={{ gap: 5 }} onClick={() => setShowNew(true)}><Ic name="plus" size={15} /> New chat</button>}
                />
              </div>
            )}
            {active && hasMore && (
              <div className="older-row">
                {loadingOlder ? <span className="spinner" /> : <button className="btn btn-ghost btn-sm" onClick={loadOlder}>Load earlier messages</button>}
              </div>
            )}
            {active && threadLoading && messages.length === 0 && <div style={{ margin: 'auto' }}><span className="spinner" /></div>}
            {active && !threadLoading && shownMessages.length === 0 && <div className="empty" style={{ margin: 'auto', textAlign: 'center' }}><>No messages yet.<br />Say hello</></div>}
            {logItems.map((it, idx) => {
              if ('sep' in it) return <div key={'sep' + idx} className="date-sep"><span>{it.sep}</span></div>
              if ('unread' in it) return <div key={'unread' + idx} className="unread-sep"><span>{it.unread} unread message{it.unread === 1 ? '' : 's'}</span></div>
              const m = it.m
              // A group event ("Priya added Ravi"): a centred line, nobody's message.
              if (m.kind === 'system') return <div key={m.id} data-msg={m.id} className="sys-line"><span>{m.system}</span></div>
              const mine = m.sender_id === user!.id
              const isTemp = m.id.startsWith('tmp_')
              const isImage = !!m.file && (m.file.type || '').startsWith('image/')
              const isCard = !!m.kind && !m.deleted
              // A run: the same person again, straight after and within a few
              // minutes. As in WhatsApp and Cliq, only its first message carries
              // the name and the face, and the run sits closer together — a name
              // over every line made a busy group read like a list of strangers.
              const prevIt = logItems[idx - 1]
              const prevM = prevIt && 'm' in prevIt ? prevIt.m : null
              const plain = (x: Msg) => x.kind !== 'system' && !x.call && !x.meeting
              const cont = !!prevM && plain(prevM) && plain(m) && !prevM.deleted && prevM.sender_id === m.sender_id
                && new Date(m.created_at).getTime() - new Date(prevM.created_at).getTime() < RUN_GAP_MS
              const inGroup = active?.type === 'group'
              const withFace = inGroup && !mine && plain(m)
              const showSender = inGroup && !mine && !m.deleted && !cont
              const face = withFace && !cont ? active?.members.find((mm) => mm.id === m.sender_id) : null
              // A message that names me gets an accent stripe — in a busy group,
              // scrolling back for the one line that was actually aimed at you is
              // the whole reason mentions exist.
              const mentionsMe = !mine && ((m.mentions || []).some((x) => x.id === user!.id)
                || new RegExp(`@(${ALL_TOKENS.join('|')})\\b`, 'i').test(m.body || ''))
              // Reactions fold into one pill under the bubble (the top three
              // emoji and a total), as WhatsApp does; tapping it says who. A
              // chip per emoji that toggled your own reaction on tap left no way
              // to find out who had reacted at all.
              const rxs = m.reactions || []
              const rxCount: Record<string, number> = {}
              for (const rx of rxs) rxCount[rx.emoji] = (rxCount[rx.emoji] || 0) + 1
              const rxTop = Object.keys(rxCount).sort((a, b) => rxCount[b] - rxCount[a]).slice(0, 3)
              const rxMine = rxs.some((rx) => rx.user_id === user!.id)
              const rxWho = rxs.map((rx) => (rx.user_id === user!.id ? 'You' : senderName(rx.user_id))).join(', ')
              const picked = !!multi && multi.includes(m.id)
              // The text itself: folded behind "Read more" when it is long, and
              // shown whole while searching (the match may be further down).
              const body = m.kind ? '' : (m.body || '')
              const long = body.length > FOLD_CHARS || body.split('\n').length > FOLD_LINES
              const folded = long && !unfolded.has(m.id) && !inSearch.trim()
              const shownBody = folded ? foldText(body) : body
              const tick = isTemp ? 'pending' : m.seen ? 'read' : m.delivered ? 'delivered' : 'sent'
              const foot = (
                <>
                  {m.starred && <span title="Starred" style={{ display: 'inline-flex' }}><Ic name="star" size={11} /></span>}
                  {m.edited_at && <span className="edited-tag">Edited</span>}
                  <span className="bubble-time">{fmtTime(m.created_at)}</span>
                  {mine && <Ticks state={tick} />}
                </>
              )
              return (
                <div key={m.id} data-msg={m.id}
                  className={'msg-wrap' + (flashId === m.id ? ' flash' : '') + (touchUI && selectedId === m.id && !m.deleted ? ' selected' : '') + (picked ? ' picked' : '') + (m.call || m.meeting ? ' centred' : mine ? ' mine' : '') + (cont ? ' cont' : '') + (withFace ? ' has-face' : '')}
                  style={{ alignItems: m.call || m.meeting ? 'center' : mine ? 'flex-end' : 'flex-start' }}
                  // Desktop, picking messages: a click anywhere on the row picks
                  // it — caught on the way down, so a quote, a link or a button
                  // inside the message does not do its own thing instead.
                  onClickCapture={multi && !touchUI ? (e) => {
                    if ((e.target as HTMLElement).closest('.pick-box')) return
                    e.preventDefault(); e.stopPropagation(); toggleMulti(m.id)
                  } : undefined}>
                  {multi && (
                    <button type="button" className={'pick-box' + (picked ? ' on' : '')} aria-pressed={picked}
                      aria-label={picked ? 'Unselect this message' : 'Select this message'}
                      onClick={(e) => { e.stopPropagation(); toggleMulti(m.id) }}>
                      {picked && <Ic name="check" size={12} />}
                    </button>
                  )}
                  {touchUI && !multi && !m.call && !m.meeting && <span className="swipe-ic" aria-hidden="true"><Ic name="reply" size={16} /></span>}
                  {face && (
                    <span className="msg-face" aria-hidden="true">
                      <Avatar name={face.name} color={face.avatar_color} size={28} src={face.avatar_file ? userAvatarUrl(face.id, face.avatar_file) : undefined} />
                    </span>
                  )}
                  {m.meeting ? (
                    <CallSummaryCard
                      meeting={m.meeting}
                      isManager={isManager}
                      meId={user!.id}
                      // In this chat's info panel, not on /meetings/:id: that page
                      // is managers' only, and everyone in the chat can read a summary.
                      onOpenMeeting={(review) => openInfo({ view: 'summary', meetingId: m.meeting!.id, review })}
                      onOpenTask={(tid) => setOpenTaskId(tid)}
                    />
                  ) : m.call ? (
                    <div className="call-line">
                      <Ic name={m.call.kind === 'video' ? 'video' : 'phone'} size={14} />
                      <span>{m.body}</span>
                      <span className="call-line-time">{fmtTime(m.created_at)}</span>
                      <button className="call-line-back" onClick={() => startCall(active!.id, m.call!.kind, active!.name)}>Call back</button>
                    </div>
                  ) : (
                  <div className={'msg-line' + (mine ? ' mine' : '')}>
                    <div className="msg-body">
                      {showSender && <div className="msg-sender" style={{ color: senderColor(m.sender_id) }}>{senderName(m.sender_id)}</div>}
                      {m.deleted ? (
                        <div className="bubble deleted row" style={{ gap: 6 }} {...bubbleTouch(m)}><Ic name="block" size={13} /> {mine ? 'You deleted this message' : 'This message was deleted'}<span className="bubble-foot"><span className="bubble-time">{fmtTime(m.created_at)}</span></span></div>
                      ) : (
                        <div
                          className={'bubble ' + (mine ? 'user' : 'ai') + (m.file ? ' file-bubble' : '') + (isImage && !m.uploading ? ' pic-bubble' : '') + (isCard ? ' card-bubble' : '') + (mentionsMe ? ' mentions-me' : '')}
                          {...bubbleTouch(m)}
                        >
                          {m.forwarded && <div className="forwarded-tag row" style={{ gap: 5 }}><Ic name="forward" size={12} /> Forwarded</div>}
                          {m.reply && (
                            <button type="button" className="reply-quote" onClick={(e) => { e.stopPropagation(); jumpToReply(m.reply!) }} aria-label={`Replying to ${m.reply.sender_id === user!.id ? 'yourself' : m.reply.sender_name}: ${m.reply.text}. Show it`}>
                              <span className="reply-quote-main">
                                <span className="reply-quote-name">{m.reply.sender_id === user!.id ? 'You' : m.reply.sender_name}{m.reply.from && <span className="reply-quote-from"> · {m.reply.from}</span>}</span>
                                <span className="reply-quote-text">{m.reply.text}</span>
                              </span>
                              {m.reply.image && <img className="reply-quote-thumb" src={fileUrl({ id: m.reply.id })} alt="" loading="lazy" />}
                            </button>
                          )}
                          {m.kind === 'poll' && m.poll && (
                            <PollCard msg={m} meId={user!.id} members={active?.members || []} onVote={(picks) => vote(m, picks)} onViewVotes={() => setVotesFor(m.id)} />
                          )}
                          {m.kind === 'task' && m.task && <TaskCard task={m.task} meId={user!.id} onOpen={() => setOpenTaskId(m.task!.id)} />}
                          {m.kind === 'location' && m.location && <LocationCard loc={m.location} />}
                          {m.kind === 'contact' && <ContactCard contact={m.contact || null} meId={user!.id} onMessage={messageUser} />}
                          {m.file && isAudio(m.file) && !m.uploading ? (
                            <div className="voice-note">
                              <VoicePlayer src={fileUrl(m)} id={m.id} mine={mine} />
                              {m.transcript && <div className="voice-text">{m.transcript}</div>}
                              <div className="voice-actions">
                                {!m.transcript && (
                                  <button className="voice-transcribe" disabled={transcribing === m.id} onClick={() => transcribeNote(m)}>
                                    {transcribing === m.id ? <><span className="spinner" /> Transcribing…</> : <><Ic name="ai" size={12} /> Read it as text</>}
                                  </button>
                                )}
                                {isManager && (
                                  <button className="voice-transcribe" disabled={summarising === m.id} onClick={() => recordingToMeeting(m)}>
                                    {summarising === m.id ? <><span className="spinner" /> Summarising…</> : <><Ic name="doc" size={12} /> Summary &amp; tasks</>}
                                  </button>
                                )}
                              </div>
                            </div>
                          ) : m.file && (isImage && !m.uploading
                            ? <button type="button" className="chat-image-btn" onClick={(e) => { e.stopPropagation(); setViewerAt(m.id) }} aria-label={`Open photo${m.body ? `: ${m.body}` : ''}`}>
                                <img className="chat-image" src={fileUrl(m)} alt={m.file.name} loading="lazy" />
                              </button>
                            : isVideo(m.file) && !m.uploading
                              ? <video className="chat-video" src={fileUrl(m)} controls preload="metadata" playsInline />
                              : <div className="chat-file">
                                  <span className="chat-file-icon">{m.uploading ? <Ic name="clock" size={18} /> : <DocGlyph size={20} />}</span>
                                  <span className="chat-file-meta"><span className="chat-file-name">{m.file?.name}</span><span className="chat-file-size">{m.uploading ? (m.progress != null && m.progress < 100 ? `Sending… ${m.progress}%` : 'Sending…') : [fmtSize(m.file?.size), (/\.([a-z0-9]{1,5})$/i.exec(m.file?.name || '')?.[1] || '').toUpperCase()].filter(Boolean).join(' · ')}</span></span>
                                  {!m.uploading && <button className="chat-file-dl" title="Download" aria-label="Download" onClick={() => download(m)}><Ic name="download" size={14} /></button>}
                                </div>)}
                          {!m.file && !m.kind && !isTemp && /https?:\/\//i.test(body) && <LinkPreview messageId={m.id} version={m.edited_at || ''} />}
                          {shownBody && <MessageText body={shownBody} mentions={m.mentions} meId={user!.id} fromMe={mine} highlight={inSearch} />}
                          {folded && <button type="button" className="read-more" onClick={(e) => { e.stopPropagation(); setUnfolded((s) => new Set(s).add(m.id)) }}>Read more</button>}
                          {!m.file && !isCard && <span className="bubble-foot-spacer" aria-hidden="true">{foot}</span>}
                          <span className="bubble-foot">{foot}</span>
                        </div>
                      )}
                      {rxs.length > 0 && (
                        <div className={'reactions-row' + (mine ? ' mine' : '')}>
                          <button
                            className={'reaction-chip' + (rxMine ? ' mine' : '')}
                            title={rxWho}
                            aria-label={`Reactions: ${rxs.map((rx) => `${rx.user_id === user!.id ? 'You' : senderName(rx.user_id)} ${rx.emoji}`).join(', ')}. Show who reacted`}
                            onClick={(e) => { e.stopPropagation(); setSelectedId(null); setReactionsOf(m.id) }}
                          >
                            <span className="reaction-emojis">{rxTop.join('')}</span>
                            {rxs.length > 1 && <span className="reaction-count">{rxs.length}</span>}
                          </button>
                        </div>
                      )}
                    </div>
                    {/* Mouse devices: the tools beside the message, shown on hover.
                        Touch screens select the message instead (bubbleTouch).
                        Edit is one of them, for your own messages — it was only in
                        the ⋯ menu before, and nobody found it there. */}
                    {!touchUI && !isTemp && !m.deleted && !multi && (
                      <div className={'msg-tools' + (menuId === m.id || reactFor === m.id || emojiFor === m.id ? ' open' : '')}>
                        <button className="msg-tool-btn" title="React" aria-label="React" aria-expanded={reactFor === m.id} onClick={(e) => {
                          e.stopPropagation()
                          // Below the line unless that is under the composer: the
                          // thread clips it, and the newest message is the one
                          // most often reacted to.
                          const log = logRef.current?.getBoundingClientRect()
                          setReactUp(!!log && log.bottom - e.currentTarget.getBoundingClientRect().bottom < REACT_ROOM)
                          setReactFor(reactFor === m.id ? null : m.id); setMenuId(null)
                        }}><Ic name="smile" size={16} /></button>
                        <button className="msg-tool-btn" title="Reply" aria-label="Reply" onClick={(e) => { e.stopPropagation(); startReply(m) }}><Ic name="reply" size={16} /></button>
                        {mine && isEditable(m) && <button className="msg-tool-btn" title="Edit" aria-label="Edit" onClick={(e) => { e.stopPropagation(); startEdit(m) }}><PencilGlyph size={16} /></button>}
                        {m.kind !== 'task' && <button className="msg-tool-btn task-tool" title="Assign as task" aria-label="Assign as task" onClick={(e) => { e.stopPropagation(); toTask({ messageId: m.id }, m) }}><Ic name="taskAdd" size={16} /></button>}
                        <div className="msg-menu-wrap">
                          <button className="msg-tool-btn" title="More" aria-label="More actions" aria-haspopup="menu" aria-expanded={menuId === m.id}
                            onClick={(e) => { e.stopPropagation(); setMenuAnchor(e.currentTarget); setMenuId(menuId === m.id ? null : m.id); setReactFor(null) }}>⋯</button>
                          {menuId === m.id && (
                            <ActionMenu anchor={menuAnchor} alignEnd={mine} groups={deskMenu(m)} label="Message actions" onClose={closeMsgMenu} />
                          )}
                        </div>
                        {reactFor === m.id && (
                          <div className={'react-picker' + (reactUp ? ' up' : '')} onClick={(e) => e.stopPropagation()}>
                            {EMOJIS.map((emo) => <button key={emo} onClick={() => react(m, emo)}>{emo}</button>)}
                            <button className="react-more" title="More emoji" aria-label="More emoji" onClick={() => { setReactFor(null); setEmojiFor(m.id) }}>＋</button>
                          </div>
                        )}
                        {emojiFor === m.id && (
                          <EmojiPicker align={mine ? 'right' : 'left'} onClose={() => setEmojiFor(null)} onPick={(e) => { setEmojiFor(null); react(m, e) }} />
                        )}
                      </div>
                    )}
                  </div>
                  )}
                  {/* Touch screens: the selected message's quick reactions, one
                      tap from done. Yours is ringed, and tapping it takes it
                      back; one picked from the full set joins the row so it can
                      be taken back too. ＋ opens every emoji (over the composer,
                      where a phone has the room). */}
                  {touchUI && selectedId === m.id && !multi && !m.deleted && !isTemp && !m.call && !m.meeting && emojiFor !== m.id && (() => {
                    const myEmoji = rxs.find((rx) => rx.user_id === user!.id)?.emoji
                    const quick = myEmoji && !EMOJIS.includes(myEmoji) ? [myEmoji, ...EMOJIS] : EMOJIS
                    return (
                      <div className={'react-tray ' + trayPlace + (mine ? ' mine' : '')} style={trayPlace === 'inside' ? { top: trayTop } : undefined} role="group" aria-label="React to this message" onClick={(e) => e.stopPropagation()}>
                        {/* The label names the action ("Take back…"), not a pressed
                            state: reactions are one per person, and a different
                            emoji replaces yours rather than adding to it. */}
                        {quick.map((emo) => (
                          <button key={emo} className={emo === myEmoji ? 'on' : undefined} aria-label={emo === myEmoji ? `Take back your ${emo}` : `React with ${emo}`} onClick={() => react(m, emo)}>{emo}</button>
                        ))}
                        <button className="react-tray-more" aria-label="More emoji" onClick={() => setEmojiFor(m.id)}><Ic name="plus" size={18} /></button>
                      </div>
                    )
                  })()}
                </div>
              )
            })}
            {/* The call that just ended is being turned into its summary and
                suggested tasks; the summary card replaces this line when it
                lands. Said for everyone in the chat, on the call or not. */}
            {active && analyses.some((x) => x.conversationId === active.id && inProgress(x)) && (
              <div className="sys-line ai-working"><span><SparkGlyph size={13} /> Analysing the call — its summary and suggested tasks will appear here…</span></div>
            )}
            {typingName && !inSearch && <div className="bubble ai typing-bubble"><span className="typing-dots"><i /><i /><i /></span></div>}
          </div>
          {/* Scrolled up into history: back to the latest, with how many came in meanwhile. */}
          {active && awayFromBottom && (
            <button className="to-bottom" onClick={toBottom} aria-label={newBelow ? `${newBelow} new message${newBelow === 1 ? '' : 's'}. Go to the latest` : 'Go to the latest message'}>
              <ChevronDown size={18} />
              {newBelow > 0
                ? <span><span className="to-bottom-count">{newBelow > 99 ? '99+' : newBelow}</span> new message{newBelow === 1 ? '' : 's'}</span>
                : <span>Latest</span>}
            </button>
          )}
          </div>

          {/* composer — or, in a group only its admins may write to, the line
              that says so (WhatsApp's own wording). */}
          {active && readOnly && (
            <div className="composer readonly-bar" role="note">Only admins can send messages</div>
          )}
          {active && !readOnly && (
            <div className="composer">
              {replyTo && (() => {
                const fromGroup = replyTo.conversation_id !== active.id ? convos.find((c) => c.id === replyTo.conversation_id) : null
                const what = replyTo.kind === 'poll' ? `📊 ${replyTo.body}` : replyTo.kind === 'location' ? `📍 ${replyTo.body || 'Location'}` : replyTo.kind === 'contact' ? `👤 ${replyTo.body}` : replyTo.kind === 'task' ? `📋 ${replyTo.body}` : replyTo.body || replyTo.transcript
                return (
                  <div className="reply-banner">
                    <div className="reply-banner-body">
                      <span className="reply-quote-name">Replying to {replyTo.sender_id === user!.id ? 'yourself' : senderName(replyTo.sender_id) !== 'Unknown' ? senderName(replyTo.sender_id) : (replyTo.reply?.sender_name || 'them')}{fromGroup ? <span className="reply-quote-from"> · {fromGroup.name}</span> : null}</span>
                      <span className="reply-quote-text row" style={{ gap: 5 }}>{replyTo.file && !what ? <><Ic name="attach" size={12} /> {replyTo.file.name}</> : what}</span>
                    </div>
                    {replyTo.file && (replyTo.file.type || '').startsWith('image/') && <img className="reply-quote-thumb" src={fileUrl(replyTo)} alt="" />}
                    <button className="btn btn-ghost btn-sm" aria-label="Cancel reply" onClick={() => setReplyTo(null)}>✕</button>
                  </div>
                )
              })()}
              {editing && (
                <div className="reply-banner editing">
                  <span className="edit-banner-ic" aria-hidden="true"><PencilGlyph size={15} /></span>
                  <div className="reply-banner-body">
                    <span className="reply-quote-name">Edit message</span>
                    <span className="reply-quote-text">{editing.body || 'Caption'}</span>
                  </div>
                  <button className="btn btn-ghost btn-sm" aria-label="Cancel editing" onClick={endEdit}>✕</button>
                </div>
              )}
              {/* What will go with the next Send: pictures as thumbnails, other
                  files by name. ✕ takes one back out. */}
              {staged.length > 0 && (
                <div className="stage-strip" role="group" aria-label={`${staged.length} file${staged.length === 1 ? '' : 's'} ready to send`}>
                  {staged.map((s) => (
                    <div key={s.id} className={'stage-item' + (s.url ? ' pic' : '')} title={s.file.name}>
                      {s.url ? <img src={s.url} alt={s.file.name} />
                        : (<>
                          <span className={'stage-ic' + (isAudio({ name: s.file.name, type: s.file.type }) ? ' audio' : '')}>
                            {isAudio({ name: s.file.name, type: s.file.type }) ? <Ic name="mic" size={16} /> : (/\.([a-z0-9]{1,5})$/i.exec(s.file.name)?.[1] || 'FILE').toUpperCase()}
                          </span>
                          <span className="stage-meta"><span className="stage-name">{s.file.name}</span><span className="stage-size">{fmtSize(s.file.size)}</span></span>
                        </>)}
                      <button className="stage-x" aria-label={`Remove ${s.file.name}`} title="Remove" onClick={() => unstage(s.id)}><Ic name="close" size={12} /></button>
                    </div>
                  ))}
                </div>
              )}
              <div className="chat-input chat-compose">
                {slashQ !== null && slashOptions.length > 0 && (
                  <div className="mention-pop slash-pop" onMouseDown={(e) => e.preventDefault()}>
                    {slashOptions.map((c, i) => (
                      <button key={c.name} className={'mention-opt' + (i === slashIdx ? ' active' : '')} onMouseEnter={() => setSlashIdx(i)} onClick={() => pickSlash(c)}>
                        <span className="slash-name">/{c.name}{c.args ? ' ' + c.args : ''}</span>
                        <span className="slash-help">{c.help}</span>
                      </button>
                    ))}
                  </div>
                )}
                {mentionQ && mentionOptions.length > 0 && (
                  <div className="mention-pop" onMouseDown={(e) => e.preventDefault()}>
                    {mentionOptions.map((opt, i) => (
                      <button
                        key={opt.id}
                        className={'mention-opt' + (i === mentionIdx ? ' active' : '')}
                        onMouseEnter={() => setMentionIdx(i)}
                        onClick={() => applyMention(opt)}
                      >
                        {opt.id === '__all__'
                          ? <span className="mention-all"><Ic name="at" size={14} /></span>
                          : <Avatar name={opt.name} color={active.members.find((mm) => mm.id === opt.id)?.avatar_color} size={24} src={(() => { const mm = active.members.find((x) => x.id === opt.id); return mm?.avatar_file ? userAvatarUrl(mm.id, mm.avatar_file) : undefined })()} />}
                        <span className="mention-opt-name">{opt.name}</span>
                        {opt.id === '__all__'
                          ? <span className="muted" style={{ fontSize: 11.5 }}>Notify everyone here</span>
                          : <LoadChip load={workload[opt.id]} compact />}
                      </button>
                    ))}
                  </div>
                )}
                {/* Touch screens: every emoji, for reacting to the selected
                    message — the tray's ＋. It opens over the composer, the full
                    width of the screen, rather than squeezed beside the message. */}
                {touchUI && emojiFor && emojiFor !== '__composer__' && (() => {
                  const target = messages.find((x) => x.id === emojiFor)
                  return target ? <EmojiPicker autoFocus={false} onClose={() => setEmojiFor(null)} onPick={(e) => { setEmojiFor(null); react(target, e) }} /> : null
                })()}
                <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={onPickFile} />
                <input ref={mediaRef} type="file" multiple accept="image/*,video/*" style={{ display: 'none' }} onChange={onPickFile} />
                <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={onPickFile} />
                {/* WhatsApp's attach sheet: files, pictures, the camera, a place,
                    a teammate, a poll — and the one WhatsApp does not have, a
                    task handed to someone in this chat. */}
                {attachMenu && (
                  <div className="attach-pop attach-grid" role="menu" aria-label="Attach" onClick={(e) => e.stopPropagation()}>
                    <button role="menuitem" onClick={() => { setAttachMenu(false); fileRef.current?.click() }}><span className="ag-ic doc"><DocGlyph size={20} /></span>Document</button>
                    <button role="menuitem" onClick={() => { setAttachMenu(false); mediaRef.current?.click() }}><span className="ag-ic media"><GalleryGlyph size={20} /></span>Photos &amp; videos</button>
                    {touchUI && <button role="menuitem" onClick={() => { setAttachMenu(false); cameraRef.current?.click() }}><span className="ag-ic cam"><CameraGlyph size={20} /></span>Camera</button>}
                    <button role="menuitem" onClick={() => { setAttachMenu(false); setLocOpen(true) }}><span className="ag-ic loc"><PinDropGlyph size={20} /></span>Location</button>
                    <button role="menuitem" onClick={() => { setAttachMenu(false); setContactOpen(true) }}><span className="ag-ic contact"><ContactGlyph size={20} /></span>Contact</button>
                    <button role="menuitem" onClick={() => { setAttachMenu(false); setPollOpen(true) }}><span className="ag-ic poll"><PollGlyph size={20} /></span>Poll</button>
                    <button role="menuitem" onClick={() => { setAttachMenu(false); setAssignFor({ source: null, draft: { title: input.trim() } }) }}><span className="ag-ic task"><TaskGlyph size={20} /></span>Task</button>
                    {touchUI && canReadClipboardImages() && (
                      <button role="menuitem" onClick={pasteFromClipboard}>
                        <span className="ag-ic paste"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8" y="2" width="8" height="4" rx="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /></svg></span>
                        Paste
                      </button>
                    )}
                  </div>
                )}
                {/* One box holds everything: emoji on the left, the text in the
                    middle, and on the right the attach clip and the round button
                    that is the mic while the box is empty and Send once there is
                    text — the swap every messaging app makes. Six separate round
                    buttons used to share the row, which left a phone ~110px to
                    type in. The task and send-later buttons only appear once
                    there is text for them to act on. */}
                <div className={'composer-box' + (recording ? ' recording' : '')}>
                  {recording ? (
                    <div className="voice-recording">
                      <span className="voice-rec-dot" />
                      <span className="voice-rec-time">{Math.floor(recSecs / 60)}:{String(recSecs % 60).padStart(2, '0')}</span>
                      {holdDx !== null ? (<>
                        <span className="voice-slide" style={{ transform: `translateX(${holdDx * 0.6}px)`, opacity: Math.max(0.25, 1 + holdDx / SLIDE_CANCEL_PX) }}>
                          <Ic name="arrowLeft" size={14} /> Slide to cancel
                        </span>
                        <span className="voice-lock-hint" aria-hidden="true"><Ic name="lock" size={14} /><Ic name="chevronUp" size={14} /></span>
                      </>) : (<>
                        <span className="muted" style={{ fontSize: 12.5 }}>Recording…</span>
                        <button className="ic-btn cb-discard" title="Discard" aria-label="Discard the voice note" onClick={() => finishVoiceNote(true)}><Ic name="trash" size={18} /></button>
                      </>)}
                    </div>
                  ) : (<>
                    <div className="emoji-wrap">
                      <button className="ic-btn cb-ic" title="Emoji" aria-label="Insert an emoji" disabled={busy} onClick={(e) => { e.stopPropagation(); setEmojiFor(emojiFor === '__composer__' ? null : '__composer__') }}>
                        <Ic name="smile" size={21} />
                      </button>
                      {emojiFor === '__composer__' && (
                        <EmojiPicker
                          onClose={() => setEmojiFor(null)}
                          onPick={(e) => {
                            // Insert at the caret, not at the end — people reach for
                            // the picker mid-sentence as often as at the finish.
                            const el = inputRef.current
                            const at = el?.selectionStart ?? input.length
                            const next = input.slice(0, at) + e + input.slice(at)
                            setInput(next)
                            rememberEmoji(e)
                            requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + e.length, at + e.length) })
                          }}
                        />
                      )}
                    </div>
                    <textarea
                      ref={inputRef}
                      className="composer-input"
                      data-va="chats.composer"
                      rows={1}
                      placeholder={editing ? 'Edit your message…' : staged.length ? 'Add a caption…' : placeholder}
                      value={input}
                      onChange={onComposerChange}
                      onKeyDown={onComposerKey}
                      // The keyboard's action key shows the return arrow it now
                      // performs on a phone, not a send arrow it no longer does.
                      enterKeyHint={touchUI ? 'enter' : 'send'}
                      // A screenshot (or any copied file) pasted here goes into the
                      // tray above; a paste of words is still just words.
                      onPaste={(e) => {
                        const files = clipboardFiles(e.clipboardData)
                        if (!files.length) return
                        e.preventDefault()
                        stageFiles(files)
                      }}
                      onBlur={() => { sendTyping(false); setTimeout(() => setMentionQ(null), 120) }}
                      autoFocus
                    />
                    {/* Turn what you're typing into a task without sending it first —
                        the common case is realising mid-sentence that this is work. */}
                    {!editing && input.trim() && (
                      <button className="ic-btn cb-ic" title="Create a task from this text" aria-label="Create a task from this text" disabled={busy} onClick={draftFromComposer}><Ic name="taskAdd" size={19} /></button>
                    )}
                    {/* Send later carries words only — not offered while files wait. */}
                    {!editing && input.trim() && !staged.length && (
                      <button className="ic-btn cb-ic cb-later" title="Send later" aria-label="Send later" disabled={busy} onClick={() => setScheduleOpen(true)}><Ic name="clock" size={18} /></button>
                    )}
                    {/* On a touch screen the clip also offers the clipboard, there
                        being no Ctrl+V; with a mouse it goes straight to the files. */}
                    {!editing && (
                      <button
                        className="ic-btn cb-ic"
                        title="Attach a file, photo, location, contact, poll or task (or paste a screenshot with Ctrl+V)"
                        aria-label="Attach"
                        aria-haspopup="menu"
                        aria-expanded={attachMenu}
                        disabled={busy}
                        onClick={(e) => { e.stopPropagation(); setAttachMenu((o) => !o); setEmojiFor(null) }}
                      ><Ic name="attach" size={19} /></button>
                    )}
                  </>)}
                  {recording && holdDx === null
                    ? <button className="send-btn" title="Send voice note" aria-label="Send the voice note" onClick={() => finishVoiceNote(false)}><Ic name="send" size={18} /></button>
                    : holdDx !== null || (!editing && !input.trim() && !staged.length)
                      // Stays this same button while held: it holds the pointer capture.
                      ? <button className={'send-btn mic' + (holdDx !== null ? ' held' : '')} title="Record a voice note (hold on a phone)" aria-label="Record a voice note" disabled={busy} {...micPress}><Ic name="mic" size={20} /></button>
                      : <button
                          data-va="chats.send"
                          className="send-btn"
                          title={editing ? 'Save' : staged.length ? `Send ${staged.length === 1 ? 'it' : `all ${staged.length}`}` : 'Send (hold to send later)'}
                          aria-label={editing ? 'Save the edit' : staged.length ? `Send ${staged.length} file${staged.length === 1 ? '' : 's'}` : 'Send'}
                          disabled={busy || (!input.trim() && !staged.length)}
                          onClick={() => { if (heldRef.current) { heldRef.current = false; return } send() }}
                          onPointerDown={() => {
                            heldRef.current = false
                            if (editing || stagedRef.current.length) return
                            holdTimerRef.current = setTimeout(() => { heldRef.current = true; setScheduleOpen(true) }, 550)
                          }}
                          onPointerUp={endHold}
                          onPointerLeave={endHold}
                          onPointerCancel={endHold}
                          // The phone's own long-press menu would open over ours.
                          onContextMenu={(e) => e.preventDefault()}
                        >{editing ? <Ic name="check" size={20} /> : <Ic name="send" size={18} />}</button>}
                </div>
              </div>
            </div>
          )}
        </div>
        {/* Group info / Contact info. Inside the card, after .chat: the CSS
            docks it beside the conversation from 1400px, covers the
            conversation below that, and is the whole screen on a phone.
            `start` is the state object itself, so only a new open (a meeting
            card, the ⋮ menu) restarts its stack of views. */}
        {showInfo && active && infoMe && (
          <ChatInfoPanel
            key={active.id}
            conv={active}
            me={infoMe}
            online={online}
            lastSeen={lastSeen}
            start={infoStart}
            backRef={infoStepRef}
            onClose={() => setShowInfo(false)}
            onChanged={() => { loadConvos(); loadThread(active.id) }}
            onLeft={() => { setShowInfo(false); setActiveId(''); loadConvos() }}
            onOpenConversation={(cid) => { setShowArchived(false); setActiveId(cid) }}
            onMessageUser={messageUser}
            onShowMessage={showMessage}
            onCall={(kind) => startCall(active.id, kind, active.name)}
            // Focus the search box once the panel has handed focus back to its opener.
            onSearch={() => { setShowInfo(false); setInSearchOpen(true); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.in-search input')?.focus()) }}
            onMute={() => { if (active.muted) muteConversation(active, 0); else setMuteFor(active) }}
            // Handing back clearChat's promise lets the panel refresh its counts
            // once the clear has gone through.
            onClearChat={() => clearChat(active)}
            onDeleteChat={() => deleteChat(active)}
            onExport={() => exportChat(active)}
            onEditDescription={() => setDescOpen(true)}
            // No setShowInfo(false): the move to Tasks unmounts the panel anyway,
            // and Back from Tasks should find it open again.
            onViewTasks={(uid) => navigate(`/tasks?assignee=${uid}`)}
            onMeetingChanged={patchMeetingCard}
          />
        )}
      </div>

      {reactionsMsg && active && (
        <ReactionsSheet
          message={reactionsMsg}
          members={active.members}
          meId={user!.id}
          onRemoveMine={(emoji) => react(reactionsMsg, emoji)}
          onClose={() => setReactionsOf(null)}
        />
      )}
      {showNew && <NewChatModal user={user!} convos={convos} onClose={() => setShowNew(false)} onOpen={(cid) => { setShowNew(false); setActiveId(cid); loadConvos() }} />}
      {forwardMsgs && <ForwardModal messages={forwardMsgs} convos={convos} onClose={() => setForwardMsgs(null)} onDone={() => { setForwardMsgs(null); loadConvos() }} />}
      {assignFor && active && (
        <TaskAssignSheet
          conversation={active}
          meId={user!.id}
          source={assignFor.source}
          draft={assignFor.draft}
          workload={workload}
          senderName={senderName}
          onClose={() => setAssignFor(null)}
          onDone={(card) => {
            // Typed in the box and turned into a task: the words are the task
            // now, so they leave the box.
            const fromBox = !assignFor.source && !!input.trim() && input.trim() === (assignFor.draft.title || '').trim()
            setAssignFor(null); mergeIncoming(card); loadConvos(); loadWorkload()
            if (fromBox) setInput('')
          }}
          onMoreOptions={openFullTaskForm}
        />
      )}
      {openTaskId && (
        <TaskDrawer
          taskId={openTaskId}
          onClose={() => setOpenTaskId(null)}
          onChange={(t) => {
            // Keep the cards in the thread true to the task as it changes here.
            if (t && t.id) setMessages((p) => p.map((x) => (x.task?.id === t.id ? { ...x, task: { ...x.task!, title: t.title, status: t.status, priority: t.priority, due_date: t.due_date, assignee_id: t.assignee_id } } : x)))
            else if (activeIdRef.current) loadThread(activeIdRef.current)
            loadWorkload()
          }}
        />
      )}
      {infoFor && (
        <MessageInfoSheet
          message={infoFor}
          preview={<div className="bubble user mi-bubble">{infoFor.body || infoFor.file?.name || (infoFor.kind === 'location' ? '📍 Location' : '')}<span className="bubble-foot" style={{ position: 'static', marginLeft: 8 }}><span className="bubble-time">{fmtTime(infoFor.created_at)}</span><Ticks state={infoFor.seen ? 'read' : infoFor.delivered ? 'delivered' : 'sent'} /></span></div>}
          onClose={() => setInfoFor(null)}
        />
      )}
      {deleteFor && <DeleteDialog count={deleteFor.length} canEveryone={canDeleteForAll(deleteFor)} onPick={(scope) => doDelete(deleteFor, scope)} onClose={() => setDeleteFor(null)} />}
      {pollOpen && <PollComposer onSend={sendPoll} onClose={() => setPollOpen(false)} />}
      {votesFor && active && (() => {
        const vm = messages.find((x) => x.id === votesFor)
        return vm?.poll ? <PollVotesSheet msg={vm} members={active.members} meId={user!.id} onClose={() => setVotesFor(null)} /> : null
      })()}
      {locOpen && <LocationPicker onSend={sendLocation} onClose={() => setLocOpen(false)} />}
      {contactOpen && <ContactPicker meId={user!.id} onPick={sendContact} onClose={() => setContactOpen(false)} />}
      {descOpen && active && (
        <DescriptionEditor
          initial={active.description || ''}
          onClose={() => setDescOpen(false)}
          onSave={async (v) => {
            try { await api.patch(`/chat/conversations/${active.id}`, { description: v }); setDescOpen(false); loadConvos(); return true }
            catch (e: any) { toast.error(e.message); return false }
          }}
        />
      )}
      {callsOpen && (
        <CallsSheet
          isManager={isManager}
          onClose={() => setCallsOpen(false)}
          onCall={(cid, kind, name) => { setCallsOpen(false); startCall(cid, kind, name) }}
          // A one-to-one deleted from the list is opened through its person,
          // which brings it back; anything else is still in the list.
          onOpenChat={(cid, otherId) => {
            setCallsOpen(false); setShowArchived(false)
            if (!convos.some((c) => c.id === cid) && otherId) messageUser(otherId)
            else setActiveId(cid)
          }}
          onOpenSummary={(mid) => { setCallsOpen(false); navigate(`/meetings/${mid}`) }}
        />
      )}
      {viewerAt && (
        <MediaViewer
          items={mediaMsgs}
          startId={viewerAt}
          senderName={senderName}
          meId={user!.id}
          onClose={() => setViewerAt(null)}
          onForward={(m) => { setViewerAt(null); setForwardMsgs([m]) }}
          onShowInChat={(m) => { setViewerAt(null); requestAnimationFrame(() => scrollToMessage(m.id)) }}
        />
      )}
      {showStarred && <StarredModal onClose={() => setShowStarred(false)} onOpen={(cid, mid) => { setShowStarred(false); openMessage(cid, mid) }} />}
      {remindFor && <RemindModal message={remindFor} onClose={() => setRemindFor(null)} />}
      {showChannels && <ChannelsModal onClose={() => setShowChannels(false)} onOpen={(cid) => { setShowChannels(false); loadConvos(); setActiveId(cid) }} />}
      {forkFrom && active && (
        <ForkModal
          message={forkFrom}
          members={active.members}
          senderName={senderName(forkFrom.sender_id)}
          onClose={() => setForkFrom(null)}
          onDone={(cid) => { setForkFrom(null); loadConvos(); setActiveId(cid) }}
        />
      )}
      {showLater && <LaterModal onClose={() => setShowLater(false)} onOpen={(cid, mid) => { setShowLater(false); openMessage(cid, mid) }} />}
      {showStatus && <StatusModal current={myStatus} onClose={() => setShowStatus(false)} onSaved={setMyStatus} />}
      {muteFor && <MuteModal conv={muteFor} onClose={() => setMuteFor(null)} onPick={(mins) => muteConversation(muteFor, mins)} />}
      {scheduleOpen && active && (
        <ScheduleModal
          conversationId={active.id}
          body={input.trim()}
          mentions={resolveMentions(input.trim(), picked, active.members, user!.id)}
          onClose={() => setScheduleOpen(false)}
          onDone={() => { setScheduleOpen(false); setInput(''); setPicked([]) }}
        />
      )}
      {showMentions && <MentionsModal meId={user!.id} onClose={() => setShowMentions(false)} onOpen={(cid, mid) => { setShowMentions(false); openMessage(cid, mid) }} onTask={(cid, mid) => { setShowMentions(false); taskFromAnywhere(cid, mid) }} />}
    </div>
  )
}

// ---------- Forward modal ----------
function ForwardModal({ messages, convos, onClose, onDone }: { messages: Msg[]; convos: Conversation[]; onClose: () => void; onDone: () => void }) {
  // A dialog: focus moves into it, Tab stays inside, Escape closes it, and
  // focus goes back to what opened it (lib/useDialog).
  const cardRef = useDialog<HTMLDivElement>(onClose)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  // Groups only their admins may write to are left out for everyone else.
  const list = convos.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()) && !(c.type === 'group' && c.admins_only && c.role !== 'admin'))
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  // Several messages go in the order they were said.
  const ordered = messages.slice().sort((a, b) => a.created_at.localeCompare(b.created_at))
  const go = async () => {
    if (!sel.size) return
    setBusy(true)
    try {
      for (const m of ordered) await api.post(`/chat/message/${m.id}/forward`, { conversationIds: [...sel] })
      toast.success(`Forwarded${ordered.length > 1 ? ` ${ordered.length} messages` : ''} to ${sel.size} chat${sel.size === 1 ? '' : 's'}`)
      onDone()
    } catch (e: any) { toast.error(e.message); setBusy(false) }
  }
  const first = ordered[0]
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" ref={cardRef} role="dialog" aria-modal="true" aria-label="Forward message" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 style={{ margin: 0, fontSize: 16 }}>Forward to…</h3><button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button></div>
        <div className="fwd-preview row" style={{ gap: 5 }}>
          {ordered.length > 1 ? `${ordered.length} messages` : first?.file ? <><Ic name="attach" size={13} /> {first.file.name}</> : first?.kind === 'location' ? `📍 ${first.body}` : first?.kind === 'contact' ? `👤 ${first.body}` : first?.body}
        </div>
        <input className="chat-contact-search" placeholder="Search chats…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="modal-list">
          {list.map((c) => (
            <div key={c.id} className="modal-user" onClick={() => toggle(c.id)}>
              {c.type === 'group' ? <GroupAvatar conv={c} size={34} /> : <Avatar name={c.name} color={c.avatar_color} size={34} src={c.avatar_file && c.other_user_id ? userAvatarUrl(c.other_user_id, c.avatar_file) : undefined} />}
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 13.5 }}>{c.name}</div><div className="muted" style={{ fontSize: 11.5 }}>{c.type === 'group' ? `${c.member_count} members` : 'Direct'}</div></div>
              <input type="checkbox" readOnly checked={sel.has(c.id)} />
            </div>
          ))}
          {list.length === 0 && <div className="empty" style={{ padding: 16 }}>No chats</div>}
        </div>
        <button className="btn btn-primary" style={{ width: '100%', marginTop: 10 }} disabled={busy || !sel.size} onClick={go}>Forward ({sel.size})</button>
      </div>
    </div>
  )
}

// ---------- Starred messages modal ----------
function StarredModal({ onClose, onOpen }: { onClose: () => void; onOpen: (convId: string, messageId?: string) => void }) {
  const [items, setItems] = useState<Msg[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => { api.get('/chat/starred').then((d) => setItems(d.items)).catch(() => {}).finally(() => setLoaded(true)) }, [])
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 className="row" style={{ margin: 0, fontSize: 16, gap: 7 }}><Ic name="star" size={16} /> Starred messages</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="modal-list">
          {loaded && items.length === 0 && <div className="empty" style={{ padding: 20 }}>No starred messages yet</div>}
          {items.map((m) => (
            <div key={m.id} className="starred-item" onClick={() => onOpen(m.conversation_id, m.id)}>
              <div className="starred-body row" style={{ gap: 6 }}>{m.file ? <><Ic name="attach" size={13} /> {m.file.name}</> : m.body}</div>
              <div className="muted" style={{ fontSize: 11 }}>{fmtTime(m.created_at)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------- browse + join public channels ----------
// The body is its own component because it appears in two places: as a tab under
// "New", and as the standalone drawer a slash command or deep link can open.
function ChannelList({ onOpen }: { onOpen: (convId: string) => void }) {
  const [items, setItems] = useState<any[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [q, setQ] = useState('')
  useEffect(() => { api.get('/chat/channels').then((d) => setItems(d.channels)).catch(() => {}).finally(() => setLoaded(true)) }, [])

  const join = async (id: string) => {
    setBusy(id)
    try { const c: any = await api.post(`/chat/channels/${id}/join`); onOpen(c.id) }
    catch (e: any) { toast.error(e.message); setBusy(null) }
  }
  const list = items.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()))

  return (
    <>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>Open to everyone in your workspace — join without an invitation.</div>
      <input className="chat-contact-search" placeholder="Search channels…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="modal-list">
        {loaded && list.length === 0 && (
          <div className="empty" style={{ padding: 20 }}>
            {items.length ? 'No channel matched' : 'No channels yet. A manager can make one from the Group tab.'}
          </div>
        )}
        {list.map((c) => (
          <div key={c.id} className="modal-user">
            <span className="avatar group-avatar" style={{ background: c.avatar_color, width: 34, height: 34 }}>#</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5 }}>{c.name}</div>
              <div className="muted" style={{ fontSize: 11.5 }}>{c.member_count} member{c.member_count === 1 ? '' : 's'}</div>
            </div>
            {c.joined
              ? <button className="btn btn-ghost btn-sm" onClick={() => onOpen(c.id)}>Open</button>
              : <button className="btn btn-primary btn-sm" disabled={busy === c.id} onClick={() => join(c.id)}>Join</button>}
          </div>
        ))}
      </div>
    </>
  )
}

function ChannelsModal({ onClose, onOpen }: { onClose: () => void; onOpen: (convId: string) => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 className="row" style={{ margin: 0, fontSize: 16, gap: 7 }}><Ic name="hash" size={16} /> Channels</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <ChannelList onOpen={onOpen} />
      </div>
    </div>
  )
}

// ---------- fork a message into its own thread ----------
// Cliq calls this forking. The useful part is not the new room, it is that the
// room OPENS with the message that caused it — so the people pulled in do not
// arrive at a blank screen asking what this is about.
function ForkModal({ message, members, senderName, onClose, onDone }: { message: Msg; members: Member[]; senderName: string; onClose: () => void; onDone: (convId: string) => void }) {
  // A dialog: focus moves into it, Tab stays inside, Escape closes it, and
  // focus goes back to what opened it (lib/useDialog).
  const cardRef = useDialog<HTMLDivElement>(onClose)
  const [name, setName] = useState((message.body || message.file?.name || 'Side thread').slice(0, 40))
  const [sel, setSel] = useState<Set<string>>(new Set(members.map((m) => m.id)))
  const [busy, setBusy] = useState(false)
  const toggle = (id: string) => setSel((x) => { const n = new Set(x); n.has(id) ? n.delete(id) : n.add(id); return n })

  const go = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      const conv: any = await api.post(`/chat/message/${message.id}/fork`, { name: name.trim(), memberIds: [...sel] })
      onDone(conv.id)
    } catch (e: any) { toast.error(e.message); setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" ref={cardRef} role="dialog" aria-modal="true" aria-label="Fork to a new chat" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 className="row" style={{ margin: 0, fontSize: 16, gap: 7 }}><Ic name="thread" size={16} /> Fork to a new chat</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="remind-quote"><b>{senderName}:</b> {message.body || message.file?.name}</div>
        <label style={{ fontSize: 12, fontWeight: 600 }}>Name this thread</label>
        <input className="chat-contact-search" style={{ marginBottom: 10 }} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <div className="spread row" style={{ marginBottom: 6 }}>
          <span className="ch-title">Who comes along</span>
          <span className="muted" style={{ fontSize: 11.5 }}>{sel.size} selected</span>
        </div>
        <div className="modal-list">
          {members.map((m) => (
            <div key={m.id} className="modal-user" onClick={() => toggle(m.id)}>
              <Avatar name={m.name} color={m.avatar_color} size={32} src={m.avatar_file ? userAvatarUrl(m.id, m.avatar_file) : undefined} />
              <div style={{ flex: 1, minWidth: 0 }}>{m.name}</div>
              <input type="checkbox" readOnly checked={sel.has(m.id)} />
            </div>
          ))}
        </div>
        <button className="btn btn-primary" style={{ width: '100%', marginTop: 10 }} disabled={busy || !name.trim() || sel.size === 0} onClick={go}>
          Create thread ({sel.size})
        </button>
      </div>
    </div>
  )
}

// ---------- Reminders + scheduled messages ----------
// One drawer for "things I set for later", because they are the same thought:
// something I chose not to deal with now.
function LaterModal({ onClose, onOpen }: { onClose: () => void; onOpen: (convId: string, messageId?: string) => void }) {
  const [tab, setTab] = useState<'reminders' | 'scheduled'>('reminders')
  const [reminders, setReminders] = useState<any[]>([])
  const [scheduled, setScheduled] = useState<any[]>([])
  const [loaded, setLoaded] = useState(false)
  const load = () => Promise.all([
    api.get('/chat/reminders').then((d) => setReminders(d.items)).catch(() => {}),
    api.get('/chat/scheduled').then((d) => setScheduled(d.items)).catch(() => {}),
  ]).finally(() => setLoaded(true))
  useEffect(() => { load() }, [])

  const when = (iso: string) => `${dayLabel(iso)} · ${fmtTime(iso)}`
  const drop = async (kind: 'reminders' | 'scheduled', id: string) => {
    try { await api.del(`/chat/${kind}/${id}`); load() } catch (e: any) { toast.error(e.message) }
  }
  const rowBtn: React.CSSProperties = { flex: 1, minWidth: 0, textAlign: 'left', border: 0, background: 'transparent', cursor: 'pointer', padding: 0 }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 className="row" style={{ margin: 0, fontSize: 16, gap: 7 }}><Ic name="clock" size={16} /> For later</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="modal-tabs">
          <button className={tab === 'reminders' ? 'active' : ''} onClick={() => setTab('reminders')}>Reminders ({reminders.length})</button>
          <button className={tab === 'scheduled' ? 'active' : ''} onClick={() => setTab('scheduled')}>Scheduled ({scheduled.length})</button>
        </div>
        <div className="modal-list">
          {tab === 'reminders' ? (
            <>
              {loaded && reminders.length === 0 && <div className="empty" style={{ padding: 20 }}>No reminders set</div>}
              {reminders.map((r) => (
                <div key={r.id} className="starred-item mention-row">
                  <button style={rowBtn} onClick={() => onOpen(r.conversation_id, r.message_id)}>
                    <div className="muted" style={{ fontSize: 11.5 }}>{when(r.remind_at)}</div>
                    <div className="starred-body">{r.preview || '(message)'}</div>
                  </button>
                  <button className="btn btn-ghost btn-sm danger" onClick={() => drop('reminders', r.id)} aria-label="Cancel reminder">✕</button>
                </div>
              ))}
            </>
          ) : (
            <>
              {loaded && scheduled.length === 0 && <div className="empty" style={{ padding: 20 }}>Nothing scheduled</div>}
              {scheduled.map((x) => (
                <div key={x.id} className="starred-item mention-row">
                  <button style={rowBtn} onClick={() => onOpen(x.conversation_id)}>
                    <div className="muted" style={{ fontSize: 11.5 }}>To {x.conversation_name} · {when(x.send_at)}</div>
                    <div className="starred-body">{x.body}</div>
                  </button>
                  <button className="btn btn-ghost btn-sm danger" onClick={() => drop('scheduled', x.id)} aria-label="Cancel scheduled message">✕</button>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- custom status / do not disturb ----------
function StatusModal({ current, onClose, onSaved }: { current: any; onClose: () => void; onSaved: (s: any) => void }) {
  const [text, setText] = useState(current.status_text || '')
  const [emoji, setEmoji] = useState(current.status_emoji || '')
  const [busy, setBusy] = useState(false)
  const minutesLeft = (iso: string) => Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000))
  const dndOn = !!current.dnd_until && current.dnd_until > new Date().toISOString()

  const save = async (dndMinutes?: number) => {
    setBusy(true)
    try {
      const keep = dndOn ? minutesLeft(current.dnd_until) : 0
      const saved = await api.post('/chat/status', { status_text: text, status_emoji: emoji, dnd_minutes: dndMinutes === undefined ? keep : dndMinutes })
      onSaved(saved)
      onClose()
    } catch (e: any) { toast.error(e.message); setBusy(false) }
  }

  const PRESETS: [string, string][] = [
    ['💬', 'Available'], ['📅', 'In a meeting'], ['🍽️', 'At lunch'],
    ['🏠', 'Working from home'], ['✈️', 'Travelling'], ['🎯', 'Focusing'],
  ]
  const DND: [string, number][] = [['30 min', 30], ['1 hour', 60], ['4 hours', 240], ['Rest of day', 600]]

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 style={{ margin: 0, fontSize: 16 }}>Your status</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <input className="chat-contact-search" style={{ width: 54, textAlign: 'center' }} value={emoji} maxLength={2} placeholder="🙂" onChange={(e) => setEmoji(e.target.value)} aria-label="Status emoji" />
          <input className="chat-contact-search" style={{ flex: 1 }} value={text} maxLength={80} placeholder="What are you up to?" onChange={(e) => setText(e.target.value)} aria-label="Status message" />
        </div>
        <div className="status-presets">
          {PRESETS.map(([e, t]) => (
            <button key={t} className="btn btn-sm" onClick={() => { setEmoji(e); setText(t) }}>{e} {t}</button>
          ))}
        </div>
        <div className="ch-title" style={{ marginTop: 14 }}>Do not disturb</div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
          {dndOn
            ? `On for another ${minutesLeft(current.dnd_until)} min — every notification silenced, mentions included.`
            : 'Silences every notification, including mentions. Messages still arrive in the thread.'}
        </div>
        <div className="status-presets">
          {dndOn
            ? <button className="btn" disabled={busy} onClick={() => save(0)}>Turn DND off</button>
            : DND.map(([l, m]) => <button key={l} className="btn btn-sm" disabled={busy} onClick={() => save(m)}>{l}</button>)}
        </div>
        <button className="btn btn-primary" style={{ width: '100%', marginTop: 14 }} disabled={busy} onClick={() => save()}>Save status</button>
      </div>
    </div>
  )
}

// ---------- who reacted ----------
// WhatsApp's reaction sheet: everyone who reacted, filterable by emoji, with
// your own row first and removable from here. A bottom sheet on a phone, a
// small card on desktop. Reads the live message, so a reaction arriving over the
// socket while it is open shows up in it; it closes itself once the last one is
// gone, since an empty "who reacted" list answers nothing.
function ReactionsSheet({ message, members, meId, onRemoveMine, onClose }: {
  message: Msg; members: Member[]; meId: string; onRemoveMine: (emoji: string) => void; onClose: () => void
}) {
  const [tab, setTab] = useState<string>('all')
  const rxs = message.reactions || []
  useEffect(() => { if (!rxs.length) onClose() }, [rxs.length])
  // A modal: focus moves into it (it is where you take your reaction back),
  // Tab stays inside, Escape closes, focus returns to the pill that opened it.
  const sheetRef = useDialog<HTMLDivElement>(onClose)
  const counts: Record<string, number> = {}
  for (const rx of rxs) counts[rx.emoji] = (counts[rx.emoji] || 0) + 1
  const emojis = Object.keys(counts).sort((a, b) => counts[b] - counts[a])
  // A tab whose last reaction was just withdrawn falls back to All.
  const shownTab = tab === 'all' || counts[tab] ? tab : 'all'
  const rows = rxs
    .filter((rx) => shownTab === 'all' || rx.emoji === shownTab)
    .sort((a, b) => (a.user_id === meId ? -1 : b.user_id === meId ? 1 : 0))
  return (
    <div className="modal-overlay rx-overlay" onClick={onClose}>
      <div className="modal-card rx-sheet" ref={sheetRef} role="dialog" aria-modal="true" aria-label="Who reacted" onClick={(e) => e.stopPropagation()}>
        <div className="rx-head">
          <div className="rx-tabs" role="tablist" aria-label="Filter by reaction">
            <button role="tab" aria-selected={shownTab === 'all'} className={'rx-tab' + (shownTab === 'all' ? ' active' : '')} onClick={() => setTab('all')}>All {rxs.length}</button>
            {emojis.map((emo) => (
              <button key={emo} role="tab" aria-selected={shownTab === emo} className={'rx-tab' + (shownTab === emo ? ' active' : '')} onClick={() => setTab(emo)}>{emo} {counts[emo]}</button>
            ))}
          </div>
          <button className="ic-btn" onClick={onClose} aria-label="Close"><Ic name="close" size={17} /></button>
        </div>
        <div className="rx-list">
          {rows.map((rx) => {
            const mine = rx.user_id === meId
            const mem = members.find((x) => x.id === rx.user_id)
            const name = mine ? 'You' : mem?.name || 'Former member'
            const inner = (
              <>
                <Avatar name={mem?.name || name} color={mem?.avatar_color} size={36} src={mem?.avatar_file ? userAvatarUrl(mem.id, mem.avatar_file) : undefined} />
                <span className="rx-who">
                  <span className="rx-name">{name}</span>
                  {mine && <span className="rx-sub">Tap to remove</span>}
                </span>
                <span className="rx-emoji" aria-hidden="true">{rx.emoji}</span>
              </>
            )
            return mine
              ? <button key={rx.user_id} className="rx-row mine" onClick={() => onRemoveMine(rx.emoji)} aria-label={`Your reaction ${rx.emoji}. Remove it`}>{inner}</button>
              : <div key={rx.user_id} className="rx-row" aria-label={`${name} reacted ${rx.emoji}`}>{inner}</div>
          })}
        </div>
      </div>
    </div>
  )
}

// ---------- mute for a while ----------
function MuteModal({ conv, onClose, onPick }: { conv: Conversation; onClose: () => void; onPick: (minutes: number) => void }) {
  // A dialog: focus moves into it, Tab stays inside, Escape closes it, and
  // focus goes back to what opened it (lib/useDialog).
  const cardRef = useDialog<HTMLDivElement>(onClose)
  const OPTIONS: [string, number][] = [['1 hour', 60], ['8 hours', 480], ['1 day', 1440], ['1 week', 10080], ['Until I turn it back on', 525600]]
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" ref={cardRef} role="dialog" aria-modal="true" aria-label={`Mute ${conv.name}`} style={{ maxWidth: 320 }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 style={{ margin: 0, fontSize: 16 }}>Mute {conv.name}</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>Messages still arrive — you just will not be notified.</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {OPTIONS.map(([label, mins]) => <button key={label} className="btn" onClick={() => onPick(mins)}>{label}</button>)}
        </div>
      </div>
    </div>
  )
}

// ---------- send this later ----------
function ScheduleModal({ conversationId, body, mentions, onClose, onDone }: { conversationId: string; body: string; mentions: string[]; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [custom, setCustom] = useState('')
  const send = async (at: Date, label: string) => {
    if (busy) return
    setBusy(true)
    try {
      await api.post(`/chat/conversations/${conversationId}/schedule`, { body, send_at: at.toISOString(), mentions })
      toast.success(`Scheduled for ${label}`)
      onDone()
    } catch (e: any) { toast.error(e.message); setBusy(false) }
  }
  const inMins = (m: number) => new Date(Date.now() + m * 60000)
  const tomorrow9 = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d }
  const monday9 = () => { const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(9, 0, 0, 0); return d }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" style={{ maxWidth: 360 }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 className="row" style={{ margin: 0, fontSize: 16, gap: 7 }}><Ic name="clock" size={16} /> Send later</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="remind-quote">{body}</div>
        <div className="remind-presets">
          <button className="btn" disabled={busy} onClick={() => send(inMins(60), 'in an hour')}>In 1 hour</button>
          <button className="btn" disabled={busy} onClick={() => send(tomorrow9(), 'tomorrow 9 am')}>Tomorrow, 9 am</button>
          <button className="btn" disabled={busy} onClick={() => send(monday9(), 'Monday 9 am')}>Monday, 9 am</button>
        </div>
        <label style={{ fontSize: 12, fontWeight: 600, marginTop: 4 }}>Or pick a time</label>
        <div className="row" style={{ gap: 8 }}>
          <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} style={{ flex: 1 }} />
          <button className="btn btn-primary" disabled={busy || !custom} onClick={() => send(new Date(custom), 'then')}>Schedule</button>
        </div>
      </div>
    </div>
  )
}

// ---------- Remind me about this message ----------
// Relative presets first, because that is how people actually think about it
// ("in an hour", "tomorrow morning"), with an exact time underneath for the rest.
function RemindModal({ message, onClose }: { message: Msg; onClose: () => void }) {
  // A dialog: focus moves into it, Tab stays inside, Escape closes it, and
  // focus goes back to what opened it (lib/useDialog).
  const cardRef = useDialog<HTMLDivElement>(onClose)
  const [busy, setBusy] = useState(false)
  const [custom, setCustom] = useState('')

  const set = async (at: Date, label: string) => {
    if (busy) return
    setBusy(true)
    try {
      await api.post(`/chat/message/${message.id}/remind`, { remind_at: at.toISOString() })
      toast.success(`I'll remind you ${label}`)
      onClose()
    } catch (e: any) { toast.error('Could not set the reminder: ' + e.message); setBusy(false) }
  }

  const inMins = (m: number) => new Date(Date.now() + m * 60000)
  const tomorrowMorning = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d }
  const presets: [string, () => Date][] = [
    ['In 30 minutes', () => inMins(30)],
    ['In 1 hour', () => inMins(60)],
    ['In 3 hours', () => inMins(180)],
    ['Tomorrow, 9 am', tomorrowMorning],
  ]

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" ref={cardRef} role="dialog" aria-modal="true" aria-label="Remind me about this message" style={{ maxWidth: 360 }} onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 className="row" style={{ margin: 0, fontSize: 16, gap: 7 }}><Ic name="clock" size={16} /> Remind me</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="remind-quote">{message.body || message.file?.name || 'this message'}</div>
        <div className="remind-presets">
          {presets.map(([label, make]) => (
            <button key={label} className="btn" disabled={busy} onClick={() => set(make(), label.toLowerCase())}>{label}</button>
          ))}
        </div>
        <label style={{ fontSize: 12, fontWeight: 600, marginTop: 4 }}>Or pick a time</label>
        <div className="row" style={{ gap: 8 }}>
          <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} style={{ flex: 1 }} />
          <button className="btn btn-primary" disabled={busy || !custom} onClick={() => set(new Date(custom), 'then')}>Set</button>
        </div>
      </div>
    </div>
  )
}

// ---------- Jump to date ----------
// Cliq's date navigator: the days this conversation actually has, plus a free
// date picker for anything older. Listing the real days matters more than the
// picker — on a quiet thread most dates are empty, and a calendar that lets you
// choose sixty blank days is worse than a list of the nine that have messages.
function JumpToDate({ days, onPick, onClose }: { days: { iso: string; label: string; count: number }[]; onPick: (iso: string) => void; onClose: () => void }) {
  const [custom, setCustom] = useState('')
  return (
    <div className="jump-pop" onClick={(e) => e.stopPropagation()}>
      <div className="jump-head">
        <span>Jump to date</span>
        <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="jump-pick">
        <input
          type="date"
          value={custom}
          max={isoDay(new Date())}
          onChange={(e) => { setCustom(e.target.value); if (e.target.value) onPick(e.target.value) }}
          aria-label="Pick a date"
        />
      </div>
      <div className="jump-list">
        {days.length === 0 && <div className="empty" style={{ padding: 14, fontSize: 12.5 }}>No messages yet</div>}
        {days.map((d) => (
          <button key={d.iso} className="jump-day" onClick={() => onPick(d.iso)}>
            <span>{d.label}</span>
            <span className="jump-count">{d.count}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------- @ Mentions inbox ----------
// Every message that named me, newest first. A mention in a group that moves fast
// is otherwise indistinguishable from the rest of the unread count.
function MentionsModal({ meId, onClose, onOpen, onTask }: { meId: string; onClose: () => void; onOpen: (convId: string, messageId?: string) => void; onTask: (convId: string, messageId: string) => void }) {
  const [items, setItems] = useState<(Msg & { sender_name: string; conversation_name: string })[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => { api.get('/chat/mentions').then((d) => setItems(d.items)).catch(() => {}).finally(() => setLoaded(true)) }, [])
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 className="row" style={{ margin: 0, fontSize: 16, gap: 7 }}><Ic name="at" size={16} /> Mentions</h3><button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="modal-list">
          {loaded && items.length === 0 && <div className="empty" style={{ padding: 20 }}>No one has mentioned you yet</div>}
          {items.map((m) => (
            <div key={m.id} className="starred-item mention-row">
              <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => onOpen(m.conversation_id, m.id)}>
                <div className="muted" style={{ fontSize: 11.5, marginBottom: 2 }}>{m.sender_name} · {m.conversation_name}</div>
                <div className="starred-body row" style={{ gap: 6 }}>
                  {m.file ? <><Ic name="attach" size={13} /> {m.file.name}</> : <MessageText body={m.body} mentions={m.mentions} meId={meId} fromMe={false} />}
                </div>
              </div>
              <button className="btn btn-ghost btn-sm" title="Assign as task" aria-label="Assign as task" onClick={() => onTask(m.conversation_id, m.id)}><Ic name="taskAdd" size={15} /></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------- New chat / group modal ----------
function NewChatModal({ user, convos, onClose, onOpen }: { user: OrgUser; convos: Conversation[]; onClose: () => void; onOpen: (cid: string) => void }) {
  const [users, setUsers] = useState<OrgUser[]>([])
  const [mode, setMode] = useState<'pick' | 'group' | 'channels'>('pick')
  const [q, setQ] = useState('')
  const [groupName, setGroupName] = useState('')
  const [isPublic, setIsPublic] = useState(false)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  // Mirrors the check on POST /chat/conversations. Employees still see the tab —
  // hiding it entirely just makes people ask where groups come from — but it
  // explains who to ask instead of failing at the Create button.
  const canCreateGroup = user.role === 'manager' || user.role === 'admin'
  useEffect(() => { api.get('/chat/users').then((d) => setUsers(d.users)).catch(() => {}) }, [])
  const list = users.filter((u) => u.name.toLowerCase().includes(q.toLowerCase()) || u.email.toLowerCase().includes(q.toLowerCase()))
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const startDirect = async (uid: string) => {
    setBusy(true)
    try { const c = await api.post('/chat/conversations', { type: 'direct', userId: uid }); onOpen(c.id) } catch (e: any) { toast.error(e.message); setBusy(false) }
  }
  const createGroup = async () => {
    // A public channel may open empty — anyone can walk in. A private one needs
    // at least one other person or it is a note to self.
    if (!groupName.trim() || (sel.size === 0 && !isPublic)) return
    setBusy(true)
    try { const c = await api.post('/chat/conversations', { type: 'group', name: groupName.trim(), memberIds: [...sel], visibility: isPublic ? 'public' : 'private' }); onOpen(c.id) } catch (e: any) { toast.error(e.message); setBusy(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3 style={{ margin: 0, fontSize: 16 }}>{mode === 'pick' ? 'New chat' : mode === 'group' ? 'New group' : 'Channels'}</h3><button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button></div>
        <div className="modal-tabs">
          <button className={mode === 'pick' ? 'active' : ''} onClick={() => setMode('pick')}>Direct</button>
          <button className={mode === 'group' ? 'active' : ''} onClick={() => setMode('group')}>Group</button>
          <button className={mode === 'channels' ? 'active' : ''} onClick={() => setMode('channels')}>Channels</button>
        </div>
        {mode === 'channels' && <ChannelList onOpen={onOpen} />}
        {mode === 'group' && !canCreateGroup && (
          <div className="notice-inline row" style={{ gap: 7 }}><Ic name="lock" size={14} /> Only managers can create groups. Ask your manager to set one up and add you.</div>
        )}
        {mode === 'group' && canCreateGroup && (
          <>
            <input className="chat-contact-search" style={{ marginBottom: 8 }} placeholder="Group name…" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
            <div className="vis-pick">
              <button className={!isPublic ? 'active' : ''} onClick={() => setIsPublic(false)}>
                <Ic name="lock" size={13} /> Private
                <span>Invite only</span>
              </button>
              <button className={isPublic ? 'active' : ''} onClick={() => setIsPublic(true)}>
                <Ic name="hash" size={13} /> Channel
                <span>Anyone can join</span>
              </button>
            </div>
          </>
        )}
        {mode !== 'channels' && (mode === 'pick' || canCreateGroup) && <input className="chat-contact-search" placeholder="Search people…" value={q} onChange={(e) => setQ(e.target.value)} />}
        <div className="modal-list">
          {mode === 'channels' || (mode === 'group' && !canCreateGroup) ? null : list.map((u) => (
            <div key={u.id} className="modal-user" onClick={() => mode === 'pick' ? startDirect(u.id) : toggle(u.id)}>
              <Avatar name={u.name} color={u.avatar_color} size={34} src={u.avatar_file ? userAvatarUrl(u.id, u.avatar_file) : undefined} />
              <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 13.5 }}>{u.name}</div><div className="muted" style={{ fontSize: 11.5, textTransform: 'capitalize' }}>{u.role}</div></div>
              {mode === 'group' && <input type="checkbox" readOnly checked={sel.has(u.id)} />}
            </div>
          ))}
          {mode !== 'channels' && list.length === 0 && (mode === 'pick' || canCreateGroup) && <div className="empty" style={{ padding: 16 }}>No people found</div>}
        </div>
        {mode === 'group' && canCreateGroup && (
          <button className="btn btn-primary" style={{ width: '100%', marginTop: 10 }} disabled={busy || !groupName.trim() || (sel.size === 0 && !isPublic)} onClick={createGroup}>
            {isPublic ? `Create channel${sel.size ? ` (${sel.size})` : ''}` : `Create group (${sel.size})`}
          </button>
        )}
      </div>
    </div>
  )
}
