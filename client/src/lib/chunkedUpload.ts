import { API_BASE, getToken } from '../api'

// A big file goes up in chunks, several at once, each retried on its own (the
// server half is "Chunked uploads" in server/src/fileStore.js). In one request,
// a phone link that drops for a moment at 80% lost all of it and the file went
// again from zero; and one stream over a lossy, high-latency path seldom fills
// the uplink it has. The upload ends with the route the file was meant for
// being called with the upload's id in place of the file.

// Below this a file goes the old way, as one multipart request: one round trip
// instead of three, and nothing to resume that is worth resuming.
export const CHUNKED_FROM = 8 * 1024 * 1024
// Four, not six: on HTTP/1.1 a browser opens at most six connections to a
// host, and the rest of the app has to keep talking while a video goes up.
const PARALLEL = 4
// No byte moved for this long means the connection is dead, not slow — a
// phone that changes towers keeps the socket open and silent. A chunk at a
// crawl still reports progress, so this never cuts a slow upload short.
const STALL_MS = 30_000
const MAX_TRIES = 8
// Offline, there is nothing to retry against; wait for the network instead,
// but not forever.
const OFFLINE_MAX_MS = 10 * 60_000

export type UploadKind = 'chat' | 'task'

class Fatal extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function untilOnline(): Promise<void> {
  if (navigator.onLine !== false) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(t); window.removeEventListener('online', done); resolve() }
    const t = setTimeout(() => { window.removeEventListener('online', done); reject(new Fatal('you are offline')) }, OFFLINE_MAX_MS)
    window.addEventListener('online', done)
  })
}

const authHeader = (): Record<string, string> => {
  const t = getToken()
  return t ? { authorization: `Bearer ${t}` } : {}
}

// One chunk, by XHR for its upload progress (fetch reports none). Rejects
// with Fatal for an answer a retry cannot change.
function putChunk(url: string, index: number, body: Blob, live: Set<XMLHttpRequest>, onLoaded: (bytes: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    live.add(xhr)
    let stall = 0
    const arm = () => { clearTimeout(stall); stall = window.setTimeout(() => xhr.abort(), STALL_MS) }
    const end = () => { clearTimeout(stall); live.delete(xhr) }
    xhr.open('PUT', url)
    for (const [k, v] of Object.entries(authHeader())) xhr.setRequestHeader(k, v)
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.setRequestHeader('x-chunk-index', String(index))
    xhr.upload.onprogress = (e) => { arm(); onLoaded(e.loaded) }
    xhr.onload = () => {
      end()
      if (xhr.status >= 200 && xhr.status < 300) return resolve()
      let msg = `Upload failed (${xhr.status})`
      try { msg = JSON.parse(xhr.responseText).error || msg } catch {}
      // A busy or restarting server is worth asking again; a refusal is not.
      if (xhr.status >= 500 || xhr.status === 408 || xhr.status === 429) reject(new Error(msg))
      else reject(new Fatal(msg))
    }
    xhr.onerror = () => { end(); reject(new Error('the connection was lost')) }
    xhr.onabort = () => { end(); reject(new Error('the connection stalled')) }
    arm()
    xhr.send(body)
  })
}

// Sends the file and returns the id to finish it with, or null if this server
// has no chunked route (an older one), in which case the caller sends it the
// old way. `onProgress` gets whole percents, each once.
export async function sendInChunks(file: File, kind: UploadKind, onProgress?: (pct: number) => void): Promise<string | null> {
  const res = await fetch(`${API_BASE}/api/uploads`, {
    method: 'POST', cache: 'no-store',
    headers: { 'content-type': 'application/json', ...authHeader() },
    body: JSON.stringify({ kind, size: file.size, name: file.name, type: file.type }),
  })
  if (res.status === 404) return null
  const up = await res.json().catch(() => null)
  if (!res.ok || !up?.id) throw new Error(up?.error || `Upload failed (${res.status})`)
  const { id, chunkSize, chunks } = up as { id: string; chunkSize: number; chunks: number }
  const url = `${API_BASE}/api/uploads/${encodeURIComponent(id)}`

  // Bytes of chunks already in, plus how far each one in flight has got.
  let banked = 0
  const moving = new Map<number, number>()
  let shown = -1
  const report = () => {
    if (!onProgress) return
    let n = banked
    for (const b of moving.values()) n += b
    const pct = Math.min(100, Math.floor((n / file.size) * 100))
    if (pct !== shown) { shown = pct; onProgress(pct) }
  }

  const live = new Set<XMLHttpRequest>()
  let next = 0
  let failed: Error | null = null
  const worker = async () => {
    while (!failed && next < chunks) {
      const i = next++
      const start = i * chunkSize
      const body = file.slice(start, Math.min(file.size, start + chunkSize))
      for (let attempt = 1; ; attempt++) {
        if (failed) return
        try {
          await putChunk(url, i, body, live, (b) => { moving.set(i, b); report() })
          moving.delete(i); banked += body.size; report()
          break
        } catch (e: any) {
          moving.delete(i); report()
          if (failed) return
          if (e instanceof Fatal || attempt >= MAX_TRIES) throw e
          // 1, 2, 4, 8, 15, 15… s, jittered so four workers that failed
          // together do not all come back in the same instant.
          await sleep(Math.min(15_000, 1000 * 2 ** (attempt - 1)) * (0.75 + Math.random() / 2))
          await untilOnline()
        }
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks) }, () => worker().catch((e) => { failed ||= e; throw e })))
  } catch (e: any) {
    for (const x of live) x.abort()
    // Give the server its disk reservation back now, not in an hour.
    fetch(url, { method: 'DELETE', headers: authHeader() }).catch(() => {})
    throw failed || e
  }
  return id
}
