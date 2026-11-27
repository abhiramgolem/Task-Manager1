import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// `hint`: a second line under the label, for the state the row changes ("Muted until 5:00 PM").
export interface ActionItem { key: string; label: string; icon: React.ReactNode; hint?: string; on?: boolean; danger?: boolean; run: () => void }

// Space kept between the menu and the ⋯ it hangs from, and between the menu
// and the window's edges.
const GAP = 4
const EDGE = 8

// Every chat menu: a message's ⋯ on a mouse screen, the ⋮ of a selected
// message's action bar on a phone, the chat's own ⋮, and a chat's in the list
// (its ⋯, or holding the row on a phone). Grouped rows with icons, one look
// everywhere, where phones used to get a plain list of words.
//
// It lives in a portal, fixed to the window, not inside the thread or the
// list: both are scroll boxes and clip whatever pokes out of them. Hung under
// a message in the lower half of the thread — the newest ones, the ones
// people act on — the old menu opened under the composer, and on a laptop
// (1280×650 at 150%) only its first row showed; Delete could only be reached
// by scrolling the thread with the menu open. Fixed to the window, it opens
// below the ⋯ when it fits, above when it does not, and beside it when
// neither side has the room; it scrolls itself only on a window shorter than
// the whole menu.
//
// Focus moves into it on open, as a menu button's does: being in a portal,
// it is no longer next to the ⋯ in tab order, so Tab alone could not reach it.
// Arrows move through it, Escape and Tab close it and hand focus back.
export default function ActionMenu({ anchor, alignEnd, groups, label, onClose }: {
  anchor: HTMLElement | null
  // Line the menu's right edge up with the ⋯'s (your own messages, on the right
  // of the thread, and the list's rows); otherwise its left edge.
  alignEnd?: boolean
  groups: ActionItem[][]
  label: string
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight?: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !anchor) return
    const a = anchor.getBoundingClientRect()
    const vw = window.innerWidth, vh = window.innerHeight
    const w = el.offsetWidth, h = el.scrollHeight
    const below = vh - a.bottom - GAP - EDGE
    const above = a.top - GAP - EDGE
    const clampX = (x: number) => Math.min(Math.max(EDGE, x), vw - w - EDGE)
    const clampY = (y: number) => Math.min(Math.max(EDGE, y), vh - h - EDGE)
    // Under the ⋯, else over it.
    if (h <= below || h <= above) {
      setPos({ top: h <= below ? a.bottom + GAP : a.top - GAP - h, left: clampX(alignEnd ? a.right - w : a.left) })
      return
    }
    // Neither: a message mid-way down a short window (a 650px-high laptop
    // has ~350px each side, and a full menu is ~420px). Then beside the ⋯,
    // on the side away from the message, centred on it and kept on screen —
    // scrolling inside a menu would hide Delete again. Only a window shorter
    // than the menu itself gets that, at its full height.
    // Away side first; if the window ends there (someone else's message,
    // its ⋯ near the thread's right edge), the other side — over the hover
    // buttons and the message, which an open menu has no use for, rather than
    // over the ⋯ it belongs to.
    const away = alignEnd ? a.left - GAP - w : a.right + GAP
    const other = alignEnd ? a.right + GAP : a.left - GAP - w
    const inX = (x: number) => x >= EDGE && x <= vw - w - EDGE
    const side = inX(away) ? away : inX(other) ? other : away
    const fits = vh - 2 * EDGE
    if (h <= fits) setPos({ top: clampY(a.top + a.height / 2 - h / 2), left: clampX(side) })
    else setPos({ top: EDGE, left: clampX(side), maxHeight: fits })
  }, [anchor, alignEnd])

  // First item, once placed: before then it sits at 0,0 out of sight, and
  // focusing it there would scroll the page to it.
  const placed = !!pos
  useEffect(() => {
    if (placed) ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true })
  }, [placed])

  // The menu is pinned to where the ⋯ was. If what is under it moves — the
  // thread scrolls, a message arrives and pushes it up, the window is resized —
  // it would be pointing at some other message, so it closes, as a desktop
  // menu does. Its own scrolling (a very short window) is not that.
  // A press anywhere else closes it too, on the way down: the page's own
  // "a click closes menus" never hears a click on another ⋯ (that button stops
  // it, to open its own menu), so two menus could be open at once. A press on
  // this menu's ⋯ is left to that button, which closes it.
  useEffect(() => {
    const inside = (t: EventTarget | null) => t instanceof Node && (!!ref.current?.contains(t) || !!anchor?.contains(t))
    const onScroll = (e: Event) => { if (!(e.target instanceof Node && ref.current?.contains(e.target))) onClose() }
    const onPress = (e: PointerEvent) => { if (!inside(e.target)) onClose() }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onClose)
    window.addEventListener('pointerdown', onPress, true)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('pointerdown', onPress, true)
    }
  }, [onClose, anchor])

  const close = () => { onClose(); anchor?.focus({ preventScroll: true }) }
  const onKeyDown = (e: React.KeyboardEvent) => {
    // The menu has the keyboard while it is open: React passes a portal's
    // events up through the message or list row it was opened from, and the
    // page listens for Escape on the document. Neither should act on keys
    // meant for the menu.
    e.stopPropagation()
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const go = (i: number) => { e.preventDefault(); items[(i + items.length) % items.length]?.focus() }
    if (e.key === 'ArrowDown') go(at + 1)
    else if (e.key === 'ArrowUp') go(at < 0 ? items.length - 1 : at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(items.length - 1)
    // preventDefault tells the page's own Escape handler this one is taken.
    else if (e.key === 'Escape') { e.preventDefault(); close() }
    // Focus goes back to the ⋯ first, so Tab carries on from there.
    else if (e.key === 'Tab') close()
  }

  return createPortal(
    <div
      ref={ref}
      className="am-menu"
      role="menu"
      aria-label={label}
      style={pos ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight } : { top: 0, left: 0, visibility: 'hidden' }}
      // Keeps the page's "click anywhere closes menus" from closing it first.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {groups.map((g, gi) => (
        <React.Fragment key={gi}>
          {gi > 0 && <div className="am-sep" role="separator" />}
          {g.map((a) => (
            <button key={a.key} type="button" role="menuitem" tabIndex={-1}
              className={'am-item' + (a.danger ? ' danger' : '') + (a.on ? ' on' : '')}
              onClick={(e) => {
                // detail 0: pressed with Enter or Space, not clicked. The row
                // goes with the menu, so a keyboard user is handed back to the
                // ⋯ — unless the action took focus somewhere itself (Reply → the
                // composer, Forward → its dialog). A mouse user is not: focus
                // on the ⋯ would keep that message's hover buttons showing.
                const keyboard = e.detail === 0
                onClose(); a.run()
                if (keyboard) requestAnimationFrame(() => {
                  if ((!document.activeElement || document.activeElement === document.body) && anchor?.isConnected) anchor.focus({ preventScroll: true })
                })
              }}>
              <span className="am-ic">{a.icon}</span>
              <span className="am-label">{a.label}{a.hint && <span className="am-hint">{a.hint}</span>}</span>
            </button>
          ))}
        </React.Fragment>
      ))}
    </div>,
    document.body,
  )
}
