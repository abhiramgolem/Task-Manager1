import React from 'react'
import { Ic } from '../../ui'
import type { Msg } from './types'
import { fileUrl, isVideo } from './types'

// Photos and videos sent together, as WhatsApp shows them: one bubble, a 2x2
// grid, and "+N" on the fourth tile for the rest. Every tile is still its own
// message: a long-press selects that one photo, a swipe replies to it, its
// reactions and its ⋯ are its own, and a tap opens it in the viewer, which
// steps through every photo of the chat. Chats.tsx decides what makes an album
// (albumable): only photos without a caption, because a caption belongs to its
// one photo. A captioned photo stays a message of its own and splits the run.

export const ALBUM_MIN = 4
const SHOWN = 4

export default function AlbumGrid({ items, tileProps, tileClass, onOpen, extra }: {
  items: Msg[]
  // A tile's touch handlers (select, swipe to reply, pick), as a single
  // message's bubble gets them. `group` is the tile plus what hides behind its "+N".
  tileProps: (m: Msg, group: Msg[]) => React.HTMLAttributes<HTMLDivElement>
  tileClass: (m: Msg, group: Msg[]) => string
  onOpen: (m: Msg) => void
  // Drawn over a tile: its reactions, its tools on a mouse screen.
  extra?: (m: Msg) => React.ReactNode
}) {
  const shown = items.slice(0, SHOWN)
  const rest = items.slice(SHOWN)
  return (
    <div className="album-grid">
      {shown.map((m, i) => {
        const video = isVideo(m.file)
        const more = i === SHOWN - 1 ? rest.length : 0
        const group = more ? [m, ...rest] : [m]
        return (
          <div key={m.id} data-msg={m.id} className={'album-tile ' + tileClass(m, group)} {...tileProps(m, group)}>
            <button type="button" className="album-open" onClick={(e) => { e.stopPropagation(); onOpen(m) }}
              aria-label={`Open ${video ? 'video' : 'photo'} ${i + 1} of ${items.length}${more ? `, ${more} more after it` : ''}`}>
              {video
                // #t=0.1: at 0 many encoders give a black frame.
                ? <video className="album-media ready" src={fileUrl(m) + '#t=0.1'} preload="metadata" muted playsInline disablePictureInPicture disableRemotePlayback tabIndex={-1} />
                : <img className="album-media" src={fileUrl(m)} alt="" loading="lazy" draggable={false}
                    onLoad={(e) => e.currentTarget.classList.add('ready')} onError={(e) => e.currentTarget.classList.add('ready')} />}
              {video && !more && <span className="album-play" aria-hidden="true"><Ic name="play" size={18} /></span>}
              {more > 0 && <span className="album-more" aria-hidden="true">+{more}</span>}
            </button>
            {extra?.(m)}
          </div>
        )
      })}
      {/* The rest, behind "+N", stay in the page: a quote, a search or a
          notification that points at one of them lands on the album. */}
      {rest.map((m) => <span key={m.id} data-msg={m.id} className="album-hidden" aria-hidden="true" />)}
    </div>
  )
}
