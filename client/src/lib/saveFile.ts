// Every Download button goes through here. In the phone app the file is
// downloaded by the app itself into Downloads/VoTask and opened in whatever
// reads that kind of file, as WhatsApp and Cliq do (FileDownloadPlugin.java);
// the WebView cannot save a file, and a download link there was handed to the
// browser. A file downloaded once opens straight from Downloads the next time.
// On the website it is the browser's own download, as before.
import { Capacitor, registerPlugin } from '@capacitor/core'
import { toast } from './toast'

interface FileDownloadPlugin {
  save(o: { url?: string; data?: string; name: string; mime?: string; open?: boolean; id?: string }): Promise<{ uri: string; opened: boolean; mime: string }>
  open(o: { uri: string; mime?: string }): Promise<{ opened: boolean; missing?: boolean }>
  share(o: { url?: string; name?: string; mime?: string; text?: string; title?: string }): Promise<{ shared: boolean }>
}
const FileDownload = registerPlugin<FileDownloadPlugin>('FileDownload')

export const nativeFiles = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('FileDownload')

const SAVED_KEY = 'savedFiles' // { [key]: { uri, mime } }
const busy = new Set<string>()

function saved(): Record<string, { uri: string; mime: string }> {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '{}') } catch { return {} }
}
function remember(key: string, v: { uri: string; mime: string }) {
  const all = saved()
  all[key] = v
  // Only the most recent couple of hundred: this is a shortcut, not a catalogue.
  const keys = Object.keys(all)
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete all[k]
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(all)) } catch {}
}

const toBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result).split(',')[1] || '')
  r.onerror = () => reject(r.error)
  r.readAsDataURL(blob)
})

function browserDownload(href: string, name: string) {
  const a = document.createElement('a'); a.href = href; a.download = name || 'file'
  document.body.appendChild(a); a.click(); a.remove()
}

/**
 * Downloads a file (from `url`, or a `blob` made in the page) and, in the app,
 * opens it. `key` names the file for "already downloaded" (a message or
 * attachment id); without one it is downloaded every time.
 */
export async function saveFile(o: { url?: string; blob?: Blob; name: string; mime?: string; key?: string }) {
  const name = o.name || 'file'
  if (!nativeFiles()) {
    if (o.blob) {
      const href = URL.createObjectURL(o.blob)
      browserDownload(href, name)
      setTimeout(() => URL.revokeObjectURL(href), 4000)
    } else if (o.url) browserDownload(o.url, name)
    return
  }
  const key = o.key || ''
  if (key) {
    if (busy.has(key)) return
    const was = saved()[key]
    if (was) {
      const r = await FileDownload.open({ uri: was.uri, mime: was.mime }).catch(() => ({ opened: false, missing: true }))
      if (r.opened) return
      if (!r.missing) { toast.info(`${name} is in Downloads/VoTask. No app on this phone opens this kind of file.`); return }
    }
    busy.add(key)
  }
  toast.info(`Downloading ${name}…`, 2500)
  try {
    const data = o.blob ? await toBase64(o.blob) : undefined
    // The native side fetches it, so it needs the whole address.
    const url = o.blob || !o.url ? undefined : new URL(o.url, location.href).href
    const r = await FileDownload.save({ url, data, name, mime: o.mime || o.blob?.type || undefined, open: true, id: key })
    if (key) remember(key, { uri: r.uri, mime: r.mime })
    if (!r.opened) toast.success(`Saved to Downloads/VoTask: ${name}`)
  } catch (e: any) {
    toast.error(`Couldn't download ${name}${e?.message ? `: ${e.message}` : ''}`)
  } finally {
    if (key) busy.delete(key)
  }
}

/**
 * For a link with a `download` attribute: in the app, does the download itself
 * instead of letting the WebView hand the link to the browser.
 */
export function onDownloadLink(url: string, name: string, key?: string) {
  return (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    if (!nativeFiles()) return
    e.preventDefault(); e.stopPropagation()
    saveFile({ url, name, key })
  }
}

/**
 * Share to another app, as WhatsApp's Share does: a file goes as the file
 * itself (with its caption), words as words. In the phone app this is
 * Android's share sheet (FileDownloadPlugin.share), since the WebView has no
 * navigator.share and Share used to fall back to copying a link. On the
 * website it is the browser's own share where it has one, a copied link or
 * text where it does not.
 */
export async function shareOut(o: { url?: string; name?: string; mime?: string; text?: string }) {
  const text = (o.text || '').trim()
  if (nativeFiles()) {
    if (o.url) toast.info(`Preparing ${o.name || 'the file'}…`, 2500)
    try {
      await FileDownload.share({ url: o.url ? new URL(o.url, location.href).href : undefined, name: o.name, mime: o.mime, text: text || undefined })
    } catch (e: any) {
      toast.error(`Couldn't share${e?.message ? `: ${e.message}` : ''}`)
    }
    return
  }
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
  if (o.url && nav.share && nav.canShare) {
    try {
      const blob = await (await fetch(o.url)).blob()
      const file = new File([blob], o.name || 'file', { type: o.mime || blob.type })
      const data: ShareData = { files: [file], ...(text ? { text } : {}) }
      if (nav.canShare(data)) { await nav.share(data); return }
    } catch (e: any) {
      if (e?.name === 'AbortError') return // the person closed the sheet
    }
  }
  // A file's link carries the person's sign-in token, so it is never shared
  // or copied as a link: a picture goes on the clipboard as a picture, any
  // other file is left to Download.
  if (o.url) {
    if ((o.mime || '').startsWith('image/') && await copyImage(o.url)) return
    toast.info('This browser cannot share files. Use Download instead.')
    return
  }
  if (!text) return
  if (nav.share) { try { await nav.share({ text }) } catch {} return }
  try { await navigator.clipboard.writeText(text); toast.success('Copied') } catch {}
}

// A picture as PNG: the one image type every browser's clipboard takes.
async function asPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  const bmp = await createImageBitmap(blob)
  const c = document.createElement('canvas')
  c.width = bmp.width; c.height = bmp.height
  c.getContext('2d')!.drawImage(bmp, 0, 0)
  bmp.close()
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png'))
}

/**
 * Copies the picture itself, as WhatsApp's Copy does, so it pastes into
 * another chat or document as an image. The blob goes to ClipboardItem as a
 * promise, made in the tap itself, because Safari refuses a clipboard write
 * that starts after an await. Says whether it worked; on false nothing was
 * copied (an old browser, or the phone app's web view).
 */
export async function copyImage(url: string): Promise<boolean> {
  const CI = (window as any).ClipboardItem
  if (!CI || !navigator.clipboard?.write) return false
  try {
    const png = fetch(url).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.blob() }).then(asPng)
    await navigator.clipboard.write([new CI({ 'image/png': png })])
    toast.success('Picture copied')
    return true
  } catch {
    return false
  }
}
