import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from './db.js'
import { id, now, audit } from './util.js'

// A task made from a chat message takes the message's file with it.
//
// A screenshot with "look at these and reduce" is the usual way work gets handed
// over in the chat, and the picture IS the task — but making the task copied only
// the words, so the assignee opened a task that said "look at these" with nothing
// to look at. The file goes onto the task as an ordinary attachment.
//
// Its own module rather than a helper in routes/chat.js: POST /api/tasks is the
// one place tasks are made, and it must not import the chat router to get here.

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
const CHAT_DIR = path.join(DATA, 'chat_uploads')
const TASK_DIR = path.join(DATA, 'task_uploads')

// Attach message `messageId`'s file to `task`. Returns the attachment id, or null
// when there is nothing to attach or the user may not read that message. Never
// throws: the task already exists, and a file that can't follow it must not turn
// the assignment into a failure.
export function attachMessageFile(task, messageId, user) {
  try {
    if (!messageId || !task) return null
    const m = db.prepare(`SELECT id, org_id, conversation_id, file_name, file_stored, file_type, file_size, deleted_for_all
      FROM chat_messages WHERE id=?`).get(String(messageId))
    if (!m || !m.file_stored || m.deleted_for_all || m.org_id !== task.org_id) return null
    // Only someone in that chat can see its file, so only they can move it onto a task.
    if (!db.prepare('SELECT 1 FROM chat_participants WHERE conversation_id=? AND user_id=?').get(m.conversation_id, user.id)) return null
    // The sheet and the full form can both hand the same message over; one copy is enough.
    const filename = m.file_name || 'file'
    if (db.prepare('SELECT 1 FROM attachments WHERE task_id=? AND filename=? AND file_size IS ?').get(task.id, filename, m.file_size ?? null)) return null

    // A name of its own, as a hard link rather than a copy — the same reasoning
    // as forwarding a chat file: a copy of a 1 GB video would stall the one
    // server thread and spend the disk twice. Deleting the message (or the
    // attachment) unlinks one name and leaves the other's bytes in place.
    const stored = id('att') + path.extname(m.file_stored).slice(0, 12)
    const from = path.join(CHAT_DIR, m.file_stored), to = path.join(TASK_DIR, stored)
    fs.mkdirSync(TASK_DIR, { recursive: true })
    try { fs.linkSync(from, to) } catch { fs.copyFileSync(from, to) }

    const aid = id('att')
    db.prepare(`INSERT INTO attachments (id, task_id, org_id, filename, stored_name, file_type, file_size, uploaded_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(aid, task.id, task.org_id, filename, stored, m.file_type || null, m.file_size || 0, user.id, now())
    audit(task.org_id, user.id, 'task.attach', 'task', task.id, `${filename} (from chat)`)
    return aid
  } catch (e) {
    console.error('[task] could not attach the chat file:', e.message)
    return null
  }
}

// Once per database: tasks already made from a message with a file, before the
// file followed the task, get it now. A task card replying to that message is
// how one was made, and its sender is who made it. Hard links, so this is
// metadata work, not a copy of every file.
export function backfillChatTaskFiles() {
  const KEY = 'chat_task_files_backfill_v1'
  if (db.prepare('SELECT 1 FROM app_meta WHERE key=?').get(KEY)) return
  const rows = db.prepare(`SELECT c.task_id, c.sender_id, s.id AS src FROM chat_messages c
    JOIN chat_messages s ON s.id=c.reply_to
    WHERE c.kind='task' AND c.task_id IS NOT NULL AND s.file_stored IS NOT NULL AND s.deleted_for_all=0`).all()
  let n = 0
  for (const x of rows) {
    const task = db.prepare('SELECT id, org_id FROM tasks WHERE id=?').get(x.task_id)
    if (task && attachMessageFile(task, x.src, { id: x.sender_id })) n++
  }
  db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(KEY, '1')
  if (n) console.log(`[task] attached ${n} chat file(s) to tasks made from them`)
}
