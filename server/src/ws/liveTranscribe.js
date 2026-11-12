// Live transcription WebSocket proxy: browser  <->  this server  <->  Sarvam.
//
// The browser can't talk to Sarvam directly — it can't attach the
// `Api-Subscription-Key` header to a WebSocket handshake, and we must never ship
// the key to the client. So the browser opens a socket to us; we open an upstream
// socket to Sarvam, relaying raw PCM16 audio up and transcripts back down.
//
// Client -> us:   base64 string of little-endian 16-bit PCM @ 16 kHz (one frame)
// us -> Sarvam:   { audio: { data, sample_rate: "16000", encoding: "audio/wav" } }
// Sarvam -> us:   { type: "data",  data: { transcript } }  /  { type: "error", data: { message } }
// us -> Client:   { transcript }  /  { error }
//
// TWO endpoints share this relay, with deliberately different policies:
//   /api/meetings/live   managers/admins; language LOCKED (a 2h meeting mis-detected
//                        into Malayalam poisons the whole transcript, so meetings
//                        pin the language and let the user pick it in the recorder)
//   /api/assistant/live  every role; language AUTO-DETECTED (a voice command is one
//                        short code-mixed sentence — "Ravi ki assign cheyyi" locked
//                        to en-IN comes out as English mush, and a wrong guess costs
//                        one retry, not a meeting)
import { WebSocketServer, WebSocket } from 'ws'
import { verifyToken } from '../auth.js'

// Overridable so the reconnect path can be exercised against a local socket that
// drops on command — the real one only misbehaves after a long meeting, which is
// not something a test can wait for.
const SARVAM_WS = process.env.SARVAM_WS_URL || 'wss://api.sarvam.ai/speech-to-text/ws'

