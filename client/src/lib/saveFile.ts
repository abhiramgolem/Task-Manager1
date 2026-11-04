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
