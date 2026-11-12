import { api } from './api'

export interface ReportRange { from: string; to: string; label: string }

// Builds a clean, printable manager report scoped to a date range and opens it in a
// new window with the print dialog (the manager can Save as PDF or print).
// Dependency-free — the report is a self-contained HTML document.
export async function downloadManagerReport(range: ReportRange, orgName = 'Befach') {
  const d = await api.get(`/dashboards/report?from=${range.from}&to=${range.to}`, { timeoutMs: 120_000 })
  const c = d.counts
  const now = new Date().toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
  const fmt = (s: string) => new Date(s + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  const period = range.from === range.to ? fmt(range.from) : `${fmt(range.from)} → ${fmt(range.to)}`

  const esc = (s: any) => String(s ?? '').replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]!))
  const kpi = (label: string, value: any) =>
    `<div class="kpi"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`
  const rows = (arr: any[], cells: (x: any) => string[]) =>
    arr.map((x) => `<tr>${cells(x).map((cc) => `<td>${cc}</td>`).join('')}</tr>`).join('')

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(range.label)} Report</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1f1a16; margin: 32px; }
  h1 { font-size: 22px; margin: 0; }
  h2 { font-size: 15px; margin: 26px 0 10px; border-bottom: 2px solid #c5560f; padding-bottom: 5px; color: #a8480c; }
  .sub { color: #7a6f63; font-size: 13px; margin-top: 4px; }
  .pill { display: inline-block; background: #f8e5c5; border: 1px solid #e7d6bc; border-radius: 20px; padding: 3px 12px; font-size: 12px; font-weight: 700; margin-top: 10px; }
  .kpis { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
  .kpi { border: 1px solid #e7d6bc; border-radius: 10px; padding: 12px 16px; min-width: 110px; }
  .kpi .v { font-size: 26px; font-weight: 800; }
  .kpi .l { font-size: 12px; color: #7a6f63; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #eaddc7; }
  th { background: #f8e5c5; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .overdue { color: #ef4444; font-weight: 600; }
  .foot { margin-top: 30px; font-size: 11px; color: #64748b; }
  @media print { body { margin: 14mm; } }
</style></head><body>
  <h1>${esc(orgName)} — ${esc(range.label)} Report</h1>
  <div class="sub">Generated ${esc(now)}</div>
  <div class="pill">Period: ${esc(period)}</div>

  <div class="kpis">
    ${kpi('Tasks created', c.created)}
    ${kpi('Completed', c.completed)}
    ${kpi('Due in period', c.due)}
    ${kpi('Still open', c.open)}
    ${kpi('Overdue (now)', c.overdue)}
  </div>

  <h2>Activity by team member</h2>
  ${d.workload.length === 0 ? '<p class="sub">No activity in this period.</p>' :
    `<table><thead><tr><th>Member</th><th>Created</th><th>Completed</th><th>Overdue (now)</th></tr></thead>
    <tbody>${rows(d.workload, (w: any) => [esc(w.name), w.created_count, w.completed_count, w.overdue_count ? `<span class="overdue">${w.overdue_count}</span>` : '0'])}</tbody></table>`}

  <h2>New tasks by priority</h2>
  <table><thead><tr><th>Priority</th><th>Created</th></tr></thead>
  <tbody>${rows(d.by_priority, (p: any) => [esc(p.priority), p.count])}</tbody></table>

  <h2>New tasks by status</h2>
  <table><thead><tr><th>Status</th><th>Count</th></tr></thead>
  <tbody>${rows(d.by_status, (s: any) => [esc(s.status), s.count])}</tbody></table>

  <h2>Completed in period (${d.completed_tasks.length})</h2>
  ${d.completed_tasks.length === 0 ? '<p class="sub">None.</p>' :
    `<table><thead><tr><th>Task</th><th>Assignee</th><th>Completed</th></tr></thead>
    <tbody>${rows(d.completed_tasks, (t: any) => [esc(t.title), esc(t.assignee_name || 'Unassigned'), esc(t.completed_at ? ymd(new Date(t.completed_at)) : '—')])}</tbody></table>`}

  <h2>Overdue tasks — as of now (${d.overdue_tasks.length})</h2>
  ${d.overdue_tasks.length === 0 ? '<p class="sub">Nothing overdue</p>' :
    `<table><thead><tr><th>Task</th><th>Assignee</th><th>Due date</th></tr></thead>
    <tbody>${rows(d.overdue_tasks, (t: any) => [esc(t.title), esc(t.assignee_name || 'Unassigned'), `<span class="overdue">${esc(t.due_date || '—')}</span>`])}</tbody></table>`}

  <div class="foot">VoTask · AI Execution Platform</div>
</body></html>`

  const w = window.open('', '_blank')
  if (!w) { alert('Please allow pop-ups to download the report.'); return }
  w.document.write(html)
  w.document.close()
  w.focus()
  setTimeout(() => w.print(), 300)
}

// ---- date-range presets (computed in the browser's local time) ----
const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export function presetRange(kind: 'daily' | 'weekly' | 'monthly'): ReportRange {
  const today = new Date()
  const to = ymd(today)
  if (kind === 'daily') return { from: to, to, label: 'Daily' }
  if (kind === 'weekly') {
    const d = new Date(); d.setDate(d.getDate() - 6)
    return { from: ymd(d), to, label: 'Weekly' }
  }
  const d = new Date(); d.setDate(1)
  return { from: ymd(d), to, label: 'Monthly' }
}

export const todayYmd = () => ymd(new Date())
