import React from 'react'
import { Ic } from '../../ui'
import { useAttendance } from './AttendanceContext'

// The Check in / Check out pill in the top bar. Its state and the sheet it
// opens live in AttendanceProvider, shared with the phone drawer's card.
export default function CheckInButton() {
  const { visible, status, openSheet } = useAttendance()
  if (!visible) return null
  const { tone, pillText, pillShort, aria } = status
  return (
    <button type="button" className={`att-pill ${tone}`} onClick={openSheet} aria-label={aria} title={aria} data-testid="checkin-pill">
      <span className="att-pill-ic" aria-hidden="true">
        <Ic name="clock" size={15} />
        {tone !== 'out' && <span className="att-pill-dot" />}
      </span>
      <span className="att-pill-text wide">{pillText}</span>
      {/* Phones: the icon and its dot alone, plus the clock while checked in. */}
      {pillShort && <span className="att-pill-text narrow">{pillShort}</span>}
    </button>
  )
}
