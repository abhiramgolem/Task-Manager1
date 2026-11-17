// PDFs drawn inside the app with pdf.js, the way WhatsApp shows a document:
// the top of its first page on the message, and every page in a viewer, with
// nothing saved to the phone. Before this a PDF had to be downloaded and
// opened in another app just to see what it was.
//
// pdf.js and its worker are about 1.5 MB, so they are fetched the first time a
// PDF comes on screen, never with the app. The legacy build is the one that
// runs on the older Android WebViews still in the team's phones.
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'

export type PdfDoc = PDFDocumentProxy

export const isPdf = (f?: { name?: string; type?: string } | null) =>
  !!f && ((f.type || '').toLowerCase().split(';')[0].trim() === 'application/pdf' || /\.pdf$/i.test(f.name || ''))

let lib: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null
function pdfjs() {
  if (!lib) {
    const p = Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
    ]).then(([m, w]) => { m.GlobalWorkerOptions.workerSrc = w.default; return m })
    // Offline the first time: fetch it again next time rather than never.
    p.catch(() => { if (lib === p) lib = null })
    lib = p
  }
  return lib
}

// ---- open documents --------------------------------------------------------
// A few stay open so going back to one is instant. Each holds the whole file
// in memory, so the oldest is closed past that, unless something still has it.
const MAX_DOCS = 4
const docs = new Map<string, Promise<PdfDoc>>()
const holds = new Map<string, number>()

class NetError extends Error {}

function loadPdf(key: string, url: string): Promise<PdfDoc> {
  const had = docs.get(key)
  if (had) { docs.delete(key); docs.set(key, had); return had }
  const p = (async () => {
    // The whole file in one request: pdf.js's own loader asks for byte ranges,
    // which cost a CORS preflight per range from the phone app.
    let res: Response
    try { res = await fetch(url) } catch { throw new NetError('No connection. Try again when you are back online.') }
    if (res.status === 404) throw new Error('This file is no longer on the server.')
    if (!res.ok) throw new NetError(`Could not load the PDF (${res.status}).`)
    const data = new Uint8Array(await res.arrayBuffer())
    const { getDocument } = await pdfjs().catch(() => { throw new NetError('Could not load the PDF viewer. Check the connection.') })
    return getDocument({ data, isEvalSupported: false, enableXfa: false }).promise
  })()
  docs.set(key, p)
  p.catch(() => { if (docs.get(key) === p) docs.delete(key) })
  trim()
  return p
}

function trim() {
  for (const [k, p] of docs) {
    if (docs.size <= MAX_DOCS) return
    if (holds.has(k)) continue
    docs.delete(k)
    p.then((d) => d.destroy(), () => {})
  }
}

// Open a PDF and keep it open until release() (the viewer, a thumbnail
// being drawn), so it is not closed under whoever is using it.
export function holdPdf(key: string, url: string): { doc: Promise<PdfDoc>; release: () => void } {
  holds.set(key, (holds.get(key) || 0) + 1)
  let done = false
  const release = () => {
    if (done) return
    done = true
    const n = (holds.get(key) || 1) - 1
    if (n > 0) holds.set(key, n); else holds.delete(key)
    trim()
  }
  return { doc: loadPdf(key, url), release }
}

export function pdfErrorText(e: unknown): string {
  const name = (e as { name?: string } | null)?.name || ''
  if (name === 'PasswordException') return 'This PDF is locked with a password. Download it to open it in another app.'
  if (name === 'InvalidPDFException') return 'This file could not be read as a PDF. Download it to open it in another app.'
  return (e as Error)?.message || 'Could not open the PDF.'
}

// ---- first-page thumbnails --------------------------------------------------
// The top of page one, as wide as a message and this much as tall. Kept as a
// small JPEG, so a chat full of PDFs costs a few kB each once drawn.
export const THUMB_RATIO = 0.56
export interface PdfThumbInfo { src: string; pages: number }

const thumbs = new Map<string, Promise<PdfThumbInfo>>()
const ready = new Map<string, PdfThumbInfo>()

// Two files at a time: a chat scrolled past ten PDFs must not start ten
// downloads at once on a phone's data.
let running = 0
const queue: (() => void)[] = []
function slot(): Promise<() => void> {
  return new Promise((resolve) => {
    const go = () => { running++; resolve(() => { running--; queue.shift()?.() }) }
    if (running < 2) go(); else queue.push(go)
  })
}

export const readyThumb = (key: string) => ready.get(key) || null

// Page one's top, drawn to a canvas cssWidth wide at the screen's sharpness
// (at most 2x). Only the part that shows is drawn: the canvas clips the rest.
async function drawTop(doc: PdfDoc, cssWidth: number, scaleCap = 2): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(1)
  const base = page.getViewport({ scale: 1 })
  const vp = page.getViewport({ scale: (cssWidth * Math.min(window.devicePixelRatio || 1, scaleCap)) / base.width })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(vp.width)
  canvas.height = Math.ceil(Math.min(vp.height, vp.width * THUMB_RATIO))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise
  page.cleanup()
  return canvas
}

export function pdfThumb(key: string, url: string, cssWidth: number): Promise<PdfThumbInfo> {
  const had = thumbs.get(key)
  if (had) return had
  const t = (async () => {
    const free = await slot()
    const h = holdPdf(key, url)
    try {
      const doc = await h.doc
      const canvas = await drawTop(doc, cssWidth)
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85))
      canvas.width = canvas.height = 0
      if (!blob) throw new Error('Could not draw the page.')
      const info = { src: URL.createObjectURL(blob), pages: doc.numPages }
      ready.set(key, info)
      return info
    } finally {
      h.release()
      free()
    }
  })()
  thumbs.set(key, t)
  // A dropped connection is tried again when the message is next on screen;
  // a file that is not a readable PDF is not fetched over and over.
  t.catch((e) => { if (e instanceof NetError && thumbs.get(key) === t) thumbs.delete(key) })
  return t
}

// ---- the preview sent with a PDF ------------------------------------------
// Drawn on the sender's device from the file itself, the moment it is picked:
// it shows in the tray before Send and on the bubble while it uploads, and it
// goes up with the file (Chats sendWhole) so everyone else sees it at once,
// without fetching the PDF. Twice the message's width, so it is sharp on any
// phone. Null when it cannot be drawn (not a PDF, locked, too big to open on
// a phone): the message then goes as before.
export interface SentThumb { data: string; pages: number }
const SENDER_MAX = 40 * 1024 * 1024
const made = new WeakMap<Blob, Promise<SentThumb | null>>()

export function thumbForUpload(file: Blob & { name?: string }): Promise<SentThumb | null> {
  if (!isPdf({ name: file.name, type: file.type }) || file.size > SENDER_MAX) return Promise.resolve(null)
  const had = made.get(file)
  if (had) return had
  const p = (async () => {
    try {
      const { getDocument } = await pdfjs()
      const doc = await getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, enableXfa: false }).promise
      try {
        const canvas = await drawTop(doc, 540, 1)
        const data = canvas.toDataURL('image/jpeg', 0.8)
        canvas.width = canvas.height = 0
        return data.startsWith('data:image/jpeg;base64,') ? { data, pages: doc.numPages } : null
      } finally {
        doc.destroy()
      }
    } catch {
      return null
    }
  })()
  made.set(file, p)
  return p
}

// The same, but never holding a send up for long: past `ms` it goes without.
export function thumbWithin(file: Blob & { name?: string }, ms = 6000): Promise<SentThumb | null> {
  return Promise.race([thumbForUpload(file), new Promise<null>((r) => setTimeout(() => r(null), ms))])
}
