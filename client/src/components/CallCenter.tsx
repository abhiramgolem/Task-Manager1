import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api, getToken, wsUrl, API_BASE } from '../api'
import { useAuth } from '../auth'
import { Avatar, Ic } from '../ui'
import { toast } from '../lib/toast'
import { confirmDialog } from '../lib/confirm'
import { audioFilename } from '../lib/audioFile'
import { subscribeCalls, CallKind } from '../lib/call'
import { putAnalysis, replaceAnalyses, clearAnalyses, dropProvisional } from '../lib/callAnalysis'
import CallAnalysisCard from './CallAnalysisCard'
import { startLiveSpeech, isSupported as speechSupported, LiveSpeech } from '../lib/liveSpeech'
import { startPcmFromTrack, silentFrame, PcmStream } from '../lib/pcmStream'
import { startRingtone, startRingback } from '../lib/ringtone'
import {
  RingMsg, nativeCallsAvailable, ringNatively, stopNativeRing, takeNativeAction,
  onNativeCallAction, nativeCallDone, configureNativeCalls, nativeFullScreenStatus, openNativeFullScreenSettings,
} from '../lib/nativeCall'

// Audio / video / screen-share calling.
//
// The media is peer-to-peer WebRTC in a full mesh: every participant holds one
// RTCPeerConnection per other participant. A mesh is the right shape for the
// team-sized calls this app is for — it needs no media server at all, where an
// SFU would mean another deployed service and a per-stream bandwidth bill. The
// cost is that each person uploads their camera once per peer, so this stays
// good to roughly five or six people and is not trying to be a webinar tool.
//
// Mounted once in App's Layout, NOT inside the Chats page, and it opens its own
// WebSocket: a call has to be answerable while you are on Tasks or Meetings, and
// it has to survive navigating between them. The hub keeps a Set of sockets per
// user, so this second connection sits happily alongside the Chats page's own.
//
// Signalling rule that keeps it simple: THE JOINER ALWAYS OFFERS. Whoever picks
// up sends an offer to everyone already in the call, so for any pair exactly one
// side initiates and there is no glare to resolve.
//
// RINGING. A ring is not "a message that arrived once". It used to be — the
// socket said "call-ring", the card went up, and only Answer or Decline took it
// down — so a ring outlived its call: answered on another tab, hung up by the
// caller, or simply never answered, the card stayed until someone pressed
// Decline, the next day, on a call long over (and pressing Answer instead put
// them into it). Now a ring ends when the server says so (call-ring-stop,
// call-ended), when its time is up, and whenever this device comes back
// (reconnect, tab shown, app resumed) and asks what is actually ringing. The
// server also pushes every ring to the callee's phones, where the app's native
// layer rings like a phone call (lib/nativeCall.ts).

// Public STUN only. It gets a direct path on ordinary home and office networks;
// symmetric NAT (some corporate firewalls, a few mobile carriers) needs a TURN
// relay, which is a server we would have to run and pay for. When that happens
// the connection reports 'failed' and we say so rather than showing a dead frame.
const ICE: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
}

// The server's ring window (routes/chat.js RING_MS), for a server too old to send it.
const DEFAULT_RING_MS = 60000

type SttMode = 'stream' | 'upload' | 'browser'

interface Incoming {
  callId: string; conversationId: string; kind: CallKind; fromName: string; fromId: string; title: string
  expiresAt: number   // by THIS device's clock (see remainingMs)
  shownAt: number
  ring: RingMsg
}
interface Peer { id: string; name: string; stream: MediaStream | null }
interface Caption { id: string; userId: string; name: string; text: string; at: string }
// One Sarvam stream: my microphone, for as long as I am unmuted on a call
// whose transcription is on.
interface StreamHandle { ws: WebSocket; pcm: PcmStream | null; ready: boolean; closing: boolean; error: string | null }

function toIncoming(msg: any): Incoming {
  const left = typeof msg.remainingMs === 'number' ? msg.remainingMs : DEFAULT_RING_MS
  return {
    callId: msg.callId, conversationId: msg.conversationId, kind: msg.kind === 'video' ? 'video' : 'audio',
    fromName: msg.from?.name || 'Teammate', fromId: msg.from?.id,
    title: msg.title || (msg.conversationType === 'group' ? msg.conversationName : (msg.from?.name || 'Call')),
    expiresAt: Date.now() + Math.max(0, Math.min(left, 5 * 60000)),
    shownAt: Date.now(),
    ring: msg,
  }
}

// Desktop only: the system notification is what reaches someone whose VoTask
// tab is behind another window. Asked for on a click (placing or taking a
// call), because browsers ignore or bury a permission prompt that comes from
// nowhere.
function askNotifyPermission() {
  try {
    if (!nativeCallsAvailable() && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {})
    }
  } catch { /* not available */ }
}

