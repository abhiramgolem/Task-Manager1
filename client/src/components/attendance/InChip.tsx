import React from 'react'
import { useAttendanceBoard } from '../../lib/attendanceBoard'

// The tiny "In" chip beside a name: checked in today (green), or checked in
// off-site and waiting for HR (amber). Nothing at all for anyone who is out, so
// a workspace without the HRMS link looks exactly as before.
export default function InChip({ userId }: { userId?: string | null }) {
  const board = useAttendanceBoard()
  const e = userId ? board[userId] : undefined
  if (!e) return null
  const since = e.since ? new Date(e.since) : null
  const at = since && !isNaN(since.getTime()) ? ` since ${since.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''
  const label = e.state === 'PENDING' ? `Checked in off-site${at}, waiting for HR` : `Checked in${at}`
  return (
    <span className={'att-in' + (e.state === 'PENDING' ? ' pending' : '')} title={label} aria-label={label} role="img">
      <span className="att-in-dot" aria-hidden="true" />In
    </span>
  )
}
