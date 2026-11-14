// Who is checked in right now, for the small In chips next to people's names.
// One copy for the whole app, however many chips are on screen: the first
// subscriber starts a 60 s poll of /api/attendance/board, the last one stops it.
// Between polls, a punch anywhere in the org arrives as an `attendance` event on
// the chat socket CallCenter keeps open on every page, re-dispatched as the
// window event `votask-attendance` (no second socket).
import { useSyncExternalStore } from 'react'
import { api, getToken } from '../api'
import { getSession } from './hrms'

export interface BoardEntry { state: 'IN' | 'PENDING'; since: string | null }
export type Board = Record<string, BoardEntry>

const POLL_MS = 60_000
let board: Board = {}
let boardKey = ''        // whose login the board was loaded for
let loadedAt = 0
let users = 0
let timer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

function set(next: Board) {
  board = next && typeof next === 'object' ? next : {}
  boardKey = getToken() || ''
  listeners.forEach((l) => l())
}

async function load(force = false) {
  // Polls skip hidden tabs; the chips catch up when the tab is shown again.
  if (document.hidden && !force) return
  if (!getToken()) return
  try {
    const s = await getSession()
    if (!s.enabled) { if (Object.keys(board).length) set({}); return }
    loadedAt = Date.now()
    set(await api.get('/attendance/board'))
  } catch { /* keep the last board: chips are a hint, not worth an error */ }
}

const onEvent = (e: Event) => {
  const b = (e as CustomEvent).detail?.board
  if (b && typeof b === 'object') { loadedAt = Date.now(); set(b) }
}
const onVisible = () => { if (!document.hidden && Date.now() - loadedAt >= POLL_MS) load() }

function subscribe(l: () => void) {
  listeners.add(l)
  if (++users === 1) {
    // Another account's board must not show for a moment after switching.
    if (boardKey && boardKey !== (getToken() || '')) board = {}
    load(true)
    timer = setInterval(load, POLL_MS)
    window.addEventListener('votask-attendance', onEvent)
    document.addEventListener('visibilitychange', onVisible)
  }
  return () => {
    listeners.delete(l)
    if (--users === 0) {
      if (timer) clearInterval(timer)
      timer = null
      window.removeEventListener('votask-attendance', onEvent)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }
}

const snapshot = () => board

export function useAttendanceBoard(): Board {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** Ask for a fresh board now (after this user's own punch, say). */
export function refreshAttendanceBoard() { load(true) }
