import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { Ic } from '../ui'

// The picture (or video) inside a full-screen viewer, and every gesture on it.
// Shared by the chat info panel's media viewer (ChatMedia's Lightbox) and
// PhotoViewer — the thread's photos, pictures waiting to be sent, a task's
// attachments — so a picture zooms the same way wherever it was opened. The
// frame around it (bar, arrows, caption) is the viewer's own.

const ZOOM_MAX = 4
// A double-click or double-tap: near enough to read a whiteboard photo, with
// room left for a pinch to go further.
export const ZOOM_TAP = 2.5
// How far a press may wander and still be a tap.
const SLOP = 8
// How far down a finger must pull an unzoomed picture to close the viewer.
const PULL_CLOSE = 110

// The picture's scale and offset from where it sits unzoomed.
interface Zoom { s: number; x: number; y: number }
const NO_ZOOM: Zoom = { s: 1, x: 0, y: 0 }

// Where the picture sits unzoomed (centre and size), and the box it pans in.
interface Frame { cx: number; cy: number; w: number; h: number; box: DOMRect }

// A zoomed picture smaller than the box along one axis stays centred on it;
// a larger one may not bring an edge inside the box, so no dead black margin
// opens up while panning.
function fit(z: Zoom, f: Frame): Zoom {
  if (z.s <= 1) return NO_ZOOM
  const axis = (t: number, c: number, size: number, start: number, room: number) =>
    size <= room ? 0 : Math.min(start + size / 2 - c, Math.max(start + room - size / 2 - c, t))
  return { s: z.s, x: axis(z.x, f.cx, z.s * f.w, f.box.left, f.box.width), y: axis(z.y, f.cy, z.s * f.h, f.box.top, f.box.height) }
}

// Scale to `s`, keeping the bit of picture that was under (px, py) under
// (qx, qy): a pinch both zooms about the fingers and follows them.
function zoomTo(z: Zoom, s: number, px: number, py: number, qx: number, qy: number, f: Frame): Zoom {
  const k = Math.min(ZOOM_MAX, Math.max(1, s)) / z.s
  return fit({ s: z.s * k, x: qx - f.cx - (px - f.cx - z.x) * k, y: qy - f.cy - (py - f.cy - z.y) * k }, f)
}

// One thing playing at a time, as with voice notes in the thread: a recording
// left running would talk over the video that just started.
function pauseVoiceNotes() {
  for (const el of Array.from(document.querySelectorAll<HTMLAudioElement>('audio.vp-audio'))) {
    try { if (!el.paused) el.pause() } catch { /* already gone */ }
  }
}

// For the viewer's own buttons and keys: pinch and double-tap need fingers or
// a mouse, and a person on a keyboard, or who never thinks to double-tap,
// still has to be able to read the small print. Both zoom about the middle of
// what is on screen.
export interface ZoomHandle {
  zoomBy: (k: number) => void
  toggle: () => void
}

