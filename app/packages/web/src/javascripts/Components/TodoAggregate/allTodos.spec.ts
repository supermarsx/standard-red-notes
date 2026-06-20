import { NoteType, SNNote } from '@standardnotes/snjs'
import {
  collectAllTodos,
  parseAdvancedChecklist,
  parseSuperChecklist,
  todosForNote,
  totalTodoProgress,
} from './allTodos'

const superChecklistJson = (items: { text: string; checked: boolean }[]): string =>
  JSON.stringify({
    root: {
      type: 'root',
      children: [
        {
          type: 'list',
          listType: 'check',
          children: items.map((item) => ({
            type: 'listitem',
            checked: item.checked,
            children: [{ type: 'text', text: item.text }],
          })),
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
      advancedChecklistJson([
        { name: 'G', tasks: [{ id: 't', description: 'Open item', completed: false }] },
      ]),
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
