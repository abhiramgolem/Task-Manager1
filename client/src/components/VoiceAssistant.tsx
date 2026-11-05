import React, { useEffect, useRef, useState } from 'react'
import { useVoiceAssistant } from '../voice/useVoiceAssistant'
import { useWakeWord, wakeWordConfigured, wakeWordPhrase, WakeStatus } from '../voice/wakeword'
import VoiceCard from './VoiceCard'
import VoiceOrb from './VoiceOrb'

// Desktop/tablet widths: the sidebar is always on screen there. Phones keep it
// behind More. Both open the assistant from the sidebar's "Talk to AI" row
// (App.tsx); there is no floating card any more.
const WIDE_MQ = '(min-width: 721px)'

const MicIcon = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v1a7 7 0 0 0 14 0v-1" /><line x1="12" y1="19" x2="12" y2="22" />
  </svg>
)
const SpeakerIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 13" />
  </svg>
)
const SpeakerOffIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 5 6 9H2v6h4l5 4z" /><line x1="22" y1="9" x2="16" y2="15" /><line x1="16" y1="9" x2="22" y2="15" />
  </svg>
)

const STATUS_LABEL: Record<string, string> = {
  idle: 'Tap the mic and speak',
  listening: 'Listening…',
  processing: 'Thinking…',
  speaking: 'Speaking…',
  confirming: 'Say “yes” to confirm, or “no”',
  error: 'Something went wrong',
}
// Short, large-type headline shown on the immersive voice screen for each state.
const BIG_STATUS: Record<string, string> = {
  idle: 'Tap to talk',
  listening: 'Listening…',
  processing: 'Thinking…',
  speaking: 'Speaking…',
  confirming: 'Confirm?',
  error: 'Try again',
}
// One-line subtitle under the headline.
const SUB_STATUS: Record<string, string> = {
  idle: 'Tap the orb below to start',
  listening: 'Speak now',
  processing: 'Analyzing and understanding',
  speaking: 'Playing the response',
  confirming: 'Say “yes” to confirm, or “no”',
  error: 'Please try again',
}
// The four-stage progress rail shown on the voice screen.
const CheckIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
)
const BrainIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 4.5a2.5 2.5 0 0 0-4.6-1.3A2.4 2.4 0 0 0 4.9 6a2.6 2.6 0 0 0-.5 4.4A2.6 2.6 0 0 0 5 15a2.4 2.4 0 0 0 2.6 2.9A2.5 2.5 0 0 0 12 19.5z" />
    <path d="M12 4.5a2.5 2.5 0 0 1 4.6-1.3A2.4 2.4 0 0 1 19.1 6a2.6 2.6 0 0 1 .5 4.4A2.6 2.6 0 0 1 19 15a2.4 2.4 0 0 1-2.6 2.9A2.5 2.5 0 0 1 12 19.5z" />
    <path d="M12 4.5v15" />
  </svg>
)
const BoltIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.5 2 5 13.5h5.5L9.5 22 19 10.5h-5.6z" /></svg>
)
const VOICE_STEPS: { key: string; label: string; icon: React.ReactNode }[] = [
  { key: 'listening', label: 'Listening', icon: <MicIcon size={18} /> },
  { key: 'processing', label: 'Thinking', icon: <BrainIcon /> },
  { key: 'executing', label: 'Executing', icon: <BoltIcon size={17} /> },
  { key: 'complete', label: 'Complete', icon: <CheckIcon /> },
]
// The caption on the "Step n of 4" pill — one per rail stage.
const STEP_HINT = ['Speak now', 'Working it out…', 'Almost there…', 'All done']