// Keyed by the item's id where it is used, so its loading state and zoom start
// over on every step. Its box is the gesture surface: the browser is told to
// keep out (touch-action: none in the CSS), so a sideways swipe turns the
// picture and can never become the browser's Back, and a pinch zooms the
// picture, not the page under the viewer.
//   picture: pinch, double-tap or double-click to zoom (1-4x); drag to pan
//     once zoomed; at 1x, swipe sideways to step, pull down to close.
//   dark ground: a tap closes (zooms out first, when zoomed).
//   video: its own controls keep their drags and taps; swipes work around it.
const ZoomMedia = forwardRef<ZoomHandle, {
  src: string
  video?: boolean
  alt: string
  canPrev: boolean
  canNext: boolean
  onStep: (step: number) => void
  onClose: () => void
  // Until then a tap on the dark ground does not close. A quick double-tap on
  // a thumbnail opens the viewer on the first tap and lands the second on its
  // dark ground; the viewer keeps this, since this remounts on every step.
  armedAt: number
  // Tells the viewer whether its zoom button should read "in" or "out".
  onZoom?: (zoomed: boolean) => void
}>(function ZoomMedia({ src, video = false, alt, canPrev, canNext, onStep, onClose, armedAt, onZoom }, handle) {
  const [state, setState] = useState<'loading' | 'ready' | 'broken'>('loading')
  const [zoomed, setZoomed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const media = useRef<HTMLImageElement | HTMLVideoElement | null>(null)
  const setMedia = useCallback((el: HTMLImageElement | HTMLVideoElement | null) => { media.current = el }, [])
  const zoom = useRef<Zoom>(NO_ZOOM)
  // Read by the native listeners below, which are attached once.
  const now = useRef({ canZoom: false, canPrev, canNext, onStep, onClose })
  useLayoutEffect(() => { now.current = { canZoom: !video && state === 'ready', canPrev, canNext, onStep, onClose } })
  const onZoomRef = useRef(onZoom)
  useEffect(() => { onZoomRef.current = onZoom })
  useEffect(() => { onZoomRef.current?.(zoomed) }, [zoomed])

  // From layout offsets, which a transform does not move: right even while a
  // zoom is still easing in.
  const frame = (): Frame | null => {
    const el = media.current, box = boxRef.current
    if (!el || !box) return null
    const b = box.getBoundingClientRect()
    return { cx: b.left + el.offsetLeft + el.offsetWidth / 2, cy: b.top + el.offsetTop + el.offsetHeight / 2, w: el.offsetWidth, h: el.offsetHeight, box: b }
  }
  // Written to the element directly: a pinch moves it every frame, and a
  // re-render per frame would be wasted work.
  const show = (z: Zoom, animate = false) => {
    zoom.current = z
    const el = media.current
    if (!el) return
    el.classList.toggle('zm-anim', animate)
    el.style.transform = z.s === 1 && !z.x && !z.y ? '' : `translate(${z.x}px, ${z.y}px) scale(${z.s})`
    setZoomed(z.s > 1)
  }

  const zoomAboutMiddle = (s: number) => {
    const f = frame()
    if (!now.current.canZoom || !f) return
    const x = f.box.left + f.box.width / 2, y = f.box.top + f.box.height / 2
    show(zoomTo(zoom.current, s, x, y, x, y, f), true)
  }
  useImperativeHandle(handle, () => ({
    zoomBy: (k) => zoomAboutMiddle(zoom.current.s * k),
    toggle: () => zoomAboutMiddle(zoom.current.s > 1 ? 1 : ZOOM_TAP),
  }))

  // The press in progress: the pointers down (two at most), where they and
  // the picture were when the current pointer set formed, and what the press
  // has been so far. `axis` is fixed by the first move past SLOP, so an
  // unzoomed drag is a sideways swipe or a pull down, never both by turns.
  const press = useRef<{
    pts: Map<number, { x: number; y: number }>
    at: { x: number; y: number; d: number; z: Zoom; f: Frame | null }
    t0: number
    touch: boolean
    onPicture: boolean
    moved: boolean
    axis: 'x' | 'y'
    pinched: boolean
  } | null>(null)
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null)
  // A tap on the dark ground closes the viewer in the click that follows the
  // pointerup, never in the pointerup itself. On touch the browser sends that
  // click after the finger lifts and hit-tests it then: closing on pointerup
  // unmounted the viewer first, so the click landed on whatever was under the
  // finger — usually another tile, which reopened the viewer on it. A pull
  // down may close on pointerup: a drag that long is never followed by a click.
  const closeOnClick = useRef(false)

  const anchor = () => {
    const p = press.current
    if (!p) return
    const pts = Array.from(p.pts.values())
    const x = pts.reduce((a, q) => a + q.x, 0) / pts.length, y = pts.reduce((a, q) => a + q.y, 0) / pts.length
    const d = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0
    p.at = { x, y, d, z: zoom.current, f: frame() }
  }

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if ((e.target as HTMLElement).tagName === 'VIDEO') return
    if (!press.current) {
      closeOnClick.current = false
      press.current = {
        pts: new Map(), at: { x: 0, y: 0, d: 0, z: zoom.current, f: null },
        t0: Date.now(), touch: e.pointerType !== 'mouse', onPicture: e.target !== e.currentTarget, moved: false, axis: 'x', pinched: false,
      }
    }
    const p = press.current
    if (p.pts.size >= 2) return
    p.pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (p.pts.size === 2) p.pinched = true
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* already lifted */ }
    anchor()
  }

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = press.current
    if (!p || !p.pts.has(e.pointerId)) return
    p.pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const pts = Array.from(p.pts.values())
    const x = pts.reduce((a, q) => a + q.x, 0) / pts.length, y = pts.reduce((a, q) => a + q.y, 0) / pts.length
    const dx = x - p.at.x, dy = y - p.at.y
    const d = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0
    if (!p.moved) {
      if (Math.hypot(dx, dy) < SLOP && Math.abs(d - p.at.d) < SLOP) return
      p.moved = true
      p.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y'
      setDragging(true)
    }
    const { canZoom, canPrev: back, canNext: fwd } = now.current
    const f = p.at.f
    if (pts.length === 2) {
      if (canZoom && f && p.at.d) show(zoomTo(p.at.z, p.at.z.s * d / p.at.d, p.at.x, p.at.y, x, y, f))
    } else if (p.at.z.s > 1) {
      if (f) show(fit({ s: p.at.z.s, x: p.at.z.x + dx, y: p.at.z.y + dy }, f))
    } else if (p.touch && !p.pinched) {
      // The picture follows the finger: sideways it drags heavily where there
      // is nothing further to swipe to; downwards it is on its way out.
      if (p.axis === 'x') show({ s: 1, x: dx * ((dx > 0 ? back : fwd) ? 1 : 0.3), y: 0 })
      else show({ s: 1, x: 0, y: Math.max(0, dy) })
    }
  }

  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = press.current
    if (!p || !p.pts.delete(e.pointerId)) return
    if (p.pts.size) { anchor(); return } // one finger of a pinch lifted: pan on with the other
    press.current = null
    setDragging(false)
    const z = zoom.current
    const { canZoom, canPrev: back, canNext: fwd, onStep: step, onClose: close } = now.current
    if (e.type === 'pointercancel' || p.pinched) {
      // A pinch let go just above 1x would look like a mistake: settle at 1x.
      show(z.s < 1.1 ? NO_ZOOM : z, true)
      return
    }
    if (p.moved) {
      lastTap.current = null
      if (p.at.z.s > 1) return
      const dx = e.clientX - p.at.x, dy = e.clientY - p.at.y
      if (p.touch && p.axis === 'y' && dy > PULL_CLOSE) { close(); return }
      const width = p.at.f ? p.at.f.box.width : window.innerWidth
      const swipe = p.touch && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && (Date.now() - p.t0 < 700 || Math.abs(dx) > width / 3)
      if (swipe && (dx < 0 ? fwd : back)) step(dx < 0 ? 1 : -1)
      else show(NO_ZOOM, true)
      return
    }
    // A tap on the dark ground closes (in the click — see closeOnClick), or
    // zooms back out first.
    if (!p.onPicture) {
      lastTap.current = null
      if (z.s > 1) show(NO_ZOOM, true)
      else if (Date.now() >= armedAt) closeOnClick.current = true
      return
    }
    // On the picture, two taps (or clicks: the system's double-click time is
    // usually 500ms) close together toggle the zoom about that spot.
    const t = Date.now(), last = lastTap.current
    if (last && t - last.t < (p.touch ? 300 : 500) && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 30) {
      lastTap.current = null
      const f = frame()
      if (canZoom && f) show(z.s > 1 ? NO_ZOOM : zoomTo(z, ZOOM_TAP, e.clientX, e.clientY, e.clientX, e.clientY, f), true)
      return
    }
    lastTap.current = { t, x: e.clientX, y: e.clientY }
  }

  // Attached natively: React's wheel and touchmove listeners are passive, and
  // these must be able to say no to the browser.
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    // A trackpad's sideways swipe: one step per swipe, however long its
    // momentum keeps sending events.
    let swipe = { sum: 0, done: false, last: 0 }
    const onWheel = (e: WheelEvent) => {
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? box.clientHeight : 1
      const dx = e.deltaX * unit, dy = e.deltaY * unit
      const z = zoom.current
      const f = frame()
      if (e.ctrlKey) {
        // A trackpad pinch arrives as ctrl+wheel; left alone it zooms the page.
        if (!now.current.canZoom || !f) return
        e.preventDefault()
        show(zoomTo(z, z.s * Math.exp(-dy / 100), e.clientX, e.clientY, e.clientX, e.clientY, f))
      } else if (z.s > 1) {
        e.preventDefault()
        if (f) show(fit({ s: z.s, x: z.x - dx, y: z.y - dy }, f))
      } else if (Math.abs(dx) > Math.abs(dy)) {
        // Sideways on a trackpad is the browser's Back; here it turns the picture.
        e.preventDefault()
        if (e.timeStamp - swipe.last > 200) swipe = { sum: 0, done: false, last: 0 }
        swipe.last = e.timeStamp
        swipe.sum += dx
        const { canPrev: back, canNext: fwd, onStep: step } = now.current
        if (!swipe.done && Math.abs(swipe.sum) > 60 && (swipe.sum > 0 ? fwd : back)) { swipe.done = true; step(swipe.sum > 0 ? 1 : -1) }
      }
    }
    // For browsers that predate touch-action: no panning, no page zoom. A
    // video's own controls keep their touches.
    const onTouchMove = (e: TouchEvent) => { if ((e.target as HTMLElement).tagName !== 'VIDEO') e.preventDefault() }
    // A rotation or a resized window moves the box: keep the picture inside it.
    const onResize = () => { const f = frame(); if (f) show(fit(zoom.current, f)) }
    box.addEventListener('wheel', onWheel, { passive: false })
    box.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('resize', onResize)
    return () => {
      box.removeEventListener('wheel', onWheel)
      box.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  let body: React.ReactNode
  if (state === 'broken') {
    const noun = video ? 'video' : 'image'
    body = (
      <div className="zm-missing">
        <Ic name={video ? 'video' : 'image'} size={34} />
        <div>This {noun} can't be shown here.</div>
        <div className="zm-missing-sub">It may have been removed from the server, or this browser can't open its format.</div>
      </div>
    )
  } else if (video) {
    // Native controls for seeking and volume, minus the browser's own Download
    // item: every viewer's bar has the one Download it offers.
    body = (
      <video ref={setMedia} className="zm-video" src={src} controls autoPlay playsInline controlsList="nodownload"
        onPlay={pauseVoiceNotes} onError={() => setState('broken')} />
    )
  } else {
    body = (
      <>
        {state === 'loading' && <span className="spinner zm-spin" aria-hidden="true" />}
        <img ref={setMedia} className="zm-img" src={src} alt={alt} draggable={false}
          onLoad={() => setState('ready')} onError={() => setState('broken')} />
      </>
    )
  }
  return (
    <div ref={boxRef} className={'zm-box' + (zoomed ? ' zoomed' : '') + (dragging ? ' dragging' : '')}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onClick={(e) => {
        if (!closeOnClick.current || e.target !== e.currentTarget) return
        closeOnClick.current = false
        now.current.onClose()
      }}>
      {body}
    </div>
  )
})

export default ZoomMedia
