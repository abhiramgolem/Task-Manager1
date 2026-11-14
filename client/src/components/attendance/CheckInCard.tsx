import React from 'react'
import { useAttendance } from './AttendanceContext'

// "Check-in / Out" at the top of the phone drawer, as in Cliq: the status on the
// left, a switch on the right that is on while checked in. Tapping anywhere
// opens the sheet rather than flipping the switch straight away, because a punch
// may need a selfie or the location first — the switch only moves once the HRMS
// has recorded it, so it never shows something that did not happen.
export default function CheckInCard() {
  const { visible, status, openSheet } = useAttendance()
  if (!visible) return null
  const { tone, on, cardText, aria } = status
  return (
    <button type="button" className={`att-card ${tone}`} onClick={openSheet} aria-label={aria} data-testid="checkin-card">
      <span className="att-card-text">
        <span className="att-card-title">Check-in / Out</span>
        <span className="att-card-sub"><span className="att-card-dot" aria-hidden="true" />{cardText}</span>
      </span>
      <span className="att-card-sep" aria-hidden="true" />
      <span className={'att-switch' + (on ? ' on' : '')} aria-hidden="true"><span className="att-switch-knob" /></span>
    </button>
  )
}