// Reassurance grid under the rail. The copy tracks the stage, so it describes
// what's happening right now rather than being generic marketing chrome.
const WaveIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M3 12v1M7 7v10M11 4v16M15 8v8M19 11v2" />
  </svg>
)
const ShieldIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2 4 5.5v6c0 4.6 3.2 8.8 8 10.5 4.8-1.7 8-5.9 8-10.5v-6z" /></svg>
)
const TargetIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
    <circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.4" /><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" strokeLinecap="round" />
  </svg>
)
// Solid silhouettes, not fine line-art: at 18px inside a 34px pill, thin strokes
// with lots of small features (a cog's teeth, a rocket's fins) turn to mush.
const RocketIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 1.5c3.6 2.6 5.6 6.4 5.6 10.4l-2.4 3.2H8.8l-2.4-3.2C6.4 7.9 8.4 4.1 12 1.5zm0 5.2a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
    <path d="M8.4 16.6 5.6 19l3.1-.5zM15.6 16.6 18.4 19l-3.1-.5zM10.4 17.4 12 22.5l1.6-5.1z" />
  </svg>
)
// A closed automation loop reads instantly at this size where a cog does not.
const LoopIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M4 12a8 8 0 0 1 13.7-5.6" /><path d="M20 12a8 8 0 0 1-13.7 5.6" />
    <path d="M18 2.6v4h-4M6 21.4v-4h4" strokeLinejoin="round" />
  </svg>
)
type Feature = { icon: React.ReactNode; title: string; sub: string }
const FEATURES: Record<string, Feature[]> = {
  listening: [
    { icon: <WaveIcon />, title: 'Real-time Listening', sub: 'Captures your voice instantly' },
    { icon: <BoltIcon />, title: 'Action Oriented', sub: 'Understands and gets things done' },
    { icon: <ShieldIcon />, title: 'Secure & Private', sub: 'Your data stays protected' },
    { icon: <TargetIcon />, title: 'Always by your side', sub: 'Your intelligent co-pilot' },
  ],
  processing: [
    { icon: <WaveIcon />, title: 'Real-time Listening', sub: 'Captures your voice instantly' },
    { icon: <TargetIcon />, title: 'Accurate Understanding', sub: 'Powered by LLMs & RAG' },
    { icon: <ShieldIcon />, title: 'Secure & Private', sub: 'Your data stays protected' },
    { icon: <BoltIcon />, title: 'Action Oriented', sub: 'Turns words into real actions' },
  ],
  executing: [
    { icon: <RocketIcon />, title: 'Real-time Execution', sub: 'Actions happen in real-time' },
    { icon: <LoopIcon />, title: 'Task Automation', sub: 'Automating complex tasks for you' },
    { icon: <ShieldIcon />, title: 'Secure & Reliable', sub: 'Your data is always protected' },
    { icon: <BoltIcon />, title: 'Action Oriented', sub: 'Turning words into real results' },
  ],
}

