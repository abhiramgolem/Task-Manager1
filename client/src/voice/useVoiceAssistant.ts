// The voice assistant's conversation loop. Owns the hands-free state machine:
//
//   armed ──(wake word / tap)──▶ listening ──▶ processing ──▶ run the plan
//        ▲                                                       │
//        │                                       ┌───────────────┴────────────┐
//        │                                    finished                    suspended
//        │                                       │                  (needs a slot, a
//        └──────── speak, then re-open mic ──────┴───── ask, then ──── yes/no, or a
//                                                       re-open mic     correction)
//
// Each turn records until the speaker goes quiet (recorder VAD), transcribes via the
// multilingual endpoint, and asks POST /assistant/command what to do. What comes
// back is adapted into an Action Engine plan (serverPlan.ts) and executed there —
// this file no longer knows how any individual action is performed.
//
// That split is the point. Previously this hook held a switch over action kinds and
// called the REST API directly, which meant a voice edit and a hand edit were two
// different code paths, and the user saw nothing happen between "shall I?" and
// "done". Now the engine drives the real screens (tools.ts), so the work is visible,
// and the loop's only remaining job is the CONVERSATION: listen, ask the question
// the engine suspended on, feed the answer back, speak the result.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, API_BASE, getToken } from '../api'
import { useAuth } from '../auth'
import { startRecording, canRecord } from './recorder'
import { startLiveListen } from './liveStt'
import { startPcmStream } from '../lib/pcmStream'
import { speak, stopSpeaking, isTtsEnabled, setTtsEnabled } from './tts'
import { runPlan, answerAndResume, type Outcome, type ToolContext } from './actionEngine'
import { planFromServer, undoPlan } from './serverPlan'
import { on, resetTrace, emit, type TraceStep } from './agentBus'
import { setAgentTurn } from './agentTurn'
// Side-effect import: registers every tool in the table. Without it the engine
// knows no tools and every plan fails as "not able to do that yet".
import './tools'

// Barge-in sensitivity. The threshold sits above liveStt's 0.045 speech gate
// because echo cancellation leaves a little of the assistant's own voice behind,
// and 350ms of it rules out a cough, a door, or a single leaked syllable.
const BARGE_THRESHOLD = 0.075
const BARGE_MS = 350

export type VoiceState = 'idle' | 'listening' | 'processing' | 'confirming' | 'speaking' | 'error'

// A read tool (overview / workload / grouping) returns figures the UI renders as a
// card. `type` picks the renderer; the shape follows from the tool that produced it.
export interface VoiceCardData {
  type: 'overview' | 'workload' | 'group'
  label?: string
  title?: string
  stats?: Record<string, number>
  rows?: { id?: string; name?: string; label?: string; c: number }[]
  total?: number
}
// A message is either spoken text or a data card rendered inline in the panel.
export interface VoiceMsg { role: 'user' | 'ai'; text: string; card?: VoiceCardData }

// The engine stopped and needs something from the user. Kept in state so the panel
// can render the right affordance: yes/no buttons for a confirmation, a password
// field when removing a teammate, or nothing at all for a spoken slot answer.
export type Suspended = Extract<Outcome, { status: 'suspended' }>

