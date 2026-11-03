import React, { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useSurface } from '../voice/uiRegistry'
import { pickValue, flashPress, pause, settle, findVaEl } from '../voice/uiController'
import { agentHasMic, agentHadMicSince, onAgentTurn } from '../voice/agentTurn'
import { matchesWakePhrase } from '../voice/wakeSpeech'
import { Capacitor } from '@capacitor/core'
import { api, getToken, API_BASE, wsUrl } from '../api'
import { useAuth } from '../auth'
import { LANG_LABEL, EmptyState, Ic } from '../ui'
import { confirmDialog } from '../lib/confirm'
import { listReviewDrafts } from '../lib/reviewDraft'
import { useCallAnalyses, inProgress as analysing, callLabel } from '../lib/callAnalysis'
import { MeetingDraft, loadMeetingDraft, saveMeetingDraft, clearMeetingDraft, draftLineCount, draftDuration, draftAgo } from '../lib/meetingDraft'
import ParticipantPicker from '../components/ParticipantPicker'
import { startPcmStream, PcmStream } from '../lib/pcmStream'
import { keepRecordingInBackground, updateBackgroundRecording, releaseBackgroundRecording } from '../lib/backgroundRecording'

// Preset meeting titles for the dropdown; "Other" lets the user type a custom one.
const MEETING_TITLES = ['Tech Meeting', 'Marketing Meeting', 'Sales Meeting', 'HR Meeting', 'Tech and Marketing Meeting']

// Meeting-title field: a dropdown of presets plus an "Other" option that reveals
// a free-text input. An existing custom title (not in the presets) opens as "Other".
function MeetingTitleSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isPreset = MEETING_TITLES.includes(value)
  const [isOther, setIsOther] = useState(value !== '' && !isPreset)
  const selectValue = isOther ? '__other__' : (isPreset ? value : '')
  const pick = (v: string) => {
    if (v === '__other__') { setIsOther(true); onChange('') }
    else { setIsOther(false); onChange(v) }
  }
  return (
    <>
      <label>Meeting title</label>
      <select value={selectValue} onChange={(e) => pick(e.target.value)}>
        <option value="">Select meeting type…</option>
        {MEETING_TITLES.map((t) => <option key={t} value={t}>{t}</option>)}
        <option value="__other__">Other (Enter Title)</option>
      </select>
      {isOther && (
        <input style={{ marginTop: 8 }} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Enter meeting title" autoFocus />
      )}
    </>
  )
}

const SAMPLE = `Priya: Good morning team. Let's start the standup.
Priya: Munidhar, complete the login API by Friday. It's high priority.
Munidhar: Sure Priya, I'll finish it by Friday.
Priya: Ravi, deployment documentation ready cheyyandi by tomorrow.
Ravi: Theek hai, kal tak ready kar dunga.
Priya: Anjali, payment gateway ka testing aaj complete karo, it's urgent.`

