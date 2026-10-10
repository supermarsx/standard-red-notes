import { NoteType, SNNote } from '@standardnotes/snjs'

import { collectAllTodos } from './allTodos'
import { todoRowsFromGroups, type TodoRow, type TodoTag } from './todoFilters'
import { checklistChain, superChecklistNoteText, type ChecklistTaskSpec } from './todoLexicalFixture'
import {
  DEFAULT_TODO_CALENDAR_PUBLICATION,
  isLocalMidnight,
  legacyTodoUidSuffix,
  localCalendarDate,
  normalizeTodoCalendarPublication,
  publishableRecurrence,
  rowIsInScope,
  staleTodoCalendarUids,
  TODO_CALENDAR_MAX_ITEMS,
  TODO_CALENDAR_PUBLICATION_PREF_KEY,
  TODO_CALENDAR_UID_PREFIX,
  todoCalendarPublications,
  todoCalendarUid,
  type TodoCalendarPublicationSettings,
} from './todoCalendarPublication'
import type { ChecklistRecurrence } from '../SuperEditor/Checklist/checklistRecurrence'

const SCHEDULE_KEY = 'srnChecklistSchedule'
const TODO_ID_KEY = 'srnChecklistTodoId'
const SUMMARY_KEY = 'srnChecklistOccurrenceSummary'

type Fixture = { text: string; checked?: boolean; dueAt?: string; todoId?: string; children?: Fixture[] }

/** A Super note whose checklist is nested the way `$handleIndent` really nests. */
function noteWith(tasks: Fixture[], options: { uuid?: string; title?: string } = {}): SNNote {
  const text = superChecklistNoteText(tasks as ChecklistTaskSpec[], {
    stateFor: (task) => {
      const fixture = task as Fixture
      const state: Record<string, unknown> = {}
      if (fixture.todoId) {
        state[TODO_ID_KEY] = fixture.todoId
      }
      if (fixture.dueAt) {
        state[SCHEDULE_KEY] = { version: 1, dueAt: fixture.dueAt }
      }
      return Object.keys(state).length > 0 ? state : undefined
    },
  })
  return {
    uuid: options.uuid ?? 'note-1',
    title: options.title ?? 'Chores',
    text,
    noteType: NoteType.Super,
    trashed: false,
  } as unknown as SNNote
}

function rowsOf(notes: SNNote[], tags: Record<string, TodoTag[]> = {}): TodoRow[] {
  return todoRowsFromGroups(collectAllTodos(notes), (note) => tags[note.uuid] ?? [])
}

const tag = (uuid: string, title: string, longTitle = title): TodoTag => ({ uuid, title, longTitle })

const settings = (overrides: Partial<TodoCalendarPublicationSettings> = {}): TodoCalendarPublicationSettings => ({
  ...DEFAULT_TODO_CALENDAR_PUBLICATION,
  scope: 'all',
  ...overrides,
})

const anchor = (overrides: Partial<ChecklistRecurrence['anchor']> = {}): ChecklistRecurrence['anchor'] => ({
  timeZone: 'Europe/Berlin',
  year: 2026,
  month: 1,
  day: 31,
  hour: 9,
  minute: 0,
  second: 0,
  millisecond: 0,
  ...overrides,
})

