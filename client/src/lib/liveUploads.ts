// Files still going up, kept for the whole app rather than inside the open
// chat. A video can take minutes; someone who left the chat (or Chats
// altogether) while it went came back to a thread with no trace of it,
// thought it had been lost, and sent it again: the first copy was still
// uploading behind their back, so it arrived twice.
//
// Chats keeps the upload itself running as before. What lives here is what
// it needs to show it again when it is opened afresh: the "Sending… 40%"
// bubble of a file too big for the outbox, how far each file has got, its
// Cancel, and which files are in flight at all, so they are not started a
// second time on the way back in. Events reach whichever Chats is mounted
// now, not the one that started the upload.
import type { Msg } from '../components/chat/types'

export type UploadEvent =
  | { clientId: string; convId: string; type: 'progress'; pct: number }
  | { clientId: string; convId: string; type: 'saved'; msg: Msg }
  | { clientId: string; convId: string; type: 'failed'; reason: string | null }
  | { clientId: string; convId: string; type: 'gone' }

// Uploads under way, by client id.
export const sending = new Set<string>()
// Their Cancel.
export const aborts = new Map<string, () => void>()

const progress = new Map<string, number>()
const files = new Map<string, { convId: string; name: string; size: number }>()
// "Sending…" bubbles of files too big for the outbox (which keeps its own).
const bubbles = new Map<string, Msg>()
const subs = new Set<(e: UploadEvent) => void>()

export function onUpload(f: (e: UploadEvent) => void): () => void {
  subs.add(f)
  return () => { subs.delete(f) }
}

export function emitUpload(e: UploadEvent) {
  if (e.type === 'progress') progress.set(e.clientId, e.pct)
  else {
    progress.delete(e.clientId)
    bubbles.delete(e.clientId)
    if (e.type !== 'failed') files.delete(e.clientId)
  }
  subs.forEach((f) => { try { f(e) } catch { /* one listener must not stop the rest */ } })
}

// A file has started going up (or going up again).
export function startUpload(clientId: string, convId: string, file: { name: string; size: number }, bubble?: Msg) {
  files.set(clientId, { convId, name: file.name, size: file.size })
  if (bubble) bubbles.set(clientId, bubble)
}

export const progressOf = (clientId: string) => progress.get(clientId)

// The big files still going up in a chat, as "Sending…" bubbles.
export const liveBubbles = (convId: string): Msg[] =>
  [...bubbles.values()]
    .filter((m) => m.conversation_id === convId)
    .map((m) => ({ ...m, uploading: true, failed: false, progress: progress.get(m.client_id || '') }))

// The same file (name and size) already on its way to this chat: what to ask
// before it is sent a second time. `pct` is how far it has got, if known.
export function inFlight(convId: string, file: { name: string; size: number }): { pct?: number } | null {
  for (const [id, f] of files) {
    if (f.convId === convId && f.name === file.name && f.size === file.size && (sending.has(id) || bubbles.has(id))) return { pct: progress.get(id) }
  }
  return null
}

// What a chat's row in the list says while a file is on its way there.
export function sendingIn(convId: string): { name: string; pct?: number } | null {
  for (const [id, f] of files) {
    if (f.convId === convId && (sending.has(id) || bubbles.has(id))) return { name: f.name, pct: progress.get(id) }
  }
  return null
}
