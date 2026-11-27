// VoTask's notification sounds inside the app: the same files the phone's
// notifications play (android res/raw), so a mention sounds the same whether
// it arrives as a push or while VoTask is open.
//
//   votask_chime    tasks and everything else the bell announces
//   votask_mention  someone @mentioned you — its own sound, as in Cliq, so it
//                   can be told from the rest without looking: three rising
//                   tings, louder than the chime, and on a phone the same
//                   triple buzz as its notification (ChatNotifier.java)
export type NotifSound = 'votask_chime' | 'votask_mention'

// A mention is meant to be noticed; the chime stays in the background.
const GAIN: Record<NotifSound, number> = { votask_chime: 0.5, votask_mention: 0.85 }
const VIBRATE: Partial<Record<NotifSound, number[]>> = { votask_mention: [180, 90, 180, 90, 260] }

// Browsers start an AudioContext suspended until the page has been interacted
// with; it is resumed on play, so the first click anywhere unlocks it.
let ctx: AudioContext | null = null
const decoded = new Map<NotifSound, Promise<AudioBuffer>>()
const playedAt = new Map<NotifSound, number>()

/** Play a sound. `unlessPlayedWithinMs`: skip it if it just played (one event heard twice). */
export function playNotifSound(name: NotifSound, { unlessPlayedWithinMs = 0 } = {}) {
  if (unlessPlayedWithinMs && Date.now() - (playedAt.get(name) || 0) < unlessPlayedWithinMs) return
  playedAt.set(name, Date.now())
  // Phones only in effect; a browser without a motor ignores it.
  try { const v = VIBRATE[name]; if (v) navigator.vibrate?.(v) } catch {}
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext
    if (!Ctx) return
    const c: AudioContext = ctx || (ctx = new Ctx())
    if (c.state === 'suspended') void c.resume()
    let buf = decoded.get(name)
    if (!buf) {
      buf = fetch(`${import.meta.env.BASE_URL}sounds/${name}.wav`).then((r) => r.arrayBuffer()).then((b) => c.decodeAudioData(b))
      decoded.set(name, buf)
    }
    buf.then((b) => {
      const src = c.createBufferSource()
      const gain = c.createGain()
      src.buffer = b
      gain.gain.value = GAIN[name]
      src.connect(gain); gain.connect(c.destination)
      src.start()
    }).catch(() => { decoded.delete(name) })
  } catch { /* autoplay blocked or unsupported — sound is a nicety */ }
}
