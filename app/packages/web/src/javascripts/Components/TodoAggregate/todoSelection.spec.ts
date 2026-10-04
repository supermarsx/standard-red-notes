import { NoteType } from '@standardnotes/snjs'
import type { NoteTodos, TodoItem } from './allTodos'
import { pruneTodoSelection, selectableTodoKey, todoSelectionKey } from './todoSelection'

const group = (noteUuid: string, todoId: string, extra: Partial<TodoItem> = {}): NoteTodos =>
  ({
    note: { uuid: noteUuid, noteType: NoteType.Super } as never,
    source: 'super',
    items: [{ id: todoId, todoId, locator: '0.0', text: 'Task', checked: false, depth: 0, ...extra }],
    completed: 0,
    total: 1,
  }) as NoteTodos

describe('todo aggregate selection', () => {
  it('keeps exact note and todo identities distinct', () => {
    expect(todoSelectionKey('note-a', 'todo-1')).not.toBe(todoSelectionKey('note-b', 'todo-1'))
  })

  it('prunes deleted todos and resets safely when the application data switches', () => {
    const selected = new Set([todoSelectionKey('note-a', 'todo-1'), todoSelectionKey('note-b', 'todo-2')])
    expect([...pruneTodoSelection(selected, [group('note-b', 'todo-2')])]).toEqual([
      todoSelectionKey('note-b', 'todo-2'),
    ])
    expect(pruneTodoSelection(selected, []).size).toBe(0)
  })

  it('refuses to make an occurrence-summary record selectable, identity or not', () => {
    // "Complete" and "Clear schedules" act on everything selected. A record is not
    // work, and it has no schedule to clear — it must never reach a selection, and
    // a stored selection naming one must not survive a prune either.
    const record = group('note-rec', 'todo-record', {
      occurrenceSummary: {
        version: 1,
        missedCount: 4,
        oldestMissedAt: '2025-02-16T09:00:00.000Z',
        newestMissedAt: '2025-11-14T09:00:00.000Z',
      },
    })
    expect(selectableTodoKey(record, record.items[0])).toBeUndefined()
    expect(pruneTodoSelection(new Set([todoSelectionKey('note-rec', 'todo-record')]), [record]).size).toBe(0)
  })

  it('refuses to make a heading section selectable', () => {
    const section = group('note-sec', 'todo-heading', { headingLevel: 2 })
    expect(selectableTodoKey(section, section.items[0])).toBeUndefined()
    expect(pruneTodoSelection(new Set([todoSelectionKey('note-sec', 'todo-heading')]), [section]).size).toBe(0)
  })

  it('still selects an ordinary Super task', () => {
    const task = group('note-a', 'todo-1')
    expect(selectableTodoKey(task, task.items[0])).toBe(todoSelectionKey('note-a', 'todo-1'))
  })
})
