import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, API_BASE, getToken } from '../api'
import { useAuth } from '../auth'
import { PriorityBadge, StatusBadge, Ic, dueLabel } from '../ui'
import { toast } from '../lib/toast'
import TaskDrawer from '../components/TaskDrawer'

interface Msg { role: 'user' | 'ai'; text: string; tasks?: any[] }
interface Convo { id: string; title: string; msgs: Msg[]; updated: number }

const MicIcon = ({ size = 16 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" />
  </svg>
)

const GREETING: Msg = { role: 'ai', text: 'Hello! 👋 How can I help you today? Ask me anything about your tasks, deadlines, meetings, or your team\'s workload — in plain language.' }

function relTime(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  return Math.floor(s / 86400) + 'd ago'
}

export default function Assistant() {
  const { user } = useAuth()
  const [convos, setConvos] = useState<Convo[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [navOpen, setNavOpen] = useState(false)
  // System-level problems (query failed, couldn't save) are shown as a strip
  // OUTSIDE the conversation — never as words in the assistant's own bubble.
  const [sysError, setSysError] = useState('')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [lastQuery, setLastQuery] = useState('')
  const [collapsed, setCollapsed] = useState<boolean>(() => localStorage.getItem('smarttask_chat_sidebar_collapsed') === '1')
  const logRef = useRef<HTMLDivElement>(null)

  // Voice input: record a short clip and transcribe it server-side (same Sarvam/
  // Whisper pipeline as the task voice features — reliable on Android & multilingual).
  const [listening, setListening] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const mrRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const canRecord = typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof (window as any).MediaRecorder !== 'undefined'

  const releaseMic = () => {
    try { if (mrRef.current && mrRef.current.state !== 'inactive') mrRef.current.stop() } catch {}
    try { streamRef.current?.getTracks().forEach((t) => t.stop()) } catch {}
    streamRef.current = null
  }
  useEffect(() => releaseMic, [])

  const transcribe = async (blob: Blob) => {
    setTranscribing(true)
    try {
      const fd = new FormData()
      fd.append('audio', blob, 'assistant.webm')
      const headers: Record<string, string> = {}
      const token = getToken()
      if (token) headers.authorization = `Bearer ${token}`
      const res = await fetch(`${API_BASE}/api/tasks/transcribe`, { method: 'POST', headers, body: fd, cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || `Transcription failed (${res.status})`)
      const text = String(data?.text || '').trim()
      // Fill the box (append if the user already typed something) so they can review
      // and edit before sending. The assistant LLM handles any language directly.
      if (text) setInput((prev) => (prev ? prev.trim() + ' ' : '') + text)
      else toast.info("Didn't catch that — please tap the mic and try again.")
    } catch (err: any) {
      toast.error(err?.message || 'Could not transcribe. Check your connection and try again.')
    } finally { setTranscribing(false) }
  }

  const toggleMic = async () => {
    if (listening) { setListening(false); try { mrRef.current?.stop() } catch {}; return }
    if (!canRecord) { toast.error('Voice input needs microphone access on this device.'); return }
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
    catch { toast.error('Microphone access is blocked. Allow mic permission and try again.'); return }
    streamRef.current = stream
    chunksRef.current = []
    let mr: MediaRecorder
    try { mr = new MediaRecorder(stream, { mimeType: 'audio/webm' }) } catch { mr = new MediaRecorder(stream) }
    mrRef.current = mr
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data) }
    mr.onstop = () => {
      try { streamRef.current?.getTracks().forEach((t) => t.stop()) } catch {}
      streamRef.current = null
      const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' })
      chunksRef.current = []
      if (blob.size) transcribe(blob)
    }
    try { mr.start() } catch { setListening(false); releaseMic(); return }
    setListening(true)
  }

  const setSidebar = (c: boolean) => { setCollapsed(c); localStorage.setItem('smarttask_chat_sidebar_collapsed', c ? '1' : '0') }

  const active = useMemo(() => convos.find((c) => c.id === activeId) || convos[0], [convos, activeId])
  const msgs = active?.msgs || []

  // One-time migration of any chats saved in the old localStorage store.
  const migrateLocal = async (serverConvos: Convo[]): Promise<Convo[]> => {
    if (serverConvos.length) return serverConvos
    try {
      const raw = localStorage.getItem(`smarttask_chats_${user?.id}`)
      const local: Convo[] = raw ? JSON.parse(raw) : []
      const meaningful = (local || []).filter((c) => c.msgs?.some((m) => m.role === 'user'))
      if (!meaningful.length) return serverConvos
      const created: Convo[] = []
      for (const c of meaningful) created.push(await api.post('/assistant/conversations', { title: c.title, msgs: c.msgs }))
      localStorage.removeItem(`smarttask_chats_${user?.id}`)
      return created
    } catch { return serverConvos }
  }

  // Load conversations from the server (synced across devices).
  useEffect(() => {
    let cancel = false
    ;(async () => {
      try {
        let { conversations } = await api.get('/assistant/conversations')
        conversations = await migrateLocal(conversations)
        if (!conversations.length) {
          conversations = [await api.post('/assistant/conversations', { title: 'New chat', msgs: [GREETING] })]
        }
        if (cancel) return
        setConvos(conversations)
        setActiveId(conversations[0].id)
      } catch {
        if (!cancel) { const c: Convo = { id: 'local', title: 'New chat', msgs: [GREETING], updated: Date.now() }; setConvos([c]); setActiveId(c.id) }
      } finally { if (!cancel) setLoading(false) }
    })()
    return () => { cancel = true }
  }, [user?.id])

  useEffect(() => { api.get('/assistant/suggestions').then((d) => setSuggestions(d.suggestions)).catch(() => {}) }, [])
  useEffect(() => { logRef.current?.scrollTo(0, logRef.current.scrollHeight) }, [msgs, busy])

  const patchActive = (fn: (c: Convo) => Convo) =>
    setConvos((cs) => cs.map((c) => (c.id === activeId ? fn(c) : c)))

  const startNew = async () => {
    setNavOpen(false)
    try {
      const c: Convo = await api.post('/assistant/conversations', { title: 'New chat', msgs: [GREETING] })
      setConvos((cs) => [c, ...cs]); setActiveId(c.id)
    } catch { /* offline — keep current */ }
  }

  const deleteConvo = async (cid: string, e: React.MouseEvent) => {
    e.stopPropagation()
    api.del(`/assistant/conversations/${cid}`).catch(() => setSysError("Couldn't delete that chat on the server — it may reappear on refresh."))
    const next = convos.filter((c) => c.id !== cid)
    if (!next.length) { await startNew(); setConvos((cs) => cs.filter((c) => c.id !== cid)); return }
    setConvos(next)
    if (cid === activeId) setActiveId(next[0].id)
  }

  // Persist a conversation and reflect the real outcome in the save indicator —
  // a failed write must never look like a successful one.
  const persist = async (convId: string, title: string, msgs: Msg[]) => {
    setSaveState('saving')
    try { await api.put(`/assistant/conversations/${convId}`, { title, msgs }); setSaveState('saved') }
    catch { setSaveState('error'); setSysError("Your last message couldn't be saved. Check your connection.") }
  }

  const send = async (q: string) => {
    if (!q.trim() || busy || !active) return
    const conv = active
    setInput(''); setBusy(true); setSysError(''); setLastQuery(q)
    const history = conv.msgs.slice(-8).map((m) => ({ role: m.role, text: m.text }))
    const title = conv.title === 'New chat' ? q.slice(0, 48) : conv.title
    const withUser: Msg[] = [...conv.msgs, { role: 'user', text: q }]
    patchActive((c) => ({ ...c, title, msgs: withUser, updated: Date.now() }))
    try {
      const r = await api.post('/assistant/query', { query: q, history })
      const finalMsgs: Msg[] = [...withUser, { role: 'ai', text: r.answer, tasks: r.tasks }]
      patchActive((c) => ({ ...c, title, msgs: finalMsgs, updated: Date.now() }))
      setBusy(false)
      await persist(conv.id, title, finalMsgs)
    } catch (e: any) {
      // A system/network failure is NOT the assistant speaking — surface it as a
      // retryable system strip and keep the user's message in place.
      setBusy(false)
      setSysError(e?.message ? `Couldn't reach the assistant: ${e.message}` : "Couldn't reach the assistant.")
    }
  }

  if (loading) return <div className="card" style={{ display: 'grid', placeItems: 'center', height: 'calc(100vh - 160px)' }}><span className="spinner" /></div>

  const sorted = [...convos].sort((a, b) => b.updated - a.updated)

  return (
    <div className={'assistant-layout' + (navOpen ? ' nav-open' : '') + (collapsed ? ' collapsed' : '')}>
      <aside className="chat-history">
        <div className="chat-history-head">
          <span className="ch-title">Chats</span>
          <button className="btn btn-ghost btn-sm collapse-btn" title="Hide history" onClick={() => setSidebar(true)}>«</button>
        </div>
        <button className="btn btn-primary new-chat-btn" onClick={startNew}>+ New chat</button>
        <div className="convo-list">
          {sorted.map((c) => (
            <div
              key={c.id}
              className={'convo-item' + (c.id === activeId ? ' active' : '')}
              onClick={() => { setActiveId(c.id); setNavOpen(false) }}
            >
              <div className="convo-meta">
                <div className="convo-title">{c.title}</div>
                <div className="convo-time">{relTime(c.updated)}</div>
              </div>
              <button className="convo-del" title="Delete chat" onClick={(e) => deleteConvo(c.id, e)}>×</button>
            </div>
          ))}
        </div>
      </aside>

      <div className="card chat-pane" style={{ padding: 18 }}>
        <div className="chat">
          <button className="btn btn-ghost btn-sm history-open-btn row" style={{ gap: 6 }} title="Show history" onClick={() => setSidebar(false)}><Ic name="menu" size={15} /> History</button>
          {/* Mobile header: history icon (opens past chats) · current title · quick New */}
          <div className="chat-mobile-bar">
            <button className="chat-list-btn" onClick={() => setNavOpen(true)} title="Chat history" aria-label="Chat history">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l3 3" /></svg>
            </button>
            <span className="convo-current">{active?.title || 'New chat'}</span>
            <button className="btn btn-ghost btn-sm assistant-newchat" onClick={startNew} title="New chat">+ New</button>
          </div>
          <div className="chat-log" ref={logRef}>
            {msgs.map((m, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start', gap: 8 }}>
                <div className={'bubble ' + m.role}>{m.text}</div>
                {m.tasks && m.tasks.length > 0 && (
                  <div className="card" style={{ maxWidth: '80%', width: '100%' }}>
                    <table>
                      <tbody>
                        {m.tasks.map((t: any) => (
                          <tr key={t.id} className="clickable" onClick={() => setOpenId(t.id)}
                            role="button" tabIndex={0} aria-label={`Open ${t.title}`}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(t.id) } }}>
                            <td><div style={{ fontWeight: 600, fontSize: 13 }}>{t.title}</div><div className="muted" style={{ fontSize: 11.5 }}>{t.assignee_name || 'Unassigned'} · {dueLabel(t)}</div></td>
                            <td style={{ textAlign: 'right' }}><PriorityBadge p={t.priority} /> <StatusBadge s={t.status} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
            {busy && (
              <div className="bubble ai typing-bubble">
                <span className="typing-dots"><i /><i /><i /></span>
                <span className="typing-text" style={{ marginLeft: 8 }}>Reading your tasks…</span>
              </div>
            )}
          </div>
          {sysError && (
            <div className="sys-strip" role="alert">
              <span className="sys-strip-ic" aria-hidden="true"><Ic name="warning" size={16} /></span>
              <span className="sys-strip-text">{sysError}</span>
              {lastQuery && saveState !== 'saving' && (
                <button className="btn btn-sm" onClick={() => send(lastQuery)}>Retry</button>
              )}
              <button className="sys-strip-x" aria-label="Dismiss" onClick={() => setSysError('')}>✕</button>
            </div>
          )}
          <div>
            {suggestions.length > 0 && (
              <div className="suggestions">
                {suggestions.map((s) => <span key={s} className="suggestion" onClick={() => send(s)}>{s}</span>)}
              </div>
            )}
            <div className="chat-input">
              <input placeholder={listening ? 'Listening… tap the mic to stop' : 'Ask about your tasks…'} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) send(input) }} autoFocus />
              {canRecord && (
                <button
                  type="button"
                  className={'btn btn-mic' + (listening ? ' btn-mic-live' : '')}
                  onClick={toggleMic}
                  disabled={transcribing}
                  title={listening ? 'Stop' : 'Speak your question'}
                  aria-label={listening ? 'Stop recording' : 'Speak your question'}
                >
                  {transcribing ? <span className="spinner" /> : listening ? <span className="mic-dot" /> : <MicIcon size={18} />}
                </button>
              )}
              <button className="btn btn-primary" onClick={() => send(input)} disabled={busy || listening}>Send</button>
            </div>
            <div className={'save-state save-state--' + saveState} aria-live="polite">
              {saveState === 'saving' && <>Saving…</>}
              {saveState === 'saved' && <span className="row" style={{ gap: 5, justifyContent: 'flex-end' }}><Ic name="check" size={13} /> Saved · synced across your devices</span>}
              {saveState === 'error' && <span className="row" style={{ gap: 5, justifyContent: 'flex-end' }}><Ic name="warning" size={13} /> Not saved — your last message may be lost</span>}
            </div>
          </div>
        </div>
      </div>
      {openId && <TaskDrawer taskId={openId} onClose={() => setOpenId(null)} />}
    </div>
  )
}
