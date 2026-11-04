import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, requirePlatformAdmin } from '../auth.js'
import { audit } from '../util.js'
import { usageForOrg } from '../ai/usage.js'
import { sendUpdatePush, pushEnabled } from '../push.js'

// CROSS-ORG platform admin routes. The ONLY place that reads/writes across orgs —
// gated to a flagged super-admin. Normal org isolation is untouched everywhere else.
const r = Router()
r.use(authRequired, requirePlatformAdmin)

// Platform-wide totals.
r.get('/stats', (req, res) => {
  res.json({
    orgs: db.prepare('SELECT COUNT(*) c FROM organizations').get().c,
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    tasks: db.prepare('SELECT COUNT(*) c FROM tasks').get().c,
    ai_cost: db.prepare('SELECT COALESCE(SUM(cost_usd),0) c FROM usage_events').get().c,
    ai_calls: db.prepare('SELECT COUNT(*) c FROM usage_events').get().c,
  })
})

// Per-organization AI/API usage (calls, tokens, estimated cost), highest spend
// first, plus a platform-wide grand total. The cross-org usage overview.
r.get('/usage', (req, res) => {
  const rows = db.prepare(`
    SELECT o.id, o.name, o.usage_access,
      (SELECT COUNT(*) FROM usage_events ue WHERE ue.org_id = o.id) AS calls,
      (SELECT COALESCE(SUM(total_tokens),0) FROM usage_events ue WHERE ue.org_id = o.id) AS tokens,
      (SELECT COALESCE(SUM(cost_usd),0) FROM usage_events ue WHERE ue.org_id = o.id) AS cost
    FROM organizations o ORDER BY cost DESC`).all()
  const total = db.prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost FROM usage_events').get()
  res.json({ orgs: rows.map((o) => ({ ...o, usage_access: !!o.usage_access })), total })
})

// Grant or revoke an org admin's access to view their own organization's usage.
r.patch('/orgs/:id/usage-access', (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id=?').get(req.params.id)
  if (!org) return res.status(404).json({ error: 'Not found' })
  const enabled = req.body?.enabled ? 1 : 0
  db.prepare('UPDATE organizations SET usage_access=? WHERE id=?').run(enabled, org.id)
  audit(req.user.org_id, req.user.id, 'platform.usage_access', 'organization', org.id, String(enabled))
  res.json({ ok: true, usage_access: !!enabled })
})

// Every organization with per-org counts, owner, and last activity.
r.get('/orgs', (req, res) => {
  const rows = db.prepare(`
    SELECT o.id, o.name, o.is_personal, o.allowed_domains, o.created_at, o.usage_access,
      (SELECT COUNT(*) FROM users u WHERE u.org_id = o.id) AS user_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.org_id = o.id) AS task_count,
      (SELECT MAX(created_at) FROM audit_logs a WHERE a.org_id = o.id) AS last_activity,
      (SELECT email FROM users u WHERE u.org_id = o.id ORDER BY created_at ASC LIMIT 1) AS owner_email,
      (SELECT COUNT(*) FROM usage_events ue WHERE ue.org_id = o.id) AS usage_calls,
      (SELECT COALESCE(SUM(cost_usd),0) FROM usage_events ue WHERE ue.org_id = o.id) AS usage_cost
    FROM organizations o
    ORDER BY o.created_at DESC`).all()
  res.json(rows.map((o) => ({ ...o, usage_access: !!o.usage_access, allowed_domains: (o.allowed_domains || '').split(',').filter(Boolean) })))
})

