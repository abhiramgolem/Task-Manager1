import { customAlphabet } from 'nanoid'
import crypto from 'node:crypto'

const nano = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12)
export const id = (prefix = '') => (prefix ? `${prefix}_` : '') + nano()
export const now = () => new Date().toISOString()

// A high-entropy, URL-safe token for invite / password-reset / verification links.
// 32 random bytes → 43-char base64url string (far stronger than an id()).
export const genToken = () => crypto.randomBytes(32).toString('base64url')

// Base URL of the front-end, used to build links inside emails. In production the
// API and the web client share one origin (set APP_URL to it on Render); locally
// the Vite dev server runs on :5173.
export const appUrl = () => (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '')

// An ISO timestamp `days` in the future — for token expiry.
export const inDays = (days) => new Date(Date.now() + days * 86400000).toISOString()

// Default lead time (in days from today) for each priority — used to auto-fill a
// task's due date when none was set. Critical = today, High = tomorrow, etc.
const DUE_DAYS_BY_PRIORITY = { Critical: 0, High: 1, Medium: 3, Low: 5 }

// Compute a default due date (YYYY-MM-DD, in the server's local timezone) from a
// priority. Local date parts are used so "same day" is correct for IST evenings.
export function dueDateForPriority(priority, from = new Date()) {
  const days = DUE_DAYS_BY_PRIORITY[priority] ?? DUE_DAYS_BY_PRIORITY.Medium
  const d = new Date(from)
  d.setDate(d.getDate() + days)
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${da}`
}

import { db } from './db.js'
import { sendPushToUser } from './push.js'

// --- Password safety: reject the most common/breached passwords server-side ---
// (Defense in depth — the client also blocks these, but the API enforces it too.)
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', '12345678', '123456789', '1234567890',
  'qwerty', 'qwertyui', 'qwerty123', '11111111', '00000000', 'abc12345', 'iloveyou',
  'admin123', 'welcome1', 'welcome123', 'letmein1', 'letmein123', 'football', 'monkey12',
  'sunshine', 'princess', 'dragon123', 'master123', 'login123', 'changeme', 'secret12',
])
export function isCommonPassword(pw) {
  return COMMON_PASSWORDS.has(String(pw || '').toLowerCase())
}

// --- Per-org allowed email domains -----------------------------------------
// An org may restrict which email domains its members can use (e.g. befach.com,
// gmail.com). Empty list = no restriction (any domain allowed). Used by user
// creation, imports, and invites so every org enforces its OWN domains.
export function orgAllowedDomains(orgId) {
  const org = db.prepare('SELECT allowed_domains FROM organizations WHERE id=?').get(orgId)
  const raw = (org?.allowed_domains || '').trim()
  return raw ? raw.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean) : []
}
export function emailDomainAllowed(orgId, email) {
  const domains = orgAllowedDomains(orgId)
  if (!domains.length) return true // no restriction configured
  const dom = String(email || '').toLowerCase().split('@')[1] || ''
  return domains.includes(dom)
}

export function audit(orgId, actorId, action, entityType, entityId, detail = '') {
  db.prepare(
    `INSERT INTO audit_logs (id, org_id, actor_id, action, entity_type, entity_id, detail, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id('aud'), orgId, actorId, action, entityType, entityId, typeof detail === 'string' ? detail : JSON.stringify(detail), now())
}

// Short, human title per notification type — shown as the push heading.
const PUSH_TITLES = {
  task_assigned: 'New task assigned',
  task_reassigned: 'Task reassigned',
  task_comment: 'New comment',
  task_submitted: 'Task submitted',
  task_completed: 'Task completed',
  task_approved: 'Task approved',
  task_reopened: 'Task reopened',
  chat_message: 'New message',
  chat_mention: 'You were mentioned',
  chat_call: 'Missed call',
  chat_reminder: 'Reminder',
  call_review: 'Call ready for review',
}

