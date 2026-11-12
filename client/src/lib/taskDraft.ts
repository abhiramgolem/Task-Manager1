// A task drafted somewhere else in the app — today, from a chat message — and
// handed to the Tasks page, which opens its real "New task" form pre-filled on it.
//
// sessionStorage rather than query params: a chat message runs to 4000 characters,
// which does not fit a URL, and a task description has no business sitting in the
// browser's history. The draft is read once and dropped, so a later reload of
// /tasks?new=1 opens an empty form rather than resurrecting a stale message.
export interface TaskDraft {
  title: string
  description?: string
  priority?: string
  due_date?: string
  assignee_id?: string
  assignee_name?: string | null
  // The chat message it came from, when that message carries a file: the task
  // is created with the file attached (POST /tasks → attachMessageFile).
  source_message_id?: string
}

const KEY = 'smarttask_task_draft'

export function stashTaskDraft(draft: TaskDraft) {
  try { sessionStorage.setItem(KEY, JSON.stringify(draft)) } catch {}
}

export function takeTaskDraft(): TaskDraft | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    sessionStorage.removeItem(KEY)
    return JSON.parse(raw)
  } catch { return null }
}
