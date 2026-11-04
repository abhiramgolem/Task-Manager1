import React, { useEffect, useState } from 'react'
import { useCategories, categoryColor } from './lib/categories'

// Priority/status hues. Kept as concrete values (not CSS vars) because they're
// also passed to SVG fills, gradient stops, and color-mix in inline styles where
// var() isn't always resolvable. They intentionally match the semantic tokens.
// These are rendered as TEXT on a 12% tint of themselves (see Badge, soft), so
// each is the ink weight of its hue rather than the fill weight. A mid-weight
// colour on its own pale tint is a narrow gap by construction — amber on amber
// measured 3.1:1 at 12px, under AA. 'To Do' also drops a leftover warm grey from
// the old palette.
export const PRIORITY_COLORS: Record<string, string> = {
  Critical: 'var(--danger-ink)', High: 'var(--warning-ink)', Medium: 'var(--info-ink)', Low: 'var(--n-600)',
}
export const STATUS_COLORS: Record<string, string> = {
  'To Do': 'var(--n-600)', 'In Progress': 'var(--info-ink)', 'Blocked': 'var(--danger-ink)',
  'In Review': 'var(--violet-ink)', 'Done': 'var(--success-ink)', 'Reopened': 'var(--brand-ink)',
}
export const LANG_LABEL: Record<string, string> = { en: 'English', hi: 'हिन्दी', te: 'తెలుగు' }

// Task categories (business units / brands) live in lib/categories.ts: the
// built-ins plus whatever the org added, with their colours.