export default function CallCenter() {
  const { user } = useAuth()
  const [incoming, setIncoming] = useState<Incoming | null>(null)
  const [callId, setCallId] = useState<string | null>(null)
  const [kind, setKind] = useState<CallKind>('audio')
  const [title, setTitle] = useState('')
  const [phase, setPhase] = useState<'idle' | 'ringing' | 'connecting' | 'live'>('idle')
  const [peers, setPeers] = useState<Record<string, Peer>>({})
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)
  const [sharing, setSharing] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [minimized, setMinimized] = useState(false)
  const [maximized, setMaximized] = useState(false)
  // Every call is transcribed, so that when it ends the server can turn it
  // into a summary in the chat and the tasks agreed on it, ready for a manager
  // to review and assign — no button to remember to press. Everyone on the call sees that it is on, and
  // ANYONE can switch it off (or back on); the switch is the call's, not one
  // person's, and everyone is told who flipped it.
  const [transcribing, setTranscribing] = useState(false)
  // What the server has actually filed, everyone's lines, as they land. This
  // is the live transcript on screen and also the proof it is working: a line
  // shows only once it is in the transcript the summary will be written from.
  const [captions, setCaptions] = useState<Caption[]>([])
  const [captionsOpen, setCaptionsOpen] = useState(true)
  // Surfaced live, because the alternative is what happened: speech capture
  // dies quietly and you only learn at the end of the call that there is
  // nothing to make tasks from.
  const [speechDead, setSpeechDead] = useState<string | null>(null)
  // Set when this device had to drop to a less accurate way of hearing itself.
  const [sttNote, setSttNote] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const pcsRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const localRef = useRef<MediaStream | null>(null)
  const screenRef = useRef<MediaStream | null>(null)
  const callIdRef = useRef<string | null>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  // Candidates that arrived before the offer they belong to. Adding one to a
  // connection with no remote description throws and silently kills the media
  // path, so they queue here until setRemoteDescription lands.
  const pendingIce = useRef<Map<string, RTCIceCandidateInit[]>>(new Map())
  // Per-peer negotiation bookkeeping for the perfect-negotiation pattern.
  const negRef = useRef<Map<string, { makingOffer: boolean; ignoreOffer: boolean; polite: boolean }>>(new Map())
  // Peer id -> display name, learned from the ring and from call-joined. Kept in
  // a ref because the socket handler closes over it and must always read the
  // latest, not the value captured when the socket was opened.
  const peersNameRef = useRef<Record<string, string>>({})

  // Transcription plumbing. The call's switch (on unless someone turned it
  // off), whether the media is flowing yet, and my own half of the
  // conversation, heard on this device and sent up as it is spoken.
  // Everyone in the call runs one of these; the server puts the halves back
  // together in time order.
  const transcribeRef = useRef(true)
  const liveRef = useRef(false)
  const micOnRef = useRef(true)
  const convIdRef = useRef<string | null>(null)
  const sttRef = useRef<SttMode>('browser')
  const ringMsRef = useRef(DEFAULT_RING_MS)
  const speechRef = useRef<LiveSpeech | null>(null)
  const streamRef = useRef<StreamHandle | null>(null)
  const streamTriesRef = useRef(0)
  // A browser that cannot recognise speech (Firefox, an iPhone app's web view)
  // records its own microphone instead, in short pieces sent to the server to
  // transcribe — each piece a whole file, which is what a speech service needs.
  const pieceRecRef = useRef<MediaRecorder | null>(null)
  const pieceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pieceUploadsRef = useRef<Promise<unknown>[]>([])
  // The consent line is said once per call, not on every reconnect.
  const toldRef = useRef<string | null>(null)
  // Identifies THIS tab, not this user. A person can be on the call from a
  // second device, or from a reloaded page, and their peers need to tell the
  // new connection from the dead one they are still holding.
  const sessionIdRef = useRef(Math.random().toString(36).slice(2) + Date.now().toString(36))
  const peerSessionRef = useRef<Map<string, string>>(new Map())
  // Mirrors of state that late-running callbacks (hang-up, the socket handler)
  // must read as of NOW, not as of the render that created them.
  const peersRef = useRef<Record<string, Peer>>({})
  const kindRef = useRef<CallKind>('audio')
  const phaseRef = useRef<'idle' | 'ringing' | 'connecting' | 'live'>('idle')
  const incomingRef = useRef<Incoming | null>(null)
  // Rings this device has already dealt with (answered, declined, timed out,
  // told to stop). A late socket message or a slow "what is ringing?" answer
  // must never put one of them back on screen.
  const handledRef = useRef<Set<string>>(new Set())
  // While a start/answer/rejoin request is in flight, and for a moment after,
  // the server may not yet list me in the call. The "am I really still in
  // it?" check must not tear down a call that is still being joined.
  const joiningRef = useRef(false)
  const joinedAtRef = useRef(0)

  useEffect(() => { callIdRef.current = callId }, [callId])
  useEffect(() => { peersRef.current = peers }, [peers])
  useEffect(() => { kindRef.current = kind }, [kind])
  useEffect(() => { phaseRef.current = phase }, [phase])
  useEffect(() => { incomingRef.current = incoming }, [incoming])

  // What the server says about the call it just started, answered or rejoined.
  const applyCallInfo = (info: any) => {
    transcribeRef.current = info?.transcribe !== 0
    setTranscribing(transcribeRef.current)
    sttRef.current = info?.stt === 'stream' || info?.stt === 'upload' ? info.stt : 'browser'
    ringMsRef.current = Number(info?.ring_ms) || DEFAULT_RING_MS
    joinedAtRef.current = Date.now()
  }

  // ---- teardown -----------------------------------------------------------
  const cleanup = useCallback(() => {
    for (const pc of pcsRef.current.values()) { try { pc.close() } catch {} }
    pcsRef.current.clear()
    pendingIce.current.clear()
    negRef.current.clear()
    peerSessionRef.current.clear()
    for (const s of [localRef.current, screenRef.current]) s?.getTracks().forEach((t) => { try { t.stop() } catch {} })
    localRef.current = null
    screenRef.current = null
    convIdRef.current = null
    liveRef.current = false
    transcribeRef.current = true
    micOnRef.current = true
    try { speechRef.current?.stop() } catch {}
    speechRef.current = null
    const h = streamRef.current
    streamRef.current = null
    if (h) { h.closing = true; h.pcm?.stop(); try { h.ws.close() } catch {} }
    streamTriesRef.current = 0
    if (pieceTimerRef.current) { clearTimeout(pieceTimerRef.current); pieceTimerRef.current = null }
    try { if (pieceRecRef.current?.state !== 'inactive') pieceRecRef.current?.stop() } catch {}
    pieceRecRef.current = null
    callIdRef.current = null
    phaseRef.current = 'idle'
    joiningRef.current = false
    setTranscribing(false); setCaptions([]); setSpeechDead(null); setSttNote(null)
    setPeers({}); setPhase('idle'); setCallId(null); setSharing(false)
    setMicOn(true); setCamOn(true); setElapsed(0); setMinimized(false); setMaximized(false)
    // A call answered on a locked phone was let over the lock screen; the
    // next time the app opens it should be locked like anything else.
    nativeCallDone()
  }, [])

  // Leave. Nothing to file from here any more: the server turns the call into
  // its summary and tasks once the last person is off it. The camera and
  // microphone stop and the call screen goes at once; what this side still
  // owes the transcript — the sentence the speech service is finishing, or on
  // a browser that records instead, the last piece of audio — goes up after
  // that, and only then is the server told this person has left, so it is in
  // before the call is written up.
  const hangUp = async (silent = false) => {
    const id = callIdRef.current
    // The analysis card goes up the moment the call window goes, not when the
    // server hears of the hang-up: that waits for this side's last sentence
    // (seconds, or longer on a browser that records), and for that long the
    // screen said nothing. Only when this hang-up ends the call — a call with
    // one other person, or the last one out — and only while transcription is
    // on. The server's own 'call-analysis' replaces it; if none comes (a group
    // call that went on, nothing captured), it is taken down again.
    if (id && !silent && phaseRef.current === 'live' && transcribeRef.current && convIdRef.current && user) {
      const remote = Object.values(peersRef.current)
      const oneToOne = remote.length === 1 && remote[0].name === title
      if (oneToOne || remote.length === 0) {
        const ts = new Date().toISOString()
        putAnalysis({
          callId: id, conversationId: convIdRef.current, kind: kindRef.current,
          conversationType: oneToOne ? 'direct' : 'group', conversationName: title,
          joined: [{ id: user.id, name: user.name }, ...remote.map((p) => ({ id: p.id, name: p.name }))],
          endedAt: ts, stage: 'waiting', at: '', provisional: true,
        })
        setTimeout(() => dropProvisional(id), 30000)
      }
    }
    const finishing = stopMyTranscript()
    cleanup()
    await finishing
    const owed = pieceUploadsRef.current
    pieceUploadsRef.current = []
    if (owed.length) await Promise.race([Promise.allSettled(owed), new Promise((r) => setTimeout(r, 20000))])
    if (id && !silent) { try { await api.post(`/chat/call/${id}/end`) } catch {} }
    // Leaving was deliberate, so do not walk back in — but a call started
    // after this one should still be rejoinable.
    rejoinedRef.current = false
  }
  const hangUpRef = useRef(hangUp)
  hangUpRef.current = hangUp

  // Release the mic and camera if the tab goes away mid-call — otherwise the
  // device stays held and the OS keeps showing the "in use" indicator.
  useEffect(() => {
    const stopAll = () => { for (const s of [localRef.current, screenRef.current]) s?.getTracks().forEach((t) => t.stop()) }
    // `pagehide` fires when a phone merely BACKGROUNDS the tab, not only when it
    // is destroyed. Tearing the media down there is what dropped calls the
    // moment you switched apps. Only release the devices when the page is
    // actually being discarded (persisted === false means no bfcache).
    const bye = (e: PageTransitionEvent) => { if (!e.persisted) stopAll() }
    window.addEventListener('pagehide', bye)
    return () => { window.removeEventListener('pagehide', bye); stopAll() }
  }, [])

  // ---- transcription: my half of the call ---------------------------------
  // Runs on EVERY participant while the call's switch is on, from the moment
  // the media is flowing. Which way this device hears itself is the server's
  // call (sttRef, see callSttMode in routes/chat.js): the speech service when
  // the server has one, the browser's own recogniser when it does not.
  const startMyTranscript = () => {
    if (!transcribeRef.current || !liveRef.current || !callIdRef.current || !micOnRef.current) return
    if (speechRef.current || pieceRecRef.current || streamRef.current) return
    const mode = sttRef.current
    if (mode === 'stream') { startStream(); return }
    if (mode === 'upload') { startPieces(); return }
    startBrowserSpeech()
  }

  // The accurate way: this call's own microphone track, streamed to the server
  // and on to Sarvam, which files each sentence into the transcript and shows
  // it to everyone as a caption. No second microphone is opened (see
  // startPcmFromTrack), so muting the call mutes this too.
  const startStream = () => {
    const id = callIdRef.current
    const track = localRef.current?.getAudioTracks()[0]
    const token = getToken()
    if (!id || !track || !token) return
    const ws = new WebSocket(wsUrl(`/api/chat/call/live?token=${encodeURIComponent(token)}&callId=${encodeURIComponent(id)}`))
    const h: StreamHandle = { ws, pcm: null, ready: false, closing: false, error: null }
    streamRef.current = h
    // Audio flows from the moment the socket opens; the server holds it until
    // Sarvam is ready, so the first words are not lost to the handshake.
    ws.onopen = () => {
      if (h.closing || streamRef.current !== h) return
      try { h.pcm = startPcmFromTrack(track, (b64) => { if (ws.readyState === WebSocket.OPEN) ws.send(b64) }) }
      catch { h.error = 'this browser could not read the microphone'; try { ws.close() } catch {} }
    }
    ws.onmessage = (ev) => {
      let m: any
      try { m = JSON.parse(ev.data) } catch { return }
      if (m.ready || m.resumed) { h.ready = true; streamTriesRef.current = 0; setSpeechDead(null) }
      else if (m.error && !h.ready) h.error = String(m.error)
    }
    ws.onclose = () => {
      h.pcm?.stop(); h.pcm = null
      if (h.closing || streamRef.current !== h) return // stopped on purpose
      streamRef.current = null
      if (!transcribeRef.current || callIdRef.current !== id || !micOnRef.current) return
      // A blip (network change, a server restart) on a stream that WAS working:
      // reconnect, backing off. One that never worked is not going to.
      if (h.ready && streamTriesRef.current < 5) {
        const n = ++streamTriesRef.current
        setTimeout(() => { if (callIdRef.current === id) startMyTranscript() }, Math.min(8000, 500 * 2 ** n))
        return
      }
      fallBack(h.error || 'the speech service could not be reached')
    }
  }

  // Down one step: the speech service in 25-second recordings (same accuracy,
  // later captions), then the browser's own recogniser (less accurate for
  // Telugu and Hindi, but something). Said on screen, so a worse transcript is
  // never a silent surprise.
  const fallBack = (why: string) => {
    if (sttRef.current === 'stream' && typeof MediaRecorder !== 'undefined') {
      sttRef.current = 'upload'
      setSttNote(`Live captions are delayed: ${why}. Your words are being sent in short recordings instead.`)
    } else {
      sttRef.current = 'browser'
      setSttNote(`Using this browser's own speech recogniser (${why}) — less accurate for Telugu and Hindi.`)
    }
    startMyTranscript()
  }

  const startBrowserSpeech = () => {
    if (!speechSupported()) { startPieces(); return }
    const callId = callIdRef.current
    setSpeechDead(null)
    speechRef.current = startLiveSpeech(
      (text) => {
        const id = callIdRef.current
        if (!id || id !== callId || !transcribeRef.current) return
        api.post(`/chat/call/${id}/segment`, { text }).catch(() => {})
      },
      undefined,
      (st) => {
        // Only a genuinely fatal state is worth interrupting a call for — and
        // then this side falls back to recording, so its half is not lost.
        if (st.kind === 'dead') {
          try { speechRef.current?.stop() } catch {}
          speechRef.current = null
          setSpeechDead(st.reason)
          startPieces()
        }
      },
    )
    if (!speechRef.current) { setSpeechDead('speech recognition would not start'); startPieces() }
  }

  // The recording fallback: my microphone only (everyone else is transcribing
  // their own), in pieces of about 25 seconds — each one a complete file the
  // server can transcribe on its own, and short enough for a speech service
  // that refuses anything over 30 seconds. A piece goes up as soon as it ends,
  // so a long call is not one huge upload at the end.
  const startPieces = () => {
    const stream = localRef.current
    const id = callIdRef.current
    if (!stream || !id || pieceRecRef.current || typeof MediaRecorder === 'undefined') return
    const track = stream.getAudioTracks()[0]
    if (!track) return
    const mine = new MediaStream([track])
    const next = () => {
      if (!transcribeRef.current || callIdRef.current !== id) { pieceRecRef.current = null; return }
      let rec: MediaRecorder
      try { rec = new MediaRecorder(mine) } catch { pieceRecRef.current = null; return }
      const chunks: BlobPart[] = []
      const startedAt = new Date().toISOString()
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
        if (blob.size > 3000) pieceUploadsRef.current.push(uploadPiece(id, blob, startedAt))
        if (pieceRecRef.current === rec) next()
      }
      pieceRecRef.current = rec
      rec.start()
      pieceTimerRef.current = setTimeout(() => { try { if (rec.state !== 'inactive') rec.stop() } catch {} }, 25000)
    }
    next()
  }
  const uploadPiece = async (id: string, blob: Blob, startedAt: string) => {
    try {
      const form = new FormData()
      form.append('file', new File([blob], audioFilename(blob, 'call-piece'), { type: blob.type || 'audio/webm' }))
      form.append('started_at', startedAt)
      const headers: Record<string, string> = {}
      const t = getToken(); if (t) headers.authorization = `Bearer ${t}`
      const res = await fetch(`${API_BASE}/api/chat/call/${id}/audio`, { method: 'POST', headers, body: form })
      const data = await res.json().catch(() => ({}))
      if (!res.ok && data.code === 'NO_PROVIDER') {
        // Nowhere to send it: stop recording rather than keep uploading audio
        // nothing can read. The others' halves still make the summary.
        setSpeechDead('this browser cannot transcribe, and the server has no speech service')
        stopPieces()
      }
    } catch { /* one lost piece; the next one carries on */ }
  }
  // Resolves once the last piece has been handed to its upload: the recorder's
  // own onstop (set first, so it runs first) queues the upload, then this.
  const stopPieces = (): Promise<void> => {
    if (pieceTimerRef.current) { clearTimeout(pieceTimerRef.current); pieceTimerRef.current = null }
    const rec = pieceRecRef.current
    pieceRecRef.current = null   // so its onstop does not start another piece
    if (!rec || rec.state === 'inactive') return Promise.resolve()
    const stopped = new Promise<void>((resolve) => rec.addEventListener('stop', () => setTimeout(resolve, 0), { once: true }))
    try { rec.stop() } catch { return Promise.resolve() }
    return Promise.race([stopped, new Promise<void>((r) => setTimeout(r, 1500))])
  }
  // The stream is let go of at once (so nothing else touches it), but closed
  // only after the speech service has had a moment to hand back the sentence
  // in progress. A second of silence is what tells it that sentence is over;
  // closing straight away is how the last thing said on a call — usually the
  // "so Ravi, you'll send it Friday" that matters most — went missing.
  const flushStream = (): Promise<void> => {
    const h = streamRef.current
    streamRef.current = null
    if (!h) return Promise.resolve()
    h.closing = true
    h.pcm?.stop(); h.pcm = null
    const ws = h.ws
    if (ws.readyState !== WebSocket.OPEN) { try { ws.close() } catch {}; return Promise.resolve() }
    for (let i = 0; i < 5; i++) { try { ws.send(silentFrame(250)) } catch {} }
    return new Promise((resolve) => {
      let done = false
      const finish = () => { if (done) return; done = true; try { ws.close() } catch {}; resolve() }
      ws.onmessage = (ev) => { try { if (JSON.parse(ev.data).transcript) setTimeout(finish, 300) } catch {} }
      setTimeout(finish, 2500)
    })
  }
  const stopMyTranscript = (): Promise<void> => {
    try { speechRef.current?.stop() } catch {}
    speechRef.current = null
    return Promise.all([stopPieces(), flushStream()]).then(() => {})
  }

  // The call's switch — anyone on the call may flip it, and everyone is told.
  const setCallTranscription = async (on: boolean) => {
    const id = callIdRef.current
    if (!id) return
    transcribeRef.current = on
    setTranscribing(on)
    if (on) startMyTranscript(); else stopMyTranscript()
    try { await api.post(`/chat/call/${id}/recording`, { on }) }
    catch (e: any) { toast.error('Could not change transcription: ' + e.message) }
  }

  // ---- signalling ---------------------------------------------------------
  const signal = useCallback((to: string, payload: any) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'call-signal', callId: callIdRef.current, to, signal: { ...payload, session: sessionIdRef.current } })) } catch {}
    }
  }, [])

  const getPc = useCallback((peerId: string, peerName: string) => {
    const existing = pcsRef.current.get(peerId)
    if (existing) return existing
    const pc = new RTCPeerConnection(ICE)
    pcsRef.current.set(peerId, pc)
    setPeers((p) => ({ ...p, [peerId]: p[peerId] || { id: peerId, name: peerName, stream: null } }))

    for (const track of localRef.current?.getTracks() || []) pc.addTrack(track, localRef.current!)
    // Renegotiation is driven by onnegotiationneeded below, so adding a camera
    // later is just addTrack. An earlier version pre-armed an empty video
    // transceiver to avoid renegotiating at all; it mis-associated the m-lines on
    // the answering side and the upgraded video silently never flowed.
    const neg = { makingOffer: false, ignoreOffer: false, polite: (user?.id || '') < peerId }
    negRef.current.set(peerId, neg)

    // Perfect negotiation (the WebRTC spec's own recipe). Either side may need to
    // renegotiate at any moment — turning a camera on, sharing a screen — and if
    // both do it at once the offers collide. One peer is designated "polite" by a
    // rule both sides compute identically (compare user ids): the polite one rolls
    // back and accepts, the impolite one ignores. Without this, a mid-call upgrade
    // is a coin flip.
    pc.onnegotiationneeded = async () => {
      try {
        neg.makingOffer = true
        await pc.setLocalDescription()
        signal(peerId, { sdp: pc.localDescription })
      } catch (e: any) {
        console.warn('[call] negotiation failed', e?.message)
      } finally {
        neg.makingOffer = false
      }
    }

    pc.onicecandidate = (e) => { if (e.candidate) signal(peerId, { candidate: e.candidate.toJSON() }) }
    pc.ontrack = (e) => {
      const stream = e.streams[0]
      setPeers((p) => ({ ...p, [peerId]: { ...(p[peerId] || { id: peerId, name: peerName }), stream } }))
      setPhase('live')
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        toast.error(`Could not reach ${peerName} directly — the network is blocking peer-to-peer media.`)
      }
    }
    return pc
  }, [signal, user?.id])

  // Connect to everyone already in the call. Creating the peer connection adds
  // our tracks, which fires onnegotiationneeded, which sends the offer — so there
  // is no separate "make an offer" step to keep in sync any more.
  const offerTo = useCallback(async (peerIds: string[], names: Record<string, string>) => {
    for (const pid of peerIds) getPc(pid, names[pid] || 'Teammate')
  }, [getPc])

  const drainIce = useCallback(async (pc: RTCPeerConnection, from: string) => {
    const queued = pendingIce.current.get(from) || []
    pendingIce.current.delete(from)
    for (const c of queued) { try { await pc.addIceCandidate(c) } catch {} }
  }, [])

  // ---- media --------------------------------------------------------------
  const grabMedia = useCallback(async (k: CallKind) => {
    // iOS/WKWebView hands back a suspended context and refuses the camera unless
    // this runs inside the user's tap — which it does: every path here starts at
    // a button press (see CLAUDE.md on the WebView differences).
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: k === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    })
    localRef.current = stream
    if (localVideoRef.current) localVideoRef.current.srcObject = stream
    return stream
  }, [])

  // Bind the self-preview to whatever we are currently sending. This cannot be
  // done where the camera is acquired: the self tile only exists once `kind`
  // flips to 'video', so the ref is still null at that moment — which is why an
  // upgraded audio call showed your camera to everyone except you.
  useEffect(() => {
    const el = localVideoRef.current
    const stream = sharing ? screenRef.current : localRef.current
    if (el && stream && el.srcObject !== stream) el.srcObject = stream
  })

  // ---- the ring -----------------------------------------------------------
  const dismissRing = useCallback((ringId: string) => {
    handledRef.current.add(ringId)
    stopNativeRing(ringId)
    if (incomingRef.current?.callId === ringId) incomingRef.current = null
    setIncoming((cur) => (cur && cur.callId === ringId ? null : cur))
  }, [])

  const showRing = useCallback((msg: any) => {
    if (!msg?.callId || handledRef.current.has(msg.callId)) return
    if (incomingRef.current?.callId === msg.callId) return
    if (callIdRef.current) {
      if (callIdRef.current === msg.callId) return
      // Already on a call: turn it down rather than ring over a live one — and
      // say so, so the call is not silently lost.
      handledRef.current.add(msg.callId)
      api.post(`/chat/call/${msg.callId}/decline`).catch(() => {})
      toast.info(`${msg.from?.name || 'Someone'} tried to call you while you were on this call`, 6000)
      return
    }
    const inc = toIncoming(msg)
    if (inc.expiresAt <= Date.now()) return
    incomingRef.current = inc
    setIncoming(inc)
  }, [])

  // What is ringing for me, per the server. A ring shown before this question
  // was asked and missing from the answer is over; anything listed that is
  // not on screen yet goes up (opened from a push, a laptop woken from sleep).
  const syncRinging = useCallback(async (): Promise<any[] | null> => {
    const asked = Date.now()
    let items: any[] = []
    try { items = ((await api.get('/chat/calls/ringing')) as any).items || [] } catch { return null }
    const cur = incomingRef.current
    if (cur && cur.shownAt < asked && !items.some((i) => i.callId === cur.callId)) dismissRing(cur.callId)
    if (!callIdRef.current && !incomingRef.current) {
      const next = items.find((i) => !handledRef.current.has(i.callId))
      if (next) showRing(next)
    }
    return items
  }, [dismissRing, showRing])

  // ---- start / answer -----------------------------------------------------
  const begin = useCallback(async (conversationId: string, k: CallKind, label: string) => {
    if (callIdRef.current || joiningRef.current) { toast.error('You are already on a call'); return }
    askNotifyPermission()
    joiningRef.current = true
    setKind(k); setTitle(label); setPhase('ringing'); phaseRef.current = 'ringing'
    try {
      await grabMedia(k)
    } catch {
      joiningRef.current = false
      setPhase('idle'); phaseRef.current = 'idle'
      toast.error(k === 'video' ? 'No camera or microphone available' : 'No microphone available')
      return
    }
    try {
      const call: any = await api.post(`/chat/conversations/${conversationId}/call`, { kind: k })
      setCallId(call.id); callIdRef.current = call.id
      convIdRef.current = conversationId
      applyCallInfo(call)
      // Joining a call already in progress: offer to everyone in it right away.
      if (call.joined && call.peers?.length) { setPhase('connecting'); phaseRef.current = 'connecting'; await offerTo(call.peers, peersNameRef.current) }
    } catch (e: any) {
      cleanup()
      toast.error('Could not start the call: ' + e.message)
    } finally {
      joiningRef.current = false
    }
  }, [grabMedia, offerTo, cleanup])

  const answerCall = useCallback(async (inc: Incoming) => {
    if (callIdRef.current || joiningRef.current) return
    dismissRing(inc.callId)
    askNotifyPermission()
    joiningRef.current = true
    peersNameRef.current[inc.fromId] = inc.fromName
    setKind(inc.kind); kindRef.current = inc.kind; setTitle(inc.title)
    setPhase('connecting'); phaseRef.current = 'connecting'
    setCallId(inc.callId); callIdRef.current = inc.callId
    convIdRef.current = inc.conversationId
    try {
      await grabMedia(inc.kind)
    } catch {
      cleanup()
      toast.error(inc.kind === 'video' ? 'No camera or microphone available' : 'No microphone available')
      try { await api.post(`/chat/call/${inc.callId}/decline`) } catch {}
      return
    }
    try {
      const res: any = await api.post(`/chat/call/${inc.callId}/answer`)
      applyCallInfo(res)
      await offerTo(res.peers || [], peersNameRef.current)
    } catch (e: any) {
      cleanup()
      toast.error(/ended/i.test(e.message || '') ? 'That call has already ended' : 'Could not join: ' + e.message)
    } finally {
      joiningRef.current = false
    }
  }, [dismissRing, grabMedia, offerTo, cleanup])

  const answer = useCallback(() => { const inc = incomingRef.current; if (inc) answerCall(inc) }, [answerCall])

  const decline = useCallback(async () => {
    const inc = incomingRef.current
    if (!inc) return
    dismissRing(inc.callId)
    askNotifyPermission()
    try { await api.post(`/chat/call/${inc.callId}/decline`) } catch {}
  }, [dismissRing])

  // Answer pressed on the phone's own ringing screen. The app was opened (or
  // brought forward) by it; the call itself is looked up fresh, because by now
  // it may have stopped ringing.
  const answerById = useCallback(async (ringId: string) => {
    if (!ringId || callIdRef.current === ringId) return
    const cur = incomingRef.current
    if (cur?.callId === ringId) { answerCall(cur); return }
    const items = await syncRinging()
    const hit = (items || []).find((i) => i.callId === ringId)
    if (hit) answerCall(toIncoming(hit))
    else toast.info('That call has already ended')
  }, [answerCall, syncRinging])
  const answerByIdRef = useRef(answerById)
  answerByIdRef.current = answerById
  const syncRingingRef = useRef(syncRinging)
  syncRingingRef.current = syncRinging

  // ---- the socket ---------------------------------------------------------
  useEffect(() => {
    if (!user) return
    let closed = false
    let retry: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (closed) return
      const token = getToken()
      if (!token) return
      const ws = new WebSocket(wsUrl(`/api/chat/ws?token=${encodeURIComponent(token)}`))
      wsRef.current = ws
      ws.onmessage = async (ev) => {
        let msg: any
        try { msg = JSON.parse(ev.data) } catch { return }

        // Every (re)connect: whatever happened while the socket was down — a
        // ring that started, a ring that stopped, a call that ended — is only
        // knowable by asking.
        if (msg.type === 'ready') {
          syncRingingRef.current(); syncCallsRef.current()
          // ...and a call's write-up that moved on while this device was away.
          api.get('/chat/calls/analysis').then((d: any) => replaceAnalyses(d.items || [])).catch(() => {})
          return
        }

        // A chat message: handed to the in-app banner (InAppChatAlert), which
        // decides whether it is worth a sound. This socket is the one that is
        // open on every page, not just Chats.
        if (msg.type === 'message') { window.dispatchEvent(new CustomEvent('votask-chat-message', { detail: msg })); return }
        // Someone in the org checked in or out: the In chips' board (lib/attendanceBoard).
        if (msg.type === 'attendance') { window.dispatchEvent(new CustomEvent('votask-attendance', { detail: msg })); return }

        if (msg.type === 'call-ring') { showRing(msg); return }
        if (msg.type === 'call-ring-stop') { dismissRing(msg.callId); return }

        if (msg.type === 'call-signal' && msg.callId === callIdRef.current) {
          const from = msg.from
          const sig = msg.signal || {}
          if (sig.sdp) {
            // Their session changed: this is the same person from a new tab or a
            // new device, and the connection we hold is to a browser that is
            // gone. Replace it here — keyed off the offer itself — rather than
            // on the call-joined event, which races the offer and used to leave
            // the rejoined side sending but never receiving.
            const known = peerSessionRef.current.get(from)
            if (sig.session && known && known !== sig.session) {
              const dead = pcsRef.current.get(from)
              if (dead) { try { dead.close() } catch {} }
              pcsRef.current.delete(from)
              negRef.current.delete(from)
              pendingIce.current.delete(from)
            }
            if (sig.session) peerSessionRef.current.set(from, sig.session)

            const pc = getPc(from, peersNameRef.current[from] || 'Teammate')
            const neg = negRef.current.get(from)
            try {
              // Collision: their offer arrived while we were making our own, or
              // while we are not back to a stable state. The impolite peer drops
              // theirs; the polite peer yields, and setRemoteDescription performs
              // the implicit rollback for us.
              const collision = sig.sdp.type === 'offer' && (!!neg?.makingOffer || pc.signalingState !== 'stable')
              if (neg) neg.ignoreOffer = !neg.polite && collision
              if (neg?.ignoreOffer) return

              await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp))
              await drainIce(pc, from)
              if (sig.sdp.type === 'offer') {
                await pc.setLocalDescription()
                signal(from, { sdp: pc.localDescription })
              }
              setPhase((p) => (p === 'ringing' ? 'connecting' : p))
            } catch (e: any) { console.warn('[call] sdp failed', e?.message) }
          } else if (sig.candidate) {
            const pc = pcsRef.current.get(from)
            const neg = negRef.current.get(from)
            if (pc && pc.remoteDescription) {
              try { await pc.addIceCandidate(sig.candidate) } catch (e) { if (!neg?.ignoreOffer) console.warn('[call] ice rejected') }
            } else {
              const q = pendingIce.current.get(from) || []
              q.push(sig.candidate)
              pendingIce.current.set(from, q)
            }
          }
          return
        }

        if (msg.type === 'call-joined') {
          // Me, from another device, picking up the call ringing here.
          if (msg.userId === user.id && msg.callId !== callIdRef.current) { dismissRing(msg.callId); return }
          if (msg.callId !== callIdRef.current) return
          // Someone picked up, or came back. Nothing is torn down here on
          // purpose: replacing the connection is driven by the session id on
          // their next offer, which cannot race with the offer the way this
          // event could.
          if (msg.name) peersNameRef.current[msg.userId] = msg.name
          setPhase((p) => (p === 'ringing' ? 'connecting' : p))
          return
        }
        if (msg.type === 'call-left' && msg.callId === callIdRef.current) {
          const pc = pcsRef.current.get(msg.userId)
          if (pc) { try { pc.close() } catch {}; pcsRef.current.delete(msg.userId) }
          setPeers((p) => { const n = { ...p }; delete n[msg.userId]; return n })
          return
        }
        if (msg.type === 'call-declined' && msg.callId === callIdRef.current) {
          toast.info(`${msg.name || 'They'} declined`)
          return
        }
        if (msg.type === 'call-kind' && msg.callId === callIdRef.current) {
          // They turned a camera on. Switch to the video layout so their tile can
          // render; our own camera stays off until we choose to turn it on.
          if (msg.kind === 'video') { setKind('video'); kindRef.current = 'video' }
          if (msg.by !== user.id && msg.kind === 'video') toast.info(`${msg.byName || 'They'} turned their camera on`)
          return
        }
        if (msg.type === 'call-recording' && msg.callId === callIdRef.current) {
          // Someone flipped the call's transcription. Everyone follows it —
          // MY side included, because each device can only ever hear its own
          // microphone, so the far end of a call can only be captured by the
          // far end.
          transcribeRef.current = !!msg.on
          setTranscribing(!!msg.on)
          if (msg.on) startMyTranscript(); else void stopMyTranscript()
          if (msg.by !== user.id) {
            toast.info(msg.on
              ? `${msg.byName || 'Someone'} turned transcription on — this call will be summarised into tasks`
              : `${msg.byName || 'Someone'} turned transcription off`)
          }
          return
        }
        if (msg.type === 'call-caption' && msg.callId === callIdRef.current) {
          setCaptions((c) => (c.some((x) => x.id === msg.id) ? c : [...c, { id: msg.id, userId: msg.userId, name: msg.name, text: msg.text, at: msg.at }].slice(-300)))
          return
        }
        if (msg.type === 'call-analysis') {
          // A finished call being written up, step by step (CallAnalysisCard).
          putAnalysis(msg)
          return
        }
        if (msg.type === 'call-ended') {
          if (incomingRef.current?.callId === msg.callId) dismissRing(msg.callId)
          // The others hung up. My last sentence still goes in: the server keeps
          // taking lines for a short while after a call ends.
          if (msg.callId === callIdRef.current) { void stopMyTranscript(); cleanup() }
          return
        }
        // Not ours (chat messages etc.) — the Chats page has its own socket.
      }
      ws.onclose = () => { if (!closed) retry = setTimeout(connect, 2500) }
      ws.onerror = () => { try { ws.close() } catch {} }
    }
    connect()
    // Signed out, or someone else signed in: their calls are not this person's.
    return () => { closed = true; if (retry) clearTimeout(retry); try { wsRef.current?.close() } catch {}; clearAnalyses() }
  }, [user, getPc, drainIce, signal, cleanup, showRing, dismissRing])

  // Re-enter a call that is still running. Deliberately silent and automatic:
  // no "Resume?" prompt. A dropped call is not a decision someone made, it is an
  // accident of a closed tab, a dead battery or a walk out of signal — and the
  // people still on the call are waiting. Leaving explicitly (hang up) records
  // left_at, so a call you MEANT to leave is never rejoined.
  //
  // The reverse too: a call this device still thinks it is in, which the
  // server says is over (its "call-ended" was sent while the socket was down),
  // is left — otherwise this device sits in a dead call, and being "busy" turns
  // down every real call that comes in.
  const rejoinedRef = useRef(false)
  const syncCallsRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!user) return
    let cancelled = false
    const syncCalls = async () => {
      if (cancelled) return
      const mine = callIdRef.current
      if (!mine && (rejoinedRef.current || joiningRef.current)) return
      let live: any = null
      try { live = (await api.get('/chat/calls/active')).call } catch { return }
      if (cancelled) return
      if (mine) {
        const settled = !joiningRef.current && Date.now() - joinedAtRef.current > 8000
        if (callIdRef.current === mine && settled && (!live || live.id !== mine)) {
          void stopMyTranscript()
          cleanup()
          toast.info('The call has ended')
        }
        return
      }
      if (!live || callIdRef.current || joiningRef.current) return
      rejoinedRef.current = true
      joiningRef.current = true
      const k: CallKind = live.kind === 'video' ? 'video' : 'audio'
      setKind(k); kindRef.current = k
      setTitle(live.title || 'Call')
      setPhase('connecting'); phaseRef.current = 'connecting'
      setCallId(live.id); callIdRef.current = live.id
      convIdRef.current = live.conversation_id
      try {
        await grabMedia(k)
      } catch {
        cleanup()
        toast.error('Rejoining the call needs the microphone')
        return
      }
      try {
        const res: any = await api.post(`/chat/call/${live.id}/answer`)
        applyCallInfo({ ...live, ...res, transcribe: res.transcribe ?? live.transcribe })
        toldRef.current = live.id // already told when it began
        await offerTo(res.peers || live.peers || [], peersNameRef.current)
        toast.info('Reconnected to your call')
      } catch { cleanup() } finally { joiningRef.current = false }
    }
    syncCallsRef.current = () => { syncCalls() }
    // On open, and again when the tab comes back — a phone that slept may have
    // missed the socket entirely.
    const t = setTimeout(syncCalls, 900)
    const onVis = () => {
      if (document.visibilityState !== 'visible') return
      syncCalls()
      syncRingingRef.current()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => { cancelled = true; clearTimeout(t); document.removeEventListener('visibilitychange', onVis) }
  }, [user?.id, grabMedia, offerTo, cleanup])

  // The phone's own call screen: tell it where the API is (for its Decline
  // button), then take an Answer pressed there — the one that opened the app,
  // or one pressed while it was already running.
  useEffect(() => {
    if (!user || !nativeCallsAvailable()) return
    configureNativeCalls(API_BASE || location.origin)
    takeNativeAction().then((a) => { if (a?.action === 'answer' && a.call_id) answerByIdRef.current(a.call_id) })
    // Android 14 lets an app take over the lock screen for a call only if the
    // person allows it (Settings → full-screen notifications). Without it a
    // call still rings, as a banner, but a phone in a pocket shows nothing. Asked
    // once, here, rather than in the middle of a ring.
    nativeFullScreenStatus().then(async ({ allowed }) => {
      if (allowed) return
      try { if (localStorage.getItem('votask_fullscreen_asked')) return; localStorage.setItem('votask_fullscreen_asked', '1') } catch { return }
      const yes = await confirmDialog({
        title: 'Show calls on the full screen?',
        message: 'So an incoming VoTask call covers the screen and rings like a phone call, even when your phone is locked. Turn on "Allow full-screen notifications" for VoTask on the next screen.',
        confirmText: 'Open settings', cancelText: 'Not now',
      })
      if (yes) openNativeFullScreenSettings()
    })
    return onNativeCallAction((a) => { if (a?.action === 'answer' && a.call_id) answerByIdRef.current(a.call_id) })
  }, [user?.id])

  // The bus: Chats (or anything else) asking us to ring someone.
  useEffect(() => subscribeCalls((req) => { begin(req.conversationId, req.kind, req.title) }), [begin])

  // The media is flowing: from here on, my half of the call is transcribed
  // (while the switch is on), and everyone is told so once, in words — a
  // transcript nobody was told about is not one this app will take.
  useEffect(() => {
    if (phase !== 'live') return
    liveRef.current = true
    if (!transcribeRef.current) return
    startMyTranscript()
    if (toldRef.current !== callIdRef.current) {
      toldRef.current = callIdRef.current
      toast.info('This call is transcribed. When it ends, its summary and suggested tasks land in the chat for you to review and assign — nothing is assigned by itself. Anyone on the call can switch transcription off.', 8000)
    }
  }, [phase])

  // Call timer, once media is actually flowing.
  useEffect(() => {
    if (phase !== 'live') return
    const iv = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(iv)
  }, [phase])

  // The caller's side of a ring: the "tring tring", and giving up when nobody
  // picks up — as a phone does, instead of sitting on "Ringing…" for ever. The
  // hang-up files the call as unanswered, which is also what stops the other
  // end's phone ringing.
  useEffect(() => {
    if (phase !== 'ringing' || !callId) return
    const stop = startRingback()
    const t = setTimeout(() => {
      if (callIdRef.current === callId && phaseRef.current === 'ringing') {
        toast.info('No answer')
        hangUpRef.current()
      }
    }, ringMsRef.current)
    return () => { stop(); clearTimeout(t) }
  }, [phase, callId])

  // The callee's side: a ring you can hear (and feel, on a phone), the tab's
  // title flashing, a system notification when the tab is behind another
  // window, and the phone's own ringing screen when the app is in the
  // background. All of it stops the moment the ring does, and the ring stops
  // by itself when its time is up.
  useEffect(() => {
    if (!incoming) return
    const inc = incoming
    const stopTone = startRingtone()
    const lapse = setTimeout(() => dismissRing(inc.callId), Math.max(0, inc.expiresAt - Date.now()))
    const base = document.title
    let flip = false
    const flash = setInterval(() => { flip = !flip; document.title = flip ? `📞 ${inc.fromName} is calling…` : base }, 1000)
    let note: Notification | null = null
    const away = () => {
      if (document.visibilityState !== 'hidden') return
      if (nativeCallsAvailable()) { ringNatively(inc.ring); return }
      if (note || !('Notification' in window) || Notification.permission !== 'granted') return
      try {
        note = new Notification(inc.title === inc.fromName ? `${inc.fromName} is calling you` : `${inc.fromName} is calling ${inc.title}`, {
          body: `VoTask ${inc.kind} call — click to answer`, tag: `call_${inc.callId}`, requireInteraction: true, icon: '/favicon.png',
        })
        note.onclick = () => { window.focus(); note?.close() }
      } catch { /* the browser refused; the tab title still flashes */ }
    }
    away()
    document.addEventListener('visibilitychange', away)
    return () => {
      stopTone(); clearTimeout(lapse); clearInterval(flash)
      document.removeEventListener('visibilitychange', away)
      document.title = base
      try { note?.close() } catch {}
    }
  }, [incoming, dismissRing])

  // ---- in-call controls ---------------------------------------------------
  // Turn the camera on during an audio call — WhatsApp's "switch to video".
  // Only ever an upgrade: there is no downgrade, because dropping back to audio is
  // what the camera-off button already does.
  const upgradeToVideo = async () => {
    if (kindRef.current === 'video' || !localRef.current) return
    let track: MediaStreamTrack
    try {
      const cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } })
      track = cam.getVideoTracks()[0]
    } catch { toast.error('No camera available'); return }

    localRef.current.addTrack(track)
    if (localVideoRef.current) localVideoRef.current.srcObject = localRef.current
    // Reuse an idle video sender if there is one (there will be after a screen
    // share has been stopped), otherwise add the track and let
    // onnegotiationneeded renegotiate.
    for (const pc of pcsRef.current.values()) {
      try {
        const idle = pc.getSenders().find((sn) => !sn.track && pc.getTransceivers().some((t) => t.sender === sn && t.receiver.track?.kind === 'video'))
        if (idle) await idle.replaceTrack(track)
        else pc.addTrack(track, localRef.current!)
      } catch (e: any) { console.warn('[call] camera upgrade failed', e?.message) }
    }
    setKind('video'); kindRef.current = 'video'
    setCamOn(true)
    const id = callIdRef.current
    if (id) api.post(`/chat/call/${id}/kind`, { kind: 'video' }).catch(() => {})
  }

  // Muting also pauses MY transcription. A muted aside must not be written
  // down — the call being summarised into tasks, it could end up assigned to
  // someone — and the browser's recogniser opens the microphone by itself,
  // apart from the call's track, so stopping it is the only way to be sure.
  const toggleMic = () => {
    const t = localRef.current?.getAudioTracks()[0]
    if (!t) return
    t.enabled = !t.enabled
    micOnRef.current = t.enabled
    setMicOn(t.enabled)
    if (t.enabled) startMyTranscript(); else void stopMyTranscript()
  }
  const toggleCam = () => {
    const t = localRef.current?.getVideoTracks()[0]
    if (!t) return
    t.enabled = !t.enabled
    setCamOn(t.enabled)
  }

  // Screen share swaps the outgoing video track on every peer connection rather
  // than renegotiating — replaceTrack needs no new offer, so the switch is
  // instant and cannot fail halfway across a mesh.
  const toggleShare = async () => {
    if (sharing) {
      const camTrack = localRef.current?.getVideoTracks()[0] || null
      for (const pc of pcsRef.current.values()) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
        if (sender) { try { await sender.replaceTrack(camTrack) } catch {} }
      }
      screenRef.current?.getTracks().forEach((t) => t.stop())
      screenRef.current = null
      if (localVideoRef.current) localVideoRef.current.srcObject = localRef.current
      setSharing(false)
      return
    }
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      screenRef.current = screen
      const track = screen.getVideoTracks()[0]
      for (const pc of pcsRef.current.values()) {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
        if (sender) { try { await sender.replaceTrack(track) } catch {} }
        else { try { pc.addTrack(track, screen) } catch {} }
      }
      if (localVideoRef.current) localVideoRef.current.srcObject = screen
      setSharing(true)
      // The browser's own "Stop sharing" bar bypasses our button entirely.
      track.onended = () => { toggleShare() }
    } catch { /* the picker was dismissed */ }
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  const remote = Object.values(peers)

  if (!user) return null
  const heard = captions.filter((c) => c.userId === user.id).length
  const ringFrom = incoming && incoming.title !== incoming.fromName ? incoming.fromName : ''

  return (
    <>
      {incoming && (
        <div className="call-ringer" role="alertdialog" aria-label={`Incoming ${incoming.kind} call from ${incoming.fromName}`}>
          <div className="call-ring-card">
            <div className="call-ring-face"><Avatar name={incoming.title} size={88} /></div>
            <div className="call-ring-who">{incoming.title}</div>
            <div className="call-ring-sub">
              <Ic name={incoming.kind === 'video' ? 'video' : 'phone'} size={13} /> VoTask {incoming.kind} call{ringFrom ? ` · ${ringFrom}` : ''}
            </div>
            <div className="call-ring-actions">
              <div className="call-ring-act">
                <button className="call-btn decline" onClick={decline} aria-label="Decline"><Ic name="callEnd" size={26} /></button>
                <span>Decline</span>
              </div>
              <div className="call-ring-act">
                <button className="call-btn accept" onClick={answer} aria-label="Answer" autoFocus>
                  <Ic name={incoming.kind === 'video' ? 'video' : 'phone'} size={26} />
                </button>
                <span>Answer</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {phase !== 'idle' && (
        <div className={'call-stage' + (minimized ? ' mini' : '') + (maximized ? ' max' : '')}>
          <div className="call-stage-head">
            <div style={{ minWidth: 0 }}>
              <div className="call-stage-title">{title}</div>
              <div className="call-stage-sub">
                {phase === 'ringing' ? 'Ringing…' : phase === 'connecting' ? 'Connecting…' : fmt(elapsed)}
                {sharing && ' · sharing screen'}
                {transcribing && phase === 'live' && (
                  <span className={'rec-badge' + (speechDead ? ' muted-speech' : '')}
                    title={speechDead
                      ? `Transcribing, but not on this device: ${speechDead}`
                      : sttNote || `Transcribed for tasks — ${heard} line${heard === 1 ? '' : 's'} from you so far`}>
                    <span className="rec-dot" />Transcribing
                    {speechDead ? ' · not you' : heard > 0 ? ` · ${heard}` : ''}
                  </span>
                )}
              </div>
            </div>
            <div className="row" style={{ gap: 2 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => { setMaximized((m) => !m); setMinimized(false) }}
                title={maximized ? 'Exit full screen' : 'Full screen'} aria-label={maximized ? 'Exit full screen' : 'Full screen'}>
                <Ic name={maximized ? 'minimize' : 'maximize'} size={15} />
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setMinimized((m) => !m); setMaximized(false) }}
                title={minimized ? 'Expand' : 'Minimise'} aria-label={minimized ? 'Expand call' : 'Minimise call'}>
                <Ic name={minimized ? 'arrowUp' : 'arrowDown'} size={16} />
              </button>
            </div>
          </div>

          {!minimized && (
            <div className={'call-grid' + (kind === 'audio' ? ' audio' : '')}>
              {kind === 'video' && (
                <div className={'call-tile self' + (sharing ? ' sharing' : '')}>
                  <video ref={localVideoRef} autoPlay muted playsInline />
                  <span className="call-tile-name">You{!micOn ? ' · muted' : ''}</span>
                </div>
              )}
              {remote.map((p) => (
                <div key={p.id} className="call-tile">
                  {kind === 'video'
                    ? <VideoTile stream={p.stream} />
                    : <div className="call-audio-face"><Avatar name={p.name} size={56} /><AudioSink stream={p.stream} /></div>}
                  <span className="call-tile-name">{p.name}</span>
                </div>
              ))}
              {remote.length === 0 && (
                <div className="call-waiting">
                  <Avatar name={title} size={72} />
                  <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
                    {phase === 'ringing' ? 'Waiting for them to pick up…' : 'Connecting…'}
                  </div>
                </div>
              )}
            </div>
          )}

          {!minimized && transcribing && phase === 'live' && captionsOpen && (
            <LiveTranscript captions={captions} meId={user.id} note={speechDead ? `Your side is not being heard: ${speechDead}` : sttNote} />
          )}

          <div className="call-controls">
            <button className={'call-btn' + (micOn ? '' : ' off')} onClick={toggleMic} title={micOn ? 'Mute' : 'Unmute'} aria-label={micOn ? 'Mute' : 'Unmute'}>
              <Ic name={micOn ? 'mic' : 'micOff'} size={19} />
            </button>
            {kind === 'video' ? (
              <button className={'call-btn' + (camOn ? '' : ' off')} onClick={toggleCam} title={camOn ? 'Turn camera off' : 'Turn camera on'} aria-label="Toggle camera">
                <Ic name={camOn ? 'video' : 'videoOff'} size={19} />
              </button>
            ) : (
              <button className="call-btn" onClick={upgradeToVideo} title="Turn on your camera" aria-label="Turn on your camera">
                <Ic name="video" size={19} />
              </button>
            )}
            <button className={'call-btn' + (sharing ? ' active' : '')} onClick={toggleShare} title={sharing ? 'Stop sharing' : 'Share screen'} aria-label="Share screen">
              <Ic name="screen" size={19} />
            </button>
            {/* The live transcript is everyone's words as the server filed
                them; hiding it only hides it here. */}
            <button className={'call-btn' + (captionsOpen && transcribing ? ' active' : '')} onClick={() => setCaptionsOpen((o) => !o)}
              disabled={!transcribing} aria-pressed={captionsOpen}
              title={captionsOpen ? 'Hide the live transcript' : 'Show the live transcript'} aria-label={captionsOpen ? 'Hide the live transcript' : 'Show the live transcript'}>
              <Ic name="captions" size={19} />
            </button>
            {/* The call's transcription switch. On by default; anyone on the
                call may switch it off, and everyone is told who did. What was
                said while it was on still becomes the summary. */}
            <button
              className={'call-btn' + (transcribing ? ' recording' : '')}
              onClick={() => setCallTranscription(!transcribing)}
              disabled={!callId}
              title={transcribing ? 'Transcribing for tasks — press to stop for everyone' : 'Not transcribing — press to transcribe this call for tasks'}
              aria-label={transcribing ? 'Stop transcribing this call' : 'Transcribe this call for tasks'}
              aria-pressed={transcribing}
            >
              <Ic name={transcribing ? 'taskAdd' : 'record'} size={19} />
            </button>
            <button className="call-btn decline" onClick={() => hangUp()} title="Leave the call" aria-label="Leave the call">
              <Ic name="callEnd" size={20} />
            </button>
          </div>
        </div>
      )}

      {/* A call just ended: its write-up, where the call window was. Not
          while another call rings or runs — that has the space. */}
      {phase === 'idle' && !incoming && <CallAnalysisCard me={user} />}
    </>
  )
}

