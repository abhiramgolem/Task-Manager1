// Location and device helpers for an HRMS punch, ported from the Befach HRMS
// (src/features/attendance/geofence/capture.ts and the browser half of
// device.ts). The HRMS server reads exactly these form fields, so keep the
// logic in step with those files rather than "improving" it here.
//
// One-shot capture, called only after the employee presses Check in or Check
// out: no watchPosition, no background or continuous tracking. Nothing here is
// logged.

export type LocationError = 'PERMISSION_DENIED' | 'POSITION_UNAVAILABLE' | 'TIMEOUT' | 'UNSUPPORTED'

export type CaptureOutcome =
  | { kind: 'reading'; latitude: number; longitude: number; accuracy: number; capturedAt: number }
  | { kind: 'error'; error: LocationError }

export interface CaptureOptions {
  geolocation: Pick<Geolocation, 'getCurrentPosition'> | undefined
  // window.isSecureContext: browsers only expose location to HTTPS pages (and localhost).
  secureContext: boolean
  maxAccuracyMeters: number
  // Per attempt, measured by the browser after permission is granted.
  timeoutMs?: number
  // Hard stop per attempt, including time spent on an unanswered permission prompt.
  hardTimeoutMs?: number
  // Extra attempts when the reading is less accurate than the office policy accepts.
  retries?: number
}

export const CAPTURE_TIMEOUT_MS = 15_000
export const CAPTURE_HARD_TIMEOUT_MS = 45_000

const ERROR_CODES: Record<number, LocationError> = { 1: 'PERMISSION_DENIED', 2: 'POSITION_UNAVAILABLE', 3: 'TIMEOUT' }

function readOnce(geo: Pick<Geolocation, 'getCurrentPosition'>, timeoutMs: number, hardTimeoutMs: number): Promise<CaptureOutcome> {
  return new Promise((resolve) => {
    let done = false
    const finish = (o: CaptureOutcome) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(o)
    }
    const timer = setTimeout(() => finish({ kind: 'error', error: 'TIMEOUT' }), hardTimeoutMs)
    try {
      geo.getCurrentPosition(
        (p) => finish({
          kind: 'reading',
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
          accuracy: p.coords.accuracy,
          capturedAt: p.timestamp,
        }),
        (err) => finish({ kind: 'error', error: ERROR_CODES[err.code] ?? 'POSITION_UNAVAILABLE' }),
        // A fresh reading every time (maximumAge 0): a cached position could be from somewhere else.
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
      )
    } catch {
      finish({ kind: 'error', error: 'UNSUPPORTED' })
    }
  })
}

/**
 * Reads the position once; if it is less accurate than `maxAccuracyMeters`, tries `retries` more times
 * (default one) and keeps the most accurate reading. An error on a retry keeps the earlier reading.
 */
export async function captureLocation(opts: CaptureOptions): Promise<CaptureOutcome> {
  const geo = opts.geolocation
  if (!opts.secureContext || !geo || typeof geo.getCurrentPosition !== 'function') return { kind: 'error', error: 'UNSUPPORTED' }
  const timeoutMs = opts.timeoutMs ?? CAPTURE_TIMEOUT_MS
  const hardTimeoutMs = opts.hardTimeoutMs ?? CAPTURE_HARD_TIMEOUT_MS
  let best = await readOnce(geo, timeoutMs, hardTimeoutMs)
  for (let i = 0; i < (opts.retries ?? 1); i++) {
    if (best.kind !== 'reading' || best.accuracy <= opts.maxAccuracyMeters) break
    const next = await readOnce(geo, timeoutMs, hardTimeoutMs)
    if (next.kind === 'reading' && next.accuracy < best.accuracy) best = next
  }
  return best
}

// Form fields read by the HRMS server (its geofence/schemas.ts). Nothing else is sent.
export function appendCapture(form: FormData, outcome: CaptureOutcome): void {
  if (outcome.kind === 'error') {
    form.set('locationError', outcome.error)
    return
  }
  // Plain decimals (never exponent form). 7 decimal places is about 1 cm. An accuracy beyond the server's
  // 100 km bound is unusable anyway and is capped so the reading is still judged, not refused as malformed.
  form.set('latitude', outcome.latitude.toFixed(7))
  form.set('longitude', outcome.longitude.toFixed(7))
  form.set('accuracy', Math.min(Math.max(outcome.accuracy, 0), 100_000).toFixed(1))
  form.set('capturedAt', String(Math.round(outcome.capturedAt)))
}

// ---- device ------------------------------------------------------------------
// Phones and laptops can be held to different location rules by the HRMS
// (laptops have no GPS; their location is a Wi-Fi guess). Every signal here can
// be faked, so the HRMS treats it as a hint and re-checks it against the
// request headers; anything unclear is judged as a phone, the stricter rules.

export type PunchDevice = 'PHONE' | 'COMPUTER'

const MOBILE_UA = /Mobi|Android|iPhone|iPad|iPod|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile/i

export interface BrowserSignals {
  userAgent: string
  // navigator.userAgentData (Chromium only).
  uaMobile?: boolean
  uaPlatform?: string
  maxTouchPoints: number
  // matchMedia("(hover: none) and (pointer: coarse)"): the main input is a finger, as on phones and tablets.
  touchOnly: boolean
}

/** What this browser looks like. Sent with the punch as a hint, never trusted alone. */
export function deviceFromBrowser(s: BrowserSignals): PunchDevice {
  if (s.uaMobile === true) return 'PHONE'
  if (s.uaPlatform && /^(Android|iOS)$/i.test(s.uaPlatform)) return 'PHONE'
  if (MOBILE_UA.test(s.userAgent)) return 'PHONE'
  // A phone or tablet in "desktop site" mode reports a desktop browser; its touch-only screen gives it away.
  if (s.touchOnly) return 'PHONE'
  // iPadOS reports itself as a Mac.
  if (/Macintosh/.test(s.userAgent) && s.maxTouchPoints > 1) return 'PHONE'
  return 'COMPUTER'
}

export function readBrowserSignals(): BrowserSignals {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean; platform?: string } }
  let touchOnly = false
  try {
    touchOnly = window.matchMedia('(hover: none) and (pointer: coarse)').matches
  } catch {
    // Old browsers without matchMedia: judged by the other signals.
  }
  return {
    userAgent: nav.userAgent ?? '',
    uaMobile: nav.userAgentData?.mobile,
    uaPlatform: nav.userAgentData?.platform,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    touchOnly,
  }
}

// The Android app is always a phone, whatever its WebView's user agent says.
export function punchDevice(): PunchDevice {
  const cap = (window as any).Capacitor
  if (cap?.isNativePlatform?.()) return 'PHONE'
  return deviceFromBrowser(readBrowserSignals())
}
