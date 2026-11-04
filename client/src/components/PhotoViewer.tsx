import React, { useEffect, useRef, useState } from 'react'
import { Ic } from '../ui'
import { useDialog } from '../lib/useDialog'
import { pushBackHandler } from '../back'
import ZoomMedia, { ZoomHandle } from './ZoomMedia'
import { ChevronLeft, ChevronRight } from './chat/glyphs'

// A picture full screen on black, to be looked at properly: pinch, double-tap,
// ctrl+scroll, the zoom button or +/− to get close enough to read it (see
// ZoomMedia). Who or what it is along the top, the caption along the bottom,
// and a swipe (or the arrow keys) to the next one. Used wherever a picture
// that was uploaded can be opened — a chat's photos, pictures waiting in the
// composer before Send, a task's attachments — instead of a new browser tab,
// which on the phone app threw it out of the app, and a bare <img> nobody
// could zoom.

export interface ViewerItem {
  id: string
  src: string
  video?: boolean
  alt: string
  // The top line (who sent it, or the file's name) and the one under it
  // (when, how big); "3 of 7" is added to the second.
  title: string
  subtitle?: string
  caption?: string
}

export default function PhotoViewer({ items, startId, onClose, actions, label = 'Photo viewer' }: {
  items: ViewerItem[]
  startId: string
  onClose: () => void
  // Buttons for the bar (Forward, Download…), for the item on screen.
  actions?: (it: ViewerItem) => React.ReactNode
  label?: string
}) {
  const ref = useDialog<HTMLDivElement>(onClose)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })
  // By id, not position: older messages loading above, or new ones arriving,
  // would otherwise swap the picture on screen for another one.
  const [curId, setCurId] = useState(startId)
  const idx = items.findIndex((x) => x.id === curId)
  const it = idx >= 0 ? items[idx] : null
  const go = (step: number) => { const n = items[idx + step]; if (n) setCurId(n.id) }
  const armedAt = useRef(Date.now() + 350)
  const zoomCtl = useRef<ZoomHandle>(null)
  const [zoomed, setZoomed] = useState(false)

  // Android's back button closes the viewer, not the page or drawer under it.
  useEffect(() => pushBackHandler(() => { closeRef.current(); return true }), [])

  // Resubscribed every render, so it always steps from the current item.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
      // A focused video uses the arrow keys to seek.
      if ((e.target as HTMLElement | null)?.tagName === 'VIDEO') return
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1) }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1) }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomCtl.current?.zoomBy(1.5) }
      else if (e.key === '-') { e.preventDefault(); zoomCtl.current?.zoomBy(1 / 1.5) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  // The item it was opened on went away (deleted for everyone, sent, the
  // attachment removed): close.
  const gone = !it
  useEffect(() => { if (gone) closeRef.current() }, [gone])

  // The neighbours start loading now, so stepping to them is instant.
  const near = [items[idx + 1], items[idx - 1]].filter((n) => n && !n.video).map((n) => n.src).join('\n')
  useEffect(() => {
    for (const src of near.split('\n')) {
      if (!src) continue
      const img = new Image()
      img.decoding = 'async'
      img.src = src
    }
  }, [near])

  if (!it) return null
  const sub = [it.subtitle, items.length > 1 ? `${idx + 1} of ${items.length}` : ''].filter(Boolean).join(' · ')

  return (
    <div className="mv-overlay" ref={ref} role="dialog" aria-modal="true" aria-label={label}>
      <div className="mv-head">
        <button type="button" className="mv-btn" onClick={onClose} aria-label="Close"><ChevronLeft size={24} /></button>
        <div className="mv-who" aria-live="polite">
          <div className="mv-name">{it.title}</div>
          {sub && <div className="mv-when">{sub}</div>}
        </div>
        {!it.video && (
          <button type="button" className="mv-btn" onClick={() => zoomCtl.current?.toggle()}
            aria-label={zoomed ? 'Zoom out' : 'Zoom in'} title={zoomed ? 'Zoom out (−)' : 'Zoom in (+)'}>
            <Ic name={zoomed ? 'zoomOut' : 'zoomIn'} size={19} />
          </button>
        )}
        {actions?.(it)}
      </div>
      <div className="mv-stage">
        <ZoomMedia key={it.id} ref={zoomCtl} src={it.src} video={it.video} alt={it.alt}
          canPrev={idx > 0} canNext={idx < items.length - 1} onStep={go} onClose={onClose}
          armedAt={armedAt.current} onZoom={setZoomed} />
        {idx > 0 && <button type="button" className="mv-nav prev" onClick={() => go(-1)} aria-label="Previous"><ChevronLeft size={30} /></button>}
        {idx < items.length - 1 && <button type="button" className="mv-nav next" onClick={() => go(1)} aria-label="Next"><ChevronRight size={30} /></button>}
      </div>
      {it.caption && <div className="mv-caption">{it.caption}</div>}
    </div>
  )
}