export default function Meetings() {
  const { user } = useAuth()
  const nav = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [meetings, setMeetings] = useState<any[]>([])
  const [showUpload, setShowUpload] = useState(false)
  const [showLive, setShowLive] = useState(false)

  // The voice assistant starts a meeting by navigating to /meetings?live=1.
  // Consume the flag so a refresh doesn't reopen the recorder.
  useEffect(() => {
    if (searchParams.get('live') !== '1') return
    setShowLive(true)
    const next = new URLSearchParams(searchParams)
    next.delete('live')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  // ---- Agent surface -------------------------------------------------------
  // Only opening the recorder. Everything about the RUNNING session belongs to the
  // modal, which owns the mic, the websocket and the transcript.
  useSurface('meetings', {
    openLive: async () => {
      await flashPress(findVaEl('meetings.startLive'))
      setShowLive(true)
      await pause(500)
    },
    isLiveOpen: () => showLive,
  })
  const [editing, setEditing] = useState<any | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)
  const load = () => {
    setError(false)
    api.get('/meetings').then((d) => { setMeetings(d); setLoaded(true) }).catch(() => { setError(true); setLoaded(true) })
  }
  useEffect(() => { load() }, [])
  const isManager = user?.role !== 'employee'

  // A call that just ended becomes a meeting here once it is analysed — which
  // takes up to a minute, during which it is on no list at all. Say it is on
  // its way, and fetch the list again the moment one lands.
  const calls = useCallAnalyses()
  const callsWorking = calls.filter(analysing)
  const landed = calls.filter((a) => a.stage === 'ready').map((a) => a.callId).join(',')
  const landedRef = useRef(landed)
  useEffect(() => {
    if (landed === landedRef.current) return
    landedRef.current = landed
    load()
  }, [landed])

  // "Unreviewed" is the whole reason this page gets opened after a meeting: the
  // AI's tasks sit as suggestions until a person approves them, and a long
  // meeting's queue takes long enough to work through that it routinely gets
  // abandoned halfway. In the URL so the dashboard can link straight to it.
  const filter = searchParams.get('filter') === 'unreviewed' ? 'unreviewed' : 'all'
  const setFilter = (f: 'all' | 'unreviewed') => {
    const next = new URLSearchParams(searchParams)
    if (f === 'unreviewed') next.set('filter', 'unreviewed')
    else next.delete('filter')
    setSearchParams(next, { replace: true })
  }
  const unreviewed = meetings.filter((m) => m.pending_count > 0)
  const shown = filter === 'unreviewed' ? unreviewed : meetings

  // Meetings this person had started reviewing and never finished — the edits
  // are still on this device, waiting in localStorage.
  const inProgress = React.useMemo(() => new Set(listReviewDrafts(user?.id || 'anon').map((d) => d.meetingId)), [user?.id])

  // A meeting that was recorded but never analyzed. It exists nowhere but this
  // device — the server has never heard of it — so the list is the only place it
  // can be found again, and it has to be impossible to miss.
  const [pendingDraft, setPendingDraft] = useState<MeetingDraft | null>(() => loadMeetingDraft(user?.id || 'anon'))
  const [serverDraftId, setServerDraftId] = useState<string | null>(null)
  // Local first, then the server. The device copy is instant and survives a lost
  // network; the server copy survives a wiped browser, a flat battery, or being
  // picked up on a different machine. Whichever holds more of the conversation
  // wins, because the only unrecoverable outcome is showing the shorter one.
  const refreshDraft = async () => {
    const local = loadMeetingDraft(user?.id || 'anon')
    setPendingDraft(local)
    try {
      const remote = await api.get('/meetings/draft')
      if (!remote) { setServerDraftId(null); return }
      setServerDraftId(remote.id)
      const remoteText = String(remote.raw_transcript || '')
      if (!local || remoteText.length > local.transcript.length) {
        setPendingDraft({
          title: remote.title || '', description: '',
          participants: remote.participant_ids || [],
          speaker: user?.name || 'Speaker', lang: 'en-IN',
          transcript: remoteText, seconds: remote.draft_seconds || 0,
          startedAt: Date.parse(remote.created_at) || Date.now(),
          savedAt: Date.now(),
        })
      }
    } catch { /* offline — the device copy is still on screen */ }
  }
  // The initialiser above runs once, before the user id is necessarily settled.
  // Re-read once the page is up so a recording can never be missed by a single
  // render's worth of timing.
  useEffect(() => { refreshDraft() }, [user?.id])
  const discardDraft = async () => {
    const d = pendingDraft
    if (!d) return
    const ok = await confirmDialog({
      title: 'Discard this recording?',
      message: `“${d.title || 'Live Meeting'}” — ${draftLineCount(d)} lines, ${draftDuration(d)}. It has never been analyzed, so this cannot be undone and the recording is not stored anywhere else.`,
      confirmText: 'Discard recording',
      danger: true,
    })
    if (!ok) return
    clearMeetingDraft(user?.id || 'anon')
    if (serverDraftId) { try { await api.del('/meetings/draft/' + serverDraftId) } catch { /* it will be reused, not duplicated */ } }
    setServerDraftId(null)
    refreshDraft()
  }

  // With no meetings, the empty state owns the whole page — so the one thing to do
  // next belongs in the middle of it, not only in the top-right corner. Deliberately
  // no data-va: findVaEl takes the FIRST match, and the toolbar button is the one the
  // voice agent should go on pressing.
  const startHere = isManager ? (
    <div className="row" style={{ gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
      <button className="btn btn-primary" onClick={() => setShowLive(true)}>● Start meeting</button>
      <button className="btn" onClick={() => setShowUpload(true)}>+ Upload meeting</button>
    </div>
  ) : undefined

  const del = async (m: any) => {
    if (!(await confirmDialog({ title: 'Delete meeting', message: `Delete "${m.title}" and its ${m.task_count || 0} extracted task(s)? This cannot be undone.`, confirmText: 'Delete', danger: true }))) return
    await api.del('/meetings/' + m.id)
    load()
  }

  return (
    <>
      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Filter meetings">
          <button role="tab" aria-selected={filter === 'all'} className={'seg-btn' + (filter === 'all' ? ' active' : '')} onClick={() => setFilter('all')}>
            All <span className="seg-n">{meetings.length}</span>
          </button>
          <button role="tab" aria-selected={filter === 'unreviewed'} className={'seg-btn' + (filter === 'unreviewed' ? ' active' : '')} onClick={() => setFilter('unreviewed')}>
            Unreviewed AI tasks {unreviewed.length > 0 && <span className="seg-n seg-n-alert">{unreviewed.length}</span>}
          </button>
        </div>
        {isManager && (
          <div className="row meetings-actions" style={{ gap: 8 }}>
            <button data-va="meetings.startLive" className="btn btn-primary" onClick={() => setShowLive(true)}>● Start meeting</button>
            <button className="btn" onClick={() => setShowUpload(true)}>+ Upload meeting</button>
          </div>
        )}
      </div>
      {/* Shown under BOTH filters on purpose: this meeting is not on the server at
          all, so filtering it away would hide the only copy that exists. */}
      {pendingDraft && isManager && (
        <div className="md-pending section">
          <div className="md-pending-main">
            <div className="md-pending-title">
              <Ic name="mic" size={15} /> Meeting in progress — not analyzed yet
            </div>
            <div className="md-pending-sub">
              “{pendingDraft.title || 'Live Meeting'}” — {draftLineCount(pendingDraft)} lines, {draftDuration(pendingDraft)}, saved {draftAgo(pendingDraft.savedAt)}.
              {serverDraftId ? ' Saved to your account — it will be here on any device.' : ' Saved on this device.'}
            </div>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => setShowLive(true)}>Resume meeting</button>
            <button className="btn" onClick={discardDraft}>Discard</button>
          </div>
        </div>
      )}
      {callsWorking.length > 0 && (
        <div className="md-pending md-analysing section" role="status">
          <div className="md-pending-main">
            <div className="md-pending-title">
              <span className="ca-spin" aria-hidden="true" /> Analysing {callsWorking.length === 1 ? 'a call' : `${callsWorking.length} calls`}
            </div>
            <div className="md-pending-sub">
              {callsWorking.map((a) => callLabel(a, user?.id || '')).join('; ').replace(/^./, (c) => c.toUpperCase())}.
              {' '}{callsWorking.length === 1 ? 'It' : 'They'} will be listed here in a moment, with {callsWorking.length === 1 ? 'its' : 'their'} tasks waiting for review — nothing is assigned until then.
            </div>
          </div>
        </div>
      )}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {shown.map((m) => (
          <div key={m.id} className="card clickable" onClick={() => nav('/meetings/' + m.id)}>
            <div className="card-pad">
              <div className="spread">
                <h3 style={{ fontSize: 15 }}>{m.title}</h3>
                <span className="badge" style={{ background: 'color-mix(in srgb, var(--primary) 14%, transparent)', color: 'var(--brand-ink)' }}>{m.engine}</span>
              </div>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{(m.meeting_date || '').slice(0, 10)}</div>
              <p className="muted" style={{ fontSize: 13, marginTop: 10, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {m.summary?.executive_summary || 'No summary.'}
              </p>
              <div className="spread" style={{ marginTop: 12 }}>
                <span className="tag-list">
                  {(m.detected_languages || []).map((l: string) => <span key={l} className="lang-tag">{LANG_LABEL[l] || l}</span>)}
                </span>
                <strong style={{ fontSize: 13 }}>
                  {m.pending_count ? <span style={{ color: 'var(--brand-ink)' }}>{m.pending_count} pending review</span> : `${m.task_count} tasks`}
                </strong>
              </div>
              {/* An unfinished review is worth more than the pending count: it says
                  this person already did some of the work and stopped. */}
              {inProgress.has(m.id) && m.pending_count > 0 && (
                <div className="mt-inprogress"><Ic name="edit" size={13} /> Your review is unfinished — tap to carry on</div>
              )}
              {isManager && (
                <div className="row" style={{ gap: 6, marginTop: 12 }} onClick={(e) => e.stopPropagation()}>
                  <button className="btn btn-sm row" style={{ gap: 6 }} onClick={() => setEditing(m)}><Ic name="edit" size={14} /> Edit</button>
                  <button className="btn btn-sm btn-danger row" style={{ gap: 6 }} onClick={() => del(m)}><Ic name="trash" size={14} /> Delete</button>
                </div>
              )}
            </div>
          </div>
        ))}
        {!loaded && Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="card"><div className="card-pad"><span className="skeleton" style={{ height: 100, borderRadius: 10 }} /></div></div>
        ))}
        {loaded && error && (
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <EmptyState icon={<Ic name="warning" size={40} />} title="Couldn't load meetings" hint="Check your connection and try again."
              action={<button className="btn btn-primary btn-sm" onClick={load}>Retry</button>} />
          </div>
        )}
        {loaded && !error && shown.length === 0 && (
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            {filter === 'unreviewed'
              ? <EmptyState icon={<Ic name="check" size={40} />} title="Every meeting has been reviewed" hint="AI suggestions from all your meetings have been assigned or dismissed."
                  action={<button className="btn btn-sm" onClick={() => setFilter('all')}>Show all meetings</button>} />
              : <EmptyState icon={<Ic name="mic" size={40} />} title="No meetings yet" hint="Upload or record a meeting to see the AI extract tasks automatically." action={startHere} />}
          </div>
        )}
      </div>
      {showUpload && <UploadModal onClose={() => setShowUpload(false)} onDone={(id) => { setShowUpload(false); load(); nav('/meetings/' + id) }} />}
      {showLive && <LiveMeetingModal defaultSpeaker={user?.name || 'Manager'} onClose={() => { setShowLive(false); refreshDraft() }} onDone={(id) => { setShowLive(false); refreshDraft(); load(); nav('/meetings/' + id) }} />}
      {editing && <EditMeetingModal meeting={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
    </>
  )
}

function EditMeetingModal({ meeting, onClose, onSaved }: { meeting: any; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(meeting.title || '')
  const [date, setDate] = useState((meeting.meeting_date || '').slice(0, 10))
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try { await api.patch('/meetings/' + meeting.id, { title, meeting_date: date }); onSaved() }
    finally { setBusy(false) }
  }
  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3>Edit meeting</h3><button className="btn btn-ghost" onClick={onClose}>✕</button></div>
        <div className="card-pad grid" style={{ gap: 12 }}>
          <div><MeetingTitleSelect value={title} onChange={setTitle} /></div>
          <div><label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={busy || !title.trim()}>{busy ? <span className="spinner" /> : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function UploadModal({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [mode, setMode] = useState<'text' | 'audio'>('audio')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [participants, setParticipants] = useState<string[]>([])
  const [transcript, setTranscript] = useState('')
  const [audioFile, setAudioFile] = useState<File | null>(null)
  const [provider, setProvider] = useState('none')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // Is server-side speech-to-text available? (drives the audio option)
  useEffect(() => {
    fetch(`${API_BASE}/api/health`).then((r) => r.json()).then((d) => setProvider(d.transcription || 'none')).catch(() => {})
  }, [])
  const audioAvailable = provider !== 'none'

  // Real upload progress (0–100) while the audio file is in transit; null when idle
  // or once the server side (transcription) has taken over.
  const [uploadPct, setUploadPct] = useState<number | null>(null)
  const AUDIO_MAX = 25 * 1024 * 1024

  // Upload a full audio file → server transcribes it → extracts summary & tasks.
  // XHR instead of fetch: fetch has no upload progress, and a 25 MB file on a slow
  // connection looked hung behind a bare spinner.
  const uploadAudio = (): Promise<string> => new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('audio', audioFile!, audioFile!.name)
    form.append('title', title || 'Recorded Meeting')
    form.append('description', description)
    form.append('meeting_date', date)
    form.append('participant_ids', JSON.stringify(participants))
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}/api/meetings/audio`)
    xhr.setRequestHeader('authorization', `Bearer ${getToken()}`)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) setUploadPct(Math.round((e.loaded / e.total) * 100)) }
    xhr.onload = () => {
      let data: any = {}
      try { data = JSON.parse(xhr.responseText) } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data.id)
      else reject(new Error(data.error || 'Audio processing failed'))
    }
    xhr.onerror = () => reject(new Error('Upload failed — check your connection and try again.'))
    xhr.send(form)
  })

  const process = async () => {
    setErr('')
    if (mode === 'audio') {
      if (!audioFile) { setErr('Choose an audio file first.'); return }
      // Catch an oversized file BEFORE spending minutes uploading it.
      if (audioFile.size > AUDIO_MAX) { setErr(`That file is ${fileMB} MB — the limit is 25 MB. Try a compressed format like mp3 or m4a.`); return }
    }
    setBusy(true)
    try {
      let rid: string
      if (mode === 'audio') {
        rid = await uploadAudio()
      } else {
        const r = await api.post('/meetings', { title: title || 'Untitled Meeting', description, meeting_date: date, transcript, participant_ids: participants })
        rid = r.id
      }
      onDone(rid)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false); setUploadPct(null) }
  }

  const fileMB = audioFile ? (audioFile.size / 1024 / 1024).toFixed(1) : null
  const canSubmit = mode === 'audio' ? !!audioFile : !!transcript.trim()

  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3>Upload meeting</h3><button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="card-pad grid" style={{ gap: 12 }}>
          {/* source toggle */}
          <div className="row" style={{ gap: 8 }}>
            <button className={'btn btn-sm row' + (mode === 'audio' ? ' btn-primary' : '')} style={{ gap: 6 }} onClick={() => setMode('audio')}><Ic name="music" size={14} /> Upload audio file</button>
            <button className={'btn btn-sm row' + (mode === 'text' ? ' btn-primary' : '')} style={{ gap: 6 }} onClick={() => setMode('text')}><Ic name="note" size={14} /> Paste transcript</button>
          </div>

          <div className="grid grid-3" style={{ gap: 10 }}>
            <div style={{ gridColumn: 'span 2' }}><MeetingTitleSelect value={title} onChange={setTitle} /></div>
            <div><label>Date</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          </div>
          <div><label>Description <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label><textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this meeting about?" /></div>
          <div><label>Participants <span className="muted" style={{ fontWeight: 400 }}>(only these people can be assigned tasks)</span></label><ParticipantPicker value={participants} onChange={setParticipants} autoSelectAll /></div>

          {mode === 'audio' ? (
            <div>
              <label>Audio recording <span className="muted" style={{ fontWeight: 400 }}>(mp3, wav, m4a, webm… up to 25&nbsp;MB)</span></label>
              {!audioAvailable && (
                <div style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginBottom: 8 }}>
                  Speech-to-text isn't active. Set <b>TRANSCRIPTION_PROVIDER</b> + the matching API key in <b>server/.env</b> and restart the backend.
                </div>
              )}
              <label className="audio-drop">
                <input type="file" accept="audio/*" style={{ display: 'none' }} onChange={(e) => { setAudioFile(e.target.files?.[0] || null); setErr('') }} />
                {audioFile
                  ? <span className="row" style={{ gap: 6 }}><Ic name="music" size={14} /> <b>{audioFile.name}</b> <span className="muted">({fileMB} MB)</span> — click to change</span>
                  : <span className="muted row" style={{ gap: 6 }}><Ic name="mic" size={14} /> Click to choose an audio file</span>}
              </label>
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>The recording is transcribed (any language — Telugu / Hindi / English / mixed), then the summary &amp; tasks are generated in <b>English</b>.</div>
            </div>
          ) : (
            <div>
              <div className="spread"><label>Transcript (Telugu / Hindi / English / mixed)</label><button className="btn btn-sm btn-ghost" onClick={() => setTranscript(SAMPLE)}>Insert sample</button></div>
              <textarea rows={9} value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder={'Format each line as "Speaker: text"\n\n' + SAMPLE.split('\n').slice(0, 2).join('\n')} style={{ fontFamily: 'monospace', fontSize: 12.5 }} />
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Any language — the summary and tasks are always generated in <b>English</b>.</div>
            </div>
          )}

          {err && <div style={{ color: 'var(--danger-ink)', fontSize: 13 }} role="alert">{err}</div>}
          {/* Honest progress: a real bar while bytes are in transit, then a clear
              "server is working" line — so a slow upload never looks hung. */}
          {busy && mode === 'audio' && (
            <div aria-live="polite">
              {uploadPct !== null && uploadPct < 100 ? (
                <>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${uploadPct}%`, background: 'var(--primary)' }} /></div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Uploading {fileMB} MB — {uploadPct}%</div>
                </>
              ) : (
                <div className="muted" style={{ fontSize: 12 }}>Upload complete — transcribing and analyzing. This can take a minute or two for long recordings.</div>
              )}
            </div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={process} disabled={busy || !canSubmit}>
              {busy
                ? <><span className="spinner" /> {mode === 'audio'
                    ? (uploadPct !== null && uploadPct < 100 ? `Uploading… ${uploadPct}%` : 'Transcribing & analyzing…')
                    : 'Analyzing…'}</>
                : <span className="row" style={{ gap: 6 }}><Ic name="ai" size={15} /> Analyze & extract tasks</span>}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// Live "Start meeting" recorder.
// AUTO mode: records the mic in short segments and streams them to the server's speech-to-text
//   (Sarvam / Whisper), which auto-detects language & code-mixing — so a freely mixed
//   Telugu/Hindi/English meeting transcribes continuously, at any length.
// BROWSER mode (no API key): uses the browser's Web Speech API, one language at a time.
const REC_LANGS = [
  { code: 'en-IN', label: 'English (India)' },
  { code: 'hi-IN', label: 'हिन्दी (Hindi)' },
  { code: 'te-IN', label: 'తెలుగు (Telugu)' },
]

// Record one self-contained audio segment of `ms` milliseconds from a live mic stream.
function recordSegment(stream: MediaStream, ms: number): Promise<Blob> {
  return new Promise((resolve) => {
    const chunks: BlobPart[] = []
    let mr: MediaRecorder
    try { mr = new MediaRecorder(stream, { mimeType: 'audio/webm' }) } catch { mr = new MediaRecorder(stream) }
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
    mr.onstop = () => resolve(new Blob(chunks, { type: mr.mimeType || 'audio/webm' }))
    mr.start()
    setTimeout(() => { try { if (mr.state !== 'inactive') mr.stop() } catch {} }, ms)
  })
}

function LiveMeetingModal({ defaultSpeaker, onClose, onDone }: { defaultSpeaker: string; onClose: () => void; onDone: (id: string) => void }) {
  const { user } = useAuth()
  const uid = user?.id || 'anon'
  // A meeting recorded earlier and never analyzed. Until the analyze button is
  // pressed this transcript exists nowhere else — not on the server, not on any
  // other device — so it is restored here rather than started over.
  const [recovered] = useState(() => loadMeetingDraft(uid))
  const [showRecovered, setShowRecovered] = useState(!!recovered)

  const [title, setTitle] = useState(recovered?.title || '')
  const [description, setDescription] = useState(recovered?.description || '')
  const [participants, setParticipants] = useState<string[]>(recovered?.participants || [])
  const date = new Date().toISOString().slice(0, 10)
  const [speaker, setSpeaker] = useState(recovered?.speaker || defaultSpeaker)
  const [lang, setLang] = useState(recovered?.lang || 'en-IN')
  const [provider, setProvider] = useState('none')
  const [mode, setMode] = useState<'auto' | 'browser'>('browser')
  const [recording, setRecording] = useState(false)
  const [paused, setPaused] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  // Connection state for the live recorder, shown as a status line rather than
  // an error — a reconnect during a long meeting is expected, not a failure.
  const [liveNote, setLiveNote] = useState('')
  const [transcript, setTranscript] = useState(recovered?.transcript || '')
  const [interim, setInterim] = useState('')
  // Purely to explain the gap. Without it the transcript silently stops growing
  // mid-meeting and the only honest reading is "the recorder broke".
  const [agentTalking, setAgentTalking] = useState(false)
  const [seconds, setSeconds] = useState(recovered?.seconds || 0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const recRef = useRef<any>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const pcmRef = useRef<PcmStream | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recordingRef = useRef(false)  // true only while actively capturing (false when paused)
  const liveTriesRef = useRef(0)      // consecutive live-socket reconnect attempts (backoff)
  const retryRef = useRef(0)
  const pausedRef = useRef(false)
  // Bumped whenever the capture engines are torn down. A loop, socket or
  // callback from an engine that has since been replaced compares it and bows
  // out, instead of carrying on next to its replacement.
  const engineRef = useRef(0)
  // Consecutive attempts to reopen a microphone that went away mid-meeting.
  const micRetryRef = useRef(0)
  // How this recording survives the screen going off. 'service': Android's
  // microphone service holds it, so the screen may sleep. 'screen': no service
  // (it refused, or this is an older build), so the screen is kept on instead.
  const holdRef = useRef<null | 'service' | 'screen'>(null)
  // Why the meeting is paused — a pause is now rare enough to deserve a reason.
  const [pauseWhy, setPauseWhy] = useState('')
  const speakerRef = useRef(speaker)
  useEffect(() => { speakerRef.current = speaker }, [speaker])
  const transcriptRef = useRef('')
  useEffect(() => { transcriptRef.current = transcript }, [transcript])
  const titleRef = useRef(title)
  useEffect(() => { titleRef.current = title }, [title])
  const secondsRef = useRef(seconds)
  useEffect(() => { secondsRef.current = seconds }, [seconds])

  // Write the meeting to disk as it is captured. Every spoken phrase lands here
  // within a second of being recognised, so the worst a refresh, a crash or a
  // swipe out of recents can cost is the sentence in progress.
  //
  // Deliberately NOT cleared when the recorder closes: closing without analyzing
  // is the exact case this exists for. It is cleared in one place only — after
  // the server has accepted the meeting.
  const startedAtRef = useRef(recovered?.startedAt || Date.now())
  // Visible proof the transcript is on disk. Without it, "is this being saved?"
  // is unanswerable from the screen, which is the worst possible thing not to
  // know while the meeting you are recording is the only copy.
  const [savedAt, setSavedAt] = useState<number | null>(recovered?.savedAt || null)
  const [saveFailed, setSaveFailed] = useState(false)
  // The server's copy of this recording. Created on the first press of record
  // and updated on a timer, so the meeting outlives this browser entirely.
  const draftIdRef = useRef<string | null>(null)
  const [syncedAt, setSyncedAt] = useState<number | null>(null)
  const lastSentRef = useRef('')
  useEffect(() => {
    // `interim` is the phrase being spoken right now, not yet promoted to a final
    // line. An interruption lands mid-sentence far more often than between them,
    // so it is folded in rather than dropped — marked, because it is the one part
    // the recogniser had not finished confirming.
    const pending = interim.trim() ? [transcript.replace(/\s*$/, ''), `${speaker || 'Speaker'}: ${interim.trim()}`].filter(Boolean).join('\n') : transcript
    if (!pending.trim()) return
    const ok = saveMeetingDraft(uid, {
      title, description, participants, speaker, lang,
      transcript: pending, seconds,
      startedAt: startedAtRef.current,
      savedAt: Date.now(),
    })
    setSaveFailed(!ok)
    if (ok) setSavedAt(Date.now())
  }, [transcript, interim, title, description, participants, speaker, lang, seconds, uid])

  const SRClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  const browserSupported = !!SRClass
  const autoAvailable = provider !== 'none'

  // Detect whether a server transcription provider is configured; prefer it if so.
  useEffect(() => {
    fetch(`${API_BASE}/api/health`).then((r) => r.json()).then((d) => {
      const p = d.transcription || 'none'
      setProvider(p)
      setMode(p !== 'none' ? 'auto' : 'browser')
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!recording || paused) return
    const id = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [recording, paused])

  useEffect(() => onAgentTurn(setAgentTalking), [])

  // Adopt a recording already on the server — the one left behind by the tab that
  // was refreshed, or by another device. Its transcript wins if it holds more of
  // the conversation than whatever this device kept.
  useEffect(() => {
    let dead = false
    api.get('/meetings/draft').then((d) => {
      if (dead || !d) return
      draftIdRef.current = d.id
      const remote = String(d.raw_transcript || '')
      setTranscript((cur) => (remote.length > cur.length ? remote : cur))
      setSeconds((cur) => Math.max(cur, d.draft_seconds || 0))
      if (d.title) setTitle((cur) => cur || d.title)
      if (d.participant_ids?.length) setParticipants((cur) => (cur.length ? cur : d.participant_ids))
      setSyncedAt(Date.now())
    }).catch(() => { /* offline; the device copy stands */ })
    return () => { dead = true }
  }, [])

  // Push to the server on a timer rather than on every phrase: a meeting produces
  // a line every few seconds and this must not turn into a request per word.
  // Skipped when nothing changed, so a silent room costs nothing.
  useEffect(() => {
    if (!recording && !transcript.trim()) return
    const tick = async () => {
      const text = transcriptRef.current
      if (!text.trim() || text === lastSentRef.current) return
      try {
        if (!draftIdRef.current) {
          const d = await api.post('/meetings/draft', { title })
          draftIdRef.current = d.id
        }
        await api.patch(`/meetings/draft/${draftIdRef.current}`, { transcript: text, title, seconds, participant_ids: participants })
        lastSentRef.current = text
        setSyncedAt(Date.now())
      } catch { /* offline — localStorage already has it, and the next tick retries */ }
    }
    const h = setInterval(tick, 5000)
    tick()
    return () => clearInterval(h)
  }, [recording, transcript, title, seconds, participants])

  // A refresh mid-meeting is now survivable, but it still costs the few seconds
  // since the last sync — and someone who hits it by accident deserves the chance
  // to say no. Browsers show their own wording; the string only has to be non-empty.
  useEffect(() => {
    if (!recording && !transcript.trim()) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [recording, transcript])

  // stop & clean up on unmount
  useEffect(() => () => {
    recordingRef.current = false
    teardownEngines()
    releaseHold()
  }, [])

  // The fallback for when the screen-off recording below is unavailable: keep
  // the screen on (native only), since a backgrounded WebView gets no audio.
  const keepScreenAwake = (on: boolean) => {
    if (!Capacitor.isNativePlatform()) return
    import('@capacitor-community/keep-awake')
      .then(({ KeepAwake }) => (on ? KeepAwake.keepAwake() : KeepAwake.allowSleep()))
      .catch(() => {})
  }

  // A meeting runs for hours and the phone goes face-down on the table; keeping
  // the screen lit for all of it drained the battery, and letting it sleep used
  // to pause the meeting. So the app asks Android to keep the recording going
  // with the screen off (lib/backgroundRecording.ts), and only if it says no
  // does it fall back to holding the screen on.
  //
  // Asked each time a microphone opens, not when Start is pressed: the first
  // time someone records, mic permission is only granted by that getUserMedia,
  // and Android will not start a microphone service before it is.
  const holdBackground = async () => {
    if (!Capacitor.isNativePlatform()) return
    const state = { title: titleRef.current, paused: pausedRef.current, seconds: secondsRef.current }
    if (holdRef.current === 'service') { updateBackgroundRecording(state); return }
    if (await keepRecordingInBackground(state)) {
      // Stopped while Android was being asked.
      if (!recordingRef.current && !pausedRef.current) { releaseBackgroundRecording(); return }
      holdRef.current = 'service'
      keepScreenAwake(false)
    } else if (!holdRef.current) {
      holdRef.current = 'screen'
      keepScreenAwake(true)
    }
  }
  const releaseHold = () => {
    if (holdRef.current === 'service') releaseBackgroundRecording()
    holdRef.current = null
    keepScreenAwake(false)
  }

  // The notification names the meeting and says when it is paused.
  useEffect(() => {
    if (holdRef.current === 'service') updateBackgroundRecording({ title, paused, seconds: secondsRef.current })
  }, [title, paused])

  // Backgrounded mid-capture (screen off, home button, an incoming call). With
  // the service holding the mic that is nothing at all — the meeting carries on.
  // Without it Android hands the app silence, so the honest thing is still to
  // pause rather than show a REC light over a transcript that has stopped.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return
    let handle: { remove: () => void } | undefined
    import('@capacitor/app').then(({ App }) => {
      App.addListener('appStateChange', ({ isActive }) => {
        if (isActive || !recordingRef.current || holdRef.current === 'service') return
        pauseRecording('VoTask could not keep the microphone while the app was in the background.')
      }).then((h) => { handle = h })
    }).catch(() => {})
    return () => { handle?.remove() }
  }, [])

  // The microphone itself can go: a phone call takes it, a headset is pulled
  // out, a laptop sleeps and wakes up with its audio devices re-enumerated. None
  // of that is someone ending the meeting, so none of it should leave a Resume
  // button waiting for them — a muted mic is waited out, and a lost one reopened.
  const watchMic = (track: MediaStreamTrack | undefined) => {
    if (!track) return
    const gen = engineRef.current
    const mine = () => gen === engineRef.current && recordingRef.current
    track.onmute = () => { if (mine()) setLiveNote('Microphone in use elsewhere — recording picks up again when it is free') }
    track.onunmute = () => { if (mine()) setLiveNote('') }
    track.onended = () => { if (mine()) reopenMic() }
  }
  const micOpened = () => {
    micRetryRef.current = 0
    holdBackground()
  }
  const reopenMic = () => {
    teardownEngines()
    setTranscribing(false); setInterim('')
    setLiveNote('Microphone lost — reconnecting…')
    // Backs off: a device still waking up usually refuses the first attempt.
    const n = ++micRetryRef.current
    window.setTimeout(() => { if (recordingRef.current) beginCapture() }, 1000 * n)
  }
  // Opening the microphone failed. On a fresh start that is the answer (no
  // permission, no device) and the recorder goes back to Ready. Mid-meeting it
  // is usually only early, so it is retried a few times before pausing.
  const micFailed = (msg: string) => {
    if (!micRetryRef.current) { setErr(msg); stop(); return }
    if (micRetryRef.current < 5) { reopenMic(); return }
    micRetryRef.current = 0
    pauseRecording('The microphone stopped and could not be reopened — check it is connected.')
  }

  // Speech addressed to the voice assistant is not part of this meeting, and the
  // recording is the one place where that distinction is impossible to fix after
  // the fact — "hey VoTask, stop the recording" would otherwise sit in the
  // transcript and be handed to the AI as something a participant said.
  //
  // Two layers, because one is not enough. The gate (agentTurn.ts) is checked at
  // each capture site below and covers the assistant's whole turn including its
  // spoken reply. This text check is the backstop for the gap the gate cannot
  // close: the wake word is matched on an INTERIM result, so this recogniser has
  // usually already heard the phrase by the time the assistant claims the mic.
  const isAgentSpeech = (text: string) => agentHasMic() || matchesWakePhrase(text)

  const appendLine = (text: string) => {
    if (!text.trim()) return
    if (isAgentSpeech(text)) return
    setTranscript((prev) => (prev ? prev.replace(/\s*$/, '') + '\n' : '') + `${speakerRef.current || 'Speaker'}: ${text.trim()}`)
  }

  // Browser (Web Speech) finals only. Android doesn't honour `continuous` and
  // re-fires the SAME utterance as growing-prefix finals across auto-restarts
  // ("I" → "I want" → "I want to assign a task"), plus slightly different
  // re-recognitions ("task 2" vs "task to"). Appending each one stacks dozens of
  // near-duplicate lines and makes the AI extract the same task many times.
  // Fix: if a new final extends, is contained by, or shares most of a common
  // prefix with the previous SAME-speaker line, replace that line (keep the
  // longer text) instead of adding a new one. Genuinely new sentences still
  // append. Server (auto/sarvam) modes keep using appendLine — their chunks are
  // distinct, not growing prefixes.
  const commitBrowserFinal = (text: string) => {
    const clean = text.trim()
    if (!clean) return
    if (isAgentSpeech(clean)) return
    const speaker = speakerRef.current || 'Speaker'
    const prefix = `${speaker}: `
    setTranscript((prev) => {
      const lines = prev ? prev.split('\n') : []
      const last = lines[lines.length - 1]
      if (last && last.startsWith(prefix)) {
        const lastText = last.slice(prefix.length).trim()
        const shorter = Math.min(lastText.length, clean.length)
        let common = 0
        while (common < shorter && lastText[common] === clean[common]) common++
        const sameUtterance =
          clean === lastText ||
          clean.startsWith(lastText) ||
          lastText.startsWith(clean) ||
          (shorter > 0 && common / shorter >= 0.7)
        if (sameUtterance) {
          // keep whichever capture is longer (most complete)
          lines[lines.length - 1] = clean.length >= lastText.length ? prefix + clean : last
          return lines.join('\n')
        }
      }
      lines.push(prefix + clean)
      return lines.join('\n')
    })
  }

  // ---- AUTO mode: server STT, any language ----
  const uploadChunk = async (blob: Blob, prompt: string): Promise<string> => {
    const form = new FormData()
    form.append('audio', blob, 'chunk.webm')
    if (prompt) form.append('prompt', prompt) // prior text → consistent names/spelling
    const res = await fetch(`${API_BASE}/api/meetings/transcribe`, { method: 'POST', headers: { authorization: `Bearer ${getToken()}` }, body: form })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Transcription failed')
    return data.text || ''
  }

  const startAuto = async () => {
    setErr('')
    const gen = engineRef.current
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
    catch { micFailed('Microphone permission denied. Allow mic access and try again.'); return }
    // Stopped (or paused) while the permission prompt was up.
    if (gen !== engineRef.current) { stream.getTracks().forEach((t) => t.stop()); return }
    streamRef.current = stream
    watchMic(stream.getAudioTracks()[0])
    recordingRef.current = true
    setRecording(true)
    micOpened()
    ;(async () => {
      while (recordingRef.current && gen === engineRef.current) {
        const segmentStart = Date.now()
        const blob = await recordSegment(stream, 12000)
        // Drop the whole segment if the assistant was addressed at any point
        // inside it. Coarse — up to 12 seconds of real meeting goes with it — but
        // a webm blob cannot be trimmed before upload, and a segment containing
        // "hey VoTask, stop recording" is precisely what must not reach the
        // transcript. Skipping it also saves the transcription call.
        if (agentHadMicSince(segmentStart)) continue
        if (blob.size > 2000) {
          try { setTranscribing(true); appendLine(await uploadChunk(blob, transcriptRef.current.slice(-450))) }
          catch (e: any) { setErr(e.message) }
          finally { setTranscribing(false) }
        }
      }
      stream.getTracks().forEach((t) => t.stop())
    })()
  }

  // ---- SARVAM STREAMING mode: live captions over a WebSocket ----
  // Browser streams raw PCM16 @16kHz to our server, which proxies to Sarvam and
  // streams transcripts back. Captions appear ~1-2s after each spoken phrase.
  const startSarvamStream = async () => {
    setErr('')
    recordingRef.current = true
    setRecording(true)
    const gen = engineRef.current
    let micOpening = false

    // The socket is disposable, the microphone is not.
    //
    // A three-hour meeting will lose its connection — Sarvam recycles the
    // upstream session, wifi drops, a laptop sleeps. Previously any of those
    // ended the recording silently: onclose only flipped a flag, while the mic
    // kept running and every frame was thrown away against a closed socket.
    //
    // So the socket reconnects on its own and the PCM stream is started ONCE and
    // reused. Frames read `wsRef.current` at send time rather than closing over
    // one socket instance, so they follow the reconnection without the mic ever
    // being touched (re-acquiring it would prompt for permission again and drop
    // audio while the device spun up).
    const connect = () => {
      if (!recordingRef.current || gen !== engineRef.current) return
      const ws = new WebSocket(wsUrl(`/api/meetings/live?token=${getToken()}&language=${encodeURIComponent(lang)}`))
      wsRef.current = ws

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.transcript) { appendLine(msg.transcript); setInterim('') }
          // The relay reports its own upstream recycling. That is routine on a
          // long meeting, so it is a status line, never an error — audio carries
          // on being buffered server-side throughout.
          else if (msg.reconnecting) { setLiveNote('Reconnecting to the transcriber…'); setTranscribing(false) }
          else if (msg.resumed || msg.ready) { setLiveNote(''); setTranscribing(true) }
          else if (msg.error) setErr(msg.error)
        } catch {}
      }
      ws.onerror = () => { /* onclose always follows; it owns the retry */ }
      ws.onclose = () => {
        setTranscribing(false)
        if (!recordingRef.current) return          // user pressed stop — expected
        retryRef.current = Math.min(5000, 500 * 2 ** liveTriesRef.current++)
        setLiveNote('Connection lost — reconnecting…')
        window.setTimeout(connect, retryRef.current)
      }

      ws.onopen = async () => {
        liveTriesRef.current = 0
        setTranscribing(true)
        setLiveNote('')
        // Mic already running (or still opening), just re-attached.
        if (pcmRef.current || micOpening) return
        micOpening = true
        const pcm = await startPcmStream(
          // Withhold the frames rather than the transcript: Sarvam never receives
          // the audio of a command, so there is nothing to filter downstream and
          // nothing billed for it either.
          (b64) => {
            const sock = wsRef.current
            if (sock && sock.readyState === WebSocket.OPEN && !agentHasMic()) sock.send(b64)
          },
          micFailed,
        )
        micOpening = false
        // Stopped, paused or reopened while the mic was opening: it is not ours.
        if (gen !== engineRef.current) { pcm.stop(); return }
        pcmRef.current = pcm
        if (pcm.track) { watchMic(pcm.track); micOpened() }
      }
    }
    connect()
  }

  // ---- BROWSER mode: Web Speech API, one language ----
  const startBrowser = () => {
    setErr('')
    if (!browserSupported) { setErr('Browser captions need Google Chrome or Microsoft Edge.'); return }
    const rec = new SRClass()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = lang
    rec.onresult = (e: any) => {
      // Bail before the interim is rendered too, or the live caption line shows
      // the user's command being typed into the meeting it is about to stop.
      // The recogniser itself is left running: restarting it per command costs a
      // second of genuine speech at each end.
      if (agentHasMic()) { setInterim(''); return }
      let intr = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) commitBrowserFinal(r[0].transcript); else intr += r[0].transcript
      }
      setInterim(intr)
    }
    rec.onerror = (e: any) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { setErr('Microphone permission denied.'); stop() } }
    const gen = engineRef.current
    rec.onend = () => { if (recordingRef.current && gen === engineRef.current) { try { rec.start() } catch {} } }
    recRef.current = rec
    recordingRef.current = true
    setRecording(true)
    try { rec.start() } catch {}
    // The recogniser opens its own mic, so there is no track to wait for.
    micOpened()
  }

  // Spin up the capture engine for the current mode (used by start, resume and
  // reopening a lost microphone).
  const beginCapture = () => {
    if (mode === 'auto') { provider === 'sarvam' ? startSarvamStream() : startAuto() }
    else startBrowser()
  }
  // Tear down the active capture engine without ending the session/transcript.
  const teardownEngines = () => {
    engineRef.current++
    try { recRef.current?.stop() } catch {}
    try { pcmRef.current?.stop() } catch {}
    pcmRef.current = null
    const ws = wsRef.current
    wsRef.current = null
    // Detached first: its onclose would read this as a dropped connection and
    // dial back in.
    if (ws) { ws.onclose = null; try { ws.close() } catch {} }
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null } catch {}
  }

  const start = () => {
    // Only zero the clock for a genuinely new recording. Resuming a meeting that
    // was interrupted is a continuation of the same one, and restarting its timer
    // would say the previous 40 minutes never happened.
    if (!transcript.trim()) setSeconds(0)
    setPaused(false); pausedRef.current = false; setPauseWhy('')
    micRetryRef.current = 0
    beginCapture()
  }

  // Stop capturing but keep the session + transcript; show Resume. Asked for by
  // voice, or the last resort when the mic cannot be got back.
  const pauseRecording = (why = '') => {
    if (!recordingRef.current || pausedRef.current) return
    recordingRef.current = false   // halts capture loops / auto-restart
    pausedRef.current = true
    setPaused(true)
    setPauseWhy(why)
    setTranscribing(false); setInterim(''); setLiveNote('')
    teardownEngines()
  }
  // Resume after a pause: spin a fresh engine (old mic/ws may be dead).
  const resumeRecording = () => {
    if (!pausedRef.current) return
    pausedRef.current = false
    setPaused(false)
    setPauseWhy('')
    micRetryRef.current = 0
    beginCapture()
  }

  const stop = () => {
    // recordingRef goes false FIRST, so anything still in flight — a segment
    // mid-upload, a reconnect timer, a mic being reopened — sees the meeting is
    // over rather than starting it up again.
    recordingRef.current = false
    pausedRef.current = false
    liveTriesRef.current = 0
    micRetryRef.current = 0
    setRecording(false)
    setPaused(false)
    setPauseWhy('')
    setTranscribing(false)
    setInterim('')
    setLiveNote('')
    teardownEngines()
    releaseHold()
  }

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  const close = () => { stop(); onClose() }

  // ---- Agent surface -------------------------------------------------------
  // Live recording is the one place in the app where reaching for the screen is
  // genuinely impractical: your hands are busy, the phone is face-down on the
  // table, and the meeting is happening. So this is the surface where voice is not
  // a convenience but the only sensible control.
  //
  // Each capability calls the modal's own handler, which means the agent inherits
  // every hard-won behaviour already in them: the screen-off hold, the fresh-engine
  // restart on resume (an interrupted mic/websocket is usually dead), and the
  // teardown that releases the microphone.
  //
  // `status` exists so a tool can refuse coherently — "pause" when nothing is
  // recording should say so, not silently do nothing.
  useSurface('meetings.live', {
    status: () => ({ recording, paused, transcript: transcript.trim().length, seconds }),
    // A custom select, not a text field, so this is a discrete set with a beat
    // either side rather than faked character-by-character typing.
    setTitle: ({ value }: { value: string }) =>
      pickValue(findVaEl('meetings.live.title'), value, setTitle),
    record: async () => {
      if (recording) return { already: true }
      await flashPress(findVaEl('meetings.live.record'))
      start()
      await pause(400)
      return { started: true }
    },
    pause: async () => {
      if (!recording || paused) return { skipped: true }
      // No dedicated Pause button, so there is nothing to press: just call the
      // handler and let the amber "Meeting paused" banner be the visible feedback.
      pauseRecording('You asked VoTask to pause.')
      await pause(320)
      return { paused: true }
    },
    resume: async () => {
      if (!paused) return { skipped: true }
      await flashPress(findVaEl('meetings.live.resume'))
      resumeRecording()
      await pause(400)
      return { resumed: true }
    },
    stop: async () => {
      if (!recording) return { skipped: true }
      await flashPress(findVaEl('meetings.live.stop'))
      stop()
      await pause(400)
      return { stopped: true }
    },
    // Stop if still running, then analyse. `process` reads the transcript from
    // state, so settle() before it or a just-stopped segment can be missed.
    finish: async () => {
      if (recording) { stop(); await pause(500) }
      await settle()
      if (!transcript.trim()) return { empty: true }
      await flashPress(findVaEl('meetings.live.finish'))
      await process()
      return { analysed: true }
    },
  })

  const process = async () => {
    stop()
    setBusy(true); setErr('')
    try {
      const r = await api.post('/meetings', { title: title || 'Live Meeting', description, meeting_date: date, transcript, participant_ids: participants })
      // Only now is the meeting somewhere other than this device.
      clearMeetingDraft(uid)
      if (draftIdRef.current) { try { await api.del('/meetings/draft/' + draftIdRef.current) } catch { /* harmless leftover */ } }
      onDone(r.id)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div className="modal-center" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread">
          <h3>● Start meeting — live recording</h3>
          <button className="btn btn-ghost" onClick={close}>✕</button>
        </div>
        <div className="card-pad grid" style={{ gap: 12 }}>
          {showRecovered && recovered && (
            <div className="rv-resumed">
              <div style={{ minWidth: 0 }}>
                <b>Your recording is back</b> — {draftLineCount(recovered)} lines, {draftDuration(recovered)}, from {draftAgo(recovered.savedAt)}. Press Start recording to carry on, or analyze what you have.
              </div>
              <button className="btn btn-sm" onClick={() => setShowRecovered(false)}>Got it</button>
            </div>
          )}
          <div className="grid grid-3" style={{ gap: 10 }}>
            <div data-va="meetings.live.title" style={{ gridColumn: 'span 2' }}><MeetingTitleSelect value={title} onChange={setTitle} /></div>
            <div><label>Speaker label</label><input value={speaker} onChange={(e) => setSpeaker(e.target.value)} /></div>
          </div>
          <div><label>Description <span className="muted" style={{ fontWeight: 400 }}>(optional)</span></label><textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this meeting about?" /></div>
          <div><label>Participants <span className="muted" style={{ fontWeight: 400 }}>(only these people can be assigned tasks)</span></label><ParticipantPicker value={participants} onChange={setParticipants} autoSelectAll /></div>

          <div>
            <label>Recognition mode</label>
            <div className="row" style={{ gap: 8 }}>
              <button className={'btn btn-sm' + (mode === 'auto' ? ' btn-primary' : '')} disabled={recording || !autoAvailable} onClick={() => setMode('auto')}><span className="row" style={{ gap: 6 }}><Ic name="ai" size={14} /> Auto (Telugu / Hindi / English)</span></button>
              <button className={'btn btn-sm' + (mode === 'browser' ? ' btn-primary' : '')} disabled={recording} onClick={() => setMode('browser')}>Browser captions (1 language)</button>
            </div>
            {mode === 'auto'
              ? <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Transcribes the selected language (with English mixed in) via <strong>{provider}</strong> — limited to Telugu, Hindi and English so other languages never appear. {provider === 'sarvam' ? 'Captions stream live — each phrase appears ~1-2s after it’s spoken.' : 'Live captions arrive in short segments and self-correct using prior context (names/spelling stay consistent).'} You can also edit the transcript before analyzing.</div>
              : <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Pick one language; press Stop and switch to mix languages — all append to one transcript.</div>}
            {!autoAvailable && (
              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginTop: 6 }}>
                Auto language is off — no server speech-to-text configured. For a <b>free</b> option, get a Groq key at <b>console.groq.com</b> and add <b>TRANSCRIPTION_PROVIDER=groq</b> + <b>GROQ_API_KEY</b> to <b>server/.env</b>, then restart the backend. (<b>sarvam</b> is best for Telugu/Hindi code-mixing; <b>openai</b> also works.)
              </div>
            )}
          </div>

          <div className="grid grid-3" style={{ gap: 10 }}>
            <div>
              <label>Speaking language</label>
              <select value={lang} onChange={(e) => setLang(e.target.value)} disabled={recording}>
                {REC_LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
              </select>
            </div>
            <div className="muted" style={{ alignSelf: 'end', fontSize: 12 }}>Summary &amp; tasks: <b>English</b></div>
            <div style={{ alignSelf: 'end' }} className="muted">
              {recording
                ? paused
                  ? <span style={{ color: 'var(--warning)', fontWeight: 700 }}>PAUSED {mmss}</span>
                  : <span style={{ color: '#dc2626', fontWeight: 700 }}>
                      ● REC {mmss}
                      {liveNote
                        ? <span style={{ color: 'var(--warning-ink)', fontWeight: 600 }}> · {liveNote}</span>
                        : (transcribing ? ' · transcribing…' : '')}
                    </span>
                : 'Ready'}
            </div>
          </div>

          {recording && !paused && agentTalking && (
            <div data-va="meetings.live.agent-hold" style={{ background: '#eef2ff', border: '1px solid #c7d2fe', color: '#3730a3', padding: '8px 12px', borderRadius: 8, fontSize: 13 }}>
              <b>Listening to you, not the room</b> — the recording is still running, but what you say to VoTask is being kept out of the transcript.
            </div>
          )}
          {recording && paused && (
            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', padding: '8px 12px', borderRadius: 8, fontSize: 13 }}>
<b>Meeting paused</b> — {pauseWhy ? pauseWhy + ' ' : ''}Nothing is recorded until you tap <b>Resume meeting</b>.
            </div>
          )}
          <div className="row" style={{ gap: 10 }}>
            {!recording ? (
              <button data-va="meetings.live.record" className="btn btn-rec-start" onClick={start} disabled={mode === 'browser' && !browserSupported}>● Start recording</button>
            ) : paused ? (
              <>
                <button data-va="meetings.live.resume" className="btn btn-rec-start" onClick={resumeRecording}>▶ Resume meeting</button>
                <button data-va="meetings.live.stop" className="btn btn-rec-stop" onClick={stop}>■ Stop</button>
              </>
            ) : (
              <button data-va="meetings.live.stop" className="btn btn-rec-stop" onClick={stop}>■ Stop</button>
            )}
            {recording && !paused && transcribing && <span className="spinner" />}
          </div>

          <div>
            <div className="spread">
              <label className="row" style={{ gap: 8 }}>
                Live transcript (editable — fix any names before analyzing)
                {syncedAt
                  ? <span className="md-save">✓ saved to your account</span>
                  : saveFailed
                    ? <span className="md-save md-save-bad">⚠ NOT being saved — storage blocked and no connection</span>
                    : savedAt && <span className="md-save">✓ saved to this device</span>}
              </label>{transcript && <button className="btn btn-sm btn-ghost" onClick={() => setTranscript('')}>Clear</button>}</div>
            <textarea rows={8} value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder={`Recognized speech appears here as "${speaker}: …" lines.`} style={{ fontFamily: 'monospace', fontSize: 12.5 }} />
            {interim && <div className="muted" style={{ fontStyle: 'italic', fontSize: 12, marginTop: 4 }}>… {interim}</div>}
          </div>

          {err && <div style={{ color: 'var(--danger-ink)', fontSize: 13 }}>{err}</div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={close}>Cancel</button>
            <button data-va="meetings.live.finish" className="btn btn-primary" onClick={process} disabled={busy || recording || !transcript.trim()}>{busy ? <><span className="spinner" /> Analyzing…</> : <span className="row" style={{ gap: 6 }}><Ic name="ai" size={15} /> Analyze & extract tasks</span>}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
