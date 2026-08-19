import { NoteType, SNNote } from '@standardnotes/snjs'
import {
  collectAllTodos,
  MAX_ADVANCED_GROUP_NAME_LENGTH,
  parseAdvancedChecklist,
  parseSuperChecklist,
  todosForNote,
  totalTodoProgress,
} from './allTodos'
import {
  CHECKLIST_DUE_AT_STATE_KEY,
  CHECKLIST_RECURRENCE_STATE_KEY,
  CHECKLIST_TODO_ID_STATE_KEY,
} from '../SuperEditor/Lexical/Nodes/ChecklistItemNode'
import { createChecklistRecurrence, type ChecklistRecurrence } from '../SuperEditor/Checklist/checklistRecurrence'

const superChecklistJson = (
  items: { text: string; checked: boolean; todoId?: string; dueAt?: string; recurrence?: ChecklistRecurrence }[],
): string =>
  JSON.stringify({
    root: {
      type: 'root',
      children: [
        {
          type: 'list',
          listType: 'check',
          children: items.map((item) => {
            const state = {
              ...(item.todoId ? { [CHECKLIST_TODO_ID_STATE_KEY]: item.todoId } : {}),
              ...(item.dueAt ? { [CHECKLIST_DUE_AT_STATE_KEY]: item.dueAt } : {}),
              ...(item.recurrence ? { [CHECKLIST_RECURRENCE_STATE_KEY]: item.recurrence } : {}),
            }
            return {
              type: 'listitem',
              checked: item.checked,
              ...(Object.keys(state).length > 0 ? { $: state } : {}),
              children: [{ type: 'text', text: item.text }],
            }
          }),
        },
        // A normal bullet list must NOT be treated as a todo.
        {
          type: 'list',
          listType: 'bullet',
          children: [{ type: 'listitem', children: [{ type: 'text', text: 'not a todo' }] }],
        },
      ],
    },
  })

const advancedChecklistJson = (
  groups: { name: string; tasks: { id: string; description: string; completed: boolean }[] }[],
): string => JSON.stringify({ schemaVersion: '1.0.0', groups })

const makeNote = (
  noteType: NoteType,
  text: string,
  overrides: Partial<Pick<SNNote, 'uuid' | 'title' | 'trashed'>> = {},
): SNNote =>
  ({
    uuid: overrides.uuid ?? 'n1',
    title: overrides.title ?? 'Note',
    trashed: overrides.trashed ?? false,
    noteType,
    text,
  }) as unknown as SNNote

describe('parseSuperChecklist', () => {
  it('extracts check-list items with their checked state and ignores bullet lists', () => {
    const items = parseSuperChecklist(
      superChecklistJson([
        { text: 'Buy milk', checked: false },
        { text: 'Walk dog', checked: true },
      ]),
    )
    expect(items.map((i) => i.text)).toEqual(['Buy milk', 'Walk dog'])
    expect(items.map((i) => i.checked)).toEqual([false, true])
  })

  it('returns empty for non-JSON or empty text', () => {
    expect(parseSuperChecklist('')).toEqual([])
    expect(parseSuperChecklist('plain text')).toEqual([])
  })

  it('surfaces persisted stable identity and a canonical due instant', () => {
    const items = parseSuperChecklist(
      superChecklistJson([
        {
          text: 'Ship it',
          checked: false,
          todoId: 'todo-ship-it',
          dueAt: '2026-08-12T12:30:00+01:00',
          recurrence: createChecklistRecurrence('weekly', '2026-08-12T11:30:00.000Z', 'Europe/London'),
        },
      ]),
    )
    expect(items[0]).toMatchObject({
      id: 'todo-ship-it',
      todoId: 'todo-ship-it',
      dueAt: '2026-08-12T11:30:00.000Z',
      recurrence: expect.objectContaining({ frequency: 'weekly' }),
    })
  })
})