// One org's members + task breakdown by status (read-only detail). Counts only —
// no task content crosses the org boundary, keeping tenant isolation intact.
r.get('/orgs/:id', (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id=?').get(req.params.id)
  if (!org) return res.status(404).json({ error: 'Not found' })
  const members = db.prepare('SELECT id, name, email, role, platform_admin, created_at FROM users WHERE org_id=? ORDER BY created_at').all(org.id)
  const by_status = db.prepare('SELECT status, COUNT(*) AS count FROM tasks WHERE org_id=? GROUP BY status ORDER BY count DESC').all(org.id)
  const task_count = by_status.reduce((sum, s) => sum + s.count, 0)
  const usage = usageForOrg(org.id)
  res.json({
    org: { ...org, usage_access: !!org.usage_access, allowed_domains: (org.allowed_domains || '').split(',').filter(Boolean) },
    members, by_status, task_count, usage,
  })
})

// Org-scoped tables, deleted in dependency order. Tables without org_id are skipped
// safely (the DELETE throws "no such column" and is caught).
const ORG_TABLES = [
  'transcript_segments', 'task_dependencies', 'task_comments', 'attachments', 'suggested_tasks', 'tasks',
  'meeting_participants', 'meetings', 'chat_reactions', 'chat_stars', 'chat_message_hidden', 'chat_messages',
  'chat_participants', 'chat_conversations', 'conversations', 'notifications', 'device_tokens', 'embeddings',
  'invites', 'audit_logs', 'projects', 'departments', 'users',
]

// DELETE an organization and ALL its data. Cannot delete your own org from here.
r.delete('/orgs/:id', (req, res) => {
  const org = db.prepare('SELECT * FROM organizations WHERE id=?').get(req.params.id)
  if (!org) return res.status(404).json({ error: 'Not found' })
  if (org.id === req.user.org_id) return res.status(400).json({ error: 'You cannot delete your own organization from here.' })
  // Disable FK enforcement for the bulk wipe so delete order doesn't matter, then
  // re-enable. (PRAGMA foreign_keys must be toggled OUTSIDE a transaction.)
  db.pragma('foreign_keys = OFF')
  try {
    const tx = db.transaction(() => {
      const userIds = db.prepare('SELECT id FROM users WHERE org_id=?').all(org.id).map((u) => u.id)
      for (const uid of userIds) {
        try { db.prepare('DELETE FROM password_resets WHERE user_id=?').run(uid) } catch {}
        try { db.prepare('DELETE FROM email_verifications WHERE user_id=?').run(uid) } catch {}
      }
      for (const t of ORG_TABLES) { try { db.prepare(`DELETE FROM ${t} WHERE org_id=?`).run(org.id) } catch {} }
      db.prepare('DELETE FROM organizations WHERE id=?').run(org.id)
    })
    tx()
  } finally {
    db.pragma('foreign_keys = ON')
  }
  audit(req.user.org_id, req.user.id, 'platform.org_delete', 'organization', org.id, org.name)
  res.json({ ok: true })
})

// Phones and the app version each runs (versionCode; NULL = before 4.5, which
// did not report it), for the "tell phones to update" card.
r.get('/app-update', (req, res) => {
  const builds = db.prepare('SELECT app_build AS build, COUNT(*) AS devices FROM device_tokens GROUP BY app_build ORDER BY app_build DESC').all()
  res.json({ push: pushEnabled(), builds })
})

// "VoTask update available" to every phone on a build older than `build`.
// Pressed once a release is live on Google Play, not before: a phone told to
// update before Play offers it finds nothing to install.
r.post('/app-update', async (req, res) => {
  const build = Number(req.body?.build)
  if (!Number.isInteger(build) || build < 2 || build > 1e7) return res.status(400).json({ error: 'build must be the new versionCode' })
  if (!pushEnabled()) return res.status(503).json({ error: 'Push notifications are not configured on this server' })
  const title = String(req.body?.title || '').trim().slice(0, 80) || 'VoTask update available'
  const body = String(req.body?.body || '').trim().slice(0, 300) ||
    'A new version of VoTask is on the Play Store. Open Play Store, find VoTask and tap Update.'
  const out = await sendUpdatePush(build, { title, body })
  audit(req.user.org_id, req.user.id, 'platform.app_update_push', 'app', String(build), `${out.sent} of ${out.devices} phones`)
  res.json(out)
})

export default r
