import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../../auth'
import { clearHrmsSession, getSession, hm, HrmsError, reportChanged, today as fetchToday, type TodayAttendance } from '../../lib/hrms'
import { useAttendanceBoard, refreshAttendanceBoard } from '../../lib/attendanceBoard'
import AttendanceSheet from './AttendanceSheet'

type View =
  | { kind: 'hidden' }
  | { kind: 'verify'; hrmsUrl: string }
  | { kind: 'ready'; today: TodayAttendance; hrmsUrl: string; at: number }

export type AttendanceTone = 'out' | 'in' | 'warn' | 'done'

// Everything the two ways in (the top-bar pill and the phone drawer's card)
// need to draw themselves, worked out once here so they never disagree.
export interface AttendanceStatus {
  tone: AttendanceTone
  // The drawer card's switch: on while a session is open.
  on: boolean
  pillText: string
  // Phones: the pill shows the icon and, while checked in, the clock only.
  pillShort: string
  // The drawer card's line under "Check-in / Out".
  cardText: string
  aria: string
}

interface AttendanceCtx {
  visible: boolean
  status: AttendanceStatus
  openSheet: () => void
}

const OFF: AttendanceStatus = { tone: 'out', on: false, pillText: 'Check in', pillShort: '', cardText: 'Not checked in', aria: 'Check in' }
const Ctx = createContext<AttendanceCtx>({ visible: false, status: OFF, openSheet: () => {} })

export const useAttendance = () => useContext(Ctx)

const REFRESH_MS = 5 * 60_000

function describe(view: View, elapsed: number | null): AttendanceStatus {
  if (view.kind === 'verify') {
    return { ...OFF, cardText: 'Verify your email first', aria: 'Verify your email to check in' }
  }
  if (view.kind !== 'ready') return OFF
  const t = view.today
  const checkedIn = t.state === 'CHECKED_IN'
  const clock = checkedIn && elapsed !== null ? hm(elapsed) : ''
  if (checkedIn) {
    const waiting = t.checkInPending
    return {
      tone: waiting ? 'warn' : 'in',
      on: true,
      pillText: clock ? `${clock} · Check out` : 'Check out',
      pillShort: clock,
      cardText: waiting ? 'Checked in · waiting for HR' : clock ? `Checked in · ${clock}` : 'Checked in',
      aria: `Checked in${clock ? ` for ${clock}` : ''}${waiting ? ', waiting for HR' : ''}. Check out`,
    }
  }
  if (t.state === 'CHECKOUT_PENDING') {
    return { tone: 'warn', on: false, pillText: 'Pending', pillShort: '', cardText: 'Check-out waiting for HR', aria: 'Check-out waiting for HR approval' }
  }
  if (t.waitingForHr && t.state === 'NOT_CHECKED_IN') {
    return { tone: 'warn', on: false, pillText: 'Pending', pillShort: '', cardText: 'Check-in waiting for HR', aria: 'Check-in waiting for HR approval' }
  }
  if (t.state === 'STALE_OPEN') {
    return { tone: 'warn', on: false, pillText: 'Check in', pillShort: '', cardText: 'Earlier check-out missing', aria: 'Earlier check-out missing. Check in' }
  }
  if (t.checkedOutToday && !t.firstCheckInAvailable && t.state === 'NOT_CHECKED_IN') {
    return { tone: 'done', on: false, pillText: 'Checked out', pillShort: '', cardText: 'Checked out for today', aria: 'Checked out for today' }
  }
  return { ...OFF, cardText: t.checkedOutToday ? 'Checked out' : 'Not checked in' }
}