// Human-readable file size (e.g. 1.4 MB). Used for attachment chips.
export function fmtBytes(n?: number | null): string {
  if (!n || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// Shared line-icon primitive — inherits currentColor and sizes to the text it
// sits with. Replaces semantic emoji (which render differently per-OS, get read
// aloud verbosely by screen readers, and read as informal). Emoji stay only in
// user-generated content (chat reactions).
export function Ic({ name, size = 16 }: { name: keyof typeof ICON_PATHS; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ flexShrink: 0, verticalAlign: '-.15em' }}>
      {ICON_PATHS[name]}
    </svg>
  )
}
const ICON_PATHS = {
  check: <path d="M20 6 9 17l-5-5" />,
  // Two arrows running opposite ways — swapping one thing for another.
  // Distinct from `refresh`, whose circular arrow means retry/reload.
  swap: <><path d="M7 4 3 8l4 4" /><path d="M3 8h14" /><path d="m17 20 4-4-4-4" /><path d="M21 16H7" /></>,
  arrowRight: <><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></>,
  warning: <><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12" y2="17" /></>,
  block: <><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></>,
  refresh: <><path d="M3 2v6h6" /><path d="M3.5 12a9 9 0 1 0 2.6-6.4L3 8" /></>,
  ai: <><path d="M12 3 13.4 8.6 19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4z" /><path d="M18 15l.7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7z" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  pin: <><path d="M12 21s7-5.2 7-11a7 7 0 1 0-14 0c0 5.8 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" /></>,
  send: <><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></>,
  lock: <><rect x="3" y="11" width="18" height="10" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
  doc: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>,
  chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  user: <><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></>,
  close: <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>,
  trash: <><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>,
  edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
  mail: <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 6-10 7L2 6" /></>,
  attach: <path d="M21.44 11.05 12.25 20.24a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.48-8.49" />,
  star: <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>,
  upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></>,
  mic: <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /></>,
  search: <><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>,
  // The search glass with a + or −: the photo viewers' zoom button.
  zoomIn: <><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" /></>,
  zoomOut: <><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" /></>,
  scissors: <><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><line x1="20" y1="4" x2="8.12" y2="15.88" /><line x1="14.47" y1="14.48" x2="20" y2="20" /><line x1="8.12" y1="8.12" x2="12" y2="12" /></>,
  arrowLeft: <><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></>,
  reply: <><polyline points="9 17 4 12 9 7" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></>,
  merge: <><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></>,
  note: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="9" y1="13" x2="15" y2="13" /><line x1="9" y1="17" x2="13" y2="17" /></>,
  box: <><path d="M21 8v13H3V8" /><path d="M1 3h22v5H1z" /><line x1="10" y1="12" x2="14" y2="12" /></>,
  plus: <><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>,
  muteBell: <><path d="M13.73 21a2 2 0 0 1-3.46 0" /><path d="M18.63 13A17.9 17.9 0 0 1 18 8" /><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" /><path d="M18 8a6 6 0 0 0-9.33-5" /><line x1="1" y1="1" x2="23" y2="23" /></>,
  menu: <><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></>,
  sort: <><path d="M11 5h10" /><path d="M11 9h7" /><path d="M11 13h4" /><path d="m3 8 3-3 3 3" /><path d="M6 5v14" /></>,
  arrowUp: <><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></>,
  arrowDown: <><line x1="12" y1="5" x2="12" y2="19" /><polyline points="19 12 12 19 5 12" /></>,
  music: <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>,
  board: <><rect x="3" y="3" width="6" height="18" rx="1" /><rect x="11" y="3" width="6" height="12" rx="1" /><rect x="19" y="3" width="2" height="7" rx="1" /></>,
  inbox: <><polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>,
  forward: <><polyline points="15 17 20 12 15 7" /><path d="M4 18v-2a4 4 0 0 1 4-4h12" /></>,
  smile: <><circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></>,
  video: <><path d="m23 7-7 5 7 5V7z" /><rect x="1" y="5" width="15" height="14" rx="2" /></>,
  at: <><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9" /></>,
  taskAdd: <><path d="M11 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6" /><path d="m9 11 3 3 8-8" /><line x1="17" y1="16" x2="23" y2="16" /><line x1="20" y1="13" x2="20" y2="19" /></>,
  phone: <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />,
  callEnd: <><path d="M2.5 12.5a13 13 0 0 1 19 0" /><path d="M5.6 15.6 3.9 17.3a1.6 1.6 0 0 1-2.3-2.3l1.7-1.7" /><path d="M18.4 15.6l1.7 1.7a1.6 1.6 0 0 0 2.3-2.3l-1.7-1.7" /><line x1="4" y1="20" x2="20" y2="4" /></>,
  micOff: <><line x1="1" y1="1" x2="23" y2="23" /><path d="M9 9v3a3 3 0 0 0 5.1 2.1" /><path d="M15 9.3V4a3 3 0 0 0-5.9-.7" /><path d="M19 10v2a7 7 0 0 1-1 3.6" /><path d="M5 10v2a7 7 0 0 0 10.7 6" /><line x1="12" y1="19" x2="12" y2="23" /></>,
  videoOff: <><line x1="1" y1="1" x2="23" y2="23" /><path d="M16 16v3a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" /><path d="M9 5h5a2 2 0 0 1 2 2v3l7-5v10" /></>,
  screen: <><rect x="2" y="3" width="20" height="13" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /><polyline points="9 10 12 7 15 10" /><line x1="12" y1="7" x2="12" y2="13" /></>,
  calendar: <><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></>,
  record: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" fill="currentColor" /></>,
  captions: <><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="6" y1="11" x2="12" y2="11" /><line x1="14" y1="11" x2="18" y2="11" /><line x1="6" y1="15" x2="9" y2="15" /><line x1="11" y1="15" x2="18" y2="15" /></>,
  hash: <><line x1="4" y1="9" x2="20" y2="9" /><line x1="4" y1="15" x2="20" y2="15" /><line x1="10" y1="3" x2="8" y2="21" /><line x1="16" y1="3" x2="14" y2="21" /></>,
  thread: <><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><line x1="8" y1="9" x2="16" y2="9" /><line x1="8" y1="13" x2="13" y2="13" /></>,
  code: <><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></>,
  slash: <line x1="7" y1="20" x2="17" y2="4" />,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>,
  maximize: <><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" /></>,
  minimize: <><path d="M4 14h6v6" /><path d="M20 10h-6V4" /><path d="M14 10l7-7" /><path d="M3 21l7-7" /></>,
  play: <polygon points="6 4 20 12 6 20 6 4" />,
  // Chat info panel: a Links tab, the member list, the info entry point, row
  // disclosure, leaving a group and opening something outside the app.
  link: <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
  users: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  userPlus: <><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><line x1="20" y1="8" x2="20" y2="14" /><line x1="23" y1="11" x2="17" y2="11" /></>,
  info: <><circle cx="12" cy="12" r="9" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></>,
  chevronRight: <polyline points="9 18 15 12 9 6" />,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>,
  external: <><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></>,
  pause: <><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></>,
} as const