describe('todoCalendarPublication', () => {
  describe('the pref key', () => {
    it('is pinned as the literal the enum member resolves to', () => {
      // Web reads PrefKey's RUNTIME value from a generated bundle that predates
      // a brand-new member, where it is `undefined`; the literal depends on
      // nothing generated. See checklistBackfill.ts for the full account.
      expect(TODO_CALENDAR_PUBLICATION_PREF_KEY).toBe('todoCalendarPublication')
    })
  })

  describe('defaults', () => {
    it('publishes NOTHING until a scope is chosen', () => {
      expect(DEFAULT_TODO_CALENDAR_PUBLICATION.scope).toBe('tags')
      expect(DEFAULT_TODO_CALENDAR_PUBLICATION.tagUuids).toEqual([])
      const rows = rowsOf([noteWith([{ text: 'A', dueAt: '2026-03-14T17:00:00.000Z' }])])
      expect(todoCalendarPublications(rows, DEFAULT_TODO_CALENDAR_PUBLICATION)).toEqual([])
    })

    it('excludes completed tasks by default', () => {
      expect(DEFAULT_TODO_CALENDAR_PUBLICATION.includeCompleted).toBe(false)
    })
  })

  describe('normalizeTodoCalendarPublication', () => {
    it('returns the defaults for a non-object', () => {
      for (const value of [undefined, null, 'x', 5, []]) {
        expect(normalizeTodoCalendarPublication(value)).toEqual(DEFAULT_TODO_CALENDAR_PUBLICATION)
      }
    })

    it('rejects an unknown scope', () => {
      expect(normalizeTodoCalendarPublication({ scope: 'everything' }).scope).toBe('tags')
    })

    it('de-duplicates and bounds the id lists', () => {
      const normalized = normalizeTodoCalendarPublication({
        tagUuids: ['a', 'a', 'b', 7, '', 'x'.repeat(500)],
        noteUuids: Array.from({ length: 200 }, (_value, index) => `n${index}`),
      })
      expect(normalized.tagUuids).toEqual(['a', 'b'])
      expect(normalized.noteUuids).toHaveLength(64)
    })

    it('clamps the item ceiling', () => {
      expect(normalizeTodoCalendarPublication({ maximumItems: 0 }).maximumItems).toBe(1)
      expect(normalizeTodoCalendarPublication({ maximumItems: 99_999 }).maximumItems).toBe(TODO_CALENDAR_MAX_ITEMS)
      expect(normalizeTodoCalendarPublication({ maximumItems: 'x' }).maximumItems).toBe(200)
    })

    it('keeps the helpful behaviours on for an ABSENT field and off only for an explicit false', () => {
      expect(normalizeTodoCalendarPublication({}).dateOnlyAtLocalMidnight).toBe(true)
      expect(normalizeTodoCalendarPublication({ dateOnlyAtLocalMidnight: false }).dateOnlyAtLocalMidnight).toBe(false)
      expect(normalizeTodoCalendarPublication({}).includeTagsAsCategories).toBe(true)
      expect(normalizeTodoCalendarPublication({ includeTagsAsCategories: false }).includeTagsAsCategories).toBe(false)
    })

    it('treats anything but literal true as not including completed tasks', () => {
      for (const value of ['true', 1, {}]) {
        expect(normalizeTodoCalendarPublication({ includeCompleted: value }).includeCompleted).toBe(false)
      }
    })
  })

  describe('what is refused', () => {
    it('refuses a task with no deadline', () => {
      const rows = rowsOf([noteWith([{ text: 'No date' }, { text: 'Dated', dueAt: '2026-03-14T17:00:00.000Z' }])])
      expect(todoCalendarPublications(rows, settings()).map((item) => item.summary)).toEqual(['Dated'])
    })

    it('refuses a deadline the canonical normalizer will not accept', () => {
      const rows = rowsOf([noteWith([{ text: 'Bad', dueAt: 'tomorrow' }])])
      expect(todoCalendarPublications(rows, settings())).toEqual([])
    })

    it('refuses an occurrence-summary RECORD, which is not a task', () => {
      // Built with the summary marker directly, because a record is exactly the
      // row that must never be given a schedule.
      const text = superChecklistNoteText([{ text: '3 missed occurrences' }, { text: 'Real' }], {
        stateFor: (task) =>
          task.text === 'Real'
            ? { [SCHEDULE_KEY]: { version: 1, dueAt: '2026-03-14T17:00:00.000Z' } }
            : {
                [SUMMARY_KEY]: {
                  version: 1,
                  missedCount: 3,
                  oldestMissedAt: '2026-01-01T09:00:00.000Z',
                  newestMissedAt: '2026-02-01T09:00:00.000Z',
                },
                [SCHEDULE_KEY]: { version: 1, dueAt: '2026-03-01T09:00:00.000Z' },
              },
      })
      const note = { uuid: 'note-1', title: 'T', text, noteType: NoteType.Super, trashed: false } as unknown as SNNote
      const published = todoCalendarPublications(rowsOf([note]), settings())
      expect(published.map((item) => item.summary)).toEqual(['Real'])
    })

    it('refuses a heading section row', () => {
      const text = superChecklistNoteText([{ text: 'Task' }], {
        before: [{ type: 'heading', tag: 'h1', children: [{ type: 'text', text: 'Section' }] }],
        stateFor: () => ({ [SCHEDULE_KEY]: { version: 1, dueAt: '2026-03-14T17:00:00.000Z' } }),
      })
      const note = { uuid: 'note-1', title: 'T', text, noteType: NoteType.Super, trashed: false } as unknown as SNNote
      const published = todoCalendarPublications(rowsOf([note]), settings())
      expect(published.map((item) => item.summary)).toEqual(['Task'])
    })

    it('refuses a heading row that CARRIES a deadline', () => {
      // `parseSuperChecklistDocument` cannot produce this today: a section row is
      // synthesised from a heading node and only a `listitem` can hold schedule
      // state, so a heading always lacks `dueAt` and is excluded by the deadline
      // check above. The guard stays, and is asserted HERE at this function's own
      // contract boundary (it takes any `TodoRow[]`), because "a section due
      // date" is a natural next feature and the failure it would cause —
      // publishing a section TITLE as a calendar event — is silent.
      const [base] = rowsOf([noteWith([{ text: 'Task', dueAt: '2026-03-14T17:00:00.000Z' }])])
      const heading: TodoRow = {
        ...base,
        item: { ...base.item, text: 'Phase 1', headingLevel: 1, dueAt: '2026-03-20T17:00:00.000Z' },
      }
      expect(todoCalendarPublications([heading], settings())).toEqual([])
      expect(todoCalendarPublications([heading, base], settings()).map((item) => item.summary)).toEqual(['Task'])
    })

    it('refuses an occurrence-summary row that CARRIES a deadline', () => {
      // Same shape of defence as the heading row above: `$setChecklistOccurrenceSummary`
      // clears any schedule when it writes the marker, so a record with a
      // deadline cannot be authored — but a record that READ as due would be
      // indistinguishable from work, which is the one property the marker exists
      // to guarantee.
      const [base] = rowsOf([noteWith([{ text: 'Task', dueAt: '2026-03-14T17:00:00.000Z' }])])
      const record: TodoRow = {
        ...base,
        item: {
          ...base.item,
          text: '3 missed occurrences',
          dueAt: '2026-03-20T17:00:00.000Z',
          occurrenceSummary: {
            version: 1,
            missedCount: 3,
            oldestMissedAt: '2026-01-01T09:00:00.000Z',
            newestMissedAt: '2026-02-01T09:00:00.000Z',
          },
        },
      }
      expect(todoCalendarPublications([record], settings())).toEqual([])
    })

    it('refuses a blank summary, which the store would reject anyway', () => {
      const rows = rowsOf([noteWith([{ text: '   ', dueAt: '2026-03-14T17:00:00.000Z' }])])
      expect(todoCalendarPublications(rows, settings())).toEqual([])
    })

    it('never publishes a Lexical INDENT WRAPPER as a second, textless event', () => {
      // The wrapper is a sibling listitem holding the nested list, and
      // `afterCloneFrom` copies node state, so it can INHERIT the parent's
      // deadline. Two indented rows must therefore yield exactly two events.
      const rows = rowsOf([
        noteWith([
          {
            text: 'Parent',
            dueAt: '2026-03-14T17:00:00.000Z',
            children: [{ text: 'Child', dueAt: '2026-03-15T17:00:00.000Z' }],
          },
        ]),
      ])
      const published = todoCalendarPublications(rows, settings())
      expect(published.map((item) => item.summary)).toEqual(['Parent', 'Child'])
      expect(published.every((item) => item.summary.trim().length > 0)).toBe(true)
    })

    it('walks a deep chain without recursing: 400 levels, one event per level', () => {
      const chain = checklistChain(400)
      const stamp = (task: ChecklistTaskSpec): ChecklistTaskSpec => ({
        ...task,
        children: task.children?.map(stamp),
      })
      const text = superChecklistNoteText([stamp(chain)], {
        stateFor: () => ({ [SCHEDULE_KEY]: { version: 1, dueAt: '2026-03-14T17:00:00.000Z' } }),
      })
      const note = { uuid: 'note-1', title: 'T', text, noteType: NoteType.Super, trashed: false } as unknown as SNNote
      const published = todoCalendarPublications(rowsOf([note]), settings({ maximumItems: TODO_CALENDAR_MAX_ITEMS }))
      expect(published.length).toBeGreaterThan(100)
      expect(published[0].summary).toBe('Level 0')
    })
  })

  describe('scope', () => {
    const notes = [
      noteWith([{ text: 'Work task', dueAt: '2026-03-14T17:00:00.000Z' }], { uuid: 'note-work', title: 'Work' }),
      noteWith([{ text: 'Home task', dueAt: '2026-03-15T17:00:00.000Z' }], { uuid: 'note-home', title: 'Home' }),
    ]
    const tags = { 'note-work': [tag('tag-work', 'Work')], 'note-home': [tag('tag-home', 'Home')] }

    it('all publishes every dated task', () => {
      expect(todoCalendarPublications(rowsOf(notes, tags), settings({ scope: 'all' }))).toHaveLength(2)
    })

    it('tags publishes only the selected folders, and nothing when none are selected', () => {
      expect(todoCalendarPublications(rowsOf(notes, tags), settings({ scope: 'tags', tagUuids: [] }))).toHaveLength(0)
      const selected = todoCalendarPublications(
        rowsOf(notes, tags),
        settings({ scope: 'tags', tagUuids: ['tag-work'] }),
      )
      expect(selected.map((item) => item.summary)).toEqual(['Work task'])
    })

    it('notes publishes only the selected notes', () => {
      const selected = todoCalendarPublications(
        rowsOf(notes, tags),
        settings({ scope: 'notes', noteUuids: ['note-home'] }),
      )
      expect(selected.map((item) => item.summary)).toEqual(['Home task'])
    })

    it('rowIsInScope agrees with the pass for each mode', () => {
      const [work] = rowsOf([notes[0]], tags)
      expect(rowIsInScope(work, settings({ scope: 'all' }))).toBe(true)
      expect(rowIsInScope(work, settings({ scope: 'tags', tagUuids: ['tag-home'] }))).toBe(false)
      expect(rowIsInScope(work, settings({ scope: 'notes', noteUuids: ['note-work'] }))).toBe(true)
    })

    it('honours the per-run ceiling', () => {
      const many = noteWith(
        Array.from({ length: 10 }, (_value, index) => ({
          text: `Task ${index}`,
          dueAt: '2026-03-14T17:00:00.000Z',
        })),
      )
      expect(todoCalendarPublications(rowsOf([many]), settings({ maximumItems: 3 }))).toHaveLength(3)
    })
  })

  describe('completed tasks', () => {
    const note = noteWith([
      { text: 'Open', dueAt: '2026-03-14T17:00:00.000Z' },
      { text: 'Done', checked: true, dueAt: '2026-03-13T17:00:00.000Z' },
    ])

    it('excludes a finished task unless asked', () => {
      expect(todoCalendarPublications(rowsOf([note]), settings()).map((item) => item.summary)).toEqual(['Open'])
    })

    it('includes it, flagged completed, when asked', () => {
      const published = todoCalendarPublications(rowsOf([note]), settings({ includeCompleted: true }))
      expect(published.map((item) => item.summary)).toEqual(['Open', 'Done'])
      expect(published.find((item) => item.summary === 'Done')?.completed).toBe(true)
      expect(published.find((item) => item.summary === 'Open')?.completed).toBeUndefined()
    })
  })

  describe('the all-day discriminator', () => {
    // These are derived from the RUNTIME's own local zone so the spec is
    // zone-independent: a fixed instant would be midnight only in one zone.
    const localMidnight = (() => {
      const date = new Date(2026, 2, 14, 0, 0, 0, 0)
      return date.toISOString()
    })()
    const localNoon = new Date(2026, 2, 14, 12, 0, 0, 0).toISOString()

    it('recognises local midnight and nothing else', () => {
      expect(isLocalMidnight(localMidnight)).toBe(true)
      expect(isLocalMidnight(localNoon)).toBe(false)
      expect(isLocalMidnight('not-a-date')).toBe(false)
    })

    it('publishes a DATE-ONLY due for a local-midnight deadline', () => {
      const rows = rowsOf([noteWith([{ text: 'Date only', dueAt: localMidnight }])])
      expect(todoCalendarPublications(rows, settings())[0].due).toBe('2026-03-14')
    })

    it('publishes the exact instant for a deadline with a time', () => {
      const rows = rowsOf([noteWith([{ text: 'Timed', dueAt: localNoon }])])
      expect(todoCalendarPublications(rows, settings())[0].due).toBe(localNoon)
    })

    it('publishes the instant when the axis is OFF, leaving the server to infer', () => {
      const rows = rowsOf([noteWith([{ text: 'Date only', dueAt: localMidnight }])])
      expect(todoCalendarPublications(rows, settings({ dateOnlyAtLocalMidnight: false }))[0].due).toBe(localMidnight)
    })

    it('localCalendarDate refuses a non-instant', () => {
      expect(localCalendarDate('nope')).toBeUndefined()
      expect(localCalendarDate(localNoon)).toBe('2026-03-14')
    })
  })

  describe('categories', () => {
    const notes = [noteWith([{ text: 'Task', dueAt: '2026-03-14T17:00:00.000Z' }], { uuid: 'note-1' })]

    it('attaches folder PATHS so two folders of the same leaf name stay distinct', () => {
      const tags = { 'note-1': [tag('t1', 'Personal', 'Home.Personal')] }
      expect(todoCalendarPublications(rowsOf(notes, tags), settings())[0].categories).toEqual(['Home.Personal'])
    })

    it('omits them when the axis is off', () => {
      const tags = { 'note-1': [tag('t1', 'Personal')] }
      expect(
        todoCalendarPublications(rowsOf(notes, tags), settings({ includeTagsAsCategories: false }))[0].categories,
      ).toBeUndefined()
    })

    it('bounds the list', () => {
      const tags = {
        'note-1': Array.from({ length: 20 }, (_value, index) => tag(`t${index}`, `Tag ${index}`)),
      }
      expect(todoCalendarPublications(rowsOf(notes, tags), settings())[0].categories).toHaveLength(8)
    })
  })

  describe('publishableRecurrence', () => {
    const rule = (overrides: Partial<ChecklistRecurrence>): ChecklistRecurrence =>
      ({ version: 1, anchor: anchor(), ...overrides }) as ChecklistRecurrence

    it('maps the five fixed frequencies', () => {
      expect(publishableRecurrence(rule({ frequency: 'daily' }))).toEqual({
        frequency: 'daily',
        timeZone: 'Europe/Berlin',
      })
      expect(publishableRecurrence(rule({ frequency: 'weekdays' })).frequency).toBe('weekdays')
      expect(publishableRecurrence(rule({ frequency: 'weekly' })).frequency).toBe('weekly')
      expect(publishableRecurrence(rule({ frequency: 'monthly' }))).toMatchObject({
        frequency: 'monthly',
        monthDay: 31,
      })
      expect(publishableRecurrence(rule({ frequency: 'yearly' }))).toMatchObject({
        frequency: 'yearly',
        monthDay: 31,
        month: 1,
      })
    })

    it('carries the ANCHOR day, not the current occurrence, so a clamped rule does not drift', () => {
      // A 31st-of-the-month task whose present occurrence landed on 28 February
      // still repeats on the 31st.
      const mapped = publishableRecurrence(rule({ frequency: 'monthly', anchor: anchor({ month: 2, day: 31 }) }))
      expect(mapped.monthDay).toBe(31)
    })

    it('folds a custom interval+unit into frequency+interval', () => {
      expect(
        publishableRecurrence({ version: 1, frequency: 'custom', interval: 3, unit: 'day', anchor: anchor() }),
      ).toMatchObject({ frequency: 'daily', interval: 3 })
      expect(
        publishableRecurrence({ version: 1, frequency: 'custom', interval: 2, unit: 'week', anchor: anchor() }),
      ).toMatchObject({ frequency: 'weekly', interval: 2 })
      expect(
        publishableRecurrence({ version: 1, frequency: 'custom', interval: 4, unit: 'month', anchor: anchor() }),
      ).toMatchObject({ frequency: 'monthly', interval: 4, monthDay: 31 })
      expect(
        publishableRecurrence({ version: 1, frequency: 'custom', interval: 5, unit: 'year', anchor: anchor() }),
      ).toMatchObject({ frequency: 'yearly', interval: 5, monthDay: 31, month: 1 })
    })

    it('drops an interval of 1 so the server sees two equal rules as equal', () => {
      expect(
        publishableRecurrence({ version: 1, frequency: 'custom', interval: 1, unit: 'day', anchor: anchor() }),
      ).toEqual({ frequency: 'daily', timeZone: 'Europe/Berlin' })
    })

    it('omits a blank anchor zone rather than publishing an empty string', () => {
      expect(publishableRecurrence(rule({ frequency: 'daily', anchor: anchor({ timeZone: '' }) }))).toEqual({
        frequency: 'daily',
      })
    })
  })

  describe('identity', () => {
    it('is STABLE across passes for a legacy row with no persisted id', () => {
      const note = noteWith([{ text: 'A', dueAt: '2026-03-14T17:00:00.000Z' }])
      const first = todoCalendarPublications(rowsOf([note]), settings())[0].uid
      const second = todoCalendarPublications(rowsOf([note]), settings())[0].uid
      expect(first).toBe(second)
      expect(first.startsWith(TODO_CALENDAR_UID_PREFIX)).toBe(true)
    })

    it('is bounded, so a long locator cannot blow the store key limit', () => {
      expect(legacyTodoUidSuffix('x'.repeat(5_000))).toHaveLength(8)
      expect(legacyTodoUidSuffix('a')).not.toBe(legacyTodoUidSuffix('b'))
    })

    it('distinguishes two notes that carry the same locator', () => {
      const a = noteWith([{ text: 'A', dueAt: '2026-03-14T17:00:00.000Z' }], { uuid: 'note-a' })
      const b = noteWith([{ text: 'A', dueAt: '2026-03-14T17:00:00.000Z' }], { uuid: 'note-b' })
      const uids = todoCalendarPublications(rowsOf([a, b]), settings()).map((item) => item.uid)
      expect(new Set(uids).size).toBe(2)
    })

    it('publishes one record per uid, keeping the first', () => {
      // `parseSuperChecklistDocument` already strips a todoId that appears
      // twice, so this is asserted at THIS function's own contract boundary: it
      // takes any `TodoRow[]`, and a caller merging rows from two sources must
      // not make the second POST look like an edit of the first.
      const [base] = rowsOf([noteWith([{ text: 'First', dueAt: '2026-03-14T17:00:00.000Z' }])])
      const shared = { ...base.item, todoId: 'todo-duplicate1' }
      const rows: TodoRow[] = [
        { ...base, item: { ...shared, text: 'First' } },
        { ...base, item: { ...shared, text: 'Second', dueAt: '2026-03-15T17:00:00.000Z' } },
      ]
      const published = todoCalendarPublications(rows, settings())
      expect(published).toHaveLength(1)
      expect(published[0].summary).toBe('First')
      expect(published[0].uid).toBe(`${TODO_CALENDAR_UID_PREFIX}todo-duplicate1`)
    })

    it('uses the persisted id for a row that actually carries one', () => {
      const [base] = rowsOf([noteWith([{ text: 'A', dueAt: '2026-03-14T17:00:00.000Z' }])])
      const row: TodoRow = { ...base, item: { ...base.item, todoId: 'todo-abcdef12' } }
      expect(todoCalendarUid(row)).toBe(`${TODO_CALENDAR_UID_PREFIX}todo-abcdef12`)
      expect(todoCalendarPublications([row], settings())[0].uid).toBe(`${TODO_CALENDAR_UID_PREFIX}todo-abcdef12`)
    })
  })

  describe('staleTodoCalendarUids', () => {
    it('reports what this pass no longer owns, so a dropped task leaves the calendar', () => {
      expect(
        staleTodoCalendarUids(
          [`${TODO_CALENDAR_UID_PREFIX}keep`, `${TODO_CALENDAR_UID_PREFIX}drop`],
          [{ uid: `${TODO_CALENDAR_UID_PREFIX}keep`, summary: 'Keep', due: '2026-03-14' }],
        ),
      ).toEqual([`${TODO_CALENDAR_UID_PREFIX}drop`])
    })

    it('never sweeps up an item the user published BY HAND', () => {
      expect(staleTodoCalendarUids(['my-own-reminder', `${TODO_CALENDAR_UID_PREFIX}drop`], [])).toEqual([
        `${TODO_CALENDAR_UID_PREFIX}drop`,
      ])
    })

    it('reports nothing when the pass still owns everything', () => {
      const uid = `${TODO_CALENDAR_UID_PREFIX}keep`
      expect(staleTodoCalendarUids([uid], [{ uid, summary: 'Keep', due: '2026-03-14' }])).toEqual([])
    })
  })

  describe('the record handed to the publish endpoint', () => {
    it('names its source note, so a bare event on a grid is traceable', () => {
      const rows = rowsOf([noteWith([{ text: 'A', dueAt: '2026-03-14T17:00:00.000Z' }], { title: 'Groceries' })])
      expect(todoCalendarPublications(rows, settings())[0].description).toBe(
        'Task from "Groceries" in Standard Red Notes.',
      )
    })
  })
})
