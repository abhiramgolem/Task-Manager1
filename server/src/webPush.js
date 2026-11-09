// Browser notifications for the website (Web Push), the way WhatsApp Web and
// Cliq on the web notify: a message or a task reaches the person's computer
// while VoTask's tab is in the background, or closed while the browser runs.
// The phone app keeps its own FCM path (push.js); this is the same
// notification, sent to every browser the person has turned it on in.
//
// Keys: a VAPID key pair identifies this server to the browsers' push
// services. From VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY when set; otherwise made
// once and kept in app_meta, so it works with no setup and survives restarts.
// A new pair would orphan every browser that subscribed, which is why it is
// stored rather than made on each boot.
import webpush from 'web-push'
import { db } from './db.js'
import { appUrl } from './util.js'

let keys = null
function vapid() {
  if (keys) return keys
  let pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY
  if (!pub || !priv) {
    const row = db.prepare("SELECT value FROM app_meta WHERE key='vapid_keys'").get()
    if (row) ({ publicKey: pub, privateKey: priv } = JSON.parse(row.value))
    else {
      const k = webpush.generateVAPIDKeys()
      db.prepare("INSERT INTO app_meta (key, value) VALUES ('vapid_keys', ?)").run(JSON.stringify(k))
      pub = k.publicKey; priv = k.privateKey
    }
  }
  // The push services want a way to reach whoever runs the server: the site's
  // own https address, or a mailto: given in VAPID_SUBJECT.
  const site = appUrl()
  const subject = process.env.VAPID_SUBJECT || (site.startsWith('https://') ? site : 'mailto:notifications@localhost.invalid')
  webpush.setVapidDetails(subject, pub, priv)
  keys = { pub, priv }
  return keys
}

export const webPushKey = () => vapid().pub

// One row per browser. An endpoint moves to whoever signed in on that browser
// last, as a phone's token does, so a shared computer never shows the last
// person's messages to the next.
export function saveWebSub(userId, sub, ua = '') {
  const endpoint = String(sub?.endpoint || '')
  const p256dh = String(sub?.keys?.p256dh || ''), auth = String(sub?.keys?.auth || '')
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 2000 || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) return false
  db.prepare('DELETE FROM web_push_subs WHERE endpoint=?').run(endpoint)
  db.prepare('INSERT INTO web_push_subs (endpoint, user_id, p256dh, auth, ua, created_at) VALUES (?,?,?,?,?,?)')
    .run(endpoint, userId, p256dh, auth, String(ua).slice(0, 200), new Date().toISOString())
  return true
}
export function removeWebSub(endpoint, userId) {
  db.prepare('DELETE FROM web_push_subs WHERE endpoint=? AND user_id=?').run(String(endpoint || ''), userId)
}

// Where a click on the notification goes: the same places the bell and the
// phone open (client lib/notifTarget.ts).
function targetOf(d = {}) {
  if (d.conversationId) {
    const q = new URLSearchParams({ c: d.conversationId })
    if (d.messageId) q.set('msg', d.messageId)
    if (d.type === 'update_reminder') q.set('update', '1')
    return `/chats?${q}`
  }
  if (String(d.type || '').startsWith('chat_')) return '/chats'
  if (d.taskId) {
    const q = new URLSearchParams({ task: d.taskId })
    if (d.commentId) q.set('comment', d.commentId)
    return `/tasks?${q}`
  }
  return '/'
}

// Fire-and-forget to every browser of this person. Never throws. A browser the
// push service says is gone (404/410: notifications switched off, site data
// cleared) is dropped.
export async function sendWebPush(userId, { title, body, tag, data }) {
  if (!userId) return
  const rows = db.prepare('SELECT endpoint, p256dh, auth FROM web_push_subs WHERE user_id=?').all(userId)
  if (!rows.length) return
  try { vapid() } catch (e) { console.warn('  [web-push] keys:', e.message); return }
  const payload = JSON.stringify({ title: title || 'VoTask', body: body || '', tag: tag || undefined, url: targetOf(data), type: data?.type || '' })
  await Promise.all(rows.map(async (r) => {
    try {
      // urgency high: delivered at once, as a phone's high-priority push is.
      await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, payload, { TTL: 24 * 3600, urgency: 'high' })
    } catch (e) {
      if (e?.statusCode === 404 || e?.statusCode === 410) db.prepare('DELETE FROM web_push_subs WHERE endpoint=?').run(r.endpoint)
      else console.warn('  [web-push] send failed', e?.statusCode || '', String(e?.body || e?.message || '').slice(0, 120))
    }
  }))
}