export function Badge({ children, color, soft }: { children: React.ReactNode; color: string; soft?: boolean }) {
  return (
    <span className="badge" style={soft
      // color-mix, not `color + '22'`: concatenation only works on a literal hex,
      // which forced every badge colour to be hard-coded — and a hard-coded
      // colour cannot follow the theme. These are tokens now.
      ? { background: `color-mix(in srgb, ${color} 16%, transparent)`, color, border: `1px solid color-mix(in srgb, ${color} 36%, transparent)` }
      : { background: color, color: '#fff' }}>
      {children}
    </span>
  )
}

export function PriorityBadge({ p }: { p: string }) {
  return <Badge color={PRIORITY_COLORS[p] || 'var(--n-600)'} soft>{p}</Badge>
}
export function StatusBadge({ s }: { s: string }) {
  return <Badge color={STATUS_COLORS[s] || '#64748b'} soft>{s}</Badge>
}
// Category (business unit) tag. Renders nothing when the task is uncategorized.
export function CategoryBadge({ c }: { c?: string | null }) {
  useCategories() // re-render once the org's own categories (and colours) arrive
  if (!c) return null
  return <Badge color={categoryColor(c)} soft>{c}</Badge>
}

// A textarea that grows to fit what is in it, so nothing you type is hidden
// behind an inner scrollbar.
//
// A fixed-height box for free text is a small cruelty: a comment three lines long
// is read three lines at a time through a slot, and editing one means scrolling
// inside a control while trying to judge the whole. It grows without a ceiling on
// purpose — every place it is used sits in a scrollable panel, so a long entry
// scrolls the panel (which the reader controls) instead of the box (which they
// have to discover).
//
// The double assignment is required, not superstition: height must go back to
// auto before scrollHeight is read, or the measurement is capped by the height
// already set and the box can only ever grow.
export function AutoTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = React.useRef<HTMLTextAreaElement>(null)
  const fit = () => {
    const el = ref.current
    if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px' }
  }
  useEffect(fit, [props.value])
  return (
    <textarea
      ref={ref} rows={1} {...props} onInput={fit}
      style={{ resize: 'none', overflow: 'hidden', lineHeight: 1.45, minHeight: 40, ...props.style }}
    />
  )
}

// Two initials, except that a number after the first word is kept whole:
// "Employee 1" and "Employee 10" are different people, and both used to read
// "E1". Up to three digits fit the circle. A longer number gets the first letter
// alone, because cut short ("E1" for Employee 1000) it would name someone else.
function initialsOf(name?: string) {
  const words = (name || '?').split(' ')
  if (words[0] && /^\d+$/.test(words[1] || '')) return (words[0][0] + (words[1].length <= 3 ? words[1] : '')).toUpperCase()
  return words.map((n) => n[0]).slice(0, 2).join('').toUpperCase()
}

export function Avatar({ name, color, size = 28, src }: { name?: string; color?: string; size?: number; src?: string | null }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => { setBroken(false) }, [src]) // a new image URL should retry, not stay fallen-back
  const initials = initialsOf(name)
  if (src && !broken) {
    return <img className="avatar" src={src} alt={name || ''} onError={() => setBroken(true)}
      style={{ width: size, height: size, objectFit: 'cover' }} />
  }
  // "E10" and "E100" are wider than two letters: a step smaller keeps them
  // inside the circle at every size, down to the 16px faces.
  const scale = initials.length > 3 ? 0.28 : initials.length > 2 ? 0.34 : 0.4
  return (
    <span className="avatar" style={{ background: color || '#ea580c', width: size, height: size, fontSize: size * scale }}>
      {initials}
    </span>
  )
}

export function ConfidenceTag({ c }: { c: string }) {
  if (c === 'needs_confirmation') return <Badge color="var(--warning)" soft>Needs confirmation</Badge>
  if (c === 'low') return <Badge color="var(--warning)" soft>Review recommended</Badge>
  return null
}

