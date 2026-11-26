import React from 'react'
import { Avatar } from '../ui'
import type { Task, User } from '../api'

// Everyone a task is for: its owner first, then the people it is shared with
// (server taskAssignees.js). Older servers send no co_assignees.
export function peopleOf(task: Pick<Task, 'assignee' | 'co_assignees'>): User[] {
  return [task.assignee, ...(task.co_assignees || [])].filter(Boolean) as User[]
}

export function isOnTask(task: Pick<Task, 'assignee' | 'co_assignees'>, userId?: string | null): boolean {
  return !!userId && peopleOf(task).some((u) => u.id === userId)
}

// A list cell: the owner as before, plus "+2" for the people the task is
// shared with, whose names are in the tooltip and the screen-reader label.
export function AssigneeLine({ task, size = 22, className = 'row an', nameClass = 'an-name' }: {
  task: Pick<Task, 'assignee' | 'co_assignees'>; size?: number; className?: string; nameClass?: string
}) {
  const people = peopleOf(task)
  if (!people.length) return null
  const [first, ...rest] = people
  const all = people.map((u) => u.name).join(', ')
  return (
    <span className={className} title={rest.length ? all : undefined} aria-label={rest.length ? `Assigned to ${all}` : undefined}>
      <Avatar name={first.name} color={first.avatar_color} size={size} />
      <span className={nameClass}>{first.name}</span>
      {rest.length > 0 && <span className="an-more" aria-hidden="true">+{rest.length}</span>}
    </span>
  )
}
