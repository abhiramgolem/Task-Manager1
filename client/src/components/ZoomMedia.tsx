import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { Ic } from '../ui'

// The picture (or video) inside a full-screen viewer, and every gesture on it.
// Shared by the chat info panel's media viewer (ChatMedia's Lightbox) and
// PhotoViewer — the thread's photos, pictures waiting to be sent, a task's
// attachments — so a picture zooms the same way wherever it was opened. The
// frame around it (bar, arrows, caption) is the viewer's own.
//
// Swiping works as in WhatsApp: the pictures either side wait just off screen
// (`prev` / `next`) and slide in with the finger, and a swipe that counts
// carries on until the neighbour sits where this one was, and only then hands
// over (onStep). The viewer's next render shows that same picture in the same
// place, so the hand-over can't be seen. Before, only the picture on screen
// moved and the next one appeared from nowhere; a video took no swipe at all.

const ZOOM_MAX = 4
// A double-click or double-tap: near enough to read a whiteboard photo, with
// room left for a pinch to go further.
export const ZOOM_TAP = 2.5
// How far a press may wander and still be a tap.
const SLOP = 8
// How far an unzoomed drag goes before it is called sideways or downwards.
// Deciding at SLOP read a thumb's arc, which often sets off steeply, as a
// pull down: the viewer closed instead of turning the picture.
const AXIS_AT = 20
// How far down a finger must pull an unzoomed picture to close the viewer.
const PULL_CLOSE = 110
// The dark space between two pictures as they slide past each other.
const GAP = 24
// How long a turn takes to finish once the finger lets go (.zm-anim in the CSS).
const TURN_MS = 200
// A video's own control bar (play, seek, volume, full screen) along its
// bottom edge: a drag that starts there seeks, and is not a swipe.
const VIDEO_BAR = 64

