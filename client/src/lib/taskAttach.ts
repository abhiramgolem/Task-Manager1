import { api } from '../api'
import { CHUNKED_FROM, sendInChunks } from './chunkedUpload'

// Task attachments: any kind of file, up to 500 MB each — the server's limit
// (TASK_ATTACH_MAX_MB in routes/tasks.js), checked here so an oversized file is
// turned away at once instead of after minutes of uploading.
export const TASK_ATTACH_MAX = 500 * 1024 * 1024

// Splits a pick into what can be attached and a message about what can't.
export function attachable(list: FileList | File[]): { ok: File[]; skipped: string | null } {
  const all = Array.from(list)
  const ok = all.filter((f) => f.size <= TASK_ATTACH_MAX)
  const over = all.filter((f) => f.size > TASK_ATTACH_MAX)
  const skipped = !over.length ? null
    : over.length === 1 ? `"${over[0].name}" is over 500 MB, so it wasn't attached.`
    : `${over.length} files are over 500 MB, so they weren't attached.`
  return { ok, skipped }
}

// "report.final.XLSX" → "XLSX"; '' when there is no short extension to show.
export const fileExt = (name?: string | null) => (/\.([a-z0-9]{1,5})$/i.exec(name || '')?.[1] || '').toUpperCase()

// Uploads one file onto a task. A big one goes up in chunks (lib/chunkedUpload)
// — opening that upload is also where the server says it has no room, before
// anything is sent. The old way, kept for small files and an older server, a
// big file asks first whether there is room: a refusal sent mid-upload never
// reaches the browser (it reads no answer until it has sent everything) and
// would surface as a dropped connection several minutes in.
export async function attachToTask(taskId: string, file: File, onProgress?: (pct: number) => void) {
  if (file.size > CHUNKED_FROM) {
    const uploadId = await sendInChunks(file, 'task', onProgress)
    if (uploadId) return api.post(`/tasks/${taskId}/attachments`, { uploadId })
  }
  if (file.size > 10 * 1024 * 1024) await api.get(`/tasks/upload-room?size=${file.size}`)
  return api.upload(`/tasks/${taskId}/attachments`, file, 'file', onProgress)
}