// ---------------------------------------------------------------------------
// AI confidence — ONE definition used everywhere. A raw percentage means nothing
// on its own ("82% of what?"), so every surface pairs the number with a named
// band and the drivers behind it. Bands: Verified ≥70 · Review recommended 40–69
// · Needs confirmation <40. This is the single source of truth — MeetingDetail,
// the review modal, and the task drawer all key off confidenceBand().
// ---------------------------------------------------------------------------
export type ConfBand = { key: 'verified' | 'review' | 'confirm'; label: string; color: string; bg: string; border: string; ink: string }
export function confidenceBand(score: number): ConfBand {
  const n = clampPct(score)
  if (n >= 70) return { key: 'verified', label: 'Verified', color: 'var(--success)', bg: 'var(--success-bg)', border: 'var(--success-border)', ink: 'var(--success-ink)' }
  if (n >= 40) return { key: 'review', label: 'Review recommended', color: 'var(--warning)', bg: 'var(--warning-bg)', border: 'var(--warning-border)', ink: 'var(--warning-ink)' }
  return { key: 'confirm', label: 'Needs confirmation', color: 'var(--danger)', bg: 'var(--danger-bg)', border: 'var(--danger-border)', ink: 'var(--danger-ink)' }
}
function clampPct(score: number) { return Math.max(0, Math.min(100, Math.round(score || 0))) }

// Compact confidence chip: named band + score. Use inline in dense rows.
export function ConfidenceScore({ score }: { score: number }) {
  const n = clampPct(score)
  const b = confidenceBand(n)
  return (
    <span title={`AI confidence ${n}% — ${b.label}`} className="conf-chip" style={{ color: b.ink, background: b.bg, borderColor: b.border }}>
      <span className="conf-chip-track" style={{ background: `color-mix(in srgb, ${b.color} 22%, transparent)` }}>
        <span className="conf-chip-fill" style={{ width: n + '%', background: b.color }} />
      </span>
      <span className="conf-chip-label">{b.label}</span>
      <span className="conf-chip-pct">{n}%</span>
    </span>
  )
}

// Full Evidence block — the audit trail behind an AI suggestion, rendered as a
// first-class panel (not a 11.5px grey footnote). Shows the original quote, why
// the owner was chosen, and a named confidence band. Reused by MeetingDetail,
// the review modal, and the task drawer so the evidence looks identical everywhere.
export function Evidence({ quote, quoteLang, reasoning, score, ownerLabel, compact }: {
  quote?: string | null; quoteLang?: string | null; reasoning?: string | null
  score?: number; ownerLabel?: React.ReactNode; compact?: boolean
}) {
  const hasQuote = !!(quote && quote.trim())
  const hasReason = !!(reasoning && reasoning.trim())
  if (!hasQuote && !hasReason && score == null) return null
  return (
    <div className={'evidence' + (compact ? ' evidence-compact' : '')}>
      <div className="evidence-label">Evidence</div>
      {hasQuote && (
        <blockquote className="evidence-quote">
          <span className="evidence-quote-mark" aria-hidden="true">“</span>{quote}”
          <span className="evidence-quote-src">From the meeting{quoteLang ? ` · ${LANG_LABEL[quoteLang] || quoteLang} → English` : ' · original language'}</span>
        </blockquote>
      )}
      {(ownerLabel || hasReason) && (
        <div className="evidence-reason">
          {ownerLabel && <div className="evidence-owner">{ownerLabel}</div>}
          {hasReason && <div className="evidence-why">{reasoning}</div>}
        </div>
      )}
      {score != null && (
        <div className="evidence-conf">
          <div className="evidence-conf-head">
            <span>Confidence</span>
            <span className="evidence-conf-band" style={{ color: confidenceBand(score).ink }}>{confidenceBand(score).label} · {clampPct(score)}%</span>
          </div>
          <div className="evidence-conf-track">
            <span className="evidence-conf-fill" style={{ width: clampPct(score) + '%', background: confidenceBand(score).color }} />
          </div>
        </div>
      )}
    </div>
  )
}

