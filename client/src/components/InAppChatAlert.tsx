import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../auth'
import { Ic } from '../ui'

// A new message while the app is open, in a chat you are not looking at.
//
// With VoTask in the foreground nothing announced a message at all: the phone's
// own notification is held back while the app is open (CallMessagingService),
// and only the Chats badge changed — easy to miss while working on a task. Cliq
// and WhatsApp both chime and show a banner. This does the same: a short tone
// and a card at the top for a few seconds; tapping it opens the message.
//
// The server decides who is alerted (routes/chat.js deliver → `alert`): muted
// chats and do-not-disturb stay silent, as they do for push. The open chat
// itself never alerts — you are reading it (lib/openChat.ts).

let openChatId: string | null = null
export const setOpenChat = (id: string | null) => { openChatId = id }

interface Alert { cid: string; mid: string; title: string; text: string }

let audio: AudioContext | null = null
function chime() {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext
    if (!Ctx) return
    audio = audio || new Ctx()
    if (audio.state === 'suspended') void audio.resume()
    const t = audio.currentTime
    // Two soft notes, a fourth apart — noticeable, not alarming.
    for (const [freq, at] of [[880, 0], [1175, 0.11]] as const) {
      const o = audio.createOscillator(), g = audio.createGain()
      o.type = 'sine'; o.frequency.value = freq
      g.gain.setValueAtTime(0.0001, t + at)
      g.gain.exponentialRampToValueAtTime(0.12, t + at + 0.015)
      g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.22)
      o.connect(g).connect(audio.destination)
      o.start(t + at); o.stop(t + at + 0.25)
    }
  } catch { /* sound is a nicety */ }
}

export default function InAppChatAlert() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [alert, setAlert] = useState<Alert | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastChime = useRef(0)

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent).detail
      if (!d?.alert || !d.message || !user || d.message.sender_id === user.id) return
      if (d.message.kind === 'system' || document.hidden) return
      if (d.conversationId === openChatId) return
      setAlert({ cid: d.conversationId, mid: d.message.id, title: d.title || 'New message', text: d.preview || '' })
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setAlert(null), 4500)
      // A burst (several lines in a row) chimes once, not once per line.
      if (Date.now() - lastChime.current > 3000) { lastChime.current = Date.now(); chime() }
    }
    window.addEventListener('votask-chat-message', on)
    return () => window.removeEventListener('votask-chat-message', on)
  }, [user?.id])

  if (!alert) return null
  const open = () => {
    setAlert(null)
    navigate(`/chats?c=${encodeURIComponent(alert.cid)}&msg=${encodeURIComponent(alert.mid)}`)
  }
  return (
    <div className="iac-wrap" role="status" aria-live="polite">
      <button type="button" className="iac-card" onClick={open}>
        <span className="iac-ic"><Ic name="chat" size={18} /></span>
        <span className="iac-main">
          <span className="iac-title">{alert.title}</span>
          <span className="iac-text">{alert.text}</span>
        </span>
      </button>
      <button type="button" className="iac-x" onClick={() => setAlert(null)} aria-label="Dismiss"><Ic name="close" size={14} /></button>
    </div>
  )
}
