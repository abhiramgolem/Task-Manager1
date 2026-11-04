import React from 'react'
import { Ic } from '../../ui'
import PhotoViewer, { ViewerItem } from '../PhotoViewer'
import type { Msg } from './types'
import { fileUrl, isVideo, whenLabel } from './types'

// WhatsApp's photo viewer: the picture full screen on black, who sent it and
// when along the top, the caption along the bottom, and a swipe (or the arrow
// keys) to the next one in the chat. Opening a picture used to throw it into a
// new browser tab — on the phone app, out of the app entirely. The viewer, and
// the zoom a photo of a whiteboard or a receipt needs, is PhotoViewer's; this
// is what a chat message adds to it.

export default function MediaViewer({ items, startId, senderName, meId, onClose, onForward, onShowInChat }: {
  items: Msg[]
  startId: string
  senderName: (uid: string) => string
  meId: string
  onClose: () => void
  onForward: (m: Msg) => void
  onShowInChat: (m: Msg) => void
}) {
  const byId = new Map(items.map((m) => [m.id, m]))
  const shown: ViewerItem[] = items.map((m) => ({
    id: m.id,
    src: fileUrl(m),
    video: isVideo(m.file),
    alt: m.body || m.file?.name || 'Photo',
    title: m.sender_id === meId ? 'You' : senderName(m.sender_id),
    subtitle: whenLabel(m.created_at),
    caption: m.body || undefined,
  }))

  const download = (m: Msg) => {
    const a = document.createElement('a'); a.href = fileUrl(m, true); a.download = m.file?.name || 'file'
    document.body.appendChild(a); a.click(); a.remove()
  }

  return (
    <PhotoViewer items={shown} startId={startId} onClose={onClose} actions={(it) => {
      const m = byId.get(it.id)
      if (!m) return null
      return (
        <>
          <button type="button" className="mv-btn" onClick={() => onShowInChat(m)} aria-label="Show in chat" title="Show in chat"><Ic name="chat" size={19} /></button>
          <button type="button" className="mv-btn" onClick={() => onForward(m)} aria-label="Forward" title="Forward"><Ic name="forward" size={19} /></button>
          <button type="button" className="mv-btn" onClick={() => download(m)} aria-label="Download" title="Download"><Ic name="download" size={19} /></button>
        </>
      )
    }} />
  )
}