// Today's attendance from the HRMS, shared by the top-bar pill and the phone
// drawer's card, plus the one sheet both open. Nothing shows at all unless the
// server has the HRMS link configured AND the HRMS knows this person (403: no
// employee with this email; 404: integration off).
export function AttendanceProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const [view, setView] = useState<View>({ kind: 'hidden' })
  const [open, setOpen] = useState(false)
  const [, setTick] = useState(0)
  const loadedAt = useRef(0)
  const seq = useRef(0)

  const load = useCallback(async () => {
    const mine = ++seq.current
    loadedAt.current = Date.now()
    try {
      const s = await getSession()
      if (mine !== seq.current) return
      if (!s.enabled || !s.hrmsUrl) { setView({ kind: 'hidden' }); return }
      if (s.needsVerification) { setView({ kind: 'verify', hrmsUrl: s.hrmsUrl }); return }
      const d = await fetchToday()
      if (mine !== seq.current) return
      setView({ kind: 'ready', today: d.today, hrmsUrl: d.hrmsUrl || s.hrmsUrl, at: performance.now() })
    } catch (e) {
      if (mine !== seq.current) return
      // Not an HRMS employee, or the link is off: nothing at all. Anything else
      // (offline, HRMS restarting) keeps what was showing; a later refresh fixes it.
      if (e instanceof HrmsError && (e.status === 403 || e.status === 404)) setView({ kind: 'hidden' })
    }
  }, [])

  // A different account, a changed email, or an email just confirmed: whose
  // attendance this is may have changed, so start from a fresh token.
  useEffect(() => {
    if (!user) return
    clearHrmsSession()
    setView({ kind: 'hidden' })
    setOpen(false)
    load()
  }, [user?.id, user?.email, user?.email_verified, load])

  // Coming back to the tab, and every few minutes while it is visible: the day
  // may have rolled over, or a punch made on another device.
  useEffect(() => {
    const onVis = () => { if (!document.hidden && Date.now() - loadedAt.current > 60_000) load() }
    const t = setInterval(() => { if (!document.hidden) load() }, REFRESH_MS)
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [load])

  // This person's own entry on the shared board changed (a punch from their
  // phone while this laptop is open, say): reload. Only their own entry, so a
  // colleague's punch never makes every open tab call the HRMS.
  const board = useAttendanceBoard()
  const mineOnBoard = user ? board[user.id]?.state || 'OUT' : 'OUT'
  const prevMine = useRef(mineOnBoard)
  useEffect(() => {
    if (prevMine.current === mineOnBoard) return
    prevMine.current = mineOnBoard
    if (view.kind === 'ready') load()
  }, [mineOnBoard, view.kind, load])

  const t = view.kind === 'ready' ? view.today : null
  const checkedIn = t?.state === 'CHECKED_IN'
  // The clock counts from the HRMS's elapsed time plus time since it answered,
  // so a wrong device clock never shows. H:MM only, so a tick every 10 s is enough.
  useEffect(() => {
    if (!checkedIn) return
    const id = setInterval(() => setTick((n) => n + 1), 10_000)
    return () => clearInterval(id)
  }, [checkedIn])
  const elapsed = view.kind === 'ready' && t?.openElapsedSeconds != null
    ? t.openElapsedSeconds + (performance.now() - view.at) / 1000 : null

  const visible = view.kind !== 'hidden' && !!user
  const openSheet = useCallback(() => setOpen(true), [])
  const onPunched = () => { reportChanged(); load(); setTimeout(refreshAttendanceBoard, 1500) }

  return (
    <Ctx.Provider value={{ visible, status: describe(view, elapsed), openSheet }}>
      {children}
      {/* Portalled: the sticky top bar and the drawer are their own stacking
          contexts, so a sheet rendered inside either would sit under the bottom
          tab bar and the voice orb whatever its own z-index. */}
      {visible && open && createPortal(
        <AttendanceSheet
          today={t}
          hrmsUrl={view.hrmsUrl}
          elapsed={elapsed}
          needsVerification={view.kind === 'verify'}
          onClose={() => setOpen(false)}
          onPunched={onPunched}
        />,
        document.body,
      )}
    </Ctx.Provider>
  )
}
