// Where tapping a notification takes you. The bell and the phone push both ask
// here, so the two cannot drift apart again: the push used to send mentions and
// missed calls to Tasks while the bell sent them to Chats, and neither knew
// which chat a message was in, so both stopped at the chat list.
//
// A chat notification carries its conversation (and usually the exact message)
// since the server started recording them; an older one, filed before that and
// not matched by the backfill, still opens the chat list as it always did.

export interface NotifRef {
  type?: string | null
  conversationId?: string | null
  messageId?: string | null
  taskId?: string | null
  commentId?: string | null
}

export function notifTarget(n: NotifRef): string | null {
  if (n.conversationId) {
    const q = new URLSearchParams({ c: n.conversationId })
    if (n.messageId) q.set('msg', n.messageId)
    // The daily update reminder opens the card to fill in, not just the chat.
    if (n.type === 'update_reminder') q.set('update', '1')
    return `/chats?${q}`
  }
  if (n.type?.startsWith('chat_')) return '/chats'
  if (n.taskId) {
    // A comment opens the task on that comment (the drawer scrolls to it).
    const q = new URLSearchParams({ task: n.taskId })
    if (n.commentId) q.set('comment', n.commentId)
    return `/tasks?${q}`
  }
  return null
}

// A chat link opened while already on Chats replaces the entry rather than
// adding one: Back from the chat it opens should not land on a second copy of
// the chat (or list) you were just looking at.
export const replacesEntry = (to: string, pathname: string) => pathname === '/chats' && to.startsWith('/chats')
