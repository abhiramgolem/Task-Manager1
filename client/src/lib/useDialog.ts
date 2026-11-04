import { useEffect, useRef } from 'react'
import { lockBodyScroll, unlockBodyScroll } from './scrollLock'

// Accessibility hook for modal dialogs. Attach the returned ref to the dialog
// container and it will:
//   • close on Escape,
//   • trap Tab focus inside the dialog (so keyboard users can't tab out to the
//     page behind it),
//   • move focus into the dialog on open, and
//   • restore focus to the previously-focused element on close.
// Pair with role="dialog" (or "alertdialog") + aria-modal="true" on the container.
// `enabled` turns the whole behaviour off while keeping the hook call in place
// (hooks can't be called conditionally). A panel docked beside the page is not a
// dialog: trapping Tab inside it and stealing focus on open would strand the
// keyboard away from the list it sits next to.
export function useDialog<T extends HTMLElement>(onClose: () => void, enabled = true) {
  const ref = useRef<T | null>(null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])

  // Same `enabled` gate as the focus trap: a docked pane is part of the page and
  // must leave the page scrolling normally.
  useEffect(() => {
    if (!enabled) return
    lockBodyScroll()
    return () => unlockBodyScroll()
  }, [enabled])

  useEffect(() => {
    if (!enabled) return
    const prevActive = document.activeElement as HTMLElement | null

    const selector = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'
    // Query the LIVE node each time — the dialog's content can swap (skeleton →
    // loaded), so a node captured at mount would go stale.
    const focusables = () => Array.from(ref.current?.querySelectorAll<HTMLElement>(selector) || [])
      .filter((el) => el.offsetParent !== null || el === document.activeElement)

    // Move focus into the dialog (first field, else the dialog itself).
    const first = focusables()[0]
    if (first) first.focus()
    else if (ref.current) { ref.current.setAttribute('tabindex', '-1'); ref.current.focus() }

    const onKey = (e: KeyboardEvent) => {
      // A dialog raised over this one owns the keyboard: a confirmation
      // (remove? delete?), a chat dialog opened from inside it (Mute, from the
      // chat info panel) or a photo viewer (a task's attachment, opened from
      // the task drawer). This listener runs first (capture), so without the
      // check Escape would close the dialog underneath and Tab would pull focus
      // back into it. Its own wrapping overlay is not "over" it, nor is
      // anything inside it.
      const self = ref.current
      const over = Array.from(document.querySelectorAll('.confirm-center, .modal-overlay, .mv-overlay, .ci-lb'))
        .some((el) => !el.contains(self) && !self?.contains(el))
      if (over) return
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (!items.length) return
      const firstEl = items[0], lastEl = items[items.length - 1]
      const active = document.activeElement as HTMLElement
      if (e.shiftKey && (active === firstEl || !ref.current?.contains(active))) { e.preventDefault(); lastEl.focus() }
      // Focus can fall to <body> when the button that had it goes away (a menu
      // item, a cancelled question's opener): Tab then starts inside again.
      else if (!e.shiftKey && (active === lastEl || active === document.body)) { e.preventDefault(); firstEl.focus() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      // Restore focus to whatever opened the dialog.
      if (prevActive && typeof prevActive.focus === 'function') prevActive.focus()
    }
  }, [enabled])

  return ref
}
