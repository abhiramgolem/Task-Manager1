// Tiny fetch wrapper that injects the JWT and unwraps JSON / errors.
const TOKEN_KEY = 'smarttask_token'

// Base URL of the backend. Empty in dev (Vite proxies /api → :4000); set to the
// hosted backend (e.g. https://smarttask-api.onrender.com) for the Android build
// via VITE_API_BASE in client/.env.production.
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')

// Build a WebSocket URL against the backend. In a packaged app `location.host`
// is the app itself (localhost), so we must derive the WS origin from API_BASE
// (http→ws, https→wss). In dev, API_BASE is empty and Vite proxies the upgrade,
// so we fall back to the current page origin.
export const wsUrl = (path: string) => {
  const base = API_BASE || `${location.protocol}//${location.host}`
  return `${base.replace(/^http/, 'ws')}${path}`
}

export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const setToken = (t: string | null) => {
  if (t) localStorage.setItem(TOKEN_KEY, t)
  else localStorage.removeItem(TOKEN_KEY)
}

// An error from the API that says what kind of failure it was, so a caller can
// tell "the server said no" (status 4xx, keep the server's words) from "we never
// reached it" (offline / restarting — try again), and only a 401 means signed out.
export class ApiError extends Error {
  status: number      // 0 = no answer at all (offline, timed out)
  offline: boolean    // could not reach VoTask, or it answered with its restart page
  constructor(message: string, status: number, offline = false) {
    super(message)
    this.status = status
    this.offline = offline
  }
}

// What people see instead of "Failed to fetch" or "Unexpected token '<'". The
// second one was Render's HTML error page (shown while the server restarts after
// a deploy) being parsed as JSON.
export const OFFLINE_MSG = 'No connection to VoTask. Check your internet and try again.'
export const RESTARTING_MSG = 'VoTask is restarting. Please try again in a moment.'
const TIMEOUT_MSG = 'VoTask is taking too long to answer. Please try again.'

// Reads a response body without trusting it to be JSON.
async function readBody(res: Response) {
  const text = await res.text().catch(() => '')
  if (!text) return { data: null, json: true }
  try { return { data: JSON.parse(text), json: true } } catch { return { data: null, json: false } }
}

// The error a failed response turns into. A gateway error, or any answer that
// isn't our JSON, is the platform in front of us — the app is restarting.
function failure(res: Response, data: any, json: boolean, fallback: string) {
  if (!json || res.status === 502 || res.status === 503 || res.status === 504) {
    return new ApiError(data?.error || RESTARTING_MSG, res.status, true)
  }
  return new ApiError(data?.error || `${fallback} (${res.status})`, res.status)
}

// Reads give up after 25 s: a request stuck on a dead connection used to spin
// forever. Writes are left alone — some legitimately take minutes (analysing a
// meeting, transcribing) — unless the caller passes its own `timeoutMs`.
const READ_TIMEOUT = 25_000

async function request(path: string, opts: RequestInit & { timeoutMs?: number } = {}) {
  const { timeoutMs, ...init } = opts
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as any) }
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`
  const limit = timeoutMs ?? ((init.method || 'GET') === 'GET' ? READ_TIMEOUT : 0)
  const ctl = limit ? new AbortController() : null
  const timer = ctl ? setTimeout(() => ctl.abort(), limit) : null
  let res: Response
  try {
    // never serve a cached response — user-specific data must not bleed across accounts
    res = await fetch(`${API_BASE}/api${path}`, { ...init, headers, cache: 'no-store', signal: ctl?.signal ?? init.signal })
  } catch (e: any) {
    throw new ApiError(e?.name === 'AbortError' && ctl?.signal.aborted ? TIMEOUT_MSG : OFFLINE_MSG, 0, true)
  } finally {
    if (timer) clearTimeout(timer)
  }
  const { data, json } = await readBody(res)
  if (!res.ok) throw failure(res, data, json, 'Request failed')
  if (!json) throw new ApiError(RESTARTING_MSG, res.status, true)
  return data
}

// `onProgress` switches to XHR, which fetch cannot replace here: fetch reports
// no upload progress, and a file of hundreds of MB takes minutes on a phone —
// a spinner that never moves for that long reads as stuck.
async function uploadFile(path: string, file: File, field = 'file', onProgress?: (pct: number) => void) {
  const form = new FormData()
  form.append(field, file)
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`
  if (onProgress) {
    return new Promise<any>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${API_BASE}/api${path}`)
      if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`)
      let shown = -1
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return
        const pct = Math.floor((e.loaded / e.total) * 100)
        if (pct !== shown) { shown = pct; onProgress(pct) }
      }
      xhr.onload = () => {
        let data: any = null
        try { data = JSON.parse(xhr.responseText) } catch {}
        if (xhr.status >= 200 && xhr.status < 300) resolve(data)
        else if (!data || xhr.status >= 502) reject(new ApiError(data?.error || RESTARTING_MSG, xhr.status, true))
        else reject(new ApiError(data?.error || `Upload failed (${xhr.status})`, xhr.status))
      }
      xhr.onerror = () => reject(new ApiError(OFFLINE_MSG, 0, true))
      xhr.send(form)
    })
  }
  let res: Response
  try {
    res = await fetch(`${API_BASE}/api${path}`, { method: 'POST', headers, body: form, cache: 'no-store' })
  } catch { throw new ApiError(OFFLINE_MSG, 0, true) }
  const { data, json } = await readBody(res)
  if (!res.ok) throw failure(res, data, json, 'Upload failed')
  return data
}

