// The application's tool table — everything the agent is able to do, as data.
//
// This is the only place a capability is defined. The model is shown these names,
// the Action Engine validates against them, and the UI surfaces execute them. Adding
// "generate a report" means adding one entry here and one surface on the report page;
// no part of the engine, the conversation loop or the prompt builder changes.
//
// The important rule, and the reason this file exists at all: a tool is a *workflow*,
// not an API call. `create_task` does not POST /tasks — it opens the screen a person
// would open and fills the fields a person would fill. The user watches their own UI
// do the work, which is the entire product claim. The write still happens through the
// same endpoint the form always used, so permissions, notifications, category
// detection and audit logging are unchanged.
//
// It stops short of the button on purpose: speech is the one input here that can be
// confidently wrong, and a misheard name or date should cost a glance, not an undo.
import { registerTools, type ToolDef, type ToolResult, type ToolContext } from './actionEngine'
import { invoke, awaitSurface, getSurface } from './uiRegistry'
import { pause } from './uiController'
import { api } from '../api'

const ok = (say?: string, data?: any): ToolResult => ({ ok: true, say, data })
const fail = (say: string, suggest?: ToolResult['suggest']): ToolResult => ({ ok: false, say, suggest })

// Route the agent takes for a given "show me X" request. Kept here rather than in the
// prompt so the model only has to name a target, not know the app's URL scheme.
const VIEW_URLS: Record<string, string> = {
  dashboard: '/',
  tasks: '/tasks',
  my_tasks: '/tasks?mine=1',
  overdue: '/tasks?view=overdue',
  completed: '/tasks?view=completed',
  active: '/tasks?view=active',
  meetings: '/meetings',
  chats: '/chats',
  leaderboard: '/leaderboard',
  admin: '/admin',
}

