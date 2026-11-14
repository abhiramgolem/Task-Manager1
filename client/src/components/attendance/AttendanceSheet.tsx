import React, { useEffect, useRef, useState } from 'react'
import { Ic } from '../../ui'
import { useDialog } from '../../lib/useDialog'
import { pushBackHandler } from '../../back'
import { toast } from '../../lib/toast'
import { confirmDialog } from '../../lib/confirm'
import EmailCodeEntry from '../EmailCodeEntry'
import SelfieCamera from './SelfieCamera'
import LocationBlocked from './LocationBlocked'
import { appendCapture, captureLocation, punchDevice } from '../../lib/hrmsCapture'
import { duration, hm, punch, type PunchBlocked, type PunchKind, type TodayAttendance } from '../../lib/hrms'

const STATE_LABEL: Record<TodayAttendance['state'], string> = {
  NOT_CHECKED_IN: 'Not checked in',
  CHECKED_IN: 'Checked in',
  STALE_OPEN: 'Earlier check-out missing',
  CHECKOUT_PENDING: 'Check-out waiting for HR',
}

// The Check in / Check out sheet: a centred card on wide screens, a bottom sheet
// on phones. The state rules and wording follow the HRMS's own punch panel
// (attendance/components/punch-panel.tsx) so both apps behave the same. Times
// come from the HRMS; the device clock is never shown as a punch time.
//
// Order of a punch: selfie first (when the company requires one), then one
// location reading (when the office has a geofence), then the POST. Success is
// shown only once the HRMS has verified and recorded it.
export default function AttendanceSheet({ today, hrmsUrl, elapsed, needsVerification, onClose, onPunched }: {
  today: TodayAttendance | null
  hrmsUrl: string
  // Seconds since check-in, ticking (the topbar owns the clock).
  elapsed: number | null
  needsVerification: boolean
  onClose: () => void
  onPunched: () => void
}) {
  const ref = useDialog<HTMLDivElement>(onClose)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [cameraFor, setCameraFor] = useState<PunchKind | null>(null)
  const cameraRef = useRef(cameraFor)
  cameraRef.current = cameraFor
  // A second tap before React re-renders the disabled button is dropped here.
  const busy = useRef(false)
  // Android back: steps out of the camera first, then closes the sheet.
  useEffect(() => pushBackHandler(() => {
    if (cameraRef.current) { setCameraFor(null); busy.current = false } else closeRef.current()
    return true
  }), [])

  const [locating, setLocating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [blocked, setBlocked] = useState<PunchBlocked | null>(null)
  const [error, setError] = useState('')
  const [sentMsg, setSentMsg] = useState('')
  // The last selfie, kept for a location retry of the same punch: a refused
  // punch stores nothing, so the same photo is accepted again. Dropped on any
  // other answer, and when the HRMS kept it (for an off-site request).
  const lastSelfie = useRef<{ kind: PunchKind; photo: Blob } | null>(null)

  const t = today
  const checkedIn = t?.state === 'CHECKED_IN'
  const stale = t?.state === 'STALE_OPEN'
  const checkoutPending = t?.state === 'CHECKOUT_PENDING'
  const needsProfilePhoto = !!t && t.selfieRequired && !t.hasProfilePhoto
  // No new check-in while an off-site punch of today waits for HR; one check-in per day.
  const canCheckIn = !!t && t.firstCheckInAvailable && (stale || (!checkedIn && !checkoutPending && !t.waitingForHr))
  const canCheckOut = !!t && (checkedIn || (stale && t.canCheckOut))
  const doneForToday = !!t && t.checkedOutToday && !t.missingCheckOutToday && !t.firstCheckInAvailable && !t.waitingForHr && !checkedIn && !checkoutPending && !stale
  const missingToday = !!t && t.missingCheckOutToday && !t.firstCheckInAvailable && !t.waitingForHr && !checkedIn && !checkoutPending
  const staleEarlierDay = !!t && stale && t.openSessionDate !== t.today

  const send = async (kind: PunchKind, selfie: Blob | null) => {
    if (!t) return
    setError(''); setBlocked(null); setSentMsg('')
    const form = new FormData()
    form.set('kind', kind)
    // Phone or laptop: a hint only; the HRMS checks it against the request.
    const device = punchDevice()
    form.set('device', device)
    if (selfie) form.set('selfie', new File([selfie], 'selfie.jpg', { type: 'image/jpeg' }))
    try {
      if (t.location) {
        const limits = t.location
        setLocating(true)
        const target = device === 'COMPUTER' && limits.computerMaxAccuracyMeters !== null ? limits.computerMaxAccuracyMeters : limits.maxAccuracyMeters
        const outcome = await captureLocation({
          geolocation: 'geolocation' in navigator ? navigator.geolocation : undefined,
          secureContext: window.isSecureContext,
          maxAccuracyMeters: target,
        }).finally(() => setLocating(false))
        appendCapture(form, outcome)
      }
      setSaving(true)
      const r = await punch(form)
      if (r.ok) {
        lastSelfie.current = null
        toast.success(r.message || (kind === 'CHECK_IN' ? 'Checked in' : 'Checked out'))
        onPunched()
        onClose()
        return
      }
      if (!r.blocked || r.blocked.selfieSaved) lastSelfie.current = null
      if (r.blocked) setBlocked(r.blocked)
      else setError(r.error || 'The punch was not recorded.')
    } catch (e: any) {
      lastSelfie.current = null
      setError(e?.message || 'The punch was not recorded.')
    } finally {
      setSaving(false)
      busy.current = false
    }
  }

  const start = async (kind: PunchKind) => {
    if (!t || busy.current) return
    busy.current = true
    if (kind === 'CHECK_OUT' && stale) {
      const ok = await confirmDialog({
        title: 'Check out overnight?',
        message: `End the session that started ${t.openSince}? Use this only for an overnight shift.`,
        confirmText: 'Check out',
      })
      if (!ok) { busy.current = false; return }
    }
    // A required selfie is taken first; the camera's confirm then sends the punch.
    if (t.selfieRequired) { setCameraFor(kind); return }
    void send(kind, null)
  }

  const retry = (kind: PunchKind) => {
    if (!t || busy.current) return
    busy.current = true
    const kept = lastSelfie.current?.kind === kind ? lastSelfie.current.photo : null
    if (t.selfieRequired && !kept) { setCameraFor(kind); return }
    void send(kind, kept)
  }

  const onPhoto = (photo: Blob) => {
    const kind = cameraFor
    setCameraFor(null)
    if (!kind) { busy.current = false; return }
    lastSelfie.current = { kind, photo }
    void send(kind, photo)
  }

  const working = saving || locating || cameraFor !== null
  const label = (idle: string) => (locating ? 'Checking location…' : saving ? 'Saving…' : idle)
  const tone = checkedIn && !t?.checkInPending ? 'in' : (stale || checkoutPending || t?.checkInPending || t?.waitingForHr) ? 'warn' : 'out'

  return (
    <div className="att-overlay" onClick={(e) => { if (e.target === e.currentTarget && !working) onClose() }}>
      <div className="att-sheet" role="dialog" aria-modal="true" aria-labelledby="att-title" ref={ref}>
        <div className="att-head">
          <div>
            <div id="att-title" className="att-title">Attendance</div>
            {t && <div className="att-sub">Today, {t.today}</div>}
          </div>
          <button type="button" className="att-x" onClick={onClose} aria-label="Close"><Ic name="close" size={18} /></button>
        </div>

        {cameraFor ? (
          <SelfieCamera title={cameraFor === 'CHECK_IN' ? 'Check-in selfie' : 'Check-out selfie'}
            privacyUrl={`${hrmsUrl}/privacy/attendance-photos`}
            onCancel={() => { setCameraFor(null); busy.current = false }} onConfirm={onPhoto} />
        ) : needsVerification ? (
          <div className="att-body">
            <div className="att-banner warn">Verify your email to check in. Attendance is matched to your HRMS record by your email address, so it has to be confirmed first.</div>
            <EmailCodeEntry />
          </div>
        ) : !t ? (
          <div className="att-body"><p className="att-fine">Loading…</p></div>
        ) : (
          <div className="att-body">
            <div className="att-status">
              <span className={'att-status-ic ' + tone} aria-hidden="true"><Ic name={tone === 'warn' ? 'warning' : 'clock'} size={20} /></span>
              <div className="att-status-main">
                <div className="att-status-label" data-testid="attendance-status">{t.state === 'NOT_CHECKED_IN' && t.checkedOutToday ? (t.firstCheckInAvailable ? 'Checked out' : 'Checked out for today') : STATE_LABEL[t.state]}</div>
                {checkedIn && t.openSince && (
                  <div className="att-status-sub">Since {t.openSince.slice(11)}{elapsed !== null && <> · <strong className="att-clock">{hm(elapsed)}</strong></>}</div>
                )}
                {checkedIn && t.checkInPending && <div className="att-status-sub warn">Off-site check-in, waiting for HR approval</div>}
                {!checkedIn && t.workedSeconds > 0 && <div className="att-status-sub">Recorded today: {duration(t.workedSeconds)}</div>}
              </div>
            </div>

            <div className="att-actions main">
              {canCheckIn && (
                <button type="button" className="btn btn-primary" onClick={() => start('CHECK_IN')} disabled={working || needsProfilePhoto}>
                  <Ic name="check" size={15} /> {label(stale ? 'Check in for today' : 'Check in')}
                </button>
              )}
              {canCheckOut && (
                <button type="button" className={'btn' + (stale ? '' : ' btn-primary')} onClick={() => start('CHECK_OUT')} disabled={working}>
                  <Ic name="logout" size={15} /> {label(stale ? 'Check out (overnight)' : 'Check out')}
                </button>
              )}
            </div>
            <p role="status" aria-live="polite" className={locating ? 'att-fine' : 'sr-only'}>
              {locating ? 'Checking your location… If asked, allow location access for VoTask.' : ''}
            </p>

            {checkoutPending && <div className="att-banner info">Your off-site check-out is waiting for HR approval. It counts once HR approves it.</div>}
            {t.waitingForHr && !checkedIn && !checkoutPending && (
              <div className="att-banner info">Your off-site check-in for today is waiting for HR approval. You can check in again today only if HR rejects it.</div>
            )}
            {missingToday && (
              <div className="att-banner warn">
                Today&apos;s check-in has no check-out. Only one check-in is allowed per day:{' '}
                <a href={`${hrmsUrl}/attendance/corrections/new?date=${t.today}`} target="_blank" rel="noopener noreferrer">request a correction</a> to add your check-out.
              </div>
            )}
            {doneForToday && (
              <div className="att-banner info">You have checked out for today. Only one check-in is allowed per day; if your check-out was a mistake, request a correction in the HRMS.</div>
            )}
            {needsProfilePhoto && canCheckIn && (
              <div className="att-banner warn">
                Add your profile photo in HRMS first: your attendance selfies are compared with it.{' '}
                <a href={`${hrmsUrl}/account#profile-photo`} target="_blank" rel="noopener noreferrer">Add profile photo</a>
              </div>
            )}
            {staleEarlierDay && (
              <div className="att-banner warn">
                Your check-in from {t.openSince} has no check-out. If you forgot to check out, check in for today and{' '}
                <a href={`${hrmsUrl}/attendance/corrections/new?date=${t.openSessionDate}`} target="_blank" rel="noopener noreferrer">request a correction</a>.
              </div>
            )}
            {t.selfieRequired && !needsProfilePhoto && (
              <p className="att-fine">A selfie is taken at each check-in and check-out and matched to your HRMS profile photo. Only you and HR can see it.</p>
            )}

            {blocked && !working && (
              <LocationBlocked key={blocked.checkId} blocked={blocked} retryDisabled={working} onRetry={() => retry(blocked.kind)}
                onSent={(m) => { setBlocked(null); setSentMsg(m); onPunched() }} />
            )}
            {error && <div className="att-banner error" role="alert">{error}</div>}
            {sentMsg && <div className="att-banner ok" role="status">{sentMsg}</div>}
          </div>
        )}

        <a className="att-link" href={`${hrmsUrl}/api/votask/login/start?next=%2Fattendance`} target="_blank" rel="noopener noreferrer">
          Open attendance in HRMS <Ic name="external" size={13} />
        </a>
      </div>
    </div>
  )
}
