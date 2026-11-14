import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Ic } from '../../ui'

// The attendance camera, ported from the Befach HRMS (selfie/selfie-camera.tsx):
// a live selfie, taken here and now. There is deliberately no "choose from
// gallery", because a saved photo proves nothing about who is punching today.
// Rendered inside the attendance sheet in place of its body, not as a second
// dialog stacked on top of it.
//
// The photo is scaled to at most 640 px and encoded as JPEG (~30-60 KB): enough
// to recognise a face, small enough to store one per punch. The canvas re-encode
// also drops any metadata (no EXIF, no location). The HRMS re-checks size,
// format and dimensions and refuses a photo it has seen before.

type Phase = 'starting' | 'live' | 'preview' | 'failed'
interface Problem { title: string; hint: string; retry: boolean }

const MAX_SIDE = 640
const QUALITY = 0.8

// Average brightness and contrast of the frame at 32x32. A covered lens, or a
// frame grabbed before the sensor woke up, is near-black and flat: refused.
// Merely dim is allowed with a warning, because blocking check-in at a dim
// entrance would be worse than a dark photo.
function lightOf(src: HTMLCanvasElement): 'ok' | 'dark' | 'blank' {
  const small = document.createElement('canvas')
  small.width = 32
  small.height = 32
  const ctx = small.getContext('2d', { willReadFrequently: true })
  if (!ctx) return 'ok'
  ctx.drawImage(src, 0, 0, 32, 32)
  const d = ctx.getImageData(0, 0, 32, 32).data
  let sum = 0
  let sq = 0
  const n = d.length / 4
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    sum += y
    sq += y * y
  }
  const mean = sum / n
  const sd = Math.sqrt(Math.max(0, sq / n - mean * mean))
  if (mean < 12 || sd < 4) return 'blank'
  return mean < 40 ? 'dark' : 'ok'
}

function problemFor(error: unknown): Problem {
  const name = error instanceof Error || error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return { title: 'Camera permission is off', hint: 'Allow camera access for VoTask in your browser or phone settings, then try again.', retry: true }
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return { title: 'No camera found', hint: 'A selfie is needed. Connect or enable a camera, or use your phone.', retry: true }
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return { title: 'The camera is busy', hint: 'Another app may be using it, such as a video call. Close it and try again.', retry: true }
  }
  return { title: 'The camera could not start', hint: 'Try again, or reload the page.', retry: true }
}

export default function SelfieCamera({ title, onCancel, onConfirm, privacyUrl }: {
  title: string
  onCancel: () => void
  onConfirm: (photo: Blob) => void
  privacyUrl?: string
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  // Bumped by every start and by unmount: a camera request that resolves after a
  // newer one began stops its own stream, or the camera light would stay on with
  // nobody watching.
  const generation = useRef(0)
  const [phase, setPhase] = useState<Phase>('starting')
  const [problem, setProblem] = useState<Problem | null>(null)
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null)
  const [light, setLight] = useState<'ok' | 'dark' | 'blank' | null>(null)

  const stop = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  const start = useCallback(async () => {
    const gen = ++generation.current
    stop()
    setProblem(null)
    setPhase('starting')
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setProblem(window.isSecureContext
        ? { title: 'This browser cannot use the camera', hint: 'Use an up-to-date Chrome, Edge or Safari, or the VoTask app.', retry: false }
        : { title: 'The camera needs a secure page', hint: 'Open VoTask from its https:// address and try again.', retry: false })
      setPhase('failed')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      })
      const video = videoRef.current
      if (gen !== generation.current || !video) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      video.srcObject = stream
      await video.play().catch(() => {})
      // Some phones hand over a few empty frames while the sensor settles.
      const t0 = Date.now()
      while (!(video.videoWidth > 0 && video.readyState >= 2) && Date.now() - t0 < 5000) {
        await new Promise((r) => setTimeout(r, 60))
        if (gen !== generation.current) return
      }
      if (gen !== generation.current) return
      if (!video.videoWidth) {
        stop()
        setProblem({ title: 'The camera sent no picture', hint: 'Close other apps that may be using it, then try again.', retry: true })
        setPhase('failed')
        return
      }
      setPhase('live')
    } catch (error) {
      if (gen !== generation.current) return
      setProblem(problemFor(error))
      setPhase('failed')
    }
  }, [])

  useEffect(() => {
    const gen = generation
    const timer = window.setTimeout(() => void start(), 0)
    return () => {
      window.clearTimeout(timer)
      gen.current++
      stop()
    }
  }, [start])
  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.url) }, [shot])

  const cancel = () => {
    generation.current++
    stop()
    onCancel()
  }

  const capture = () => {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    const scale = Math.min(1, MAX_SIDE / Math.max(video.videoWidth, video.videoHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const l = lightOf(canvas)
    setLight(l)
    if (l === 'blank') return
    canvas.toBlob((blob) => {
      if (!blob) return
      setShot({ blob, url: URL.createObjectURL(blob) })
      setPhase('preview')
    }, 'image/jpeg', QUALITY)
  }

  const retake = () => {
    setShot(null)
    setLight(null)
    const live = streamRef.current?.getVideoTracks().some((t) => t.readyState === 'live')
    if (live) setPhase('live')
    else void start()
  }

  const confirm = () => {
    if (!shot) return
    generation.current++
    stop()
    onConfirm(shot.blob)
  }

  return (
    <div className="att-cam" data-testid="selfie-camera">
      <div className="att-cam-title">{title}</div>
      <div className="att-cam-frame">
        {/* Mirrored like a mirror, which is what people expect of a front camera; the saved photo is not mirrored. */}
        <video ref={videoRef} playsInline muted autoPlay aria-label="Camera preview" className={'att-cam-video' + (phase === 'live' ? '' : ' hidden')} />
        {shot && phase === 'preview' && <img src={shot.url} alt="Your selfie" className="att-cam-video" />}
        {phase === 'live' && <div className="att-cam-oval" aria-hidden="true" />}
        {phase === 'starting' && <p role="status" className="att-cam-msg">Starting the camera…</p>}
        {phase === 'failed' && problem && (
          <div role="alert" className="att-cam-msg">
            <Ic name="videoOff" size={28} />
            <strong>{problem.title}</strong>
            <span>{problem.hint}</span>
          </div>
        )}
      </div>
      {light === 'blank' && (
        <div className="att-banner error">That picture came out black or blank. Make sure nothing covers the camera and your face is in the frame, then try again.</div>
      )}
      {light === 'dark' && phase === 'preview' && <div className="att-banner warn">This photo is quite dark. Retake it in better light if you can.</div>}
      <div className="att-actions">
        <button type="button" className="btn" onClick={cancel}>Cancel</button>
        {phase === 'live' && <button type="button" className="btn btn-primary" onClick={capture}><Ic name="video" size={15} /> Take photo</button>}
        {phase === 'preview' && <>
          <button type="button" className="btn" onClick={retake}>Retake</button>
          <button type="button" className="btn btn-primary" onClick={confirm}>Use this photo</button>
        </>}
        {phase === 'failed' && problem?.retry && <button type="button" className="btn btn-primary" onClick={() => void start()}><Ic name="refresh" size={15} /> Try again</button>}
      </div>
      <p className="att-fine">
        Your photo and the server time are saved as proof of attendance, and your face is matched automatically to your profile photo. Only you and HR can see it.
        {privacyUrl && <> <a href={privacyUrl} target="_blank" rel="noopener noreferrer">Privacy notice</a></>}
      </p>
    </div>
  )
}
