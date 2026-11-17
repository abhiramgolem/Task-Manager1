import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Ic } from '../ui'
import { useDialog } from '../lib/useDialog'
import { pushBackHandler } from '../back'
import { saveFile, shareOut } from '../lib/saveFile'
import { holdPdf, pdfErrorText, pdfThumb, readyThumb, PdfDoc } from '../lib/pdf'
import { ChevronLeft, ShareGlyph } from './chat/glyphs'

// A PDF read inside the app, as WhatsApp opens a document: every page down a
// dark screen, pinch or the buttons to zoom, Download in the corner. Opened
// from a chat's message, the chat's Docs list and a task's attachments
// through openPdf(), and drawn by the one <PdfViewerHost/> in App.

export interface PdfOpen {
  id: string           // what the open file is cached under
  url: string          // the file to view
  downloadUrl: string  // the same file sent as a download
  saveKey?: string     // saveFile's key, so a file already saved opens again
  name: string
  subtitle?: string
  // The photo viewer's buttons, where the place it was opened from has them.
  onForward?: () => void
  onShowInChat?: () => void
  // A file still on this device (a PDF in the tray before Send): no Share or Download.
  local?: boolean
}

let current: PdfOpen | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())
export function openPdf(o: PdfOpen) { current = o; emit() }
function closePdf() { current = null; emit() }

export function PdfViewerHost() {
  const o = useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb) } }, () => current)
  return o ? <PdfViewer key={o.id} {...o} onClose={closePdf} /> : null
}

// ---- the thumbnail on a message ---------------------------------------------
// Larger files are not fetched just to be previewed: they show as before, and
// a tap still opens them.
const AUTO_MAX = 8 * 1024 * 1024
const THUMB_W = 270

export function PdfDocPreview({ fileKey, url, size, thumb, pages, onOpen, meta }: {
  fileKey: string
  url: string
  size?: number
  // The first page as the sender's device drew it, when it came with the
  // file: shown straight away, nothing else fetched. Without it (older
  // messages, a PDF the sender's phone could not open) it is drawn here.
  thumb?: string
  pages?: number | null
  onOpen: () => void
  // The row under the picture (icon, name, size); gets the page count once known.
  meta: (pages?: number) => React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [info, setInfo] = useState(() => readyThumb(fileKey))
  const [failed, setFailed] = useState(false)
  const [sentBroken, setSentBroken] = useState(false)
  const sent = !!thumb && !sentBroken
  const skip = size != null && size > AUTO_MAX
  useEffect(() => {
    if (sent || info || skip) return
    const el = ref.current
    if (!el) return
    let alive = true
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return
      io.disconnect()
      pdfThumb(fileKey, url, THUMB_W).then((i) => { if (alive) setInfo(i) }, () => { if (alive) setFailed(true) })
    }, { rootMargin: '300px 0px' })
    io.observe(el)
    return () => { alive = false; io.disconnect() }
  }, [fileKey, skip, sent])
  return (
    <div ref={ref} className="pdf-doc">
      {sent ? (
        <button type="button" className="pdf-thumb" onClick={(e) => { e.stopPropagation(); onOpen() }} aria-label="Open the PDF">
          <img src={thumb} alt="" draggable={false} loading="lazy" onError={() => setSentBroken(true)} />
        </button>
      ) : !skip && !failed && (
        <button type="button" className="pdf-thumb" onClick={(e) => { e.stopPropagation(); onOpen() }} aria-label="Open the PDF">
          {info ? <img src={info.src} alt="" draggable={false} /> : <span className="pdf-thumb-wait"><span className="spinner" /></span>}
        </button>
      )}
      {meta((sent ? pages : null) || info?.pages)}
    </div>
  )
}

// ---- the viewer ---------------------------------------------------------------
const MAX_ZOOM = 4
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(1, z))
// Pages are never drawn wider than this on a big screen, so a desktop reads
// them at a page's size rather than a poster's.
const MAX_FIT = 900

