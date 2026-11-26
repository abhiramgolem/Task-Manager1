import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, User } from '../api'
import { Avatar } from '../ui'

// Pick meeting attendees. Selected people show as chips. The full employee list
// stays hidden until the manager clicks "＋ Add members", then a scrollable list
// (with an optional filter) drops down so he can add people without typing names.
// With autoSelectAll, everyone is pre-added when the list loads (absentees can
// then be removed) — the default for a new meeting.
export default function ParticipantPicker({ value, onChange, autoSelectAll }: { value: string[]; onChange: (ids: string[]) => void; autoSelectAll?: boolean }) {
  const [users, setUsers] = useState<User[]>([])
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const seeded = useRef(false) // pre-select everyone only once, so the user can still remove people
  useEffect(() => {
    api.get('/users').then((list: User[]) => {
      setUsers(list)
      if (autoSelectAll && !seeded.current && value.length === 0) onChange(list.map((u) => u.id))
      seeded.current = true
    }).catch(() => {})
  }, [])

  const selected = users.filter((u) => value.includes(u.id))
  const available = useMemo(() => {
    const t = q.trim().toLowerCase()
    return users.filter((u) => !value.includes(u.id) && (!t || u.name.toLowerCase().includes(t) || (u.email || '').toLowerCase().includes(t)))
  }, [users, q, value])

  const add = (id: string) => onChange([...value, id])
  const remove = (id: string) => onChange(value.filter((x) => x !== id))
  const addAll = () => { onChange(users.map((u) => u.id)); setOpen(false) }

  const chip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, background: 'color-mix(in srgb, var(--primary) 16%, var(--surface))', color: 'var(--link)', borderRadius: 999, padding: '3px 6px 3px 4px', fontSize: 12.5, fontWeight: 600 }

  return (
    <div>
      {/* Selected attendees */}
      <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {selected.map((u) => (
          <span key={u.id} style={chip}>
            <Avatar name={u.name} color={u.avatar_color} size={18} /> {u.name}
            <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '0 4px', color: 'var(--link)' }} onClick={() => remove(u.id)} title="Remove">✕</button>
          </span>
        ))}
        {!selected.length && <span className="muted" style={{ fontSize: 12 }}>No attendees yet.</span>}
      </div>

      {/* Controls */}
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className={'btn btn-sm' + (open ? ' btn-primary' : '')} onClick={() => setOpen((o) => !o)}>
          ＋ Add members
        </button>
        {users.length > 0 && value.length < users.length && (
          <button type="button" className="btn btn-sm" onClick={addAll}>Add everyone</button>
        )}
      </div>

      {/* Dropdown list — only when opened */}
      {open && (
        <div className="card" style={{ marginTop: 8, padding: 8 }}>
          <input placeholder="Filter employees…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <div style={{ maxHeight: 200, overflow: 'auto', marginTop: 8 }}>
            {available.map((u) => (
              <div key={u.id} className="spread" style={{ padding: '7px 6px', borderBottom: '1px solid var(--border)' }}>
                <span className="row" style={{ gap: 8 }}>
                  <Avatar name={u.name} color={u.avatar_color} size={22} /> {u.name}
                  <span className="muted" style={{ fontSize: 11, textTransform: 'capitalize' }}>{u.role}</span>
                </span>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => add(u.id)}>＋ Add</button>
              </div>
            ))}
            {available.length === 0 && (
              <div className="muted" style={{ padding: 12, fontSize: 12 }}>
                {users.length && value.length === users.length ? 'Everyone has been added.' : 'No matching employees.'}
              </div>
            )}
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  )
}