// Friendly full-area placeholder for empty lists/views — a big icon, a title,
// an optional hint line, and an optional call-to-action (e.g. a "New task" button).
export function EmptyState({ icon, title, hint, action }: { icon?: React.ReactNode; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="empty-state">
      {icon != null && <div className="empty-state-icon">{icon}</div>}
      <div className="empty-state-title">{title}</div>
      {hint && <div className="empty-state-hint">{hint}</div>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  )
}

export function Stat({ label, value, accent, hint }: { label: string; value: React.ReactNode; accent?: string; hint?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-value" style={{ color: accent }}>{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  )
}

export function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max ? Math.round((value / max) * 100) : 0
  return (
    <div className="bar-track"><div className="bar-fill" style={{ width: pct + '%', background: color }} /></div>
  )
}

// Power BI–style donut: SVG ring split into colored segments with the total in the center.
// Pass onSegmentClick to make each colored segment a clickable link (e.g. drill into
// that priority's tasks). Zero-value slices are skipped so they're not clickable.
export function Donut({ data, size = 150, thickness = 24, onSegmentClick }:
  { data: { label: string; value: number; color: string }[]; size?: number; thickness?: number; onSegmentClick?: (label: string) => void }) {
  const total = data.reduce((s, d) => s + d.value, 0)
  const r = (size - thickness) / 2
  const circ = 2 * Math.PI * r
  const cx = size / 2
  let offset = 0
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <g transform={`rotate(-90 ${cx} ${cx})`}>
        <circle cx={cx} cy={cx} r={r} fill="none" stroke="var(--n-200)" strokeWidth={thickness} />
        {total > 0 && data.map((d, i) => {
          const len = (d.value / total) * circ
          const clickable = !!onSegmentClick && d.value > 0
          const seg = (
            <circle key={i} cx={cx} cy={cx} r={r} fill="none" stroke={d.color} strokeWidth={thickness}
              strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={-offset}
              onClick={clickable ? () => onSegmentClick!(d.label) : undefined}
              style={{ transition: 'stroke-dasharray .5s', cursor: clickable ? 'pointer' : undefined }}>
              {clickable && <title>{`Open ${d.label} tasks (${d.value})`}</title>}
            </circle>
          )
          offset += len
          return seg
        })}
      </g>
      <text x={cx} y={cx} textAnchor="middle" dominantBaseline="central"
        fontSize={size * 0.26} fontWeight={800} fill="var(--text)">{total}</text>
      <text x={cx} y={cx + size * 0.18} textAnchor="middle" dominantBaseline="central"
        fontSize={size * 0.09} fill="var(--muted)" letterSpacing=".05em">OPEN</text>
    </svg>
  )
}

// Friendly absolute timestamp, e.g. "4 Jun 2026, 3:42 PM". Returns '—' when missing.
export function fmtDateTime(iso?: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// Default lead time (days from today) per priority — mirrors the server's
// dueDateForPriority so the UI can pre-fill the same date the backend would.
const DUE_DAYS_BY_PRIORITY: Record<string, number> = { Critical: 0, High: 1, Medium: 3, Low: 5 }
export function defaultDueDate(priority: string): string {
  const days = DUE_DAYS_BY_PRIORITY[priority] ?? 3
  const d = new Date()
  d.setDate(d.getDate() + days)
  return localDateKey(d)
}

// 'YYYY-MM-DD' on the viewer's own calendar. A due date is a day, not an
// instant: toISOString() would give the UTC day, which in India is still
// yesterday until 5:30 in the morning.
function localDateKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// A stored due date as that same local day. new Date('2026-10-02') is UTC
// midnight, which west of Greenwich is still the 1st; an impossible date
// ('2026-02-31') gives null rather than rolling over into March.
function dueDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (!m) return null
  const d = new Date(+m[1], +m[2] - 1, +m[3])
  return d.getMonth() === +m[2] - 1 && d.getDate() === +m[3] ? d : null
}

// "Fri, 2 Oct" in the viewer's own date order, with the year only when it is
// not this one. The stored date stays in the tooltip. Its spaces don't break: in
// a narrow column the date stays one line and only "(overdue)" wraps below it.
export function dueLabel(t: { due_date?: string | null; due_date_raw?: string | null }) {
  if (t.due_date) {
    const now = new Date()
    const day = dueDay(t.due_date)
    const overdue = (day ? localDateKey(day) : t.due_date) < localDateKey(now)
    const text = day
      ? day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: day.getFullYear() === now.getFullYear() ? undefined : 'numeric' }).replace(/ /g, ' ')
      : t.due_date
    return <span title={t.due_date} style={{ color: overdue ? 'var(--danger-ink)' : 'inherit', fontWeight: overdue ? 600 : 400 }}>{text}{overdue ? <span className="due-overdue"> (overdue)</span> : ''}</span>
  }
  if (t.due_date_raw) return <span style={{ fontStyle: 'italic', color: 'var(--muted)' }}>“{t.due_date_raw}”</span>
  return <span style={{ color: 'var(--n-400)' }}>—</span>
}