export const TOOLS: ToolDef[] = [
  {
    name: 'navigate',
    label: ({ target }) => `Opening ${String(target || 'that').replace(/_/g, ' ')}…`,
    requires: ['target'],
    prompts: { target: 'Which screen would you like me to open?' },
    run: async ({ target }, ctx) => {
      const url = VIEW_URLS[String(target)]
      if (!url) return fail(`I don't know a screen called "${target}".`)
      ctx.navigate(url)
      await pause(500)                    // let the route mount before the next step
      return ok()
    },
  },

  {
    name: 'create_task',
    label: ({ title }) => (title ? `Creating "${title}"…` : 'Creating the task…'),
    // Deliberately NOT requiring priority or due date: the form defaults both, and
    // interrogating the user for fields the app can decide is what makes assistants
    // tedious. Title and assignee are the two a wrong guess would get wrong.
    requires: ['title'],
    prompts: {
      title: 'What should the task be called?',
      assignee_name: 'Who should I assign it to?',
    },
    summarize: ({ title, assignee_name }) =>
      `Create "${title}"${assignee_name ? ` for ${assignee_name}` : ''}`,
    run: async ({ title, description, assignee_id, assignee_name, priority, due_date }, ctx) => {
      // 1. Get to the Tasks screen and open the form the human would use.
      ctx.navigate('/tasks')
      await awaitSurface('tasks')
      await invoke('tasks', 'openNew')
      const form = await awaitSurface('tasks.new')

      // 2. Resolve the person BEFORE typing anything. A name that matches nobody has
      // to become a question, and it is far less jarring to ask up front than to ask
      // after the user has watched half a form fill in.
      //
      // `assignee_id` arrives already resolved when the server's own name matching
      // succeeded (it has the alias table and the full org, which the client does
      // not). Only fall back to matching the spoken name here when it didn't.
      let assigneeId: string | null = assignee_id || null
      let assigneeName: string | null = assignee_id ? assignee_name || null : null
      if (!assigneeId && assignee_name) {
        const { match, candidates } = await form.resolveAssignee({ name: assignee_name })
        if (!match) {
          const alt = candidates[0]
          await invoke('tasks.new', 'cancel')
          return fail(
            `I couldn't find anyone called ${assignee_name}.`,
            alt
              ? { question: `I couldn't find ${assignee_name}. I found ${alt.name} — should I use them?`, patch: { assignee_name: alt.name } }
              : undefined,
          )
        }
        assigneeId = match.id
        assigneeName = match.name
      }

      // 3. Fill the form in the order a person reads it.
      await form.setTitle({ value: title })
      if (description) await form.setDescription({ value: description })
      if (priority) await form.setPriority({ value: priority })
      if (assigneeId) await form.setAssignee({ id: assigneeId })
      if (due_date) await form.setDueDate({ value: due_date })

      // The server resolves the person to an id but does not send the name back, so
      // read it off the form we just filled. Without this the agent reports "I've
      // created X" for an assignment it did make — technically true, but it drops
      // the one fact the user most needs to hear to know it picked the right person.
      if (assigneeId && !assigneeName) assigneeName = (await form.read())?.assignee_name || null

      // 4. Stop. The form is filled; the person presses Create.
      //
      // Speech recognition is the one input in this app that can be confidently
      // wrong — a misheard name assigns work to the wrong colleague, and a
      // misheard date sets a deadline nobody agreed to. Submitting on the user's
      // behalf turns every such mistake into something they have to notice and
      // then undo, after it has already notified someone.
      //
      // So the agent does everything up to the button and hands over. Filling is
      // still done by driving the real form, so what is approved is exactly what
      // saves. Create is left focused, so Enter finishes it in one keystroke.
      await form.handOver()

      return ok(
        assigneeName
          ? `I've filled it in for ${assigneeName} — have a look, then press Create task.`
          : `I've filled it in — have a look, then press Create task.`,
      )
    },
  },

  {
    name: 'filter_tasks',
    label: ({ priority, status }) => `Filtering by ${[priority, status].filter(Boolean).join(' + ') || 'your criteria'}…`,
    run: async ({ priority, status, assignee }, ctx) => {
      ctx.navigate('/tasks')
      await invoke('tasks', 'filter', { priority, status, assignee })
      return ok()
    },
  },

  {
    name: 'open_task',
    label: () => 'Opening the task…',
    requires: ['task_id'],
    prompts: { task_id: 'Which task did you mean?' },
    run: async ({ task_id }, ctx) => {
      ctx.navigate('/tasks')
      await invoke('tasks', 'openTask', { id: task_id })
      return ok()
    },
  },

  // ---- chats ---------------------------------------------------------------
  {
    name: 'send_message',
    label: ({ to_name }) => `Messaging ${to_name || 'them'}…`,
    requires: ['to_user_id', 'text'],
    prompts: { text: 'What should the message say?' },
    // The only action here that another person sees, and the only one that cannot
    // be undone from the UI. It confirms even though it is now fully visible.
    destructive: true,
    summarize: ({ to_name, text }) => `Message ${to_name || 'them'}: "${text}"`,
    run: async ({ to_user_id, to_name, text }, ctx) => {
      ctx.navigate('/chats')
      await awaitSurface('chats')
      await invoke('chats', 'openDirect', { userId: to_user_id })
      await invoke('chats', 'typeMessage', { value: text })
      await invoke('chats', 'send')
      window.dispatchEvent(new Event('chat-unread-changed'))
      return ok(`Sent to ${to_name || 'them'}.`)
    },
  },

  // ---- editing an existing task, in its drawer -----------------------------
  // These open the task the user is talking about and change it there, rather than
  // PATCHing invisibly and jumping to a list. Seeing WHICH task changed is the
  // whole difference between trusting the assistant and re-checking its work.
  {
    name: 'set_status',
    label: ({ status, task_title }) => `Setting ${task_title ? `"${task_title}"` : 'the task'} to ${status}…`,
    requires: ['task_id', 'status'],
    run: async ({ task_id, status }, ctx) => {
      await openDrawer(task_id, ctx)
      await invoke('task.drawer', 'changeStatus', { status })
      window.dispatchEvent(new CustomEvent('tasks-changed'))
      return ok()
    },
  },

  {
    name: 'assign_task',
    label: ({ assignee_name }) => `Assigning to ${assignee_name || 'them'}…`,
    requires: ['task_id', 'assignee_id'],
    run: async ({ task_id, assignee_id, assignee_name }, ctx) => {
      await openDrawer(task_id, ctx)
      await invoke('task.drawer', 'assignTo', { id: assignee_id })
      window.dispatchEvent(new CustomEvent('tasks-changed'))
      return ok(assignee_name ? `Assigned to ${assignee_name}.` : undefined)
    },
  },

  {
    name: 'add_comment',
    label: () => 'Adding your comment…',
    requires: ['task_id', 'body'],
    prompts: { body: 'What should the comment say?' },
    run: async ({ task_id, body }, ctx) => {
      await openDrawer(task_id, ctx)
      await invoke('task.drawer', 'comment', { body })
      window.dispatchEvent(new CustomEvent('tasks-changed'))
      return ok()
    },
  },

  // ---- live meetings -------------------------------------------------------
  // The one screen where voice is not a convenience. During a meeting your hands
  // are busy, the phone is face-down on the table, and reaching for it to press
  // Pause is exactly the interruption you are trying to avoid.
  {
    name: 'start_meeting',
    label: () => 'Starting the recording…',
    run: async ({ title }, ctx) => {
      ctx.navigate('/meetings?live=1')
      // ?live=1 opens the recorder; the page consumes the flag itself.
      const live = await awaitSurface('meetings.live', 10000)
      if (title) await live.setTitle({ value: title })
      const r = await live.record()
      if (r?.already) return ok('That meeting is already recording.')
      // The microphone now belongs to the meeting — see `endSession` in
      // actionEngine.ts. Say the wake word again to take it back.
      return { ...ok('Recording now.'), endSession: true }
    },
  },

  {
    name: 'control_meeting',
    label: ({ action }) => ({
      pause: 'Pausing the recording…', resume: 'Resuming the recording…',
      stop: 'Stopping the recording…', finish: 'Finishing and analysing…',
    } as Record<string, string>)[action] || 'Adjusting the recording…',
    requires: ['action'],
    run: async ({ action }) => {
      // Never navigate here. The recorder lives inside the Meetings page, so a
      // route change would unmount it and destroy the session being controlled.
      const live = getSurface('meetings.live')
      if (!live) return fail("There's no meeting recording open right now.")
      const before = await live.status()

      switch (action) {
        case 'pause':
          if (!before.recording) return fail('Nothing is recording at the moment.')
          if (before.paused) return ok('It’s already paused.')
          await live.pause()
          return ok('Paused. Say resume when you’re ready.')
        case 'resume':
          if (!before.paused) return fail('The recording isn’t paused.')
          await live.resume()
          // Capturing again, so the mic goes back to the meeting. Pause and stop
          // deliberately do NOT stand down: nothing is recording after those, and
          // staying live is what lets "…now finish it" follow without a wake word.
          return { ...ok('Recording again.'), endSession: true }
        case 'stop':
          if (!before.recording) return fail('Nothing is recording at the moment.')
          await live.stop()
          return ok('Stopped. Say finish when you want the tasks pulled out.')
        case 'finish': {
          const r = await live.finish()
          if (r?.empty) return fail("There's nothing transcribed yet, so there's nothing to analyse.")
          return ok('Analysing the meeting and pulling out the tasks now.')
        }
        default:
          return fail("I can pause, resume, stop or finish a recording.")
      }
    },
  },

  // ---- bridge tools --------------------------------------------------------
  // The server's voice router already resolves a spoken command into a concrete
  // action: it matched the name against the org's alias table, checked the role,
  // found the task id, parsed "by Friday" into a date. Throwing that away to
  // re-derive it on the client would be a downgrade, so these two tools carry a
  // server-resolved action into the engine and get the trace, the confirmation
  // policy and the recovery flow applied to it uniformly.

  {
    name: 'navigate_url',
    // Derived from the URL, not from the spoken sentence. The `say` is already a
    // full sentence ("Opening that now.") and interpolating it produced
    // "Opening Opening that now.…" in the trace.
    label: ({ url }) => `Opening ${screenName(url)}…`,
    requires: ['url'],
    run: async ({ url }, ctx) => {
      ctx.navigate(url)
      await pause(420)
      return ok()
    },
  },

  {
    name: 'admin_tab',
    label: ({ tab }) => `Opening ${tab === 'users' ? 'User Management' : tab}…`,
    requires: ['tab'],
    run: async ({ tab }) => {
      await invoke('admin', 'openTab', { tab })
      return ok()
    },
  },

  {
    name: 'api_action',
    label: ({ action }) => {
      const s = action?.summary
      return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}…` : 'Applying that…'
    },
    requires: ['action'],
    // Only the actions you cannot walk back. A status change or a comment is
    // visible, reversible, and the user just asked for it out loud — making those
    // a two-turn "shall I?" is the thing that makes assistants tiring to use.
    // Deleting, removing a teammate and sending a message to a human are all
    // one-way doors, so those still stop and ask.
    // invite_user belongs here with the others: it emails a stranger and puts them
    // in the org. Visible to someone else, and not silently undoable.
    // approve_suggestions creates real tasks and notifies every assignee — as
    // outward-facing as send_message, so it stops for the same yes.
    // post_update puts a card in a team chat for everyone there to see.
    destructive: ({ action }) => ['delete_task', 'remove_user', 'send_message', 'invite_user', 'approve_suggestions', 'post_update'].includes(action?.kind),
    summarize: ({ action }) => {
      const s = action?.summary || 'apply that change'
      return s.charAt(0).toUpperCase() + s.slice(1)
    },
    confirmMeta: ({ action }) => ({ needsPassword: ['remove_user', 'invite_user'].includes(action?.kind) }),
    run: async ({ action, password }, ctx) => {
      await runAction(action, password)
      // Refresh whatever the change touched and land the user where the result is.
      // Mirrors what the old direct-execution path did, so the lists behind the
      // assistant never show stale data after a voice edit.
      if (action.kind === 'invite_user') {
        window.dispatchEvent(new CustomEvent('users-changed'))
        // Straight to the User Management tab, not Administration's default
        // Overview: the whole point is to see the invitation now sitting under
        // "Pending invitations". UserManagement loads on mount, so this is also
        // what actually makes the new row appear.
        ctx.navigate('/admin?tab=users')
      } else if (action.kind === 'remove_user') {
        window.dispatchEvent(new CustomEvent('users-changed'))
        ctx.navigate('/admin')
      } else if (action.kind === 'send_message') {
        window.dispatchEvent(new Event('chat-unread-changed'))
        ctx.navigate('/chats')
      } else if (action.kind === 'post_update') {
        // To the chat, where the card just went up.
        ctx.navigate(`/chats?c=${encodeURIComponent(action.conversation_id)}`)
      } else if (action.kind === 'read_notifications') {
        // Stay put — clearing the bell is not a reason to yank the user anywhere.
        window.dispatchEvent(new Event('notifications-changed'))
      } else if (action.kind === 'approve_suggestions') {
        // Land on the meeting so the user sees the queue drain and the tasks appear.
        window.dispatchEvent(new CustomEvent('tasks-changed'))
        ctx.navigate(`/meetings/${action.meeting_id}`)
      } else {
        window.dispatchEvent(new CustomEvent('tasks-changed'))
        ctx.navigate('/tasks')
        if (action.task_id) await invoke('tasks', 'highlightTask', { id: action.task_id }).catch(() => {})
      }
      return ok()
    },
  },
]

// A short, human name for a route, for the trace line: "/tasks?status=Blocked"
// reads as "the Blocked tasks", not as a URL.
function screenName(url: string): string {
  try {
    const [path, query] = String(url || '').split('?')
    const q = new URLSearchParams(query || '')
    const status = q.get('status'), priority = q.get('priority'), view = q.get('view')
    if (status) return `the ${status} tasks`
    if (priority) return `the ${priority} tasks`
    if (view) return `the ${view} tasks`
    const name: Record<string, string> = {
      '/': 'the dashboard', '/tasks': 'Tasks', '/meetings': 'Meetings',
      '/chats': 'Chats', '/leaderboard': 'the Leaderboard', '/admin': 'Administration',
    }
    return name[path] || 'that'
  } catch { return 'that' }
}

// Open a task's drawer and wait for it to be the one on screen.
//
// The drawer is a single component reused for whichever task is open, so it can
// already be mounted showing a DIFFERENT task when a plan's second step runs. The
// id check is what stops step two editing the task step one happened to leave open.
async function openDrawer(taskId: string, ctx: ToolContext): Promise<void> {
  ctx.navigate('/tasks')
  await invoke('tasks', 'openTask', { id: taskId })
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    const surface = getSurface('task.drawer')
    if (surface && (await surface.id()) === taskId) { await pause(320); return }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error("that task's details didn't open")
}

// Execute one server-resolved action against the endpoints the UI itself uses, so
// permissions, notifications, category detection and audit logging are identical to
// a change made by hand.
async function runAction(action: any, password?: string): Promise<void> {
  switch (action.kind) {
    case 'create_task': await api.post('/tasks', action.body); break
    case 'set_status': await api.post(`/tasks/${action.task_id}/status`, action.body); break
    case 'add_comment': await api.post(`/tasks/${action.task_id}/comments`, action.body); break
    case 'delete_task': await api.del(`/tasks/${action.task_id}`); break
    case 'send_message': {
      const conv: any = await api.post('/chat/conversations', { type: 'direct', userId: action.to_user_id })
      await api.post(`/chat/conversations/${conv.id}/messages`, { body: action.text })
      break
    }
    case 'read_notifications': await api.post('/notifications/read-all'); break
    case 'post_update': await api.post(`/chat/conversations/${action.conversation_id}/update`, { values: action.values, note: action.note || '' }); break
    case 'delete_own_comment': await api.del(`/tasks/${action.task_id}/comments/latest-own`); break
    // Empty ids = every pending suggestion that has an owner, same as the meeting
    // page's own "Assign all" button.
    case 'approve_suggestions': await api.post(`/meetings/${action.meeting_id}/assign`, {}); break
    case 'remove_user': {
      // Re-auth first: a spoken command must never be sufficient on its own to
      // delete a colleague's account.
      await api.post('/auth/verify-password', { password })
      await api.del(`/users/${action.to_user_id}`)
      break
    }
    case 'invite_user': {
      // Same re-auth bar as removal — this sends mail in the org's name and grants
      // a stranger a way in. The invitee sets their own name and password on the
      // link, so no credential for them ever passes through the voice channel.
      await api.post('/auth/verify-password', { password })
      await api.post('/invites', { email: action.email, role: action.role })
      break
    }
    // update_task / assign_task and friends all PATCH the task's fields.
    default: await api.patch(`/tasks/${action.task_id}`, action.body)
  }
}

registerTools(TOOLS)
