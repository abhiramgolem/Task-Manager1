// Real-time chat hub: pushes new direct messages to recipients instantly over
// a WebSocket, so the Chats page doesn't have to wait for the next poll.
//
// Client -> us:   nothing (the socket is push-only; messages are still SENT over
//                 the REST POST /api/chat/:userId so they're persisted reliably)
// us -> Client:   { type: 'ready' }                          on connect
//                 { type: 'message', message: {...} }        when a DM arrives
//
// A user may have several tabs/devices open, so we keep a Set of sockets per
// user id and fan out to all of them.
import { WebSocketServer } from 'ws'
import { verifyToken } from '../auth.js'
import { db } from '../db.js'

// userId -> Set<WebSocket>
const clients = new Map()
// userId -> org_id, for scoping presence. Presence used to go to every socket on
// the server, so one company's people saw another's come and go.
const orgOf = new Map()

// The biggest legitimate frame is a WebRTC offer (a few KB of SDP). The library
// default is 100 MiB per message, which on a 512 MB instance is a memory bomb.
const MAX_FRAME = 64 * 1024

// Things to run whenever one of someone's devices connects. The chat routes
// register here to move delivery ticks forward — a registry rather than an
// import, because routes/chat.js already imports this module.
const onlineHooks = []
export function onUserOnline(fn) { onlineHooks.push(fn) }

