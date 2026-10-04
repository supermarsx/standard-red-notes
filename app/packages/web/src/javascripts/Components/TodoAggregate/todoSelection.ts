import type { NoteTodos, TodoItem } from './allTodos'
import { isCountableTodoItem } from './todoHierarchy'

export function todoSelectionKey(noteUuid: string, todoId: string): string {
  return JSON.stringify([noteUuid, todoId])
}

/**
 * The key a row is selected BY, or undefined for a row that must not be selected.
 *
 * Only WORK is selectable. A heading section is context the user authored, and an
 * occurrence-summary row is a record of what a capped generation pass did not write
 * down — letting either into a selection would let "Complete" or "Clear schedules"
 * operate on something that is not a task, and "Clear schedules" on a record is
 * not even meaningful: it has no schedule by construction.
 */
export function selectableTodoKey(group: NoteTodos, item: TodoItem): string | undefined {
  return group.source === 'super' && item.todoId && isCountableTodoItem(item)
    ? todoSelectionKey(group.note.uuid, item.todoId)
    : undefined
}

export function pruneTodoSelection(selected: ReadonlySet<string>, groups: NoteTodos[]): Set<string> {
  const available = new Set<string>()
  for (const group of groups) {
    for (const item of group.items) {
      const key = selectableTodoKey(group, item)
      if (key) {
        available.add(key)
      }
    }
  }
  return new Set([...selected].filter((key) => available.has(key)))
}