function attachSarvamRelay(server, { path, allowUser, pickLanguage, accept, onTranscript, stillAllowed }) {
  // `noServer` + manual upgrade routing so multiple WS endpoints can share one
  // HTTP server. (Binding with `{ server, path }` makes ws abort every mismatched
  // upgrade with a 400, which would kill the other endpoints' handshakes.)
  // Audio arrives as short PCM frames; 1 MB is generous for one and stops a
  // single frame from claiming the library's 100 MiB default.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  server.on('upgrade', (req, socket, head) => {
    let pathname
    try { pathname = new URL(req.url, 'http://localhost').pathname } catch { return }
    if (pathname !== path) return // not ours — let another handler take it
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (client, req) => {
    const url = new URL(req.url, 'http://localhost')
    const token = url.searchParams.get('token')
    const language = pickLanguage(url.searchParams.get('language'))

    // --- Auth ---
    const user = verifyToken(token)
    if (!user || !allowUser(user)) {
      try { client.send(JSON.stringify({ error: 'Authentication required' })) } catch {}
      return client.close(4401, 'unauthorized')
    }
    // A relay that serves one thing (a call) decides here whether this person
    // may open it, and gets back whatever it needs to file the words.
    const ctx = accept ? accept(user, url) : null
    if (accept && !ctx) {
      try { client.send(JSON.stringify({ error: 'Not transcribing this call' })) } catch {}
      return client.close(4403, 'forbidden')
    }

    // --- Provider guard ---
    const key = process.env.SARVAM_API_KEY
    if ((process.env.TRANSCRIPTION_PROVIDER || '').toLowerCase() !== 'sarvam' || !key) {
      try { client.send(JSON.stringify({ error: 'Live streaming requires TRANSCRIPTION_PROVIDER=sarvam and SARVAM_API_KEY.' })) } catch {}
      return client.close(4400, 'provider')
    }

    // --- Open the upstream Sarvam socket ---
    const model = process.env.SARVAM_MODEL || 'saarika:v2.5'
    const upstreamUrl = `${SARVAM_WS}?language-code=${encodeURIComponent(language)}`
      + `&model=${encodeURIComponent(model)}&mode=transcribe`
      + `&sample_rate=16000&input_audio_codec=pcm_s16le`
    // --- Upstream lifecycle -------------------------------------------------
    //
    // Sarvam's streaming socket does not stay open for the length of a real
    // meeting — it ends on its own, and the relay used to answer that by killing
    // the browser's socket too. The recording then died silently: the mic kept
    // running and the UI still said "recording", but every frame was dropped on
    // a closed socket. That is the whole reason a long meeting could not be
    // captured.
    //
    // So the upstream is now disposable. When it closes we open another one and
    // carry on, buffering the audio that arrives in between so the words spoken
    // during the gap are still sent. The browser's socket is never closed for an
    // upstream problem — only when the client itself goes away.
    let sarvam = null
    let sarvamReady = false
    let everOpened = false      // distinguishes "bad key" from "session ended"
    let clientGone = false
    let attempts = 0
    let reconnectTimer = null
    let sessions = 1, sessionStart = 0, lastCloseAt = 0

    // Frames waiting for an upstream. PCM16 @16 kHz is ~32 KB/s, ~43 KB/s once
    // base64'd, so this cap holds roughly a minute and a half of speech — far
    // more than a reconnect needs, and bounded so a wedged upstream cannot grow
    // it without limit for three hours.
    const MAX_PENDING_BYTES = 4 * 1024 * 1024
    const pending = []
    let pendingBytes = 0
    let droppedFrames = 0

    const toClient = (obj) => { if (client.readyState === WebSocket.OPEN) { try { client.send(JSON.stringify(obj)) } catch {} } }

    const flush = () => {
      while (pending.length && sarvam && sarvam.readyState === WebSocket.OPEN) {
        const f = pending.shift()
        pendingBytes -= f.length
        sarvam.send(f)
      }
      if (!pending.length) pendingBytes = 0
    }

    const sendToSarvam = (b64) => {
      const frame = JSON.stringify({ audio: { data: b64, sample_rate: '16000', encoding: 'audio/wav' } })
      if (sarvamReady && sarvam && sarvam.readyState === WebSocket.OPEN) { sarvam.send(frame); return }
      pending.push(frame)
      pendingBytes += frame.length
      // Drop the OLDEST first: if we must lose audio, losing the start of the gap
      // beats losing what is being said right now.
      while (pendingBytes > MAX_PENDING_BYTES && pending.length) {
        pendingBytes -= pending.shift().length
        droppedFrames++
      }
    }

    const openUpstream = () => {
      if (clientGone) return
      sarvam = new WebSocket(upstreamUrl, { headers: { 'Api-Subscription-Key': key } })

      sarvam.on('open', () => {
        sarvamReady = true
        attempts = 0
        const first = !everOpened
        everOpened = true
        // `ready` only on the FIRST open. The voice assistant starts its turn
        // clock on that message, and re-sending it mid-turn would restart the
        // clock every time Sarvam recycled a socket.
        if (first) {
          sessionStart = Date.now()
          toClient({ ready: true })
        } else {
          const gap = Date.now() - lastCloseAt
          console.log(`[live] upstream #${++sessions} open after ${gap}ms (${pending.length} frames buffered, ${droppedFrames} dropped)`)
          toClient({ resumed: true, dropped: droppedFrames })
        }
        flush()
      })

      sarvam.on('message', (raw) => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }
        if (msg.type === 'data' && msg.data?.transcript) {
          toClient({ transcript: msg.data.transcript })
          if (onTranscript) { try { onTranscript(ctx, msg.data.transcript) } catch (e) { console.warn('[live] transcript hook failed:', e.message) } }
        }
        else if (msg.type === 'error') toClient({ error: msg.data?.message || 'Sarvam error' })
      })

      // Errors are not handled here: ws always follows an 'error' with a 'close',
      // and having one path decide what happens next avoids reconnecting twice.
      sarvam.on('error', () => {})

      sarvam.on('close', () => {
        sarvamReady = false
        if (clientGone) return
        if (!everOpened) {
          // Never connected once — a bad key or a wrong URL. Retrying that
          // forever would just hide the misconfiguration.
          toClient({ error: 'Could not reach Sarvam. Check SARVAM_API_KEY.' })
          try { client.close() } catch {}
          return
        }
        lastCloseAt = Date.now()
        console.log(`[live] upstream closed after ${Math.round((lastCloseAt - sessionStart) / 1000)}s of session — reconnecting`)
        const delay = Math.min(5000, 250 * 2 ** attempts++)
        toClient({ reconnecting: true })
        reconnectTimer = setTimeout(openUpstream, delay)
      })
    }

    openUpstream()

    // Both sockets get pings. An idle stretch — a pause in the room — must not
    // be mistaken for a dead peer and closed by an intermediary.
    const keepAlive = setInterval(() => {
      // Sarvam bills for every second streamed. A socket whose reason to exist
      // is gone (the call ended, its transcription was switched off) is closed
      // here rather than trusting the browser to: a crashed or stuck tab would
      // otherwise stream silence to Sarvam for as long as it stayed open.
      if (stillAllowed && !stillAllowed(ctx)) { try { client.close(4403, 'done') } catch {}; return }
      if (sarvam && sarvam.readyState === WebSocket.OPEN) { try { sarvam.ping() } catch {} }
      if (client.readyState === WebSocket.OPEN) { try { client.ping() } catch {} }
    }, 20000)

    const teardown = () => {
      clientGone = true
      clearInterval(keepAlive)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try { sarvam && sarvam.close() } catch {}
    }

    // --- Client -> Sarvam relay ---
    client.on('message', (raw) => {
      // Audio frames are base64 strings; ignore anything non-text/empty.
      const data = raw.toString()
      if (data) sendToSarvam(data)
    })
    client.on('close', teardown)
    client.on('error', teardown)
  })

  return wss
}

