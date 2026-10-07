/** @jest-environment jsdom */

import { readFileSync } from 'fs'
import { join } from 'path'
import { SNNote } from '@standardnotes/snjs'
import {
  DEFAULT_TODO_FILTERS,
  TODO_MAX_INDENT_LEVEL,
  type TodoFilters,
  type TodoRow,
  type TodoTag,
} from './todoFilters'
import type { NoteTodos, TodoItem } from './allTodos'
import {
  buildTodoPrintBody,
  describeActiveTodoFilters,
  todoPrintIndentRem,
  todoPrintSummaryText,
} from './todoPrintProjection'
import { checklistOccurrenceSummaryText } from '../SuperEditor/Checklist/checklistBackfill'

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
    const described = describeActiveTodoFilters(filters({ tagUuids: ['tag-work', 'deleted-elsewhere'] }), [
      tag('tag-work', 'Work'),
    ])
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

  describe('heading sections on paper', () => {
    const sectioned = () => [
      row({ item: { text: 'Project', headingLevel: 1, description: 'Why this list exists' }, isMatch: false }),
      row({ item: { text: 'Task A' }, depth: 1 }),
      row({ item: { text: 'Phase 1', headingLevel: 2 }, depth: 1, isMatch: false }),
      row({ item: { text: 'Task B' }, depth: 2 }),
    ]

    it('carries the heading-derived depth onto paper, not only onto the screen', () => {
      // A depth change the print path does not honour is a half-fix: the printed
      // list would read as flat while the view reads as a tree.
      const entries = Array.from(build(sectioned()).querySelectorAll<HTMLElement>('.srn-print-todo'))
      expect(
        entries.map((entry) => [
          entry.querySelector('.srn-print-todo-text')?.textContent,
          entry.getAttribute('data-todo-depth'),
          parseFloat(entry.style.marginInlineStart),
        ]),
      ).toEqual([
        ['Project', '0', 0],
        ['Task A', '1', todoPrintIndentRem(1)],
        ['Phase 1', '1', todoPrintIndentRem(1)],
        ['Task B', '2', todoPrintIndentRem(2)],
      ])
    })

    it('prints no checkbox beside a section, and states its level as data', () => {
      const entries = Array.from(build(sectioned()).querySelectorAll<HTMLElement>('.srn-print-todo'))
      const [project, taskA, phase] = entries
      // A ☐ beside a heading would print the claim that the section is a task
      // somebody can tick.
      expect(project.querySelector('.srn-print-checkbox')).toBeNull()
      expect(project.hasAttribute('data-todo-checked')).toBe(false)
      expect(project.classList.contains('srn-print-todo--heading')).toBe(true)
      expect(project.getAttribute('data-todo-heading-level')).toBe('1')
      expect(phase.getAttribute('data-todo-heading-level')).toBe('2')
      // …and an ordinary task still gets one.
      expect(taskA.querySelector('.srn-print-checkbox')?.textContent).toBe('☐')
    })

    it('prints a section description, and nothing at all when there is none', () => {
      const entries = Array.from(build(sectioned()).querySelectorAll<HTMLElement>('.srn-print-todo'))
      expect(entries[0].querySelector('.srn-print-todo-description')?.textContent).toBe('Why this list exists')
      // No em dash, no empty line: a section with no description claims nothing.
      expect(entries[2].querySelector('.srn-print-todo-description')).toBeNull()
      expect(entries[1].querySelector('.srn-print-todo-description')).toBeNull()
    })

    it('does not print "shown as the parent of a match" on a section', () => {
      // Every section is context by construction, so saying it on all of them is
      // noise; the words exist for the exceptional case of a TASK kept as context.
      const body = build(sectioned())
      const project = body.querySelector<HTMLElement>('.srn-print-todo--heading')
      expect(project?.textContent).not.toContain('shown as the parent of a match')
      expect(project?.classList.contains('srn-print-todo--context')).toBe(false)
      expect(project?.querySelector('.srn-print-todo-meta')).toBeNull()
    })
  })

  describe('the occurrence-summary record on paper', () => {
    const summary = {
      version: 1 as const,
      missedCount: 34,
      oldestMissedAt: '2025-02-16T09:00:00.000Z',
      newestMissedAt: '2025-11-14T09:00:00.000Z',
    }

    it('prints the record’s own wording, not the row’s stored label', () => {
      const body = build([row({ item: { text: 'stale label from the document', occurrenceSummary: summary } })])
      const text = body.querySelector('.srn-print-todo-text')?.textContent ?? ''
      // The shared helper's words, so paper can never state a different count or
      // date range from the screen.
      expect(text).toBe(checklistOccurrenceSummaryText(summary))
      expect(text).toContain('34 earlier occurrences were not generated')
      expect(text).not.toContain('stale label')
    })

    it('says in words that it is a record rather than an outstanding todo', () => {
      const body = build([row({ item: { text: 'record', occurrenceSummary: summary } })])
      expect(body.querySelector('.srn-print-todo-meta')?.textContent).toContain('a record, not a todo')
    })

    it('is not counted in the printed summary line', () => {
      const body = buildTodoPrintBody({
        rows: [
          row({ item: { text: 'Water the plants' } }),
          row({ item: { text: 'record', occurrenceSummary: summary } }),
        ],
        filters: filters({ hideCompleted: true }),
        tagOptions: [],
        totalCount: 1,
        now: Date.now(),
      })
      expect(body.querySelector('.srn-print-todo-summary')?.textContent).toContain('Showing 1 of 1 todos')
    })
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
      // Heading sections print as structure, which needs a rule of its own: they
      // carry no checkbox, so weight and spacing are all that say they are not
      // tasks.
      '.srn-print-todo--heading',
      '.srn-print-todo-description',
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

/**
 * Nested-checklist depth on paper.
 *
 * This exists because "the printed Todos view is flat" could mean two very
 * different things: the projection losing the depth, or the rows arriving flat.
 * It is the second — the projection consumes `TodoRow.depth` and reproduces it
 * three ways (a data attribute, the shared indent formula, and a level label past
 * the indent ceiling). These tests feed it CORRECT depths and pin all three, so
 * the print path can never be blamed for, or quietly start causing, a flattening
 * that belongs upstream.
 */
describe('buildTodoPrintBody depth fidelity', () => {
  const build = (rows: TodoRow[]) =>
    buildTodoPrintBody({
      rows,
      filters: DEFAULT_TODO_FILTERS,
      tagOptions: [],
      totalCount: rows.length,
      now: Date.now(),
    })

  it('reproduces four distinct levels, with the state of each row', () => {
    const rows = [
      row({ id: 'r0', item: { id: 'r0', text: 'Pack', checked: true }, depth: 0 }),
      row({ id: 'r1', item: { id: 'r1', text: 'Socks', checked: false }, depth: 1 }),
      row({ id: 'r2', item: { id: 'r2', text: 'Wool', checked: true }, depth: 2 }),
      row({ id: 'r3', item: { id: 'r3', text: 'Thick', checked: false }, depth: 3 }),
    ]

    const entries = Array.from(build(rows).querySelectorAll<HTMLElement>('.srn-print-todo'))
    expect(
      entries.map((entry) => [
        entry.querySelector('.srn-print-todo-text')?.textContent,
        entry.getAttribute('data-todo-depth'),
        parseFloat(entry.style.marginInlineStart),
        entry.querySelector('.srn-print-checkbox')?.textContent,
      ]),
    ).toEqual([
      ['Pack', '0', 0, '☒'],
      ['Socks', '1', todoPrintIndentRem(1), '☐'],
      ['Wool', '2', todoPrintIndentRem(2), '☒'],
      ['Thick', '3', todoPrintIndentRem(3), '☐'],
    ])
    // Four different indents: the margins strictly increase, so a reader can see
    // the tree rather than having to trust the data attribute.
    const margins = entries.map((entry) => parseFloat(entry.style.marginInlineStart))
    expect(margins).toEqual([...margins].sort((a, b) => a - b))
    expect(new Set(margins).size).toBe(4)
  })

  it('states a depth past the indent ceiling in words, since the indent stops moving', () => {
    const deep = TODO_MAX_INDENT_LEVEL + 3
    const entries = Array.from(
      build([
        row({ id: 'ceiling', item: { id: 'ceiling', text: 'At ceiling' }, depth: TODO_MAX_INDENT_LEVEL }),
        row({ id: 'past', item: { id: 'past', text: 'Past it' }, depth: deep }),
      ]).querySelectorAll<HTMLElement>('.srn-print-todo'),
    )

    expect(entries[0].getAttribute('data-todo-depth')).toBe(String(TODO_MAX_INDENT_LEVEL))
    expect(entries[1].getAttribute('data-todo-depth')).toBe(String(deep))
    // The indent is clamped — so the real depth has to be said instead.
    expect(parseFloat(entries[1].style.marginInlineStart)).toBe(parseFloat(entries[0].style.marginInlineStart))
    expect(entries[1].querySelector('.srn-print-todo-level')?.textContent).toBe(` L${deep}`)
    expect(entries[0].querySelector('.srn-print-todo-level')).toBeNull()
  })
})
