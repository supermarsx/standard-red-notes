import { NoteType } from '@standardnotes/snjs'
import type { NoteTodos } from './allTodos'
import { pruneTodoSelection, todoSelectionKey } from './todoSelection'

const group = (noteUuid: string, todoId: string): NoteTodos =>
  ({
    note: { uuid: noteUuid, noteType: NoteType.Super } as never,
    source: 'super',
    items: [{ id: todoId, todoId, locator: '0.0', text: 'Task', checked: false, depth: 0 }],
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
})