function PdfViewer({ id, url, downloadUrl, saveKey, name, subtitle, onForward, onShowInChat, local, onClose }: PdfOpen & { onClose: () => void }) {
  const ref = useDialog<HTMLDivElement>(onClose)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose })
  // Android's back button closes the viewer, not the chat under it.
  useEffect(() => pushBackHandler(() => { closeRef.current(); return true }), [])

  const [doc, setDoc] = useState<PdfDoc | null>(null)
  const [ratio, setRatio] = useState(1.414)
  const [err, setErr] = useState('')
  useEffect(() => {
    const h = holdPdf(id, url)
    let alive = true
    h.doc.then(async (d) => {
      const p = await d.getPage(1)
      const v = p.getViewport({ scale: 1 })
      if (alive) { setRatio(v.height / v.width); setDoc(d) }
    }).catch((e) => { if (alive) setErr(pdfErrorText(e)) })
    return () => { alive = false; h.release() }
  }, [id, url])

  const stage = useRef<HTMLDivElement>(null)
  const pagesEl = useRef<HTMLDivElement>(null)
  const [stageW, setStageW] = useState(0)
  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const ro = new ResizeObserver(() => setStageW(el.clientWidth))
    ro.observe(el)
    setStageW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const [zoom, setZoom] = useState(1)
  const fitW = Math.max(0, Math.min(stageW - 16, MAX_FIT))
  const pageW = Math.round(fitW * zoom)

  // Zooming keeps the point under the fingers (or the middle of the screen)
  // where it was: the scroll is moved by the same factor once laid out again.
  const anchor = useRef<{ x: number; y: number; fx: number; fy: number; r: number } | null>(null)
  const zoomTo = (next: number, fx?: number, fy?: number) => {
    const el = stage.current
    const z = clampZoom(next)
    if (!el || z === zoom) return
    const pg = pagesEl.current
    const x = fx ?? el.clientWidth / 2, y = fy ?? el.clientHeight / 2
    // The point in the pages' own coordinates (they are centred while narrower than the screen).
    anchor.current = { x: el.scrollLeft + x - (pg?.offsetLeft || 0), y: el.scrollTop + y - (pg?.offsetTop || 0), fx: x, fy: y, r: z / zoom }
    setZoom(z)
  }
  useLayoutEffect(() => {
    const el = stage.current, pg = pagesEl.current, a = anchor.current
    if (!el || !a) return
    anchor.current = null
    el.scrollLeft = a.x * a.r + (pg?.offsetLeft || 0) - a.fx
    el.scrollTop = a.y * a.r + (pg?.offsetTop || 0) - a.fy
  }, [zoom])

  // Pinch: the pages are scaled as one picture while the fingers move, then
  // drawn again sharp at the new size when they lift.
  const pinch = useRef<{ d0: number; z0: number; fx: number; fy: number; r: number } | null>(null)
  const dist = (t: React.TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
  const onTouchStart = (e: React.TouchEvent) => {
    const el = stage.current
    if (e.touches.length !== 2 || !el) return
    const box = el.getBoundingClientRect()
    pinch.current = {
      d0: dist(e.touches), z0: zoom, r: 1,
      fx: (e.touches[0].clientX + e.touches[1].clientX) / 2 - box.left,
      fy: (e.touches[0].clientY + e.touches[1].clientY) / 2 - box.top,
    }
    const pg = pagesEl.current
    if (pg) pg.style.transformOrigin = `${el.scrollLeft + pinch.current.fx - pg.offsetLeft}px ${el.scrollTop + pinch.current.fy - pg.offsetTop}px`
  }
  const onTouchMove = (e: React.TouchEvent) => {
    const p = pinch.current
    if (!p || e.touches.length !== 2) return
    p.r = clampZoom(p.z0 * dist(e.touches) / p.d0) / p.z0
    if (pagesEl.current) pagesEl.current.style.transform = `scale(${p.r})`
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    const p = pinch.current
    if (!p || e.touches.length >= 2) return
    pinch.current = null
    if (pagesEl.current) pagesEl.current.style.transform = ''
    if (Math.abs(p.r - 1) > 0.02) zoomTo(p.z0 * p.r, p.fx, p.fy)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomTo(zoom * 1.5) }
      else if (e.key === '-') { e.preventDefault(); zoomTo(zoom / 1.5) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  // "Page 3 of 12": the page across the upper third of the screen.
  const [onPage, setOnPage] = useState(1)
  const raf = useRef(0)
  const onScroll = () => {
    cancelAnimationFrame(raf.current)
    raf.current = requestAnimationFrame(() => {
      const el = stage.current, pg = pagesEl.current
      if (!el || !pg) return
      const line = el.scrollTop + el.clientHeight / 3
      const kids = pg.children
      let n = 1
      for (let i = 0; i < kids.length; i++) { if ((kids[i] as HTMLElement).offsetTop <= line) n = i + 1; else break }
      setOnPage(n)
    })
  }
  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const download = () => saveFile({ url: downloadUrl, name: name || 'file.pdf', mime: 'application/pdf', key: saveKey })
  const sub = [doc ? (doc.numPages > 1 ? `Page ${onPage} of ${doc.numPages}` : '1 page') : '', subtitle].filter(Boolean).join(' · ')

  return (
    <div className="mv-overlay pdfv" ref={ref} role="dialog" aria-modal="true" aria-label={`PDF: ${name}`}>
      <div className="mv-head">
        <button type="button" className="mv-btn" onClick={onClose} aria-label="Close"><ChevronLeft size={24} /></button>
        <div className="mv-who" aria-live="polite">
          <div className="mv-name">{name}</div>
          {sub && <div className="mv-when">{sub}</div>}
        </div>
        {doc && (
          <>
            <button type="button" className="mv-btn pdfv-zoom" onClick={() => zoomTo(zoom / 1.5)} disabled={zoom <= 1} aria-label="Zoom out" title="Zoom out (−)"><Ic name="zoomOut" size={19} /></button>
            <button type="button" className="mv-btn pdfv-zoom" onClick={() => zoomTo(zoom * 1.5)} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in" title="Zoom in (+)"><Ic name="zoomIn" size={19} /></button>
          </>
        )}
        {onShowInChat && <button type="button" className="mv-btn" onClick={() => { onClose(); onShowInChat() }} aria-label="Show in chat" title="Show in chat"><Ic name="chat" size={19} /></button>}
        {onForward && <button type="button" className="mv-btn" onClick={() => { onClose(); onForward() }} aria-label="Forward" title="Forward"><Ic name="forward" size={19} /></button>}
        {!local && <button type="button" className="mv-btn" onClick={() => shareOut({ url, name, mime: 'application/pdf' })} aria-label="Share to another app" title="Share"><ShareGlyph size={19} /></button>}
        {!local && <button type="button" className="mv-btn" onClick={download} aria-label="Download" title="Download"><Ic name="download" size={19} /></button>}
      </div>
      <div ref={stage} className="pdfv-stage" onScroll={onScroll}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}
        onDoubleClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); zoomTo(zoom > 1 ? 1 : 2, e.clientX - b.left, e.clientY - b.top) }}>
        {err ? (
          <div className="pdfv-msg">
            <p>{local ? err.replace(/ Download it to open it in another app\./, '') : err}</p>
            {!local && <button type="button" className="btn btn-primary" onClick={download}><Ic name="download" size={15} /> Download</button>}
          </div>
        ) : !doc || !pageW ? (
          <div className="pdfv-msg"><span className="spinner" /></div>
        ) : (
          <div ref={pagesEl} className="pdfv-pages" style={{ width: pageW }}>
            {Array.from({ length: doc.numPages }, (_, i) => (
              <PdfPage key={i} doc={doc} n={i + 1} width={pageW} ratio0={ratio} root={stage} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// One page. Drawn only while near the screen and cleared once far from it:
// a long PDF zoomed in would otherwise hold hundreds of MB of pictures and the
// phone would close the app.
const MAX_PX = 8_000_000

function PdfPage({ doc, n, width, ratio0, root }: { doc: PdfDoc; n: number; width: number; ratio0: number; root: React.RefObject<HTMLDivElement | null> }) {
  const box = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const [ratio, setRatio] = useState(ratio0)
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const io = new IntersectionObserver((es) => setNear(es[es.length - 1].isIntersecting), { root: root.current, rootMargin: '1200px 600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  useEffect(() => {
    const c = cv.current
    if (!c) return
    if (!near) { c.width = 0; c.height = 0; return }
    let alive = true
    let task: { cancel: () => void } | null = null
    // A short wait, so the steps of a zoom draw once, at the end.
    const t = setTimeout(async () => {
      try {
        const page = await doc.getPage(n)
        if (!alive) return
        const base = page.getViewport({ scale: 1 })
        setRatio(base.height / base.width)
        let scale = (width * Math.min(window.devicePixelRatio || 1, 3)) / base.width
        const area = base.width * base.height * scale * scale
        if (area > MAX_PX) scale *= Math.sqrt(MAX_PX / area)
        const vp = page.getViewport({ scale })
        // Drawn aside and then copied over, so the page does not blank
        // while it is drawn again at a new zoom.
        const off = document.createElement('canvas')
        off.width = Math.ceil(vp.width)
        off.height = Math.ceil(vp.height)
        const octx = off.getContext('2d')!
        octx.fillStyle = '#fff'
        octx.fillRect(0, 0, off.width, off.height)
        const r = page.render({ canvasContext: octx, canvas: off, viewport: vp })
        task = r
        await r.promise
        if (!alive) return
        c.width = off.width
        c.height = off.height
        c.getContext('2d')!.drawImage(off, 0, 0)
        off.width = off.height = 0
      } catch { /* cancelled by a newer draw, or the viewer closed */ }
    }, 120)
    return () => { alive = false; clearTimeout(t); task?.cancel() }
  }, [near, width, doc, n])
  return (
    <div ref={box} className="pdfv-page" style={{ height: Math.round(width * ratio) }}>
      <canvas ref={cv} aria-label={`Page ${n}`} />
    </div>
  )
}
