import type { NoteTodos, TodoItem } from './allTodos'

export function todoSelectionKey(noteUuid: string, todoId: string): string {
  return JSON.stringify([noteUuid, todoId])
}

export function selectableTodoKey(group: NoteTodos, item: TodoItem): string | undefined {
  return group.source === 'super' && item.todoId ? todoSelectionKey(group.note.uuid, item.todoId) : undefined
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