export default function VoiceAssistant() {
  const v = useVoiceAssistant()
  const logRef = useRef<HTMLDivElement>(null)
  const [confirmPw, setConfirmPw] = useState('')
  const [wake, setWake] = useState<{ status: WakeStatus; detail?: string }>({ status: 'off' })
  // Per-login coachmark: introduces voice (the app's core feature) once each time
  // the user logs in. The flag is set when it shows (so it doesn't re-pop as they
  // navigate — the assistant remounts per route) and CLEARED on login (see auth.tsx),
  // so a fresh sign-in shows it again. Dismissed by Try it / Got it / ✕, by opening
  // the assistant, or automatically after a while.
  const [coach, setCoach] = useState(false)

  // Where the coachmark points: at the sidebar row (wide) or at More (phone).
  const [wide, setWide] = useState(() => window.matchMedia(WIDE_MQ).matches)
  useEffect(() => {
    const mq = window.matchMedia(WIDE_MQ)
    const sync = () => setWide(mq.matches)
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  // Wake word ("hey VoTask") — starts a session when heard. No-op until configured;
  // paused while a session is already open so it doesn't retrigger mid-conversation.
  useWakeWord({
    enabled: !v.open,
    onWake: v.start,
    onStatus: (status, detail) => setWake({ status, detail }),
  })

  const dismissCoach = () => {
    setCoach(false)
    try { localStorage.setItem('befach_voice_coach', 'seen') } catch { /* storage off */ }
  }

  // Show the coachmark shortly after login (once per login), unless already shown
  // this session. Marking it seen the moment it appears keeps it from re-popping
  // when the assistant remounts on navigation.
  useEffect(() => {
    let seen = false
    try { seen = localStorage.getItem('befach_voice_coach') === 'seen' } catch { seen = false }
    if (seen) return
    const show = setTimeout(() => {
      setCoach(true)
      try { localStorage.setItem('befach_voice_coach', 'seen') } catch { /* storage off */ }
    }, 1400)
    const hide = setTimeout(() => setCoach(false), 16000) // auto-hide so it's never sticky
    return () => { clearTimeout(show); clearTimeout(hide) }
  }, [])

  // Opening the assistant counts as "seen".
  useEffect(() => { if (v.open) dismissCoach() }, [v.open])

  // The phone drawer's "Talk to AI" row (in App's Layout) opens the assistant by
  // firing an 'open-voice' event — listen for it here where the voice state lives.
  useEffect(() => {
    const open = () => v.start()
    window.addEventListener('open-voice', open)
    return () => window.removeEventListener('open-voice', open)
  }, [v])

  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight) }, [v.messages, v.state])

  // The step the agent is on right now, if any. Drives the minimized bar's caption.
  const running = v.trace.find((s) => s.status === 'running')

  // Which of the four rail stages we're on. "Thinking" and "Executing" both live
  // inside the `processing` state — the tools only start running once the model
  // has decided what to do, so the arrival of a trace step is what separates them.
  const step = v.state === 'listening' ? 0
    : v.state === 'processing' ? (v.trace.length ? 2 : 1)
    : v.state === 'speaking' || v.state === 'confirming' ? 2
    : v.messages.length ? 3 : 0
  // The grid is stage-flavoured, and only while the stage is all there is to show.
  const features = v.messages.length || v.trace.length
    ? null
    : FEATURES[v.state === 'processing' ? 'processing'
      : v.state === 'speaking' || v.state === 'confirming' ? 'executing'
      : 'listening']

  return (
    <>
    <div className="va-root">
      {/* Minimized bar — the session stays live over the page, so the user can
          keep giving commands (speak or tap) without re-triggering the wake word.
          This is also what's on screen WHILE the agent drives the app. */}
      {v.open && v.minimized && (
        <div className={'va-mini va-mini--' + v.state} role="dialog" aria-label="Voice assistant (minimized)">
          <button className="va-mini-orb" onClick={v.micButton} title={v.state === 'listening' ? 'Stop' : 'Talk'} aria-label={v.state === 'listening' ? 'Stop' : 'Talk'}>
            {v.state === 'processing'
              ? <span className="spinner" />
              : v.state === 'listening'
                ? <span className="va-mini-wave" aria-hidden="true"><i /><i /><i /><i /></span>
                : <MicIcon size={20} />}
          </button>
          <div className="va-mini-text">
            <div className="va-mini-title">VoTask</div>
            <div className="va-mini-status">
              {/* While a plan runs, the mini bar IS the narration — the panel is
                  collapsed precisely so the user can watch the page work, so the
                  current step has to be legible here rather than only in the panel. */}
              {running ? running.label
                : v.state === 'listening' ? (v.liveText || 'Listening — say your next command')
                : v.state === 'processing' ? 'Working…'
                : v.state === 'speaking' ? 'Speaking…'
                : 'Tap to talk'}
            </div>
          </div>
          <button className="va-mini-btn" onClick={() => v.setMinimized(false)} title="Expand" aria-label="Expand">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
          </button>
          <button className="va-mini-btn" onClick={v.close} title="Close" aria-label="Close">✕</button>
        </div>
      )}

      {v.open && !v.minimized && (
        <div className={'va-panel va-panel--' + v.state} role="dialog" aria-label="Voice assistant">
          <div className="va-head">
            <button className="va-iconbtn" title="Close" onClick={v.close} aria-label="Close">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <div className="va-head-title">AI Voice Assistant</div>
            <button className="va-iconbtn" title={v.ttsOn ? 'Mute voice replies' : 'Unmute voice replies'} onClick={() => v.setTtsOn(!v.ttsOn)}>
              {v.ttsOn ? <SpeakerIcon /> : <SpeakerOffIcon />}
            </button>
          </div>

          {/* Immersive focal point: status → glowing orb → progress rail. */}
          <div className="va-stage">
            <div className="va-online"><span className="va-online-dot" /> Online</div>
            {/* Once the tools start firing, "Thinking" is no longer honest — the
                headline follows the rail rather than the raw state. */}
            <div className="va-bigstatus">{step === 2 && v.state === 'processing' ? 'Executing…' : (BIG_STATUS[v.state] || STATUS_LABEL[v.state] || '')}</div>
            <div className="va-substatus">{step === 2 && v.state === 'processing' ? 'Getting things done for you' : (SUB_STATUS[v.state] || '')}</div>

            <button className={'va-orb va-orb--' + v.state} onClick={v.micButton} aria-label={v.state === 'listening' ? 'Stop listening' : 'Start talking'}>
              <VoiceOrb state={v.state} />
            </button>

            <div className="va-orb-action">
              {v.state === 'listening' ? 'Tap to stop' : v.state === 'idle' ? 'Tap to talk' : v.state === 'processing' ? 'Please wait a moment' :' '}
            </div>

            {/* What the recognizer has heard SO FAR — words land as they're spoken.
                Doubles as failure transparency: a mishear is visible before the
                agent acts on it, so "it heard me wrong" replaces "it went mad". */}
            {v.state === 'listening' && v.liveText && (
              <div className="va-livetext">“{v.liveText}”</div>
            )}

            {/* "Step 3 of 4 · Almost there…" — only once a command is in flight;
                the idle screen has no progress to report. */}
            {v.state !== 'idle' && (
              <div className="va-stepchip">Step {step + 1} of 4 <span>·</span> {STEP_HINT[step]}</div>
            )}

            {/* Four-stage progress rail. */}
            <div className="va-steps">
              {VOICE_STEPS.map((s, i) => (
                <React.Fragment key={s.key}>
                  {i > 0 && <span className={'va-step-line' + (i <= step ? ' done' : '')} />}
                  <div className={'va-step' + (i === step ? ' active' : '') + (i < step ? ' done' : '')}>
                    <span className="va-step-ic">{s.icon}</span>
                    <span className="va-step-label">{s.label}</span>
                    <span className="va-step-dot">{i < step && <CheckIcon size={13} />}</span>
                  </div>
                </React.Fragment>
              ))}
            </div>

            {/* Reassurance grid. Dropped the moment there's a transcript or a
                trace to read — real output outranks it for the space. */}
            {features && (
              <div className="va-feats">
                {features.map((f) => (
                  <div className="va-feat" key={f.title}>
                    <span className="va-feat-ic">{f.icon}</span>
                    <span className="va-feat-text"><b>{f.title}</b><i>{f.sub}</i></span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {v.messages.length > 0 && (
            <div className="va-log" ref={logRef}>
              {v.messages.map((m, i) => (
                <React.Fragment key={i}>
                  <div className={'va-msg va-msg--' + m.role}>{m.text}</div>
                  {/* Read tools return figures — show them, don't just say them. */}
                  {m.card && <VoiceCard data={m.card} />}
                </React.Fragment>
              ))}
            </div>
          )}

          {/* What the agent is doing, step by step. This is the "watch it work"
              half of the experience: the panel narrates while the page behind it
              actually changes, so a multi-step plan is legible rather than a pause
              followed by "done". Cleared at the start of each new command. */}
          {v.trace.length > 0 && (
            <div className="va-trace">
              {v.trace.map((s) => (
                <div key={s.id} className={'va-trace-step va-trace-step--' + s.status}>
                  <span className="va-trace-mark" aria-hidden="true">
                    {s.status === 'running' ? <span className="spinner" /> : s.status === 'done' ? '✓' : s.status === 'failed' ? '✕' : '–'}
                  </span>
                  <span className="va-trace-label">{s.label}</span>
                  {s.detail && <span className="va-trace-detail">{s.detail}</span>}
                </div>
              ))}
            </div>
          )}

          {/* A suspended plan. `slot` questions are answered by just talking, so
              they need no buttons — only a confirmation gets yes/no. */}
          {v.pending && v.pending.kind !== 'slot' && (
            <div className="va-confirm">
              <div className="va-confirm-summary">
                {v.pending.meta?.needsPassword
                  ? <>{v.pending.summary}? Enter your password to confirm.</>
                  : v.pending.summary || v.pending.question}
              </div>
              {v.pending.meta?.needsPassword && (
                <input
                  type="password"
                  className="va-confirm-pw"
                  placeholder="Your password"
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && confirmPw) { v.confirmPending(confirmPw); setConfirmPw('') } }}
                  autoFocus
                />
              )}
              <div className="row" style={{ gap: 8 }}>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!!v.pending.meta?.needsPassword && !confirmPw}
                  onClick={() => { const pw = v.pending?.meta?.needsPassword ? confirmPw : undefined; setConfirmPw(''); v.confirmPending(pw) }}
                >✓ Confirm</button>
                <button className="btn btn-sm va-cancel" onClick={() => { setConfirmPw(''); v.cancelPending() }}>✕ Cancel</button>
              </div>
            </div>
          )}

          <div className="va-foot">
            {v.state === 'idle' && v.messages.length === 0 ? (
              <button className="va-mic" onClick={v.micButton} aria-label="Start talking"><MicIcon size={28} /></button>
            ) : (
              <button className="va-cancelbtn" onClick={v.close}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </div>

    {/* Holds the one-time coachmark. The assistant itself opens from the
        sidebar's "Talk to AI" row: on a wide screen the tip sits beside it, on
        a phone above the tab bar, pointing at More. */}
    <div className={'va-dock' + (wide ? ' va-dock--side' : '')}>
      {/* One-time first-visit coachmark, so people discover voice — the
          product's main feature. */}
      {!v.open && coach && (
        <div className="va-coach" role="dialog" aria-label="Voice assistant tip">
          <button className="va-coach-x" onClick={dismissCoach} aria-label="Dismiss">✕</button>
          <span className="va-coach-badge">NEW</span>
          <div className="va-coach-title">Control the app with your voice</div>
          <div className="va-coach-sub">Create tasks, check workload, open meetings — just talk. {wide ? <>Tap <b>Talk to AI</b> in the menu</> : <>Tap <b>More</b>, then <b>Talk to AI</b></>}{wakeWordConfigured() && <>, or say <b>“{wakeWordPhrase()}”</b></>}.</div>
          <div className="va-coach-actions">
            <button className="btn btn-primary btn-sm" onClick={() => { dismissCoach(); v.start() }}>Try it</button>
            <button className="va-coach-later" onClick={dismissCoach}>Got it</button>
          </div>
        </div>
      )}
    </div>
    </>
  )
}