describe('parseAdvancedChecklist', () => {
  it('flattens tasks across groups with completed state', () => {
    const items = parseAdvancedChecklist(
      advancedChecklistJson([
        {
          name: 'Today',
          tasks: [
            { id: 't1', description: 'Email Bob', completed: true },
            { id: 't2', description: 'Review PR', completed: false },
          ],
        },
      ]),
    )
    expect(items.map((i) => i.text)).toEqual(['Email Bob', 'Review PR'])
    expect(items.map((i) => i.checked)).toEqual([true, false])
  })

  it('keeps the section name each task was authored under', () => {
    const items = parseAdvancedChecklist(
      advancedChecklistJson([
        { name: '  Groceries  ', tasks: [{ id: 't1', description: 'Buy milk', completed: false }] },
        { name: 'Chores', tasks: [{ id: 't2', description: 'Mow the lawn', completed: false }] },
      ]),
    )
    expect(items.map((item) => item.groupName)).toEqual(['Groceries', 'Chores'])
  })

  it('leaves the section name absent when the payload gives none, rather than blank', () => {
    const items = parseAdvancedChecklist(
      JSON.stringify({
        groups: [
          { tasks: [{ id: 'a', description: 'No name key', completed: false }] },
          { name: '   ', tasks: [{ id: 'b', description: 'Blank name', completed: false }] },
          { name: 42, tasks: [{ id: 'c', description: 'Wrong type', completed: false }] },
        ],
      }),
    )
    expect(items.map((item) => item.groupName)).toEqual([undefined, undefined, undefined])
    // A flat payload has no sections at all.
    expect(
      parseAdvancedChecklist(JSON.stringify({ tasks: [{ id: 'a', description: 'Solo', completed: false }] }))[0]
        .groupName,
    ).toBeUndefined()
  })

  it('bounds an absurdly long section name', () => {
    const items = parseAdvancedChecklist(
      advancedChecklistJson([
        { name: 'n'.repeat(5_000), tasks: [{ id: 't', description: 'Task', completed: false }] },
      ]),
    )
    expect(items[0].groupName).toHaveLength(MAX_ADVANCED_GROUP_NAME_LENGTH)
  })

  it('supports a flat top-level tasks array fallback', () => {
    const items = parseAdvancedChecklist(
      JSON.stringify({ tasks: [{ id: 'a', description: 'Solo task', completed: false }] }),
    )
    expect(items).toHaveLength(1)
    expect(items[0].text).toBe('Solo task')
  })

  it('returns empty for unrecognized shape', () => {
    expect(parseAdvancedChecklist(JSON.stringify({ foo: 'bar' }))).toEqual([])
  })

  it('bounds third-party task counts, labels and duplicate identifiers', () => {
    const tasks = Array.from({ length: 10_005 }, (_, index) => ({
      id: 'duplicate-id',
      description: index === 0 ? 'x'.repeat(20_000) : `Task ${index}`,
      completed: false,
    }))
    const items = parseAdvancedChecklist(JSON.stringify({ tasks }))

    expect(items).toHaveLength(10_000)
    expect(items[0].text).toHaveLength(16_384)
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length)
  })
})

describe('todosForNote', () => {
  it('computes progress for a super note', () => {
    const note = makeNote(
      NoteType.Super,
      superChecklistJson([
        { text: 'A', checked: true },
        { text: 'B', checked: false },
      ]),
    )
    const todos = todosForNote(note)
    expect(todos?.source).toBe('super')
    expect(todos?.completed).toBe(1)
    expect(todos?.total).toBe(2)
  })

  it('returns null for a note with no parseable todos', () => {
    expect(todosForNote(makeNote(NoteType.Plain, 'just prose'))).toBeNull()
  })
})

describe('collectAllTodos', () => {
  it('groups by note, ordering notes with outstanding items first, and aggregates progress', () => {
    const done = makeNote(NoteType.Super, superChecklistJson([{ text: 'X', checked: true }]), {
      uuid: 'done',
      title: 'All done',
    })
    const open = makeNote(
      NoteType.Task,
      advancedChecklistJson([{ name: 'G', tasks: [{ id: 't', description: 'Open item', completed: false }] }]),
      { uuid: 'open', title: 'Has work' },
    )
    const groups = collectAllTodos([done, open])
    expect(groups[0].note.uuid).toBe('open')
    const total = totalTodoProgress(groups)
    expect(total).toEqual({ completed: 1, total: 2 })
  })

  it('skips trashed notes', () => {
    const note = makeNote(NoteType.Super, superChecklistJson([{ text: 'X', checked: false }]), { trashed: true })
    expect(collectAllTodos([note])).toEqual([])
  })
})
