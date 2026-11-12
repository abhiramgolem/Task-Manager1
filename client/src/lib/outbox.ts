// Messages that have not reached the server yet, kept on the device.
//
// A chat message used to live only in the screen's memory between "Send" and
// the server's answer. If that answer never came — the train went into a
// tunnel, the server was restarting after a deploy, the app was swiped away —
// the text was put back in the box (often the wrong chat's box, if you had
// moved on), a voice note was simply thrown away, and a photo vanished with a
// toast. WhatsApp's rule is that a message you sent is never lost: it waits with
// a clock, then shows "not sent", and goes the moment the network is back.
//
// Each unsent message is written here (IndexedDB, so it survives the app being
// closed, and can hold the audio or photo itself) under its client_id — the id
// the phone gives a message before the server has seen it. Re-sending with the
// same client_id is safe: the server answers with the copy it already saved
// (routes/chat.js alreadySent), so a retry can never post a message twice.
//
// The same database also keeps a small read cache (the chat list, the newest
// page of each chat) so the Chats screen opens with something on it while the
// network is down, instead of "No conversations yet".

export interface OutItem {
  clientId: string
  userId: string           // whose phone it is on; another account never sees it
  convId: string
  kind: 'text' | 'file'
  body: string
  replyTo?: string | null
  reply?: any              // the quote shown on the bubble
  mentions?: string[]
  transcript?: string | null
  file?: Blob | null
  fileName?: string
  fileType?: string
  fileSize?: number
  createdAt: string
  // Set when the server refused it for good (not a network problem): it is not
  // retried by itself, and the bubble says why.
  error?: string | null
}

// Files bigger than this are not copied into the outbox: IndexedDB on a phone
// has limited room, and a big file has its own resumable chunked upload anyway.
export const OUTBOX_FILE_MAX = 25 * 1024 * 1024

const DB_NAME = 'votask-chat'
const OUT = 'outbox'
const CACHE = 'cache'

let dbP: Promise<IDBDatabase | null> | null = null
function open(): Promise<IDBDatabase | null> {
  if (dbP) return dbP
  dbP = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(OUT)) db.createObjectStore(OUT, { keyPath: 'clientId' })
        if (!db.objectStoreNames.contains(CACHE)) db.createObjectStore(CACHE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch { resolve(null) }
  })
  return dbP
}

// One request against one store; resolves with its result, or `fallback` when
// storage is unavailable (private mode, storage cleared) — the app then simply
// works without persistence, as before.
async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest, fallback: T): Promise<T> {
  const db = await open()
  if (!db) return fallback
  return new Promise<T>((resolve) => {
    try {
      const req = fn(db.transaction(store, mode).objectStore(store))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => resolve(fallback)
    } catch { resolve(fallback) }
  })
}

// In-memory copy, so a sync read (rendering a chat) never waits on IndexedDB.
const mem = new Map<string, OutItem>()
let loaded: Promise<void> | null = null

export function loadOutbox(): Promise<void> {
  if (!loaded) {
    loaded = run<OutItem[]>(OUT, 'readonly', (s) => s.getAll(), []).then((items) => {
      for (const it of items || []) if (it?.clientId) mem.set(it.clientId, it)
    })
  }
  return loaded
}

export const outboxItems = (userId: string) => [...mem.values()].filter((i) => i.userId === userId)
export const outboxFor = (userId: string, convId: string) => outboxItems(userId).filter((i) => i.convId === convId)
export const outboxGet = (clientId: string) => mem.get(clientId) || null

export function outboxPut(item: OutItem) {
  mem.set(item.clientId, item)
  void run(OUT, 'readwrite', (s) => s.put(item), null)
}
export function outboxRemove(clientId: string) {
  mem.delete(clientId)
  void run(OUT, 'readwrite', (s) => s.delete(clientId), null)
}

// A new client id: unique per message, and in the form the server accepts.
export const newClientId = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2, 12))

// ---- read cache ------------------------------------------------------------
export const cacheGet = <T = any>(key: string) => run<T | null>(CACHE, 'readonly', (s) => s.get(key), null)
export const cacheSet = (key: string, value: unknown) => { void run(CACHE, 'readwrite', (s) => s.put(value, key), null) }
