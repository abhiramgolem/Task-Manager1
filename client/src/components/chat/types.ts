// What the chat API hands back (server/src/routes/chat.js), shared by the
// Chats page and the pieces of it that live in this folder.
import { API_BASE, getToken } from '../../api'

// `role` is the person's role in this chat (admin / member); `job_role` is who
// they are in the workspace (manager / employee), which is what a contact's
// subtitle should say.
export interface Member { id: string; name: string; avatar_color?: string; avatar_file?: string | null; role: string; job_role?: string; status_text?: string; status_emoji?: string; dnd_until?: string | null }
export interface Conversation {
  id: string; type: 'direct' | 'group'; name: string; avatar_color?: string; avatar_file?: string | null
  other_user_id?: string | null; other_last_seen?: string | null; member_count: number; members: Member[]; role: string
  last_message: string | null; last_sender_name: string | null; last_from_me: boolean; last_at: string | null; unread: number
  last_kind?: string | null; last_seen?: boolean; last_delivered?: boolean
  muted?: boolean; muted_until?: string | null; pinned?: boolean; visibility?: 'private' | 'public'
  archived?: boolean; marked_unread?: boolean
  description?: string; admins_only?: boolean; created_by?: string | null; created_at?: string
}
export interface Reaction { emoji: string; user_id: string }
// Who a message named. Carried as ids + current names rather than re-parsed from
// the body, so two teammates sharing a first name stay distinguishable.
export interface MentionRef { id: string; name: string }
// `from`: the group a privately-answered message came from ("Reply privately").
export interface ReplyPreview { id: string; sender_id: string; sender_name: string; text: string; image?: boolean; from?: string | null; conversation_id?: string }
export interface ChatFile { name: string; type?: string; size?: number }
// A finished call leaves a line in the thread instead of a chat bubble.
export interface CallInfo { id: string; kind: 'audio' | 'video'; status: string; started_by: string; duration_sec: number; joined: number }
// The audit a transcribed call leaves behind, shown where the call happened —
// with how many of its tasks wait for review (`tasks`), and those a manager
// has since assigned from it.
export interface AssignedFromCall { title: string; task_id: string | null; assignee_id: string | null; assignee_name: string | null }
export interface MeetingCard { id: string; title: string; summary: string; engine?: string; tasks: number; decisions: number; risks: number; blockers: number; assigned?: AssignedFromCall[]; can_review?: boolean }
export interface PollOption { text: string; voters: string[] }
export interface Poll { multi: boolean; options: PollOption[] }
export interface TaskRef {
  id: string; title?: string; status?: string; priority?: string; due_date?: string | null
  assignee_id?: string | null; assignee_name?: string | null; assignee_color?: string | null; assignee_avatar?: string | null
  deleted?: boolean
}
export interface LocationRef { lat: number; lng: number; label: string; accuracy?: number | null }
export interface ContactRef { id: string; name: string; email?: string; role?: string; avatar_color?: string; avatar_file?: string | null }
// kind: null for an ordinary message; otherwise 'system' (a group event line),
// 'poll', 'task', 'location' or 'contact', each with its own field below.
export interface Msg {
  id: string; conversation_id: string; sender_id: string; body: string; created_at: string
  kind?: 'system' | 'poll' | 'task' | 'location' | 'contact' | 'update' | null
  edited_at?: string | null; forwarded?: boolean; reply_to?: string | null; reply?: ReplyPreview | null; file?: ChatFile | null
  reactions: Reaction[]; mentions?: MentionRef[]; starred: boolean; seen: boolean; delivered?: boolean; deleted?: boolean; uploading?: boolean; progress?: number
  // Local only: a message of mine the server has not saved (lib/outbox.ts).
  failed?: boolean; failReason?: string | null; client_id?: string
  pinned_at?: string | null; call?: CallInfo | null; transcript?: string | null; meeting?: MeetingCard | null
  system?: string | null; poll?: Poll | null; task?: TaskRef | null; location?: LocationRef | null; contact?: ContactRef | null
  update?: UpdateMeta | null
}
// A daily metrics card (server routes/dailyUpdates.js): the person's own
// message with blanks. `text` is the template it was posted from ("___" a
// blank, "{month}", "{date}"); `values` fill the blanks in order. `metrics`:
// cards posted before the text templates, shown as they were.
export interface UpdateMetric { id: string; label: string; target: number | null; unit: string; value: number | null; total: number | null }
export interface UpdateMeta {
  template_id: string; title: string; day: string; note?: string
  text?: string; values?: string[]; month?: string; date?: string | null
  metrics?: UpdateMetric[]
}
export interface UpdateTemplate {
  id: string; conversation_id: string; title: string; body: string
  remind_at: string | null; remind_days: number[]; last_posted_date: string | null
}
export interface OrgUser { id: string; name: string; email: string; role: string; avatar_color?: string; avatar_file?: string | null }
export type Workload = Record<string, { open: number; overdue: number }>

// The file behind a message. API_BASE matters on the Android app, where the
// page is served from the phone itself and a bare /api path goes nowhere.
export const fileUrl = (m: { id: string }, download = false) => `${API_BASE}/api/chat/file/${m.id}?token=${getToken()}${download ? '&download=1' : ''}`
export const isImage = (f?: ChatFile | null) => !!f && (f.type || '').startsWith('image/')
// The MIME decides; only a missing or generic type falls back to the name,
// where a .webm is a recording if the app named it one (voice-note…,
// call-recording…) and a video otherwise. So a clip a phone sent as
// octet-stream still plays in the thread instead of sitting there as a file.
export const isVideo = (f?: ChatFile | null) => {
  if (!f) return false
  const type = (f.type || '').split(';')[0].trim().toLowerCase()
  if (type && type !== 'application/octet-stream') return type.startsWith('video/')
  const name = (f.name || '').toLowerCase()
  return /\.(mp4|mov|m4v|mkv|avi|3gp)$/.test(name) || (/\.webm$/.test(name) && !/^(voice-note|call-recording)/.test(name))
}
// MIME first here too: a video/webm clip is not a voice note just because of
// its extension. The name only decides when the browser declared no type at all.
export const isAudio = (f?: ChatFile | null) => !!f && !isVideo(f) && ((f.type || '').startsWith('audio/') || /\.(webm|m4a|mp3|ogg|wav)$/i.test(f.name || ''))

// Something a person typed (and so may edit): not a record of an event.
export const isEditable = (m: Msg) => !m.deleted && !m.kind && !m.call && !m.meeting && !isAudio(m.file) && !m.id.startsWith('tmp_')
// Something that can travel to another chat.
export const isForwardable = (m: Msg) => !m.deleted && !m.call && !m.meeting && (!m.kind || m.kind === 'location' || m.kind === 'contact') && !m.id.startsWith('tmp_')
// A line that records what happened rather than a message anyone sent.
export const isRecordLine = (m: Msg) => m.kind === 'system' || !!m.call || !!m.meeting

export function fmtTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })
}
export function dayLabel(iso: string) {
  const d = new Date(iso), today = new Date(), yest = new Date()
  yest.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yest.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
// "Today, 4:12 pm" / "Yesterday, 9:03 am" / "12 Oct, 6:40 pm" — the receipt times.
export function whenLabel(iso: string) {
  return `${dayLabel(iso)}, ${fmtTime(iso)}`
}
