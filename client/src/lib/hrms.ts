// Check in / Check out against the Befach HRMS. VoTask's server only signs a
// five-minute token naming the user (/api/attendance/session); every punch goes
// from this browser straight to the HRMS, because the HRMS judges a punch by
// the employee's own network and browser and keeps the selfie out of VoTask.
import { api, getToken } from '../api'

export interface HrmsSession {
  enabled: boolean
  hrmsUrl?: string
  token?: string
  expiresIn?: number
  // The user's email isn't verified: no token until it is (the HRMS trusts the email).
  needsVerification?: boolean
}

export type AttendanceState = 'NOT_CHECKED_IN' | 'CHECKED_IN' | 'STALE_OPEN' | 'CHECKOUT_PENDING'
export type PunchKind = 'CHECK_IN' | 'CHECK_OUT'

export interface TodayLocation {
  officeName: string
  maxAccuracyMeters: number
  computerMaxAccuracyMeters: number | null
  maxReadingAgeSeconds: number
}

export interface TodayAttendance {
  today: string
  timeZone: string
  state: AttendanceState
  openSince: string | null
  openSessionDate: string | null
  openElapsedSeconds: number | null
  canCheckOut: boolean
  checkInPending: boolean
  waitingForHr: boolean
  firstCheckInAvailable: boolean
  checkedOutToday: boolean
  missingCheckOutToday: boolean
  workedSeconds: number
  location: TodayLocation | null
  selfieRequired: boolean
  hasProfilePhoto: boolean
}

export interface PunchBlocked {
  checkId: string
  kind: PunchKind
  result: string
  reason: string
  distanceMeters: number | null
  accuracyMeters: number | null
  selfieSaved: boolean
}

export type PunchResult = { ok: true; message: string } | { ok: false; error: string; blocked?: PunchBlocked }

export class HrmsError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

// ---- the token ---------------------------------------------------------------
// Cached per VoTask login (switching accounts changes the token, and with it
// whose attendance this is), refreshed when under a minute is left.
let cached: { key: string; s: HrmsSession; until: number } | null = null
let inflight: Promise<HrmsSession> | null = null

export function clearHrmsSession() { cached = null; inflight = null }

export function getSession(force = false): Promise<HrmsSession> {
  const key = getToken() || ''
  if (!force && cached && cached.key === key && Date.now() < cached.until) return Promise.resolve(cached.s)
  if (inflight && !force) return inflight
  const p = api.get('/attendance/session').then((s: HrmsSession) => {
    // A token is used until a minute before it expires; "off" and "verify
    // first" are re-asked every few minutes, so turning the feature on, or
    // confirming the email, shows up without a reload.
    const life = s.token ? Math.max(0, (s.expiresIn ?? 300) - 60) * 1000 : 5 * 60_000
    if (getToken() === key) cached = { key, s, until: Date.now() + life }
    return s
  }).finally(() => { if (inflight === p) inflight = null })
  inflight = p
  return p
}

// ---- HRMS calls --------------------------------------------------------------
const OFFLINE = 'Could not reach the HRMS. Check your connection and try again.'

async function call(path: string, init: RequestInit = {}, timeoutMs = 20_000, retried = false): Promise<any> {
  const s = await getSession(retried)
  if (!s.enabled || !s.hrmsUrl) throw new HrmsError('Attendance is not set up.', 404)
  if (s.needsVerification || !s.token) throw new HrmsError('Verify your email to check in.', 412)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  let res: Response
  try {
    // No cookies: the token is the whole credential.
    res = await fetch(`${s.hrmsUrl}/api/votask${path}`, {
      ...init,
      headers: { authorization: `Bearer ${s.token}`, ...(init.headers as any) },
      credentials: 'omit',
      cache: 'no-store',
      signal: ctl.signal,
    })
  } catch (e: any) {
    throw new HrmsError(e?.name === 'AbortError' ? 'The HRMS is taking too long to answer. Try again.' : OFFLINE, 0)
  } finally {
    clearTimeout(timer)
  }
  // An expired or rotated token: get a fresh one and try once more. A FormData
  // body can be sent again as is.
  if (res.status === 401 && !retried) return call(path, init, timeoutMs, true)
  let data: any = null
  try { data = await res.json() } catch { /* not JSON */ }
  if (!res.ok) throw new HrmsError(data?.error || `HRMS error (${res.status})`, res.status)
  if (!data) throw new HrmsError(OFFLINE, res.status)
  return data
}

