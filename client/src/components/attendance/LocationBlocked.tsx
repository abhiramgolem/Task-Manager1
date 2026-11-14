import React, { useState } from 'react'
import { Ic } from '../../ui'
import { describeMeasures, requestException, KIND_LABELS, REASON_TEXT, RESULT_LABELS, type PunchBlocked } from '../../lib/hrms'

// Shown after the HRMS refused a punch because the location was not verified.
// Nothing was recorded as attendance. The employee can try again, or send this
// exact attempt to HR for approval (wording from the HRMS's location-blocked.tsx).
export default function LocationBlocked({ blocked, onRetry, retryDisabled, onSent }: {
  blocked: PunchBlocked
  onRetry: () => void
  retryDisabled: boolean
  onSent: (message: string) => void
}) {
  const measures = describeMeasures(blocked)
  const kind = KIND_LABELS[blocked.kind] || 'Punch'
  const [asking, setAsking] = useState(false)
  // Kept across a refused send, so the typed reason is not lost.
  const [reason, setReason] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const send = async () => {
    const text = reason.trim()
    if (!text || sending) return
    setSending(true); setError('')
    try {
      const r = await requestException(blocked.checkId, text)
      if (r.ok) onSent(r.message || 'Sent to HR for approval.')
      else setError(r.error || 'Could not send the request.')
    } catch (e: any) {
      setError(e?.message || 'Could not send the request.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="att-blocked" data-testid="location-blocked">
      <div role="alert" className="att-blocked-head">
        <Ic name="warning" size={16} />
        <div>
          <strong>{kind} not recorded · {RESULT_LABELS[blocked.result] || blocked.result}</strong>
          <p>{REASON_TEXT[blocked.reason] || 'Your location could not be verified.'}</p>
          {measures && <p>Reading: {measures}.</p>}
        </div>
      </div>
      {!asking ? (
        <div className="att-actions">
          <button type="button" className="btn" onClick={onRetry} disabled={retryDisabled}><Ic name="refresh" size={15} /> Try again</button>
          <button type="button" className="btn btn-primary" onClick={() => setAsking(true)} disabled={retryDisabled}>Send to HR</button>
        </div>
      ) : (
        <div className="att-exc">
          <label htmlFor={`att-reason-${blocked.checkId}`}>Reason for HR (required)</label>
          <textarea id={`att-reason-${blocked.checkId}`} rows={2} maxLength={500} value={reason}
            onChange={(e) => setReason(e.target.value)} placeholder="For example: at the warehouse for a delivery" autoFocus />
          <p className="att-fine">
            Your {kind.toLowerCase()} is recorded at the time of this attempt, waiting for HR approval
            {blocked.kind === 'CHECK_IN' ? ' (you can check out later as usual)' : ''}. It counts once HR approves it.
            {blocked.selfieSaved ? ' Your selfie is kept with it for HR.' : ''}
          </p>
          {error && <div className="att-banner error">{error}</div>}
          <div className="att-actions">
            <button type="button" className="btn" onClick={() => setAsking(false)} disabled={sending}>Back</button>
            <button type="button" className="btn btn-primary" onClick={send} disabled={sending || !reason.trim()}>
              {sending ? 'Sending…' : 'Send to HR for approval'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
