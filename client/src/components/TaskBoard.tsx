import React, { useState } from 'react'
import { Task } from '../api'
import { PriorityBadge, Avatar, ConfidenceTag, dueLabel, STATUS_COLORS } from '../ui'
import { AssigneeLine } from './TaskPeople'
import { TaskHandoverLine } from './TaskOriginBadge'

// Columns mirror the task lifecycle (same order as the status sort rank).
const COLUMNS = ['To Do', 'In Progress', 'Blocked', 'In Review', 'Done', 'Reopened']

// A drag-and-drop Kanban board. Cards are grouped into one column per status;
// dropping a card on another column moves it via onMove (which calls the status API).
// Each card also carries a small status select — HTML5 drag-and-drop never fires
// on touchscreens (and has no keyboard path), so without it the board would be
// read-only on phones/tablets.
export default function TaskBoard({ tasks, onOpen, onMove }: {
  tasks: Task[]
  onOpen: (id: string) => void
  onMove: (id: string, status: string) => void
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)

  const drop = (status: string) => {
    const id = dragId
    setDragId(null); setOverCol(null)
    if (!id) return
    const t = tasks.find((x) => x.id === id)
    if (t && t.status !== status) onMove(id, status)
  }

  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const items = tasks.filter((t) => t.status === col)
        return (
          <div
            key={col}
            className={'board-col' + (overCol === col ? ' drop-over' : '')}
            onDragOver={(e) => { e.preventDefault(); if (overCol !== col) setOverCol(col) }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverCol((c) => (c === col ? null : c)) }}
            onDrop={() => drop(col)}
          >
            <div className="board-col-head">
              <span className="board-col-dot" style={{ background: STATUS_COLORS[col] || '#64748b' }} />
              <span className="board-col-title">{col}</span>
              <span className="board-col-count">{items.length}</span>
            </div>
            <div className="board-col-body">
              {items.map((t) => (
                <div
                  key={t.id}
                  className={'board-card' + (dragId === t.id ? ' dragging' : '')}
                  draggable
                  onDragStart={() => setDragId(t.id)}
                  onDragEnd={() => { setDragId(null); setOverCol(null) }}
                  onClick={() => onOpen(t.id)}
                >
                  <div className="board-card-title">{t.title}</div>
                  <ConfidenceTag c={t.ownership_confidence} />
                  <TaskHandoverLine task={t} />
                  <div className="board-card-foot">
                    <PriorityBadge p={t.priority} />
                    <span className="board-card-due">{dueLabel(t)}</span>
                  </div>
                  {t.assignee && <AssigneeLine task={t} size={20} className="board-card-assignee" nameClass="" />}
                  <select
                    className="board-card-move"
                    value={t.status}
                    aria-label={`Move "${t.title}" to another status`}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => { if (e.target.value !== t.status) onMove(t.id, e.target.value) }}
                  >
                    {COLUMNS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              ))}
              {items.length === 0 && <div className="board-col-empty">Drop tasks here</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
