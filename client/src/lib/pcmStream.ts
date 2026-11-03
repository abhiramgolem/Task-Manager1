// Capture microphone audio and emit base64-encoded little-endian 16-bit PCM @ 16kHz
// frames — the format Sarvam's streaming WebSocket expects. MediaRecorder only
// produces webm/opus, so we tap the raw samples via the Web Audio API instead.
//
// Returns a stop() function that tears down the graph and mic.

export interface PcmStream {
  stop: () => void
  /** The microphone track, so a long recording can notice the mic going away. Absent if it never opened. */
  track?: MediaStreamTrack
}

// Float32 [-1,1] -> Int16 little-endian bytes -> base64 (browser-safe, no Buffer).
function float32ToBase64Pcm16(input: Float32Array): string {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  const bytes = new Uint8Array(out.buffer)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

// Linear-ish downsample from the AudioContext rate (usually 44.1/48kHz) to 16kHz.
function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  const target = 16000
  if (inputRate === target) return input
  const ratio = inputRate / target
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(Math.floor((i + 1) * ratio), input.length)
    let sum = 0, n = 0
    for (let j = start; j < end; j++) { sum += input[j]; n++ }
    out[i] = n ? sum / n : input[start] || 0
  }
  return out
}

// Stream an audio track that is already open — a call's own microphone — rather
// than opening the microphone a second time. A second getUserMedia during a
// call is a second capture with its own echo cancellation, and on some phones
// it steals the mic from the call outright. Stopping this leaves the track
// running: the call owns it.
export function startPcmFromTrack(track: MediaStreamTrack, onFrame: (base64: string) => void): PcmStream {
  const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext
  const ctx: AudioContext = new AudioCtx()
  // A context made without a recent tap (a call rejoined by itself after a
  // reload) can start suspended, and a suspended context streams nothing at
  // all — the transcript would just stay empty. So it is woken on the next
  // touch or key, whenever that comes.
  const wake = () => { ctx.resume?.().catch(() => {}) }
  const evs = ['pointerdown', 'keydown', 'touchstart'] as const
  wake()
  if (ctx.state === 'suspended') for (const e of evs) window.addEventListener(e, wake, { capture: true })
  const unwake = () => { for (const e of evs) window.removeEventListener(e, wake, { capture: true }) }
  ctx.onstatechange = () => { if (ctx.state !== 'suspended') unwake() }
  const source = ctx.createMediaStreamSource(new MediaStream([track]))
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  // Nothing may come out of the speakers: a zero-gain sink keeps the node
  // pulled (onaudioprocess needs a path to the destination) without playing
  // your own voice back to you.
  const sink = ctx.createGain()
  sink.gain.value = 0
  processor.onaudioprocess = (e) => onFrame(float32ToBase64Pcm16(downsampleTo16k(e.inputBuffer.getChannelData(0), ctx.sampleRate)))
  source.connect(processor)
  processor.connect(sink)
  sink.connect(ctx.destination)
  return {
    stop: () => {
      unwake()
      try { processor.disconnect() } catch {}
      try { source.disconnect() } catch {}
      try { sink.disconnect() } catch {}
      try { ctx.close() } catch {}
    },
  }
}

/** Silence in the same framing — lets a recogniser hear that the last sentence ended. */
export function silentFrame(ms = 250): string {
  return float32ToBase64Pcm16(new Float32Array(Math.round(16000 * ms / 1000)))
}

// Start streaming mic PCM to `onFrame` (called with each base64 chunk).
// `onError` fires if mic access fails. `onLevel` (optional) reports the RMS level
// (0..1) of each frame — the voice assistant runs its silence detection on the
// SAME samples it streams, so the meter and the endpointer can never disagree
// about what the mic heard.
export async function startPcmStream(
  onFrame: (base64: string) => void,
  onError: (message: string) => void,
  onLevel?: (rms: number) => void,
): Promise<PcmStream> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
  } catch {
    onError('Microphone permission denied. Allow mic access and try again.')
    return { stop: () => {} }
  }

  const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext
  const ctx: AudioContext = new AudioCtx()
  const source = ctx.createMediaStreamSource(stream)

  // ScriptProcessorNode is deprecated but universally supported and simplest for
  // pulling raw frames. 4096-sample buffer ≈ 85ms at 48kHz — low latency, low overhead.
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0)
    // Never output exact digital silence. Chromium moves a context whose output
    // is all zeros onto a stand-in, timer-driven sink after a few seconds, and
    // once the window is minimised (or the phone's screen is off) that timer is
    // throttled: the graph then runs slower than the microphone and about a
    // third of a long recording's audio was being dropped. A -120 dB offset is
    // inaudible and keeps the real device clock driving the capture.
    e.outputBuffer.getChannelData(0).fill(1e-6)
    if (onLevel) {
      let sum = 0
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
      onLevel(Math.sqrt(sum / input.length))
    }
    const down = downsampleTo16k(input, ctx.sampleRate)
    onFrame(float32ToBase64Pcm16(down))
  }
  source.connect(processor)
  processor.connect(ctx.destination) // required for onaudioprocess to fire in some browsers

  return {
    track: stream.getAudioTracks()[0],
    stop: () => {
      try { processor.disconnect() } catch {}
      try { source.disconnect() } catch {}
      try { ctx.close() } catch {}
      stream.getTracks().forEach((t) => t.stop())
    },
  }
}