export async function today(): Promise<{ today: TodayAttendance; hrmsUrl: string }> {
  const d = await call('/today')
  if (!d.ok) throw new HrmsError(d.error || 'Could not load attendance.', 500)
  return { today: d.today, hrmsUrl: d.hrmsUrl }
}

// A selfie upload and a face match can take a while on a slow phone.
export async function punch(form: FormData): Promise<PunchResult> {
  return call('/punch', { method: 'POST', body: form }, 60_000)
}

export async function requestException(checkId: string, reason: string): Promise<PunchResult> {
  const form = new FormData()
  form.set('checkId', checkId)
  form.set('reason', reason)
  return call('/exception', { method: 'POST', body: form }, 30_000)
}

// Tell VoTask a punch happened, so everyone's In chips update now. Best effort.
export function reportChanged() {
  api.post('/attendance/changed').catch(() => {})
}

// ---- display helpers ---------------------------------------------------------
/** Seconds as H:MM, the topbar's clock. */
export function hm(total: number): string {
  const s = Math.max(0, Math.floor(total))
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
}

/** Seconds as "7h 42m". */
export function duration(total: number): string {
  const s = Math.max(0, Math.floor(total))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}

// Wording from the HRMS (geofence/labels.ts), so both apps say the same thing.
export const RESULT_LABELS: Record<string, string> = {
  VERIFIED: 'Location verified',
  UNCERTAIN: 'Location uncertain',
  OUTSIDE: 'Outside the office area',
  UNAVAILABLE: 'Location unavailable',
}

export const REASON_TEXT: Record<string, string> = {
  INSIDE: 'Your location was verified inside the office area.',
  OFFICE_NETWORK: 'You are connected to the office network.',
  NEAR_BOUNDARY: 'Your position is too close to the edge of the office area to decide. Move further inside and try again, or request an exception.',
  POOR_ACCURACY: 'Your location is not accurate enough. On a phone, turn on precise location and try again. Laptops cannot measure location precisely: connect to the office Wi-Fi or network, or use your phone. Otherwise request an exception.',
  OUTSIDE_RADIUS: 'Your location appears to be outside the office area. If you are working off-site (for example at the warehouse), send a request to HR below.',
  STALE_READING: 'The location reading was too old. Try again.',
  FUTURE_READING: 'The location reading had an invalid time. Check your device clock and try again.',
  PERMISSION_DENIED: 'Location permission is blocked. Allow location for VoTask in your browser or phone settings, then try again, or request an exception.',
  POSITION_UNAVAILABLE: 'Your device could not determine its location. Turn on location services and try again, or request an exception.',
  TIMEOUT: 'Finding your location took too long. Try again, or request an exception.',
  UNSUPPORTED: 'This browser cannot share its location (it needs a secure HTTPS page and location support). Use another browser, or request an exception.',
}

export const KIND_LABELS: Record<PunchKind, string> = { CHECK_IN: 'Check-in', CHECK_OUT: 'Check-out' }

// Coarse on purpose: tens of metres near the office, tenths of a kilometre further away.
export function formatDistance(meters: number): string {
  if (meters < 1000) return `about ${Math.max(10, Math.round(meters / 10) * 10)} m`
  return `about ${(meters / 1000).toFixed(1)} km`
}

export function describeMeasures(b: { distanceMeters: number | null; accuracyMeters: number | null }): string | null {
  if (b.distanceMeters === null || b.accuracyMeters === null) return null
  return `${formatDistance(b.distanceMeters)} from the office, accuracy ±${b.accuracyMeters} m`
}
