import React from 'react'

// Chat-only glyphs, drawn in the same line style as the shared set in ui.tsx
// (2px stroke, round caps) and kept here so that set stays the app's own.
type G = { size?: number }
const Svg = ({ size = 18, children, fill = 'none' }: G & { children: React.ReactNode; fill?: string }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill={fill} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)

export const CopyGlyph = ({ size = 19 }: G) => <Svg size={size}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></Svg>
export const PollGlyph = ({ size }: G) => <Svg size={size}><path d="M5 20V10" /><path d="M12 20V4" /><path d="M19 20v-7" /></Svg>
export const PinDropGlyph = ({ size }: G) => <Svg size={size}><path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z" /><circle cx="12" cy="10" r="2.5" /></Svg>
export const ContactGlyph = ({ size }: G) => <Svg size={size}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></Svg>
export const CameraGlyph = ({ size }: G) => <Svg size={size}><path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" /><circle cx="12" cy="13" r="4" /></Svg>
export const GalleryGlyph = ({ size }: G) => <Svg size={size}><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /></Svg>
export const DocGlyph = ({ size }: G) => <Svg size={size}><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></Svg>
export const TaskGlyph = ({ size }: G) => <Svg size={size}><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12 2.5 2.5 4.5-5" /></Svg>
export const ArchiveGlyph = ({ size }: G) => <Svg size={size}><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" /><path d="M10 12h4" /></Svg>
export const InfoGlyph = ({ size }: G) => <Svg size={size}><circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8h.01" /></Svg>
export const SelectGlyph = ({ size }: G) => <Svg size={size}><circle cx="12" cy="12" r="9" /><path d="m8.5 12 2.5 2.5 4.5-5" /></Svg>
export const ExportGlyph = ({ size }: G) => <Svg size={size}><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></Svg>
export const ShareGlyph = ({ size }: G) => <Svg size={size}><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4" /></Svg>
export const PencilGlyph = ({ size }: G) => <Svg size={size}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></Svg>
export const ChevronDown = ({ size = 22 }: G) => <Svg size={size}><path d="m6 9 6 6 6-6" /></Svg>
export const ChevronLeft = ({ size = 24 }: G) => <Svg size={size}><path d="m15 18-6-6 6-6" /></Svg>
export const ChevronRight = ({ size = 24 }: G) => <Svg size={size}><path d="m9 18 6-6-6-6" /></Svg>
export const DotsV = ({ size = 20 }: G) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="12" cy="19" r="1.9" /></svg>
)
// Call log arrows: ↗ went out, ↙ came in.
export const ArrowOut = ({ size = 15 }: G) => <Svg size={size}><path d="M7 17 17 7" /><path d="M8 7h9v9" /></Svg>
export const ArrowIn = ({ size = 15 }: G) => <Svg size={size}><path d="M17 7 7 17" /><path d="M16 17H7V8" /></Svg>
export const SparkGlyph = ({ size = 15 }: G) => <Svg size={size}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" /></Svg>

// WhatsApp's message status: a clock while sending, one tick sent, two grey
// ticks delivered, two blue ticks read. Drawn rather than typed (✓✓) so the
// pair sits tight and takes the read colour as one shape.
export function Ticks({ state, title }: { state: 'pending' | 'sent' | 'delivered' | 'read'; title?: string }) {
  const label = title || { pending: 'Sending', sent: 'Sent', delivered: 'Delivered', read: 'Read' }[state]
  if (state === 'pending') {
    return (
      <span className="ticks pending" title={label} aria-label={label} role="img">
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="8" cy="8" r="6" /><path d="M8 4.8V8l2 1.4" /></svg>
      </span>
    )
  }
  return (
    <span className={'ticks ' + state} title={label} aria-label={label} role="img">
      <svg viewBox="0 0 18 12" width={state === 'sent' ? 13 : 17} height="12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {state === 'sent'
          ? <path d="m1.5 6.5 3.2 3.2L11.5 2.5" />
          : <><path d="m1 6.5 3.2 3.2L10.8 2.5" /><path d="m7.2 9.7.1.1L14 2.5" /></>}
      </svg>
    </span>
  )
}