export function attachChatHub(server) {
  // `noServer` + manual upgrade routing so this shares the HTTP server with the
  // live-transcription socket without either aborting the other's handshakes.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME })
  server.on('upgrade', (req, socket, head) => {
    let pathname
    try { pathname = new URL(req.url, 'http://localhost').pathname } catch { return }
    if (pathname !== '/api/chat/ws') return // not ours — let another handler take it
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost')
    const user = verifyToken(url.searchParams.get('token'))
    if (!user) {
      try { ws.send(JSON.stringify({ error: 'Authentication required' })) } catch {}
      return ws.close(4401, 'unauthorized')
    }

    ws.userId = user.id
    ws.orgId = user.org_id
    orgOf.set(user.id, user.org_id)
    const wasOffline = !clients.has(user.id) || clients.get(user.id).size === 0
    if (!clients.has(user.id)) clients.set(user.id, new Set())
    clients.get(user.id).add(ws)
    try { ws.send(JSON.stringify({ type: 'ready' })) } catch {}
    // Presence: tell everyone this user came online (first socket only), and tell
    // this socket who is currently online.
    try { ws.send(JSON.stringify({ type: 'presence-list', online: getOnlineUsers(user.org_id) })) } catch {}
    if (wasOffline) broadcastOrg(user.org_id, { type: 'presence', userId: user.id, online: true })
    for (const fn of onlineHooks) { try { fn(user.id) } catch (e) { console.warn('[chat] online hook failed:', e.message) } }

    // Relay ephemeral signals: "typing…", and WebRTC call negotiation.
    //
    // Everything a client sends is untrusted, and an exception thrown here is
    // uncaught: crashLog.js exits the process on one, taking every user's chat,
    // call and upload down with it. A frame of `null`, or an id sent as an object
    // (which better-sqlite3 refuses to bind), was enough. So the whole handler is
    // guarded, the frame must be a plain object, and ids are strings or nothing.
    ws.on('message', (raw) => {
      try { onFrame(raw) } catch (e) { console.warn('[chat-ws] bad frame from', user.id, '-', e.message) }
    })
    const str = (v) => (typeof v === 'string' && v.length <= 64 ? v : null)
    const onFrame = (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return

      // Application-level heartbeat. The client can't see protocol pings, so a
      // half-open socket (phone switched networks) looked OPEN to it forever and
      // it never reconnected; now it asks, and reconnects when no pong comes.
      if (msg.type === 'ping') { try { ws.send('{"type":"pong"}') } catch {} return }

      const conversationId = str(msg.conversationId)
      if (msg.type === 'typing' && conversationId) {
        const isMember = db.prepare('SELECT 1 FROM chat_participants WHERE conversation_id=? AND user_id=?').get(conversationId, user.id)
        if (!isMember) return
        const others = db.prepare('SELECT user_id FROM chat_participants WHERE conversation_id=? AND user_id!=?').all(conversationId, user.id)
        // mode 'recording' is WhatsApp's "recording audio…" — someone holding a
        // voice note open, which is worth waiting for just like typing is.
        const mode = msg.mode === 'recording' ? 'recording' : 'typing'
        const payload = { type: 'typing', conversationId, userId: user.id, name: user.name, isTyping: !!msg.isTyping, mode }
        for (const o of others) pushToUser(o.user_id, payload)
        return
      }

      // WebRTC offer / answer / ICE candidate, relayed verbatim between two
      // people in the same call. The server is a post box, not a participant:
      // it never parses the SDP and the audio and video never pass through it —
      // they go peer-to-peer, which is what keeps a group call from costing us
      // bandwidth per stream.
      //
      // Both ends are still checked every time. `callId` alone would let anyone
      // who guessed one inject an offer, so the sender must be a member of that
      // call's conversation and the recipient must be one too — a stale socket
      // from someone since removed from the group cannot keep signalling into it.
      const callId = str(msg.callId), to = str(msg.to)
      if (msg.type === 'call-signal' && callId && to) {
        const call = db.prepare('SELECT conversation_id FROM chat_calls WHERE id=?').get(callId)
        if (!call) return
        const inConvo = (uid) => db.prepare('SELECT 1 FROM chat_participants WHERE conversation_id=? AND user_id=?').get(call.conversation_id, uid)
        if (!inConvo(user.id) || !inConvo(to)) return
        pushToUser(to, { type: 'call-signal', callId, from: user.id, signal: msg.signal })
      }
    }

    // Heartbeat bookkeeping so we can reap dead sockets (closed laptops etc.).
    ws.isAlive = true
    ws.on('pong', () => { ws.isAlive = true })

    const detach = () => {
      const set = clients.get(user.id)
      if (set) {
        set.delete(ws)
        if (!set.size) {
          clients.delete(user.id)
          const ts = new Date().toISOString()
          try { db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(ts, user.id) } catch {}
          broadcastOrg(user.org_id, { type: 'presence', userId: user.id, online: false, last_seen: ts })
        }
      }
    }
    ws.on('close', detach)
    ws.on('error', () => { try { ws.close() } catch {} })
  })

  // Ping every 30s; terminate any socket that didn't pong since the last round.
  const heartbeat = setInterval(() => {
    for (const set of clients.values()) {
      for (const ws of set) {
        if (ws.isAlive === false) { try { ws.terminate() } catch {}; continue }
        ws.isAlive = false
        try { ws.ping() } catch {}
      }
    }
  }, 30000)
  wss.on('close', () => clearInterval(heartbeat))

  return wss
}

// Push a JSON payload to every live socket for a user. No-op if they're offline
// (they'll see the message on next load / poll instead).
export function pushToUser(userId, payload) {
  const set = clients.get(userId)
  if (!set || !set.size) return
  const data = JSON.stringify(payload)
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) { try { ws.send(data) } catch {} }
  }
}

// Presence changes go to the sockets of the same organisation only.
function broadcastOrg(orgId, payload) {
  const data = JSON.stringify(payload)
  for (const set of clients.values()) for (const ws of set) if (ws.orgId === orgId && ws.readyState === ws.OPEN) { try { ws.send(data) } catch {} }
}

// Currently-online user ids (those with at least one live socket) — of one
// organisation when `orgId` is given. Server-side callers that already filter
// to a conversation's members may omit it.
export function getOnlineUsers(orgId = null) {
  return [...clients.keys()].filter((uid) => (clients.get(uid)?.size || 0) > 0 && (!orgId || orgOf.get(uid) === orgId))
}