export const api = {
  get: (p: string, o?: { timeoutMs?: number }) => request(p, o),
  post: (p: string, body?: any, o?: { timeoutMs?: number }) => request(p, { method: 'POST', body: body ? JSON.stringify(body) : undefined, ...o }),
  put: (p: string, body?: any) => request(p, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  patch: (p: string, body?: any) => request(p, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  del: (p: string) => request(p, { method: 'DELETE' }),
  upload: uploadFile,
}

// ---- shared types -----------------------------------------------------------
export type Role = 'admin' | 'manager' | 'employee'
export interface User { id: string; name: string; email: string; role: Role; org_id: string; phone?: string; department_id?: string; avatar_color?: string; avatar_file?: string | null; aliases?: string; preferred_language?: string; email_verified?: number; workspace_personal?: number; platform_admin?: number }

// Authenticated avatar image URLs (token in query so <img> can load them).
// `ver` (the stored filename) busts the browser cache when the photo changes.
export const userAvatarUrl = (userId: string, ver?: string | null) => `${API_BASE}/api/users/${userId}/avatar?token=${getToken()}${ver ? `&v=${encodeURIComponent(ver)}` : ''}`
// Authenticated URL for a task attachment (token in query so <img>/<video> can load it).
// Pass download=true to force a file download instead of inline display.
export const taskAttachmentUrl = (attId: string, download = false) => `${API_BASE}/api/tasks/attachments/${attId}/file?token=${getToken()}${download ? '&download=1' : ''}`
export const groupAvatarUrl = (convId: string, ver?: string | null) => `${API_BASE}/api/chat/conversations/${convId}/avatar?token=${getToken()}${ver ? `&v=${encodeURIComponent(ver)}` : ''}`

// An AI-suggested task awaiting manager review (the review queue).
export interface Suggestion {
  id: string; meeting_id: string; title: string; description?: string
  suggested_assignee_id?: string | null; suggested_assignee_name?: string | null; suggested_assignee_color?: string | null
  suggested_assignee_raw?: string | null; assignee_reasoning?: string | null
  // Who ASKED for the work, as heard in the transcript -- resolved to an
  // account where the spoken name matched one, raw otherwise.
  suggested_assigner_id?: string | null; suggested_assigner_name?: string | null
  suggested_assigner_color?: string | null; suggested_assigner_raw?: string | null
  confidence: number; priority: string; due_date?: string | null; due_date_raw?: string | null
  source_quote?: string | null; status: 'pending' | 'approved' | 'rejected' | 'merged'; created_task_id?: string | null
}
export interface Task {
  id: string; title: string; description?: string; priority: 'Critical' | 'High' | 'Medium' | 'Low'
  status: string; due_date?: string; due_date_raw?: string; progress: number; category?: string | null
  ownership_confidence: string; approval_status: string; source_quote?: string
  assignee?: User; assignedBy?: User; assignee_name_raw?: string; assigned_by_name_raw?: string
  // Raw owner columns (hydrate() spreads the row, so these come through too).
  // Needed to tell "I raised this for myself" — which needs no manager sign-off
  // to complete or delete — from work someone else handed over.
  assignee_id?: string | null; assigned_by_id?: string | null
  project?: { id: string; name: string }; meeting_id?: string
  assigned_at?: string; submitted_at?: string; completed_at?: string; created_at?: string; updated_at?: string
  // Who closed it — the person who marked it Done, or the approver. Null for
  // tasks finished before this was recorded that the audit log couldn't name.
  completed_by_id?: string | null; completedBy?: User | null
  visible_to_manager?: number; parent_task_id?: string | null
  subtasks?: Task[]; comments?: any[]; dependencies?: any[]; attachments?: Attachment[]
  // How this task reached its current owner — drives the badge on each card.
  // 'self' means they created it for themselves, so there's no hand-off to show.
  origin?: TaskOrigin
  reassignedBy?: User; previousAssignee?: User
  reassigned_at?: string | null
  parent?: { id: string; title: string; assignee_id?: string | null } | null
  is_split_parent?: boolean
  // Flat name columns — the dashboard endpoints return rows straight from SQL
  // rather than the hydrated objects above, to avoid ~8 queries per task.
  assigned_by_name?: string | null; reassigned_by_name?: string | null
  assignee_name?: string | null; assignee_color?: string | null; parent_title?: string | null
}
export type TaskOrigin = 'assigned' | 'reassigned' | 'split' | 'self'
export interface Attachment {
  id: string; task_id: string; filename: string; file_type?: string | null; file_size?: number | null
  uploaded_by?: string | null; created_at?: string
}
