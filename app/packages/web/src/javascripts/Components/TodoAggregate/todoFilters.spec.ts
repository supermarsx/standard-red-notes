import { NoteType, SNNote } from '@standardnotes/snjs'
import type { NoteTodos, TodoItem } from './allTodos'
import {
  activeTodoFilterCount,
  collectTodoTagOptions,
  DEFAULT_TODO_FILTERS,
  filterTodoRows,
  MAX_TODO_FILTER_QUERY_LENGTH,
  MAX_TODO_FILTER_TAGS,
  normalizeTodoFilters,
  sortTodoRows,
  todoDueBucket,
  todoFiltersAreDefault,
  todoRowsFromGroups,
  visibleTodoRows,
  type TodoFilters,
  type TodoTag,
} from './todoFilters'

const NOW = Date.parse('2026-08-19T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const note = (uuid: string, title: string): SNNote => ({ uuid, title, noteType: NoteType.Super }) as unknown as SNNote

const todo = (id: string, text: string, extra: Partial<TodoItem> = {}): TodoItem => ({
  id,
  text,
  checked: false,
  locator: id,
  ...extra,
})

const group = (uuid: string, title: string, items: TodoItem[], source: NoteTodos['source'] = 'super'): NoteTodos => ({
  note: note(uuid, title),
  source,
  items,
  completed: items.filter((item) => item.checked).length,
  total: items.length,
})

const TAG_WORK: TodoTag = { uuid: 'tag-work', title: 'Work' }
const TAG_HOME: TodoTag = { uuid: 'tag-home', title: 'Home/Errands' }

const groups: NoteTodos[] = [
  group('n-work', 'Sprint board', [
    todo('w1', 'Ship the beta', { dueAt: new Date(NOW - HOUR).toISOString() }),
    todo('w2', 'Write release notes', { checked: true, dueAt: new Date(NOW + 3 * DAY).toISOString() }),
    todo('w3', 'Book the venue'),
  ]),
  group(
    'n-home',
    'Errands',
    [
      todo('h1', 'Buy milk', { dueAt: new Date(NOW + 2 * HOUR).toISOString() }),
      todo('h2', 'Call the plumber', { checked: true }),
    ],
    'advanced-checklist',
  ),
]

const tagsByNote: Record<string, TodoTag[]> = {
  'n-work': [TAG_WORK],
  'n-home': [TAG_HOME],
}

const rows = () => todoRowsFromGroups(groups, (source) => tagsByNote[source.uuid] ?? [])

const withFilters = (overrides: Partial<TodoFilters>): TodoFilters => ({ ...DEFAULT_TODO_FILTERS, ...overrides })

const texts = (list: { item: TodoItem }[]) => list.map((row) => row.item.text)

describe('todoRowsFromGroups', () => {
  it('flattens every note into uniquely identified rows carrying the notes tags', () => {
    const flattened = rows()
    expect(flattened).toHaveLength(5)
    expect(new Set(flattened.map((row) => row.id)).size).toBe(5)
    expect(flattened[0].noteTitle).toBe('Sprint board')
    expect(flattened[0].tags).toEqual([TAG_WORK])
  })

  it('falls back to Untitled and survives a throwing tag lookup', () => {
    const untitled = group('n-x', '   ', [todo('x1', 'Something')])
    const flattened = todoRowsFromGroups([untitled], () => {
      throw new Error('tag store unavailable')
    })
    expect(flattened[0].noteTitle).toBe('Untitled')
    expect(flattened[0].tags).toEqual([])
  })

  it('collects the tag options actually present, de-duplicated and sorted', () => {
    expect(collectTodoTagOptions(rows())).toEqual([TAG_HOME, TAG_WORK])
  })
})

describe('todoDueBucket', () => {
  it('buckets by deadline alone, ignoring completion', () => {
    expect(todoDueBucket(todo('a', 'a'), NOW)).toBe('unscheduled')
    expect(todoDueBucket(todo('a', 'a', { dueAt: new Date(NOW - 1).toISOString() }), NOW)).toBe('overdue')
    expect(todoDueBucket(todo('a', 'a', { dueAt: new Date(NOW).toISOString() }), NOW)).toBe('overdue')
    expect(todoDueBucket(todo('a', 'a', { dueAt: new Date(NOW + DAY).toISOString() }), NOW)).toBe('due-soon')
    expect(todoDueBucket(todo('a', 'a', { dueAt: new Date(NOW + DAY + 1).toISOString() }), NOW)).toBe('later')
    // A completed overdue item is still overdue; hide-completed is separate.
    expect(todoDueBucket(todo('a', 'a', { checked: true, dueAt: new Date(NOW - DAY).toISOString() }), NOW)).toBe(
      'overdue',
    )
  })

  it('treats an unparseable deadline as unscheduled rather than throwing', () => {
    expect(todoDueBucket(todo('a', 'a', { dueAt: 'not-a-date' }), NOW)).toBe('unscheduled')
  })
})

describe('filterTodoRows', () => {
  it('returns everything under the defaults', () => {
    expect(filterTodoRows(rows(), DEFAULT_TODO_FILTERS, NOW)).toHaveLength(5)
  })

  it('searches todo text, note title and tag title', () => {
    expect(texts(filterTodoRows(rows(), withFilters({ query: 'milk' }), NOW))).toEqual(['Buy milk'])
    expect(texts(filterTodoRows(rows(), withFilters({ query: 'sprint' }), NOW))).toEqual([
      'Ship the beta',
      'Write release notes',
      'Book the venue',
    ])
    expect(texts(filterTodoRows(rows(), withFilters({ query: 'errands' }), NOW))).toEqual([
      'Buy milk',
      'Call the plumber',
    ])
  })

  it('ignores case and surrounding whitespace in the query', () => {
    expect(texts(filterTodoRows(rows(), withFilters({ query: '  MILK  ' }), NOW))).toEqual(['Buy milk'])
  })

  it('filters by tag, admitting a row carrying ANY selected tag', () => {
    expect(texts(filterTodoRows(rows(), withFilters({ tagUuids: ['tag-home'] }), NOW))).toEqual([
      'Buy milk',
      'Call the plumber',
    ])
    expect(filterTodoRows(rows(), withFilters({ tagUuids: ['tag-home', 'tag-work'] }), NOW)).toHaveLength(5)
    expect(filterTodoRows(rows(), withFilters({ tagUuids: ['tag-missing'] }), NOW)).toEqual([])
  })

  it('filters by source kind', () => {
    expect(texts(filterTodoRows(rows(), withFilters({ source: 'advanced-checklist' }), NOW))).toEqual([
      'Buy milk',
      'Call the plumber',
    ])
    expect(filterTodoRows(rows(), withFilters({ source: 'super' }), NOW)).toHaveLength(3)
  })

  it('filters by due bucket', () => {
    expect(texts(filterTodoRows(rows(), withFilters({ due: 'overdue' }), NOW))).toEqual(['Ship the beta'])
    expect(texts(filterTodoRows(rows(), withFilters({ due: 'due-soon' }), NOW))).toEqual(['Buy milk'])
    expect(texts(filterTodoRows(rows(), withFilters({ due: 'unscheduled' }), NOW))).toEqual([
      'Book the venue',
      'Call the plumber',
    ])
    expect(filterTodoRows(rows(), withFilters({ due: 'scheduled' }), NOW)).toHaveLength(3)
  })

  it('hides completed todos', () => {
    expect(texts(filterTodoRows(rows(), withFilters({ hideCompleted: true }), NOW))).toEqual([
      'Ship the beta',
      'Book the venue',
      'Buy milk',
    ])
  })

  it('composes every filter together rather than letting one win', () => {
    const composed = withFilters({
      query: 'the',
      tagUuids: ['tag-work'],
      source: 'super',
      due: 'overdue',
      hideCompleted: true,
    })
    expect(texts(filterTodoRows(rows(), composed, NOW))).toEqual(['Ship the beta'])

    // Loosening exactly one axis at a time proves none of them is a no-op.
    expect(texts(filterTodoRows(rows(), { ...composed, due: 'all' }, NOW))).toEqual(['Ship the beta', 'Book the venue'])
    expect(filterTodoRows(rows(), { ...composed, tagUuids: ['tag-home'] }, NOW)).toEqual([])
    expect(filterTodoRows(rows(), { ...composed, source: 'advanced-checklist' }, NOW)).toEqual([])
  })
})

describe('sortTodoRows', () => {
  it('orders by deadline with undated rows last, in both directions', () => {
    expect(texts(sortTodoRows(rows(), withFilters({ sortBy: 'due' })))).toEqual([
      'Ship the beta',
      'Buy milk',
      'Write release notes',
      // Undated rows come last, tie-broken by note title (Errands < Sprint board).
      'Call the plumber',
      'Book the venue',
    ])
    const reversed = texts(sortTodoRows(rows(), withFilters({ sortBy: 'due', sortReverse: true })))
    expect(reversed.slice(0, 3)).toEqual(['Write release notes', 'Buy milk', 'Ship the beta'])
    // Undated rows stay at the bottom so reversing never buries the schedule.
    expect(reversed.slice(3).sort()).toEqual(['Book the venue', 'Call the plumber'])
  })

  it('orders by todo text, note title, and status', () => {
    expect(texts(sortTodoRows(rows(), withFilters({ sortBy: 'todo' })))[0]).toBe('Book the venue')
    expect(texts(sortTodoRows(rows(), withFilters({ sortBy: 'note' })))[0]).toBe('Buy milk')
    const byStatus = sortTodoRows(rows(), withFilters({ sortBy: 'status' }))
    expect(byStatus.slice(0, 3).every((row) => !row.item.checked)).toBe(true)
    expect(byStatus.slice(3).every((row) => row.item.checked)).toBe(true)
  })

  it('never mutates the input array', () => {
    const input = rows()
    const before = texts(input)
    sortTodoRows(input, withFilters({ sortBy: 'todo' }))
    expect(texts(input)).toEqual(before)
  })

  it('is a total order, so repeated sorts are stable', () => {
    const once = texts(visibleTodoRows(rows(), DEFAULT_TODO_FILTERS, NOW))
    const twice = texts(visibleTodoRows(rows(), DEFAULT_TODO_FILTERS, NOW))
    expect(twice).toEqual(once)
  })
})

describe('normalizeTodoFilters', () => {
  it('falls back to the defaults for junk, and never throws', () => {
    for (const junk of [undefined, null, 'nope', 42, [], { version: 99 }]) {
      expect(() => normalizeTodoFilters(junk)).not.toThrow()
      expect(normalizeTodoFilters(junk)).toEqual(DEFAULT_TODO_FILTERS)
    }
  })

  it('keeps valid fields and repairs invalid ones individually', () => {
    expect(
      normalizeTodoFilters({
        version: 1,
        query: 'milk',
        tagUuids: ['a', 'a', '', 'b', 7],
        source: 'nonsense',
        due: 'overdue',
        hideCompleted: 'yes',
        sortBy: 'todo',
        sortReverse: true,
      }),
    ).toEqual({
      version: 1,
      query: 'milk',
      tagUuids: ['a', 'b'],
      source: 'all',
      due: 'overdue',
      hideCompleted: false,
      sortBy: 'todo',
      sortReverse: true,
    })
  })

  it('bounds the query length and the tag count', () => {
    const normalized = normalizeTodoFilters({
      query: 'x'.repeat(MAX_TODO_FILTER_QUERY_LENGTH + 500),
      tagUuids: Array.from({ length: MAX_TODO_FILTER_TAGS + 20 }, (_, index) => `tag-${index}`),
    })
    expect(normalized.query).toHaveLength(MAX_TODO_FILTER_QUERY_LENGTH)
    expect(normalized.tagUuids).toHaveLength(MAX_TODO_FILTER_TAGS)
  })

  it('round-trips its own output', () => {
    const once = normalizeTodoFilters({ query: 'a', due: 'due-soon', hideCompleted: true })
    expect(normalizeTodoFilters(once)).toEqual(once)
  })
})

describe('activeTodoFilterCount', () => {
  it('counts only filters that can hide a row', () => {
    expect(activeTodoFilterCount(DEFAULT_TODO_FILTERS)).toBe(0)
    // Sorting reorders but never hides, so it must not count.
    expect(activeTodoFilterCount(withFilters({ sortBy: 'todo', sortReverse: true }))).toBe(0)
    expect(activeTodoFilterCount(withFilters({ query: '   ' }))).toBe(0)
    expect(activeTodoFilterCount(withFilters({ query: 'a' }))).toBe(1)
    expect(
      activeTodoFilterCount(
        withFilters({ query: 'a', tagUuids: ['t'], source: 'super', due: 'overdue', hideCompleted: true }),
      ),
    ).toBe(5)
  })

  it('reports the default state only when nothing narrows or reorders', () => {
    expect(todoFiltersAreDefault(DEFAULT_TODO_FILTERS)).toBe(true)
    expect(todoFiltersAreDefault(withFilters({ sortBy: 'todo' }))).toBe(false)
    expect(todoFiltersAreDefault(withFilters({ hideCompleted: true }))).toBe(false)
  })
})
