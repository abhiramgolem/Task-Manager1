import React, { useEffect, useRef, useState } from 'react'
import { Ic } from '../../ui'
import { mediaLength } from '../VoicePlayer'

// A video in the thread the way Cliq and WhatsApp show one: a still from the
// clip, a play button over it, the size along the top and the length along
// the bottom; a tap plays it full screen in the media viewer. It used to be a
// bare <video controls>, and the phone app's WebView draws no frame for one
// that has not played — only its own grey "play" placeholder — so every clip
// looked the same until someone pressed play.
//
// The still is taken here: a hidden <video> loads just far enough to have a
// frame, which is drawn to a canvas and kept as a small JPEG (in memory, and
// in localStorage for the next visit), then its source is dropped so the rest
// of the clip is never fetched. A clip it cannot read gets a dark card with
// the same play button, never the grey placeholder.

interface Still { poster: string; w: number; h: number; dur: number }

const STORE_KEY = 'votask_video_stills'
const STORE_MAX = 40
const stills = new Map<string, Still | null>()
const pending = new Map<string, Promise<Still | null>>()

function loadStore(): Record<string, Still> {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {} } catch { return {} }
}
function saveStill(id: string, s: Still) {
  try {
    const all = loadStore()
    delete all[id]
    all[id] = s
    const keys = Object.keys(all)
    for (const k of keys.slice(0, Math.max(0, keys.length - STORE_MAX))) delete all[k]
    localStorage.setItem(STORE_KEY, JSON.stringify(all))
  } catch { /* storage full or blocked: the memory copy still serves this visit */ }
}
function cachedStill(id: string): Still | null | undefined {
  if (stills.has(id)) return stills.get(id)
  const s = loadStore()[id]
  if (s) stills.set(id, s)
  return s
}

// Two at a time: a chat opened on a run of clips should not start ten
// downloads at once on a phone's connection.
let running = 0
const queue: (() => void)[] = []
function slot(): Promise<() => void> {
  return new Promise((resolve) => {
    const go = () => { running++; resolve(() => { running--; queue.shift()?.() }) }
    if (running < 2) go(); else queue.push(go)
  })
}

function grab(id: string, src: string): Promise<Still | null> {
  const known = cachedStill(id)
  if (known !== undefined) return Promise.resolve(known)
  let p = pending.get(id)
  if (p) return p
  p = slot().then((done) => new Promise<Still | null>((resolve) => {
    const v = document.createElement('video')
    let settled = false
    const finish = (s: Still | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      v.removeAttribute('src')
      try { v.load() } catch { /* released */ }
      done()
      // A failure is remembered for this visit only: offline now is not
      // offline next time.
      stills.set(id, s)
      if (s) saveStill(id, s)
      pending.delete(id)
      resolve(s)
    }
    const timer = setTimeout(() => finish(null), 20000)
    const draw = () => {
      if (settled || v.readyState < 2 || !v.videoWidth) return
      try {
        const scale = Math.min(1, 360 / v.videoWidth)
        const c = document.createElement('canvas')
        c.width = Math.round(v.videoWidth * scale)
        c.height = Math.round(v.videoHeight * scale)
        c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height)
        const dur = isFinite(v.duration) ? v.duration : 0
        finish({ poster: c.toDataURL('image/jpeg', 0.7), w: v.videoWidth, h: v.videoHeight, dur })
      } catch {
        finish(null) // a canvas the browser will not read back
      }
    }
    v.muted = true
    v.playsInline = true
    v.crossOrigin = 'anonymous'
    v.preload = 'auto'
    v.addEventListener('loadeddata', draw)
    v.addEventListener('seeked', draw)
    v.addEventListener('error', () => finish(null))
    // #t=0.1: at 0 many encoders give a black frame.
    v.src = src + '#t=0.1'
  }))
  pending.set(id, p)
  return p
}

function playTime(sec: number) {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}

export default function ChatVideo({ id, src, size, sizeLabel, name, onOpen }: {
  id: string
  src: string
  size?: number
  sizeLabel: string
  name: string
  onOpen: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const [still, setStill] = useState<Still | null | undefined>(() => cachedStill(id))
  const [dur, setDur] = useState(still?.dur || 0)

  // Fetched only once the card is near the screen.
  useEffect(() => {
    if (still !== undefined) return
    const el = ref.current
    if (!el) return
    let live = true
    const start = () => grab(id, src).then((s) => { if (live) setStill(s) })
    if (typeof IntersectionObserver === 'undefined') { start(); return () => { live = false } }
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) { io.disconnect(); start() }
    }, { rootMargin: '400px 0px' })
    io.observe(el)
    return () => { live = false; io.disconnect() }
  }, [id, src, still])

  // A clip recorded in a browser has no length in its header.
  useEffect(() => {
    if (still?.dur) { setDur(still.dur); return }
    if (still === undefined) return
    let live = true
    mediaLength(id, src, { video: true, size }).then((s) => { if (live && s) setDur(s) })
    return () => { live = false }
  }, [id, src, size, still])

  // The card takes the clip's shape, within reason: a tall phone video is
  // not allowed to fill the screen, a wide one not to become a strip.
  const ratio = still ? Math.min(1.78, Math.max(0.75, still.w / still.h)) : 4 / 3
  return (
    <button ref={ref} type="button" className="chat-vcard" style={{ aspectRatio: String(ratio) }}
      onClick={(e) => { e.stopPropagation(); onOpen() }} aria-label={`Play video${name ? `: ${name}` : ''}`}>
      {still?.poster
        ? <img className="chat-vcard-img" src={still.poster} alt="" />
        : <span className={'chat-vcard-ph' + (still === undefined ? ' loading' : '')} aria-hidden="true" />}
      {sizeLabel && <span className="chat-vcard-size" aria-hidden="true"><Ic name="video" size={13} /> {sizeLabel}</span>}
      <span className="chat-vcard-play" aria-hidden="true"><Ic name="play" size={22} /></span>
      {dur > 0 && <span className="chat-vcard-dur" aria-hidden="true">{playTime(dur)}</span>}
    </button>
  )
}
