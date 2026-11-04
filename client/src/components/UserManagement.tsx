import React, { useEffect, useRef, useState } from 'react'
import { api, User } from '../api'
import { useAuth } from '../auth'
import { Avatar, Badge, Ic } from '../ui'
import { confirmDialog } from '../lib/confirm'
import { toast } from '../lib/toast'
import { saveFile } from '../lib/saveFile'
import DepartmentSelect, { Dept } from './DepartmentSelect'

// Format only. Any domain is fine as far as the form is concerned — an org that
// wants to restrict domains does it in Administration, and the server enforces it.
const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// User-management UI for the Administration page. The manager is the org admin
// and manages employees and other managers.
export default function UserManagement() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [users, setUsers] = useState<User[]>([])
  const [depts, setDepts] = useState<any[]>([])
  const [invites, setInvites] = useState<any[]>([])
  const [editing, setEditing] = useState<any | null>(null) // 'new' | user | null
  const [inviting, setInviting] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  const [digest, setDigest] = useState<{ mode: string; hour: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const load = () => api.get('/users').then(setUsers)
  const loadInvites = () => api.get('/invites').then(setInvites).catch(() => {})
  useEffect(() => {
    load()
    loadInvites()
    api.get('/users/meta/departments').then(setDepts)
    api.get('/digest/status').then(setDigest).catch(() => {})
  }, [])
  const deptName = (id?: string) => depts.find((d) => d.id === id)?.name || '—'
  // A department created from inside a form joins this list at once: the table
  // behind the dialog names users by it, and the next dialog must offer it.
  const addDept = (d: Dept) => setDepts((prev) => (prev.some((x) => x.id === d.id) ? prev : [...prev, d].sort((a, b) => a.name.localeCompare(b.name))))

  const revokeInvite = async (inv: any) => {
    if (!(await confirmDialog({ title: 'Revoke invitation', message: `Revoke the invitation for ${inv.email}?`, confirmText: 'Revoke', danger: true }))) return
    try { await api.del('/invites/' + inv.id); loadInvites() }
    catch (e: any) { setImportMsg('✕ ' + e.message) }
  }

  const onImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImportMsg('Importing…')
    try {
      const r = await api.upload('/users/import', file)
      setImportMsg(`✓ Imported: ${r.created} created, ${r.updated} updated${r.errors?.length ? ` · ${r.errors.length} skipped` : ''}`)
      load()
    } catch (err: any) { setImportMsg('✕ ' + err.message) }
    finally { if (fileRef.current) fileRef.current.value = '' }
  }

  const downloadTemplate = () => {
    const csv = 'name,email,phone,role,department,aliases,language,password\nMunidhar Reddy,munidhar@befach.com,+91 98765 43210,employee,Engineering,"Muni,Munidhar",en,password123\n'
    saveFile({ blob: new Blob([csv], { type: 'text/csv' }), name: 'users-template.csv' })
  }

  const sendDigestNow = async () => {
    if (!(await confirmDialog({ title: 'Send digest now', message: 'Send the daily task digest now to everyone?', confirmText: 'Send' }))) return
    setImportMsg('Sending digest…')
    try {
      const r = await api.post('/digest/send-now')
      const emailNote = r.emails ? `, ${r.emails} emails` : ''
      setImportMsg(`✓ Digest → Cliq: ${r.cliq}${emailNote}${r.cliq === 'preview' ? ' — check server console' : ''}`)
    } catch (e: any) { setImportMsg('✕ ' + e.message) }
  }

  // A manager may edit/remove employees and other managers, but not admin accounts.
  const canEdit = (u: User) => isAdmin || u.role !== 'admin'

  const remove = async (u: User) => {
    if (u.id === user?.id) { setImportMsg('✕ You cannot remove your own account'); return }
    if (!(await confirmDialog({ title: 'Remove user', message: `Remove ${u.name}? This permanently deletes the account and unassigns their tasks.`, confirmText: 'Remove', danger: true }))) return
    try {
      await api.del('/users/' + u.id)
      setImportMsg(`✓ Removed ${u.name}`)
      load()
    } catch (e: any) { setImportMsg('✕ ' + e.message) }
  }

  return (
    <>
      <div className="spread um-toolbar" style={{ marginBottom: 14 }}>
        <div className="muted">{users.length} users {digest && <span>· daily Cliq digest {digest.hour}:00 ({digest.mode})</span>}</div>
        <div className="row wrap" style={{ gap: 8 }}>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={onImport} />
          <button className="btn btn-sm row" style={{ gap: 6 }} onClick={downloadTemplate}><Ic name="download" size={14} /> Template</button>
          <button className="btn btn-sm row" style={{ gap: 6 }} onClick={() => fileRef.current?.click()}><Ic name="upload" size={14} /> Import Excel/CSV</button>
          <button className="btn btn-sm row" style={{ gap: 6 }} onClick={sendDigestNow}><Ic name="mail" size={14} /> Send digest now</button>
          <button className="btn btn-sm row" style={{ gap: 6 }} onClick={() => setInviting(true)}><Ic name="mail" size={14} /> Invite teammate</button>
          <button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}>+ Add user</button>
        </div>
      </div>
      {importMsg && <div className="muted" style={{ marginBottom: 10, fontSize: 13 }}>{importMsg}</div>}
      {invites.length > 0 && (
        <div className="card" style={{ marginBottom: 12, padding: '10px 14px' }}>
          <div className="muted" style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Pending invitations ({invites.length})</div>
          {invites.map((inv) => (
            <div key={inv.id} className="row spread" style={{ padding: '5px 0', borderTop: '1px solid #f1f1f1' }}>
              <span style={{ fontSize: 13 }}>{inv.email} <span className="muted">· {inv.role}</span></span>
              <button className="btn btn-sm" style={{ color: 'var(--danger-ink)' }} onClick={() => revokeInvite(inv)}>Revoke</button>
            </div>
          ))}
        </div>
      )}
      <div className="card table-card-wrap">
        <table className="table-cards">
          <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th>Department</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="cell-title"><span className="row"><Avatar name={u.name} color={u.avatar_color} size={26} /> {u.name}</span></td>
                <td className="muted" data-label="Email">{u.email}{!u.email_verified && <span className="um-unconfirmed" title="They haven't entered the confirmation code mailed to this address yet">Unconfirmed</span>}</td>
                <td className="muted" data-label="Phone">{u.phone || '—'}</td>
                <td data-label="Role"><Badge color="#ea580c" soft>{u.role}</Badge></td>
                <td data-label="Department">{deptName(u.department_id)}</td>
                <td data-label="">
                  {canEdit(u) && (
                    <div className="row" style={{ gap: 6 }}>
                      <button className="btn btn-sm row" style={{ gap: 6 }} onClick={() => setEditing(u)}><Ic name="edit" size={14} /> Edit</button>
                      {u.id !== user?.id && (
                        <button className="btn btn-sm row" style={{ gap: 6, color: 'var(--danger)' }} onClick={() => remove(u)}><Ic name="trash" size={14} /> Remove</button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <UserForm user={editing === 'new' ? null : editing} depts={depts} onDeptAdded={addDept} isAdmin={isAdmin} onClose={() => setEditing(null)} onDone={() => { setEditing(null); load() }} />}
      {inviting && <InviteForm depts={depts} onDeptAdded={addDept} isAdmin={isAdmin} onClose={() => setInviting(false)} onDone={loadInvites} />}
    </>
  )
}

// Invite a teammate by email. Shows the resulting accept-link so the manager can
// copy/share it directly — essential when SMTP isn't configured (preview mode).
export function InviteForm({ depts, onDeptAdded, isAdmin, onClose, onDone }: { depts: any[]; onDeptAdded?: (d: Dept) => void; isAdmin: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<any>({ email: '', role: 'employee', department_id: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [result, setResult] = useState<{ link: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const roleOptions = isAdmin ? ['employee', 'manager', 'admin'] : ['employee', 'manager']

  const send = async () => {
    setErr('')
    const email = (f.email || '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setErr('Please enter a valid email address.'); return }
    setBusy(true)
    try {
      const r = await api.post('/invites', { email, role: f.role, department_id: f.department_id || null })
      setResult({ link: r.link })
      onDone()
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(result!.link); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
  }

  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3>Invite teammate</h3><button className="btn btn-ghost" onClick={onClose}>✕</button></div>
        <div className="card-pad grid" style={{ gap: 12 }}>
          {result ? (
            <>
              <div className="inv-ready">
                Invitation ready. Send them this link — it sets their password and puts them straight in.
              </div>
              <div className="row" style={{ gap: 8 }}>
                <input readOnly value={result.link} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
                <button className="btn btn-sm btn-primary" onClick={copyLink}>{copied ? 'Copied!' : 'Copy'}</button>
              </div>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn" onClick={onClose}>Done</button>
              </div>
            </>
          ) : (
            <>
              <div><label>Email</label><input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="teammate@company.com" type="email" autoFocus /></div>
              <div className="grid grid-2" style={{ gap: 10 }}>
                <div><label>Role</label><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roleOptions.map((r) => <option key={r}>{r}</option>)}</select></div>
                <div><label>Department</label><DepartmentSelect value={f.department_id} onChange={(id) => setF((p: any) => ({ ...p, department_id: id }))} depts={depts} onAdded={onDeptAdded} /></div>
              </div>
              {err && <div style={{ color: 'var(--danger-ink)', fontSize: 13 }}>{err}</div>}
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn" onClick={onClose}>Cancel</button>
                <button className="btn btn-primary" onClick={send} disabled={busy || !f.email}>{busy ? <span className="spinner" /> : 'Send invite'}</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// Exported for the task form, whose assignee picker opens it to add the person
// a task is for. `onDone` receives the saved user so that caller can select them.
export function UserForm({ user, depts, onDeptAdded, isAdmin, onClose, onDone }: { user: any | null; depts: any[]; onDeptAdded?: (d: Dept) => void; isAdmin: boolean; onClose: () => void; onDone: (saved?: User) => void }) {
  const isEdit = !!user
  const [f, setF] = useState<any>({
    // No prefilled default password — shipping a guessable 'password123' that
    // renders in clear text was a real account-security foot-gun.
    name: user?.name || '', email: user?.email || '', phone: user?.phone || '', password: '',
    role: user?.role || 'employee', department_id: user?.department_id || '', aliases: user?.aliases || '',
    preferred_language: user?.preferred_language || 'en',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // Confirming the address here is optional. A manager with the teammate beside
  // them (or on a call) sends a code and types in what they read out; anyone
  // saved without it is mailed a code of their own to enter after signing in.
  // Both pieces of state remember WHICH address they belong to, so editing the
  // email field after sending or confirming quietly drops back to "not sent".
  const [code, setCode] = useState('')
  const [codeSentTo, setCodeSentTo] = useState('')
  const [proof, setProof] = useState<{ email: string; token: string } | null>(null)
  const [codeBusy, setCodeBusy] = useState(false)
  const [codeErr, setCodeErr] = useState('')
  const email = (f.email || '').trim().toLowerCase()
  const emailOk = VALID_EMAIL.test(email)
  const emailChanged = !isEdit || email !== String(user?.email || '').toLowerCase()
  const confirmed = proof?.email === email
  const codePending = codeSentTo === email && !confirmed
  // Managers can assign employee/manager only; admins can assign any role.
  const roleOptions = isAdmin ? ['employee', 'manager', 'admin'] : ['employee', 'manager']

  const sendCode = async () => {
    setCodeErr(''); setCodeBusy(true)
    try {
      const r = await api.post('/users/email-code', { email, user_id: user?.id })
      setCodeSentTo(email); setCode('')
      if (!r.delivered) toast.info('Email isn\'t set up on this server, so the code was written to the server log.')
    } catch (e: any) { setCodeErr(e.message) } finally { setCodeBusy(false) }
  }
  const verifyCode = async () => {
    setCodeErr(''); setCodeBusy(true)
    try {
      const r = await api.post('/users/email-code/verify', { email, code })
      setProof({ email, token: r.proof })
    } catch (e: any) { setCodeErr(e.message) } finally { setCodeBusy(false) }
  }

  const save = async () => {
    setErr('')
    // Any domain is accepted here; whether this org restricts domains is the
    // server's call (Administration → Who can join this workspace).
    if (!emailOk) { setErr('Please enter a valid email address'); return }
    // Phone must be exactly 10 digits.
    const phone = (f.phone || '').replace(/\D/g, '')
    if (phone.length !== 10) { setErr('Phone number must be exactly 10 digits'); return }
    setBusy(true)
    try {
      let saved: User & { code_sent?: boolean }
      const email_proof = confirmed ? proof!.token : undefined
      if (isEdit) {
        const body: any = { ...f, email, phone, email_proof }
        if (!body.password) delete body.password // don't overwrite password if left blank
        saved = await api.patch('/users/' + user.id, body)
      } else {
        saved = await api.post('/users', { ...f, email, phone, email_proof })
      }
      if (confirmed) toast.success(`${email} is confirmed.`)
      else if (saved.code_sent) toast.success(`A confirmation code was sent to ${email}.`)
      onDone(saved)
    } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="modal-center" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="card-head spread"><h3>{isEdit ? 'Edit user' : 'Add user'}</h3><button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="card-pad grid" style={{ gap: 12 }}>
          <div className="grid grid-3" style={{ gap: 10 }}>
            <div><label>Name</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
            <div><label>Email</label><input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
            <div><label>Phone (10 digits)</label><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={10} inputMode="numeric" placeholder="9876543210" /></div>
          </div>
          {emailOk && emailChanged && (
            <div className="uf-verify">
              {confirmed ? (
                <span className="pf-verified"><Ic name="check" size={13} /> {email} confirmed</span>
              ) : codePending ? (
                <>
                  <div className="uf-verify-hint">Enter the 6-digit code sent to <b>{email}</b>.</div>
                  <div className="row" style={{ gap: 8 }}>
                    <input className="otp-input" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      onKeyDown={(e) => { if (e.key === 'Enter' && code.length === 6) verifyCode() }}
                      inputMode="numeric" autoComplete="one-time-code" placeholder="000000" aria-label="Confirmation code" />
                    <button className="btn btn-sm" onClick={verifyCode} disabled={codeBusy || code.length !== 6}>{codeBusy ? <span className="spinner" /> : 'Verify'}</button>
                    <button className="btn btn-ghost btn-sm" onClick={sendCode} disabled={codeBusy}>Resend</button>
                  </div>
                </>
              ) : (
                <div className="row spread" style={{ gap: 10 }}>
                  <span className="uf-verify-hint">Confirm this email now with a code, or skip it and they'll be emailed one to enter after signing in.</span>
                  <button className="btn btn-sm" onClick={sendCode} disabled={codeBusy}>{codeBusy ? <span className="spinner" /> : 'Send code'}</button>
                </div>
              )}
              {codeErr && <div className="uf-verify-err" role="alert">{codeErr}</div>}
            </div>
          )}
          <div className="grid grid-2" style={{ gap: 10 }}>
            <div><label>Role</label><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roleOptions.map((r) => <option key={r}>{r}</option>)}</select></div>
            <div><label>Department</label><DepartmentSelect value={f.department_id} onChange={(id) => setF((p: any) => ({ ...p, department_id: id }))} depts={depts} onAdded={onDeptAdded} /></div>
          </div>
          <div><label>Password {isEdit && <span className="muted" style={{ fontWeight: 400 }}>(leave blank to keep current)</span>}</label><input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
          {err && <div style={{ color: 'var(--danger-ink)', fontSize: 13 }} role="alert">{err}</div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={busy || !f.name || !f.email || (!isEdit && !f.password)}>{busy ? <span className="spinner" /> : isEdit ? 'Save changes' : 'Create user'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