export function attachLiveTranscribe(server) {
  return attachSarvamRelay(server, {
    path: '/api/meetings/live',
    // Only managers/admins may stream a meeting.
    allowUser: (u) => u.role === 'manager' || u.role === 'admin',
    // Lock to a single language so live meeting audio is never mis-transcribed into
    // other Indian languages. Client may request one of en/hi/te; otherwise (or
    // "unknown") fall back to SARVAM_LANGUAGE (default English).
    pickLanguage: (requested) => (requested && requested !== 'unknown')
      ? requested
      : (process.env.SARVAM_LANGUAGE || 'en-IN'),
  })
}

export function attachAssistantLive(server) {
  return attachSarvamRelay(server, {
    path: '/api/assistant/live',
    // Voice commands are for everyone — same as POST /assistant/command.
    allowUser: () => true,
    // Auto-detect by default: commands are code-mixed Telugu/Hindi/English and the
    // meeting-style en-IN lock mangles them. VOICE_STT_LANGUAGE pins it if a
    // deployment finds auto-detect drifting into other languages.
    pickLanguage: () => process.env.VOICE_STT_LANGUAGE || 'unknown',
  })
}

// A call: each person on it streams their OWN microphone here, so every line
// arrives already attributed to whoever said it — and the server files it into
// the call's transcript itself (hooks from routes/chat.js) rather than trusting
// the browser to post it back, which is one more hop to lose a line on.
// Auto-detected language: calls here are Telugu, Hindi and English mixed in one
// sentence, which a locked en-IN turns into English mush. CALL_STT_LANGUAGE pins
// it if a deployment finds detection drifting.
export function attachCallLive(server, hooks) {
  return attachSarvamRelay(server, {
    path: '/api/chat/call/live',
    allowUser: () => true,
    pickLanguage: () => process.env.CALL_STT_LANGUAGE || 'unknown',
    accept: hooks.accept,
    onTranscript: hooks.onTranscript,
    stillAllowed: hooks.stillAllowed,
  })
}
