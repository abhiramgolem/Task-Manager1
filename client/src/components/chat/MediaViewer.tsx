import React, { useEffect, useRef, useState } from 'react'
import { Ic } from '../../ui'
import { useDialog } from '../../lib/useDialog'
import type { Msg } from './types'
import { fileUrl, isVideo, whenLabel } from './types'
import { ChevronLeft, ChevronRight } from './glyphs'

// WhatsApp's photo viewer: the picture full screen on black, who sent it and
// when along the top, the caption along the bottom, and a swipe (or the arrow
// keys) to the next one in the chat. Opening a picture used to throw it into a
// new browser tab — on the phone app, out of the app entirely.

export default function MediaViewer({ items, startId, senderName, meId, onClose, onForward, onShowInChat }: {
  items: Msg[]
  startId: string
  senderName: (uid: string) => string
  meId: string
  onClose: () => void
  onForward: (m: Msg) => void
  onShowInChat: (m: Msg) => void
}) {
  const ref = useDialog<HTMLDivElement>(onClose)
  const [idx, setIdx] = useState(() => Math.max(0, items.findIndex((m) => m.id === startId)))
  const m = items[idx]
  const touch = useRef<{ x: number; y: number } | null>(null)
  const go = (d: number) => setIdx((i) => Math.min(items.length - 1, Math.max(0, i + d)))

  // Pinch to zoom, double-tap to zoom in or back out, and a drag to look round
  // a zoomed picture, as in WhatsApp. While zoomed a drag pans: turning the page
  // or closing on it would throw the reader out of the detail they zoomed for.
  // `x`/`y` translate before the scale, about the picture's centre.
  const [zoom, setZoom] = useState({ s: 1, x: 0, y: 0 })
  const [gesturing, setGesturing] = useState(false)
  const pinch = useRef<{ d: number; s: number } | null>(null)
  const pan = useRef<{ x: number; y: number; zx: number; zy: number } | null>(null)
  const lastTap = useRef(0)
  // When a double-tap last zoomed. A phone also fires dblclick for those two
  // taps, which would zoom straight back out.
  const tapZoomedAt = useRef(0)
  useEffect(() => { setZoom({ s: 1, x: 0, y: 0 }) }, [idx])
  const zoomed = zoom.s > 1.01
  const fit = (z: { s: number; x: number; y: number }) => {
    const mx = (z.s - 1) * innerWidth / 2, my = (z.s - 1) * innerHeight / 2
    return { s: z.s, x: Math.max(-mx, Math.min(mx, z.x)), y: Math.max(-my, Math.min(my, z.y)) }
  }
  // Keeps the tapped point where it is: a point p from the centre lands at
  // x + s·p, so x = (centre − tap)·(s − 1).
  const toggleZoomAt = (cx: number, cy: number) => setZoom((z) => (z.s > 1.01 ? { s: 1, x: 0, y: 0 }
    : fit({ s: 2.5, x: (innerWidth / 2 - cx) * 1.5, y: (innerHeight / 2 - cy) * 1.5 })))
  const spread = (t: React.TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [items.length])
  // The item it was opened on went away (deleted for everyone): close.
  useEffect(() => { if (!m) onClose() }, [m])
  if (!m) return null
  const photo = !isVideo(m.file)

  const download = () => {
    const a = document.createElement('a'); a.href = fileUrl(m, true); a.download = m.file?.name || 'file'
    document.body.appendChild(a); a.click(); a.remove()
  }

  return (
    <div className="mv-overlay" ref={ref} role="dialog" aria-modal="true" aria-label="Photo viewer"
      onTouchStart={(e) => {
        const t = e.touches[0]
        if (photo && e.touches.length === 2) {
          pinch.current = { d: spread(e.touches), s: zoom.s }; pan.current = null; touch.current = null; setGesturing(true)
          return
        }
        if (photo && zoomed) {
          pan.current = { x: t.clientX, y: t.clientY, zx: zoom.x, zy: zoom.y }; touch.current = { x: t.clientX, y: t.clientY }; setGesturing(true)
          return
        }
        touch.current = { x: t.clientX, y: t.clientY }
      }}
      onTouchMove={(e) => {
        if (pinch.current && e.touches.length === 2) {
          const p = pinch.current
          setZoom((z) => fit({ ...z, s: Math.max(1, Math.min(4, p.s * spread(e.touches) / p.d)) }))
        } else if (pan.current && e.touches.length === 1) {
          const p = pan.current, t = e.touches[0]
          setZoom((z) => fit({ s: z.s, x: p.zx + t.clientX - p.x, y: p.zy + t.clientY - p.y }))
        }
      }}
      onTouchEnd={(e) => {
        if (pinch.current) {
          if (e.touches.length < 2) {
            pinch.current = null; setGesturing(false)
            setZoom((z) => (z.s < 1.05 ? { s: 1, x: 0, y: 0 } : z))
          }
          return
        }
        const wasPan = !!pan.current
        pan.current = null; setGesturing(false)
        const s = touch.current; touch.current = null
        if (!s) return
        const t = e.changedTouches[0]
        const dx = t.clientX - s.x, dy = t.clientY - s.y
        // A tap on the picture: a second one within 300 ms zooms in or out.
        if (photo && Math.abs(dx) < 10 && Math.abs(dy) < 10 && (e.target as HTMLElement).closest('.mv-media')) {
          const at = Date.now()
          if (at - lastTap.current < 300) { lastTap.current = 0; tapZoomedAt.current = at; toggleZoomAt(t.clientX, t.clientY) }
          else lastTap.current = at
          return
        }
        if (wasPan) return
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1)
        else if (dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.5) onClose() // swipe down to close
      }}>
      <div className="mv-head">
        <button className="mv-btn" onClick={onClose} aria-label="Close"><ChevronLeft size={24} /></button>
        <div className="mv-who">
          <div className="mv-name">{m.sender_id === meId ? 'You' : senderName(m.sender_id)}</div>
          <div className="mv-when">{whenLabel(m.created_at)}{items.length > 1 ? ` · ${idx + 1} of ${items.length}` : ''}</div>
        </div>
        <button className="mv-btn" onClick={() => onShowInChat(m)} aria-label="Show in chat" title="Show in chat"><Ic name="chat" size={19} /></button>
        <button className="mv-btn" onClick={() => onForward(m)} aria-label="Forward" title="Forward"><Ic name="forward" size={19} /></button>
        <button className="mv-btn" onClick={download} aria-label="Download" title="Download"><Ic name="download" size={19} /></button>
      </div>
      <div className="mv-stage" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
        {idx > 0 && <button className="mv-nav prev" onClick={() => go(-1)} aria-label="Previous"><ChevronLeft size={30} /></button>}
        {isVideo(m.file)
          ? <video key={m.id} className="mv-media" src={fileUrl(m)} controls autoPlay playsInline />
          : <img key={m.id} className={'mv-media zoomable' + (gesturing ? ' gesturing' : '')} src={fileUrl(m)} alt={m.body || m.file?.name || 'Photo'}
              style={zoomed ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})` } : undefined}
              onDoubleClick={(e) => { if (Date.now() - tapZoomedAt.current > 600) toggleZoomAt(e.clientX, e.clientY) }} draggable={false} />}
        {idx < items.length - 1 && <button className="mv-nav next" onClick={() => go(1)} aria-label="Next"><ChevronRight size={30} /></button>}
      </div>
      {m.body && <div className="mv-caption">{m.body}</div>}
    </div>
  )
}
