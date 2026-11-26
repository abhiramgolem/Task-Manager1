import { pushToUser } from './ws/chatHub.js'
import { sendCallPush } from './push.js'

// Reading a notification takes it down on every device, not only the one it
// was read on. People read the bell or open the task on the computer and the
// phone kept buzzing with the same three notifications (and the other way
// round), so the tray stopped meaning "things still to look at".
//
// Each push carries a tag (notify() in util.js): `task_<id>` for a task, so a
// task's later news replaces its earlier one; `ntf_<row id>` for anything else
// on the bell; the chat's own `chat_<id>` / `react_<id>`. The tag is kept on
// the bell row (notifications.push_tag), so a read knows what to take down:
// - open tabs and an app on screen hear it at once over their socket, close
//   their browser notifications and refresh the bell (the client's
//   'notif-clear' handler, NotificationBell);
// - phones get a silent data push the app's messaging service acts on with the
//   app closed (CallMessagingService "notif-clear"). Chats are left to their
//   own "chat-read", which also clears the thread's message history.
// A browser with no VoTask tab open can't be reached without showing something;
// its stale notifications are swept the next time the app is opened.

const TAG_RE = /^[A-Za-z0-9_:-]{1,80}$/
const isChatTag = (t) => /^(chat|react)_/.test(t)

// The tag a bell row's push went out with. Rows from before tags were kept
// fall back to their task's, which is what their next push would use.
export function trayTagOf(row) {
  return row?.push_tag || (row?.task_id ? `task_${row.task_id}` : null)
}

// Bell reads leave a chat's tray entry alone: a mention is read on the bell,
// but the chat itself is still unread until it is opened.
export const bellTags = (rows) => rows.map(trayTagOf).filter((t) => t && !isChatTag(t))

// One phone push per person per few seconds, however many reads went into it:
// opening tasks one after another, or reading a busy chat line by line.
const pending = new Map()

export function clearEverywhere(userId, tags, { bell = true } = {}) {
  if (!userId) return
  const list = [...new Set((tags || []).filter((t) => typeof t === 'string' && TAG_RE.test(t)))].slice(0, 100)
  pushToUser(userId, { type: 'notif-clear', tags: list, bell })
  const phone = list.filter((t) => !isChatTag(t))
  if (!phone.length) return
  let p = pending.get(userId)
  if (!p) {
    p = { tags: new Set() }
    pending.set(userId, p)
    setTimeout(() => {
      pending.delete(userId)
      // FCM data is capped at 4 KB; a hundred tags is well under it.
      const all = [...p.tags].slice(0, 100).join(',')
      sendCallPush(userId, { type: 'notif-clear', tags: all }, { ttlSec: 3 * 3600 }).catch(() => {})
    }, 3000)
  }
  for (const t of phone) p.tags.add(t)
}
