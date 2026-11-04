// Files and text shared to VoTask from another app's share sheet (Android):
// a document from WhatsApp, photos from the gallery, a reel's link from
// Instagram. The app's ShareTarget plugin (ShareTargetPlugin.java) copies each
// file into the app's cache; here they are read back as File objects and held
// until Chats takes them, asks which chat they go to, and stages them in that
// chat's composer.
//
// A no-op on the website and on an older app build without the plugin.
import { Capacitor, registerPlugin } from '@capacitor/core'

export interface Shared { files: File[]; text: string; skipped: number }

interface NativeFile { path: string; name: string; type: string; size: number }
interface NativeShare { files?: NativeFile[]; text?: string; subject?: string; skipped?: number }
interface ShareTargetPlugin {
  getPending(): Promise<NativeShare>
  addListener(ev: 'shareReceived', cb: (s: NativeShare) => void): Promise<{ remove: () => Promise<void> }>
}

const ShareTarget = registerPlugin<ShareTargetPlugin>('ShareTarget')

export const shareTargetAvailable = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('ShareTarget')

let started = false
let pending: Shared | null = null
const subs = new Set<() => void>()

async function receive(s: NativeShare) {
  const files: File[] = []
  let skipped = s.skipped || 0
  for (const f of s.files || []) {
    try {
      const res = await fetch(Capacitor.convertFileSrc(f.path))
      if (!res.ok) throw new Error(String(res.status))
      const blob = await res.blob()
      files.push(new File([blob], f.name, { type: f.type || blob.type }))
    } catch { skipped++ }
  }
  const text = (s.text || '').trim()
  const subject = (s.subject || '').trim()
  let body: string
  if (files.length) {
    // Files come with words the sending app wrote for its own share sheet:
    // WhatsApp's "Document from Sai" and the file's name again. Other apps
    // drop those and send just the file; only a real caption is kept.
    const names = new Set(files.flatMap((f) => [f.name, f.name.replace(/\.[^.]+$/, '')].map((n) => n.trim().toLowerCase())))
    body = text.split(/\r?\n/).map((l) => l.trim())
      .filter((l) => l && !names.has(l.toLowerCase()) && !/^(documents?|photos?|images?|videos?|audios?|files?|pdfs?|stickers?|gifs?) from \S/i.test(l))
      .join('\n')
  } else {
    // A link shared from a browser or YouTube often comes with its page title
    // as the subject; it leads, unless the text already says it.
    body = subject && !text.includes(subject) ? (text ? `${subject}\n${text}` : subject) : text
  }
  if (!files.length && !body && !skipped) return
  pending = { files, text: body, skipped }
  subs.forEach((cb) => cb())
}

/** Starts listening for shares. Once, at app start. */
export function startShareTarget() {
  if (started || !shareTargetAvailable()) return
  started = true
  ShareTarget.addListener('shareReceived', (s) => { receive(s) }).catch(() => {})
  ShareTarget.getPending().then((s) => { if (s?.files?.length || s?.text || s?.skipped) receive(s) }).catch(() => {})
}

export const hasShare = () => pending !== null

/** The share waiting for a chat, taken so it is handled once. */
export function takeShare(): Shared | null {
  const s = pending
  pending = null
  return s
}

/** A share arrived (it is waiting in takeShare). */
export function onShare(cb: () => void): () => void {
  subs.add(cb)
  return () => { subs.delete(cb) }
}