// A neighbour waiting off screen to slide in.
export interface Peek { src: string; video?: boolean }

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
//   video: its taps and its control bar are its own; a finger swiping across
//     the picture turns it like a photo. A mouse leaves it alone (arrows/keys).
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
  // The items either side, shown sliding in during a swipe.
  prev?: Peek | null
  next?: Peek | null
}>(function ZoomMedia({ src, video = false, alt, canPrev, canNext, onStep, onClose, armedAt, onZoom, prev, next }, handle) {
  const [state, setState] = useState<'loading' | 'ready' | 'broken'>('loading')
  const [zoomed, setZoomed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const prevRef = useRef<HTMLDivElement>(null)
  const nextRef = useRef<HTMLDivElement>(null)
  // A turn is sliding to its end: presses wait for the next item.
  const turning = useRef(false)
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
    // The neighbours follow a sideways drag at 1x, and only that: a pan of a
    // zoomed picture or a pull down leaves them off screen.
    const dx = z.s === 1 && !z.y ? z.x : 0
    for (const [peek, side] of [[prevRef.current, -1], [nextRef.current, 1]] as const) {
      if (!peek) continue
      peek.classList.toggle('zm-anim', animate)
      peek.style.transform = dx ? `translateX(calc(${side * 100}% + ${side * GAP + dx}px))` : ''
    }
    setZoomed(z.s > 1)
    const el = media.current
    if (!el) return
    el.classList.toggle('zm-anim', animate)
    el.style.transform = z.s === 1 && !z.x && !z.y ? '' : `translate(${z.x}px, ${z.y}px) scale(${z.s})`
  }

  // A swipe that counts: slide on until the neighbour fills the box, then step.
  const turn = (dir: 1 | -1) => {
    turning.current = true
    const w = boxRef.current?.clientWidth || window.innerWidth
    show({ s: 1, x: -dir * (w + GAP), y: 0 }, true)
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    window.setTimeout(() => now.current.onStep(dir), reduced ? 0 : TURN_MS)
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
  // has been so far. `axis` is fixed once the drag reaches AXIS_AT, so an
  // unzoomed drag is a sideways swipe or a pull down, never both by turns.
  const press = useRef<{
    pts: Map<number, { x: number; y: number }>
    at: { x: number; y: number; d: number; z: Zoom; f: Frame | null }
    t0: number
    touch: boolean
    onPicture: boolean
    moved: boolean
    axis: 'x' | 'y' | null
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
    if (turning.current) return
    const onVideo = (e.target as HTMLElement).tagName === 'VIDEO'
    if (onVideo) {
      if (e.pointerType === 'mouse') return
      if (e.clientY > (e.target as HTMLElement).getBoundingClientRect().bottom - VIDEO_BAR) return
    }
    if (!press.current) {
      closeOnClick.current = false
      press.current = {
        pts: new Map(), at: { x: 0, y: 0, d: 0, z: zoom.current, f: null },
        t0: Date.now(), touch: e.pointerType !== 'mouse', onPicture: e.target !== e.currentTarget, moved: false, axis: null, pinched: false,
      }
    }
    const p = press.current
    if (p.pts.size >= 2) return
    p.pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (p.pts.size === 2) p.pinched = true
    // Not over a video: capturing would take the lift away from it, and with
    // it the tap that plays or pauses. A finger stays with the element it went
    // down on anyway, and its moves reach this box through it.
    if (!onVideo) try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* already lifted */ }
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
      setDragging(true)
    }
    const { canZoom, canPrev: back, canNext: fwd } = now.current
    const f = p.at.f
    if (pts.length === 2) {
      if (canZoom && f && p.at.d) show(zoomTo(p.at.z, p.at.z.s * d / p.at.d, p.at.x, p.at.y, x, y, f))
    } else if (p.at.z.s > 1) {
      if (f) show(fit({ s: p.at.z.s, x: p.at.z.x + dx, y: p.at.z.y + dy }, f))
    } else if (p.touch && !p.pinched) {
      // Sideways unless clearly downwards (see AXIS_AT); fixed from then on.
      if (!p.axis) {
        if (Math.hypot(dx, dy) < AXIS_AT) return
        p.axis = Math.abs(dy) > Math.abs(dx) * 1.5 ? 'y' : 'x'
      }
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
      // Once sideways, how far the finger rose or fell on the way no longer
      // matters (an arc ends well below where it began): a flick, or a slower
      // drag a quarter of the way across, turns.
      const width = p.at.f ? p.at.f.box.width : window.innerWidth
      const swipe = p.touch && p.axis === 'x' && Math.abs(dx) > 40 && (Date.now() - p.t0 < 700 || Math.abs(dx) > width / 4)
      if (swipe && (dx < 0 ? fwd : back)) turn(dx < 0 ? 1 : -1)
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
      {prev && <PeekLayer ref={prevRef} side="prev" peek={prev} />}
      {next && <PeekLayer ref={nextRef} side="next" peek={next} />}
    </div>
  )
})

// A neighbour, laid out exactly as it will be once it is the one on screen,
// one box-width (plus GAP) to the side. It also loads the neighbour ahead of
// time, so the picture is there when the turn hands over. A video shows a
// still (#t=0.1: at 0 many encoders give a black frame) and a play mark.
const PeekLayer = forwardRef<HTMLDivElement, { side: 'prev' | 'next'; peek: Peek }>(function PeekLayer({ side, peek }, ref) {
  return (
    <div ref={ref} className={'zm-peek ' + side} aria-hidden="true">
      {peek.video ? (
        <>
          <video className="zm-video" src={peek.src + '#t=0.1'} preload="metadata" muted playsInline disablePictureInPicture disableRemotePlayback />
          <span className="zm-peek-play"><Ic name="play" size={28} /></span>
        </>
      ) : <img className="zm-img" src={peek.src} alt="" draggable={false} decoding="async" />}
    </div>
  )
})

export default ZoomMedia
