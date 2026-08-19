/** @jest-environment jsdom */

import { readFileSync } from 'fs'
import { join } from 'path'
import { SNNote } from '@standardnotes/snjs'
import { DEFAULT_TODO_FILTERS, type TodoFilters, type TodoRow, type TodoTag } from './todoFilters'
import type { NoteTodos, TodoItem } from './allTodos'
import {
  buildTodoPrintBody,
  describeActiveTodoFilters,
  todoPrintIndentRem,
  todoPrintSummaryText,
} from './todoPrintProjection'

/**
 * Unit coverage for the Todos view's printable projection. `TodoView.print`
 * proves this reaches the real print path from the real view; this proves the
 * projection's own decisions — which words describe a filter, and what the body
 * is made of — without a React tree in the way.
 *
 * The last test reads the print stylesheet as TEXT on purpose: jsdom never
 * applies `@media print`, so the only way to know the classes the projection
 * emits are actually styled for paper is to check that the rules exist.
 */

const tag = (uuid: string, title: string, longTitle = title): TodoTag => ({ uuid, title, longTitle })

const group = (source: NoteTodos['source']): NoteTodos => ({
  note: { uuid: 'note', title: 'Errands' } as unknown as SNNote,
  source,
  items: [],
  completed: 0,
  total: 0,
})

type RowSpec = Omit<Partial<TodoRow>, 'item'> & { item: Partial<TodoItem> & { text: string } }

const row = (overrides: RowSpec): TodoRow => ({
  id: overrides.id ?? overrides.item.text,
  group: overrides.group ?? group('super'),
  item: { id: overrides.item.text, checked: false, depth: 0, ...overrides.item },
  noteTitle: overrides.noteTitle ?? 'Errands',
  tags: overrides.tags ?? [],
  depth: overrides.depth ?? 0,
  isMatch: overrides.isMatch ?? true,
})

const filters = (overrides: Partial<TodoFilters>): TodoFilters => ({ ...DEFAULT_TODO_FILTERS, ...overrides })

describe('describeActiveTodoFilters', () => {
  it('says nothing when nothing is filtering', () => {
    expect(describeActiveTodoFilters(DEFAULT_TODO_FILTERS, [])).toEqual([])
  })

  it("names every dimension in the filter bar's own words", () => {
    const described = describeActiveTodoFilters(
      filters({
        query: '  milk  ',
        tagUuids: ['tag-work'],
        groupNames: ['Groceries', 'Chores'],
        source: 'advanced-checklist',
        due: 'overdue',
        hideCompleted: true,
      }),
      [tag('tag-work', 'Personal', 'Work/Personal')],
    )

    expect(described).toEqual([
      'search “milk”',
      // The full path, which is how the picker itself identifies a folder.
      'folders & tags: Work/Personal',
      'checklist sections: Groceries, Chores',
      // Exactly the words on the bar's own <option>, because they share a map.
      'source: Advanced Checklist',
      'due: Overdue',
      'completed todos hidden',
    ])
  })

  it('counts a folder it cannot name rather than printing a raw uuid', () => {
    const described = describeActiveTodoFilters(
      filters({ tagUuids: ['tag-work', 'deleted-elsewhere'] }),
      [tag('tag-work', 'Work')],
    )
    expect(described).toEqual(['folders & tags: Work, 1 unavailable'])
  })
})

describe('todoPrintSummaryText', () => {
  it('states the plain count when the page is the whole list', () => {
    expect(todoPrintSummaryText(DEFAULT_TODO_FILTERS, [], 4, 4)).toBe('4 todos.')
    expect(todoPrintSummaryText(DEFAULT_TODO_FILTERS, [], 1, 1)).toBe('1 todo.')
  })

  it('states the omission and its cause the moment anything is filtering', () => {
    expect(todoPrintSummaryText(filters({ hideCompleted: true }), [], 2, 7)).toBe(
      'Showing 2 of 7 todos — filtered by completed todos hidden.',
    )
  })
})

describe('buildTodoPrintBody', () => {
  const build = (rows: TodoRow[], overrides: Partial<TodoFilters> = {}, totalCount = rows.length) =>
    buildTodoPrintBody({ rows, filters: filters(overrides), tagOptions: [], totalCount, now: Date.now() })

  it('emits no interactive control, so nothing can be excluded by CSS alone', () => {
    const body = build([row({ item: { text: 'Buy milk' } }), row({ item: { text: 'Done', checked: true } })])
    expect(body.querySelectorAll('button, input, select, textarea, a')).toHaveLength(0)
  })

  it('says so plainly when the filters admit nothing', () => {
    const body = build([], { query: 'nothing' }, 12)
    expect(body.textContent).toContain('No todos match the current filters.')
    expect(body.querySelectorAll('.srn-print-todo')).toHaveLength(0)
    // …and still says how many exist, so an empty page is never ambiguous.
    expect(body.textContent).toContain('Showing 0 of 12 todos')
  })

  it('indents by exactly the formula the on-screen row uses', () => {
    expect(todoPrintIndentRem(0)).toBe(0)
    expect(todoPrintIndentRem(4)).toBeCloseTo(3.4)
    // Past the ceiling the indent stops growing, matching the table.
    expect(todoPrintIndentRem(11)).toBe(todoPrintIndentRem(10))
    expect(todoPrintIndentRem(50)).toBe(todoPrintIndentRem(10))
  })

  it('carries the due date and the checklist section onto the row', () => {
    const body = buildTodoPrintBody({
      rows: [
        row({
          item: { text: 'Buy milk', groupName: 'Groceries', dueAt: new Date('2026-08-19T10:00:00Z').toISOString() },
          group: group('advanced-checklist'),
        }),
      ],
      filters: DEFAULT_TODO_FILTERS,
      tagOptions: [],
      totalCount: 1,
      now: new Date('2026-08-19T09:00:00Z').getTime(),
    })

    const meta = body.querySelector('.srn-print-todo-meta')?.textContent ?? ''
    expect(meta).toContain('Errands')
    expect(meta).toContain('Advanced Checklist')
    expect(meta).toContain('Groceries')
    expect(meta).toContain('due ')
  })
})

describe('the print stylesheet', () => {
  it('styles every class the todo projection emits, since jsdom cannot', () => {
    const stylesheet = readFileSync(join(__dirname, '../../../stylesheets/_print.scss'), 'utf8')

    for (const rule of [
      '.srn-print-todo-summary',
      '.srn-print-todo-list',
      '.srn-print-todo-meta',
      '.srn-print-todo-empty',
    ]) {
      expect(stylesheet).toContain(`#srn-print-body ${rule}`)
    }

    // Completion must survive as more than the ☒ glyph.
    expect(stylesheet).toMatch(
      /#srn-print-body \.srn-print-todo--done \.srn-print-todo-text\s*\{[^}]*text-decoration: line-through !important;/s,
    )
    // A long list must not have a row torn in half across a page boundary.
    expect(stylesheet).toMatch(/#srn-print-body \.srn-print-todo\s*\{[^}]*page-break-inside: avoid !important;/s)
    // The projection relies on the existing marker rule rather than a new one.
    expect(stylesheet).toContain('#srn-print-body .srn-print-checkbox')
  })
})