// A short, human name for the client behind a request — "Android app",
// "Chrome on Windows". Used by the session list and by feedback's context line.
export function deviceLabel(ua = '') {
  const s = String(ua)
  if (/SmartTask|Capacitor|wv\)/i.test(s) && /Android/i.test(s)) return 'Android app'
  const os = /Windows/i.test(s) ? 'Windows'
    : /iPhone|iPad|iPod/i.test(s) ? 'iOS'
    : /Android/i.test(s) ? 'Android'
    : /Mac OS X/i.test(s) ? 'macOS'
    : /Linux/i.test(s) ? 'Linux' : ''
  // Order matters — Edge and Chrome both claim "Chrome", Chrome claims "Safari".
  const browser = /Edg\//i.test(s) ? 'Edge'
    : /OPR\//i.test(s) ? 'Opera'
    : /Firefox\//i.test(s) ? 'Firefox'
    : /Chrome\//i.test(s) ? 'Chrome'
    : /Safari\//i.test(s) ? 'Safari' : ''
  if (browser && os) return `${browser} on ${os}`
  return browser || os || 'Unknown device'
}

// Notification types that belong to Chats, not to the bell. Rows of these
// filed before the bell went task-only are still in the table, so readers of
// it filter them out by this list too. A mention is the one chat event that
// does go to the bell: it is addressed to you by name, like a task is.
export const BELL_SKIPPED_TYPES = ['chat_message', 'chat_call', 'chat_reminder']

// Which notification categories a person still wants. Every type maps to one
// category so a toggle governs a whole family rather than a single message.
export const NOTIF_CATEGORIES = {
  task_assigned: 'tasks',
  task_reassigned: 'tasks',
  task_submitted: 'approvals',
  task_completed: 'approvals',
  task_approved: 'approvals',
  task_reopened: 'approvals',
  task_comment: 'comments',
  chat_message: 'chat',
  task_due_soon: 'deadlines',
}
// NULL prefs = never chose = everything on, which is how it behaved before the
// setting existed. Only an explicit false turns a category off.
export function notifAllowed(userId, type) {
  const cat = NOTIF_CATEGORIES[type]
  if (!cat) return true
  const row = db.prepare('SELECT notif_prefs FROM users WHERE id=?').get(userId)
  if (!row?.notif_prefs) return true
  try { return JSON.parse(row.notif_prefs)[cat] !== false } catch { return true }
}

// Create an in-app notification for a single recipient, and fire a native push
// to their devices (no-op if FCM isn't configured). Push is fire-and-forget so a
// slow/failed send never blocks the request.
//
// `link` is the exact thing a notification is about, past the task it names.
// For chat it is { conversationId, messageId }. Without it the bell and the push
// could only open the chat LIST — "Abhiram: hi" landed you on every conversation
// you have and left you to find his. The message id is optional (a new group has
// no one line to point at); the conversation alone still opens the right thread.
// For a task comment it is { commentId }: the task alone opened the drawer at its
// title, with the comment at the very bottom under everything else.
//
// `push` overrides what the phone shows: { title, body, tag }. A chat passes a
// tag per conversation so its messages replace one notification, as Cliq and
// WhatsApp do, instead of stacking a new one for every line.
export function notify(orgId, userId, type, message, taskId = null, link = null, push = null) {
  if (!userId) return
  // A muted category is dropped outright rather than filed and hidden — a bell
  // that still counts messages you asked not to receive is not switched off.
  if (!notifAllowed(userId, type)) return
  const conversationId = link?.conversationId || null
  const messageId = (conversationId && link?.messageId) || null
  const commentId = (taskId && link?.commentId) || null
  // The bell is for tasks and mentions. Chat already has its own unread
  // counts and list, and filing every message there too buried the task
  // updates among them — so other chat events are pushed but never filed.
  if (!BELL_SKIPPED_TYPES.includes(type)) {
    db.prepare(
      `INSERT INTO notifications (id, org_id, user_id, type, message, task_id, conversation_id, message_id, comment_id, read, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,0,?)`
    ).run(id('ntf'), orgId, userId, type, message, taskId, conversationId, messageId, commentId, now())
  }
  sendPushToUser(userId, {
    title: push?.title || PUSH_TITLES[type] || 'SmartTask',
    body: push?.body || message,
    tag: push?.tag,
    data: { type, taskId, conversationId, messageId, commentId },
  }).catch(() => {})
}

// Notify every manager/admin in the org (e.g. when an employee submits work).
export function notifyManagers(orgId, type, message, taskId = null, excludeId = null) {
  const mgrs = db.prepare("SELECT id FROM users WHERE org_id=? AND role IN ('manager','admin')").all(orgId)
  for (const m of mgrs) if (m.id !== excludeId) notify(orgId, m.id, type, message, taskId)
}