const YES_RE = /\b(yes|yeah|yep|yup|sure|ok|okay|okey|confirm|confirmed|correct|right|go ahead|do it|please do|haan|haa|ha|ji|karo|sari|sare|avunu|cheyyi|cheyandi|cheyyandi)\b/i
const NO_RE = /\b(no|nope|nah|cancel|cancelled|don'?t|stop|nahi|nahin|mat|vddu|venda|vodhu|leave it|never mind|nevermind)\b/i
// Undo the LAST instant mutation. Matched client-side, no LLM round-trip — the one
// moment the user most wants speed is right after watching the wrong thing happen.
const UNDO_RE = /\b(undo|revert|reverse (?:that|it)|take (?:that|it) back|wapas|vapas|venakki)\b/i

export function useVoiceAssistant() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<VoiceState>('idle')
  const [messages, setMessages] = useState<VoiceMsg[]>([])
  const [level, setLevel] = useState(0)
  const [pending, setPending] = useState<Suspended | null>(null)
  // The live step list the panel renders. Mirrors agentBus, which is the source of
  // truth — the engine and the tools push to it from outside React.
  const [trace, setTrace] = useState<TraceStep[]>([])
  const [ttsOn, setTtsOnState] = useState(isTtsEnabled())
  // Minimized = the session stays live in a small bar (page visible) so the user
  // can keep giving commands without re-triggering the wake word.
  const [minimized, setMinimized] = useState(false)

  // What the streaming recognizer has heard SO FAR this turn — rendered live in
  // the panel so the user watches their words land as they speak. Doubles as
  // failure transparency: a mishear is visible before the agent acts on it.
  const [liveText, setLiveText] = useState('')

  // Refs mirror state for use inside the async turn loop (avoids stale closures).
  const sessionRef = useRef(0)          // bump to invalidate an in-flight loop
  // Both capture paths (streaming listener / classic recorder) expose stop/cancel;
  // the ref only ever drives those two, so the union keeps micButton path-agnostic.
  const recRef = useRef<{ stop: () => void; cancel: () => void } | null>(null)
  // Whether this deployment supports streaming STT. Optimistic until a connection
  // attempt fails (no Sarvam key, proxy without WS) — then the classic
  // record→upload→transcribe path carries every later turn, no re-probing.
  const liveSttRef = useRef(true)
  // Undo-first state. `undoCandidate` is the inverse that arrived with a 'do'
  // response — it only becomes `undoRef` (the thing "undo" replays) once the
  // action actually SUCCEEDED, so undo can never "revert" a change that failed.
  // One level deep by design: "undo" means the last thing, not a history walk.
  const undoRef = useRef<{ action: any; turnId: string | null } | null>(null)
  const undoCandidateRef = useRef<any>(undefined)   // undefined = this turn wasn't a mutation
  const undoHintedRef = useRef(false)   // say "say undo to reverse it" once per session
  // The server logs every command as a voice_turn and wants to know what became of
  // it — executed, cancelled, undone, failed. That label is what turns the log into
  // training data (and it gates alias learning), so report faithfully, best-effort.
  const turnRef = useRef<string | null>(null)
  const reportOutcome = (turnId: string | null, outcome: 'executed' | 'cancelled' | 'undone' | 'failed') => {
    if (turnId) api.post(`/assistant/turns/${turnId}/outcome`, { outcome }).catch(() => {})
  }
  const pendingRef = useRef<Suspended | null>(null)
  const msgsRef = useRef<VoiceMsg[]>([])
  const emptyStreakRef = useRef(0)
  const openRef = useRef(false)
  const minimizedRef = useRef(false)
  msgsRef.current = messages
  pendingRef.current = pending
  openRef.current = open
  minimizedRef.current = minimized

  const push = (m: VoiceMsg) => setMessages((ms) => [...ms.slice(-20), m])
  const setPend = (p: Suspended | null) => { pendingRef.current = p; setPending(p) }

  // Mirror the bus into React state for rendering.
  useEffect(() => on('trace', ({ steps }) => setTrace(steps)), [])

  // Announce that the user is talking to the agent, so anything else listening to
  // the same microphone can leave that speech out of its own transcript. See
  // agentTurn.ts — without this a voice command lands inside the meeting it was
  // issued about. Gated on `state` as well as `open`, so a panel left parked at
  // idle (nobody speaking) does not hold the mic hostage.
  useEffect(() => { setAgentTurn(open && state !== 'idle') }, [open, state])
  useEffect(() => () => setAgentTurn(false), [])

  const setTtsOn = (on: boolean) => { setTtsEnabled(on); setTtsOnState(on) }

  // ---- server calls --------------------------------------------------------
  const transcribeBlob = async (blob: Blob): Promise<string> => {
    const fd = new FormData()
    fd.append('audio', blob, 'command.webm')
    const headers: Record<string, string> = {}
    const token = getToken()
    if (token) headers.authorization = `Bearer ${token}`
    const res = await fetch(`${API_BASE}/api/tasks/transcribe`, { method: 'POST', headers, body: fd, cache: 'no-store' })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error || 'Transcription failed')
    return String(data?.text || '').trim()
  }

  const sendCommand = (transcript: string) =>
    api.post('/assistant/command', { transcript, history: msgsRef.current.slice(-8) })

  // ---- the engine's view of the app ---------------------------------------
  // Injected rather than imported by the tools, so nothing in the tool table has a
  // React or router dependency. Rebuilt each render; the engine only reads it
  // during a run, so a stale closure can't outlive a turn.
  const ctx: ToolContext = {
    navigate: (url: string) => navigate(url),
    say: (text: string) => say(text),
    user: user ? { id: user.id, name: user.name, role: user.role } : null,
  }

  // Hand the microphone back and end the session.
  //
  // The loop's normal behaviour is to keep re-opening the mic so a conversation
  // flows without repeating the wake word. That is wrong the moment the agent has
  // just put a DIFFERENT listener in charge of the microphone: after "start the
  // meeting", a still-live assistant session records the opening minute of the
  // meeting as if it were a command, and the gate in agentTurn.ts — doing its job —
  // keeps that same minute out of the meeting transcript. Both listeners would be
  // behaving correctly and the user would lose the audio. So the agent gets out of
  // the way, and the wake word brings it back.
  const yieldSession = () => {
    sessionRef.current++
    try { recRef.current?.cancel() } catch {}
    recRef.current = null
    undoRef.current = null
    undoCandidateRef.current = undefined
    openRef.current = false
    setMinimized(false)
    setOpen(false)
    setState('idle')
  }

  // ---- react to whatever the engine did ------------------------------------
  // Three ways a run ends, and each one leaves the conversation somewhere different:
  // finished (speak the result), suspended (ask, and keep the mic open for the
  // answer), or failed (say why — the trace already shows which step broke).
  const handleOutcome = async (outcome: Outcome) => {
    // Which session this outcome belongs to. Standing down is the only thing here
    // that reaches outside the current turn, and there is a real gap to lose: the
    // user can say the wake word again while the agent is still speaking its reply,
    // which starts a NEW session. Tearing that one down because the previous
    // outcome asked to yield would swallow the command they just gave.
    const turn = sessionRef.current
    if (outcome.status === 'suspended') {
      setPend(outcome)
      setMinimized(false)                 // the question has to be readable
      setState('confirming')
      push({ role: 'ai', text: outcome.question })
      await say(outcome.question)
      return
    }
    if (outcome.status === 'failed') {
      setPend(null)
      setMinimized(false)
      undoCandidateRef.current = undefined       // a failed action must not become undoable
      reportOutcome(turnRef.current, 'failed'); turnRef.current = null
      push({ role: 'ai', text: outcome.say })
      await say(outcome.say)
      return
    }
    setPend(null)
    reportOutcome(turnRef.current, 'executed'); turnRef.current = null
    // The inverse becomes live only now that the action actually succeeded — so
    // "undo" can never claim to revert a change that never happened. Hint at it
    // the first time only; repeating it on every action is nagging, not teaching.
    let hint = ''
    if (undoCandidateRef.current !== undefined) {
      undoRef.current = undoCandidateRef.current
      undoCandidateRef.current = undefined
      if (undoRef.current && !undoHintedRef.current) {
        undoHintedRef.current = true
        hint = ' Say undo if you want to reverse it.'
      }
    }
    const data = outcome.results.find((r) => r.data)?.data
    // A card has figures worth reading, so expand for it. A plain success stays
    // minimized: the result is the page behind the bar (the highlighted new row),
    // and popping the panel back over it would hide the thing just accomplished.
    const card = data?.type === 'task' ? undefined : data
    if (card) setMinimized(false)
    push({ role: 'ai', text: outcome.say + hint, card })
    await say(outcome.say + hint)
    // Speak first, THEN stand down: the reply has to be heard, and the gate's tail
    // is what keeps it off the meeting's transcript.
    if (outcome.results.some((r) => r.endSession) && sessionRef.current === turn) yieldSession()
  }

  // Start a fresh plan. The trace resets here and nowhere else, so every step the
  // agent takes for ONE utterance stays visible together.
  const execute = async (plan: Parameters<typeof runPlan>[0]) => {
    setState('processing')
    emit('phase', { phase: 'executing' })
    resetTrace('new command')
    await handleOutcome(await runPlan(plan, ctx))
  }

  // Continue a suspended plan with the user's answer.
  //
  // Collapse again before resuming. handleOutcome EXPANDED the panel to show the
  // question, and without this the rest of the plan would run behind a full-screen
  // panel — so a confirmed action (which is every destructive one, and the only
  // kind another person sees) would be the one case the user never gets to watch.
  const resume = async (p: Suspended, answer: string | boolean, extra?: Record<string, any>) => {
    setState('processing')
    setPend(null)
    if (answer !== false) setMinimized(true)
    await handleOutcome(await answerAndResume(p, answer, ctx, extra))
  }

  // ---- speak + reflect state ----------------------------------------------
  //
  // Speaking listens too. Until now the mic was closed for the whole reply, so
  // talking over the assistant did nothing — you had to wait it out or tap the
  // orb. A conversation where only one side may interrupt is not a conversation.
  //
  // The monitor watches levels only; it never sends audio anywhere, so nothing is
  // transcribed or billed. Two guards stop the assistant hearing ITSELF: the mic
  // is opened with echoCancellation (pcmStream already does), and a barge-in
  // needs sustained speech — BARGE_MS above a threshold well over the residue
  // that survives cancellation — so a stray knock or the tail of its own
  // sentence cannot trigger it.
  const say = async (text: string) => {
    setState('speaking')
    let monitor: { stop: () => void } | null = null
    let bargedIn = false
    try {
      let loudFor = 0
      let lastAt = performance.now()
      monitor = await startPcmStream(
        () => {},                                   // frames discarded — levels only
        () => {},                                   // mic unavailable: just no barge-in
        (rms) => {
          const now = performance.now()
          const dt = now - lastAt
          lastAt = now
          loudFor = rms >= BARGE_THRESHOLD ? loudFor + dt : 0
          if (loudFor >= BARGE_MS && !bargedIn) {
            bargedIn = true
            // Logged because the failure mode is the assistant hearing ITSELF: if
            // this fires with no one talking, echo cancellation is not holding and
            // BARGE_THRESHOLD needs raising.
            console.warn(`[voice] barge-in: cut the reply off (rms ${rms.toFixed(3)} for ${Math.round(loudFor)}ms)`)
            stopSpeaking()
          }
        },
      )
    } catch { /* no mic while speaking — falls back to the old uninterruptible reply */ }
    try {
      await speak(text)
    } finally {
      try { monitor?.stop() } catch {}
    }
  }

  // The loop went quiet: a minimized (background) session just closes; a full
  // open session parks at idle so the user can tap the orb to talk again.
  const endOnSilence = () => {
    if (minimizedRef.current) { setMinimized(false); setOpen(false) }
    else setState('idle')
  }

  const handleResponse = async (resp: any) => {
    const bridged = planFromServer(resp)

    // Nothing to execute: an answer or a clarifying question. Speak it, show any
    // figures the server computed, and open the matching view if one was suggested.
    if (!bridged.plan) {
      setMinimized(false)                 // expand so cards/figures are visible
      const text = bridged.say || "Sorry, I didn't understand."
      push({ role: 'ai', text, card: bridged.data || undefined })
      await say(text)
      if (bridged.navigateUrl) navigate(bridged.navigateUrl)
      return
    }

    // A fresh command changes what "undo" refers to. A MUTATING plan stages its
    // own inverse (possibly none) and invalidates the previous one; a navigation
    // or meeting-control plan leaves the standing undo alone — moving around the
    // app shouldn't cost the user their safety net.
    const MUTATING = new Set(['create_task', 'set_status', 'assign_task', 'update_task', 'add_comment',
      'send_message', 'delete_task', 'plan', 'read_notifications', 'invite_user', 'remove_user', 'approve_suggestions', 'post_update'])
    turnRef.current = resp?.turn_id || null
    if (MUTATING.has(String(bridged.plan.intent || ''))) {
      undoRef.current = null
      // The turn id rides along so an eventual "undo" can relabel THIS turn as
      // undone on the server — the strongest "the agent got it wrong" signal there is.
      undoCandidateRef.current = bridged.undo ? { action: bridged.undo, turnId: resp?.turn_id || null } : null
    } else {
      undoCandidateRef.current = undefined
    }

    // Shrink to the mini bar before ANY plan runs. The full-screen panel covers the
    // whole app, so leaving it up while the agent fills a form means the user is
    // told what happened but never sees it — which defeats the entire point of
    // driving the real UI instead of calling the API. The mini bar keeps the session
    // live (so the next command needs no wake word) and keeps the trace visible
    // while the page behind it actually changes.
    //
    // handleOutcome expands again the moment the agent needs the user back: a
    // question, a confirmation, a failure, or figures to show.
    setMinimized(true)
    await execute(bridged.plan)
  }

  // ---- the conversational loop (records → interprets → acts → repeats) -----
  // Keeps re-opening the mic so the exchange flows; ends (→ armed) when the user
  // goes silent. `sessionRef` invalidates the loop if the user stops/closes.
  const runTurn = useCallback(async (): Promise<void> => {
    const mySession = sessionRef.current
    const alive = () => sessionRef.current === mySession && openRef.current

    while (alive()) {
      // 1+2. Listen and transcribe. The streaming path does both AT ONCE: PCM goes
      // up while the user speaks, so the transcript is ready the moment they stop
      // — no upload, no REST transcription wait. The classic record→upload path is
      // the fallback for deployments without Sarvam streaming (and mic failures).
      setState('listening'); setLevel(0); setLiveText('')
      const t0 = performance.now()
      let text = ''
      let listened = false
      if (liveSttRef.current) {
        try {
          const live = await startLiveListen({
            onPartial: (t) => { if (alive()) setLiveText(t) },
            onLevel: (l) => { if (alive()) setLevel(l) },
          })
          recRef.current = live
          text = await live.done
          listened = true
          console.debug(`[voice] listen+stt (streaming) ${Math.round(performance.now() - t0)}ms`)
        } catch {
          // Couldn't establish the stream — remember and fall through to classic.
          liveSttRef.current = false
        }
        recRef.current = null
        setLiveText('')
        if (!alive()) return
      }
      if (!listened) {
        let blob: Blob
        try {
          const rec = await startRecording({ onLevel: (l) => { if (alive()) setLevel(l) } })
          recRef.current = rec
          blob = await rec.done
        } catch {
          const m = 'I need microphone access to listen.'
          push({ role: 'ai', text: m }); setState('idle'); await speak(m); return
        }
        recRef.current = null
        if (!alive()) return

        // Silence ends the loop → armed; any pending confirmation stays on screen
        // so its yes/no buttons still work.
        setState('processing'); setLevel(0)
        if (!blob.size) { endOnSilence(); return }
        try { text = await transcribeBlob(blob) } catch { /* treat as empty */ }
        console.debug(`[voice] listen+stt (classic) ${Math.round(performance.now() - t0)}ms`)
        if (!alive()) return
      }
      setState('processing'); setLevel(0)
      if (!text) {
        emptyStreakRef.current++
        if (emptyStreakRef.current >= 2) { endOnSilence(); return }
        await say("Sorry, I didn't catch that.")
        continue
      }
      emptyStreakRef.current = 0
      push({ role: 'user', text })

      // 3. If a plan is suspended, this utterance is most likely its answer.
      const pend = pendingRef.current
      if (pend) {
        if (pend.kind === 'slot') {
          // A missing field is answered with free text ("Fix the login bug"), so
          // there is nothing to interpret — hand it straight back to the engine.
          // A password slot never reaches here: those are typed, not spoken.
          await resume(pend, text)
          continue
        }
        // confirm / recover are yes-or-no.
        const yes = YES_RE.test(text), no = NO_RE.test(text)
        if (yes && !no) { await resume(pend, true); continue }
        if (no && !yes) {
          // Label first: the engine answers a declined confirm with a DONE outcome
          // ("Okay, cancelled."), which must not be recorded as executed.
          reportOutcome(turnRef.current, 'cancelled'); turnRef.current = null
          await resume(pend, false); continue
        }
        // Neither, or both — the user said something else entirely, which in
        // practice means they are correcting themselves. Drop the pending plan and
        // treat this as a fresh command.
        setPend(null)
      }

      // 3.5. Spoken undo — resolved right here, no server round-trip. The moment a
      // user most wants speed is right after watching the wrong thing happen, and
      // the inverse action is already sitting in hand.
      if (UNDO_RE.test(text)) {
        const u = undoRef.current
        undoRef.current = null
        undoCandidateRef.current = undefined     // an undo is not itself undoable
        if (u) {
          // Relabel the original turn as undone — the clearest correction signal
          // the learning log gets.
          reportOutcome(u.turnId, 'undone')
          turnRef.current = null                 // the undo plan itself is not a server turn
          setMinimized(true)
          await execute(undoPlan(u.action))
          continue
        }
        await say("There's nothing recent I can undo.")
        continue
      }

      // 4. Ask the brain what to do, then act on it.
      let resp: any
      const tBrain = performance.now()
      try { resp = await sendCommand(text) }
      catch { const m = 'I had trouble with that — please try again.'; push({ role: 'ai', text: m }); await say(m); continue }
      console.debug(`[voice] brain ${Math.round(performance.now() - tBrain)}ms`)
      if (!alive()) return
      await handleResponse(resp)
      // loop → re-open the mic for the next command
    }
  }, [])

  // ---- public controls -----------------------------------------------------
  const start = useCallback(() => {
    setMinimized(false)
    if (!canRecord()) { push({ role: 'ai', text: 'Voice needs microphone access on this device.' }); setOpen(true); return }
    setOpen(true)
    emptyStreakRef.current = 0
    sessionRef.current++
    openRef.current = true
    runTurn()
  }, [runTurn])

  const stop = useCallback(() => {
    sessionRef.current++
    try { recRef.current?.cancel() } catch {}
    recRef.current = null
    stopSpeaking()
    setPend(null)
    // The session's context is gone with it — an "undo" spoken minutes later, cold,
    // reverting something no longer on screen would be a surprise, not a rescue.
    undoRef.current = null
    undoCandidateRef.current = undefined
    setMinimized(false)
    setState('idle')
  }, [])

  const close = useCallback(() => { stop(); setOpen(false) }, [stop])

  // The panel's mic button: finalize the current turn if listening, barge-in past
  // TTS if speaking, or kick off a fresh turn when idle.
  const micButton = useCallback(() => {
    if (state === 'listening') { try { recRef.current?.stop() } catch {}; return }
    if (state === 'speaking') { stopSpeaking(); return }
    if (state === 'idle') {
      setOpen(true); emptyStreakRef.current = 0; sessionRef.current++; openRef.current = true; runTurn()
    }
  }, [state, runTurn])

  // Manual confirm / cancel buttons on the pending card — the tap equivalent of
  // saying yes or no. `password` is supplied only for actions that require re-auth
  // (removing a teammate), which is typed into the card rather than spoken.
  const confirmPending = useCallback(async (password?: string) => {
    const p = pendingRef.current
    if (!p) return
    // Stop the mic first: the button was pressed, so the recorder is mid-turn and
    // would otherwise transcribe the room while the plan runs.
    sessionRef.current++
    try { recRef.current?.cancel() } catch {}
    await resume(p, true, password ? { password } : undefined)
    sessionRef.current++; openRef.current = true; runTurn()
  }, [runTurn])

  const cancelPending = useCallback(() => {
    const p = pendingRef.current
    setPend(null)
    undoCandidateRef.current = undefined   // the action it belonged to was abandoned
    reportOutcome(turnRef.current, 'cancelled'); turnRef.current = null
    const m = 'Okay, cancelled.'
    push({ role: 'ai', text: m }); speak(m)
    if (p) resetTrace('cancelled')
  }, [])

  useEffect(() => () => { sessionRef.current++; try { recRef.current?.cancel() } catch {}; stopSpeaking() }, [])

  return {
    open, state, messages, level, pending, trace, ttsOn, minimized, liveText,
    start, stop, close, micButton, confirmPending, cancelPending, setTtsOn,
    setOpen, setMinimized,
  }
}