// The call's transcript as it is being written, newest at the bottom. It
// follows the conversation unless you have scrolled up to read something.
function LiveTranscript({ captions, meId, note }: { captions: Caption[]; meId: string; note: string | null }) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [captions.length])
  return (
    <div className="call-captions" aria-live="polite">
      <div className="call-captions-head">
        <span>Live transcript</span>
        {captions.length > 0 && <span className="call-captions-n">{captions.length} line{captions.length === 1 ? '' : 's'}</span>}
      </div>
      {note && <div className="call-captions-note">{note}</div>}
      <div className="call-captions-body" ref={ref}
        onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}>
        {captions.length === 0
          ? <div className="call-captions-empty">Listening… what everyone says appears here.</div>
          : captions.slice(-80).map((c) => (
            <p key={c.id} className={'call-caption' + (c.userId === meId ? ' me' : '')}>
              <b>{c.userId === meId ? 'You' : c.name}</b>{c.text}
            </p>
          ))}
      </div>
    </div>
  )
}

// A <video> whose srcObject has to be set imperatively — React can't express it
// as a prop, and re-setting the same stream restarts playback, so it's guarded.
function VideoTile({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el && stream && el.srcObject !== stream) el.srcObject = stream
  }, [stream])
  return <video ref={ref} autoPlay playsInline />
}

// Audio-only calls still need an element for the remote track to play through.
function AudioSink({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el && stream && el.srcObject !== stream) el.srcObject = stream
  }, [stream])
  return <audio ref={ref} autoPlay />
}
