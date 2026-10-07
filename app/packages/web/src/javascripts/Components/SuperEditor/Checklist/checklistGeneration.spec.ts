/**
 * Behaviour contract for the editor-side generation pass.
 *
 * The user's example is the first test and is taken literally: a monthly task
 * three months overdue produces THREE tasks, because the window includes the
 * stored deadline — that deadline IS the first occurrence that was owed, not a
 * boundary to step past.
 *
 * The rest of the file pins the properties that make the feature safe rather than
 * merely present: a generated row never carries the recurrence rule (so nothing
 * compounds and exactly one rule stays in play for the propagation path), a
 * second pass generates nothing (so the cap is a per-pass bound and not a backlog
 * that re-offers itself), the record of what the cap left out is updated in place
 * rather than appended, and only the live row's roll reproduces a subtree.
 */
import { $createListItemNode, $createListNode, $isListNode, ListItemNode, ListNode } from '@lexical/list'
import { createHeadlessEditor } from '@lexical/headless'
import { $createTextNode, $getRoot, LexicalNode } from 'lexical'
import {
  $getChecklistDueAt,
  $getChecklistOccurrenceSummary,
  $getChecklistRecurrence,
  $getChecklistTodoId,
  $setChecklistOccurrenceSummary,
  $setChecklistSchedule,
  CHECKLIST_OCCURRENCE_SUMMARY_VERSION,
} from '../Lexical/Nodes/ChecklistItemNode'
import { createChecklistRecurrence } from './checklistRecurrence'
import { checklistOccurrenceSummaryText, type ChecklistBackfillSettings } from './checklistBackfill'
import {
  $generateMissedChecklistOccurrences,
  checklistGenerationChangedDocument,
  readChecklistBackfillSettings,
  CHECKLIST_AUTO_GENERATE_RECURRENCES_PREF,
  CHECKLIST_GENERATE_CAP_PREF,
} from './checklistGeneration'

const LOCALE = 'en-GB'
const NOW = Date.parse('2027-03-20T12:00:00.000Z')
/** Three monthly occurrences fall in [dueAt, NOW]: 15 Jan, 15 Feb, 15 Mar. */
const THREE_OVERDUE = '2027-01-15T09:00:00.000Z'
/** Deep enough that a cap of 12 must truncate: Jan 2025 .. Mar 2027 is 27. */
const DEEP_BACKLOG = '2025-01-15T09:00:00.000Z'

const monthly = (dueAt: string) => createChecklistRecurrence('monthly', dueAt, 'UTC')!
const settings = (overrides: Partial<ChecklistBackfillSettings> = {}): ChecklistBackfillSettings => ({
  autoGenerate: true,
  cap: 12,
  ...overrides,
})

const createEditor = () =>
  createHeadlessEditor({
    namespace: 'checklist-generation-test',
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error
    },
  })

/**
 * One monthly recurring row in its own check list.
 *
 * `checked` is applied AFTER the schedule on purpose: `$setChecklistSchedule`
 * reopens a checked recurring row (a recurring schedule always names its next
 * ACTIVE occurrence), so seeding the other way round would silently produce an
 * open row and a test for "a completed task generates nothing" would be testing
 * the wrong state.
 */
const $seedRecurringRow = (dueAt: string, label = 'pay the rent', checked = false): ListItemNode => {
  const list = $createListNode('check')
  const row = $createListItemNode(false)
  row.append($createTextNode(label))
  list.append(row)
  $getRoot().append(list)
  $setChecklistSchedule(row, dueAt, monthly(dueAt))
  if (checked) {
    row.setChecked(true)
  }
  return row
}

/** True for one of Lexical's text-less indent wrappers. */
const isIndentWrapper = (node: LexicalNode | null): boolean =>
  node instanceof ListItemNode && node.getChildrenSize() > 0 && node.getChildren().every((c) => $isListNode(c))

/**
 * Indent one subtask under `parent`, as the EDITOR really represents
 * indentation: a new row is appended to `parent`'s own list, after `parent` and
 * anything already indented beneath it, and then pushed down with
 * `ListItemNode.setIndent`. Lexical's `$handleIndent` parks the sub-list in a
 * text-less wrapper listitem that is a SIBLING of `parent`, never a child of it.
 *
 * Hand-building `{ listitem: [text, nestedList] }` is forbidden: Lexical does
 * not emit it, so a test using it passes while the generation pass's subtree
 * handling is dead on every real document.
 */
const $appendSubtask = (parent: ListItemNode, text: string): ListItemNode => {
  const item = $createListItemNode(false)
  item.append($createTextNode(text))
  let anchor: ListItemNode = parent
  while (isIndentWrapper(anchor.getNextSibling())) {
    anchor = anchor.getNextSibling() as ListItemNode
  }
  anchor.insertAfter(item)
  item.setIndent(parent.getIndent() + 1)
  return item
}

/** The rows indented directly under `row`, read straight out of the structure. */
const $subtasksOf = (row: ListItemNode): ListItemNode[] => {
  const subtasks: ListItemNode[] = []
  let sibling = row.getNextSibling()
  while (isIndentWrapper(sibling)) {
    for (const list of (sibling as ListItemNode).getChildren()) {
      if ($isListNode(list)) {
        subtasks.push(...(list.getChildren() as ListItemNode[]))
      }
    }
    sibling = (sibling as ListItemNode).getNextSibling()
  }
  return subtasks
}

const $list = (index = 0): ListNode => $getRoot().getChildren()[index] as ListNode
const $rows = (index = 0): ListItemNode[] => $list(index).getChildren() as ListItemNode[]
/** Each row as (own text, deadline, has-a-rule, is-a-record), in document order. */
const $shape = (index = 0) =>
  $rows(index).map((row) => ({
    dueAt: $getChecklistDueAt(row),
    recurring: $getChecklistRecurrence(row) !== undefined,
    record: $getChecklistOccurrenceSummary(row) !== undefined,
  }))

describe('generating the occurrences a recurring checklist task owed', () => {
  it("produces three tasks for three months overdue — the user's example, literally", () => {
    const editor = createEditor()
    editor.update(
      () => {
        $seedRecurringRow(THREE_OVERDUE)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const result = $generateMissedChecklistOccurrences(settings(), NOW, LOCALE)
        expect(result).toEqual({ examined: 1, tasks: 1, generated: 3, summaries: 0, advanced: 1 })
        expect(checklistGenerationChangedDocument(result)).toBe(true)

        // The live row first, then its owed occurrences in occurrence order. The
        // stored deadline is included because it IS the first occurrence owed.
        expect($shape()).toEqual([
          { dueAt: '2027-04-15T09:00:00.000Z', recurring: true, record: false },
          { dueAt: '2027-01-15T09:00:00.000Z', recurring: false, record: false },
          { dueAt: '2027-02-15T09:00:00.000Z', recurring: false, record: false },
          { dueAt: '2027-03-15T09:00:00.000Z', recurring: false, record: false },
        ])
      },
      { discrete: true },
    )
  })

  it('gives every generated row the live row’s text, a fresh identity, and no rule', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $seedRecurringRow(THREE_OVERDUE, 'water the plants')
      },
      { discrete: true },
    )

    editor.update(
      () => {
        $generateMissedChecklistOccurrences(settings(), NOW, LOCALE)
        const rows = $rows()
        expect(rows.map((row) => row.getTextContent())).toEqual(Array(4).fill('water the plants'))
        expect(rows.every((row) => row.getChecked() === false)).toBe(true)

        const ids = rows.map((row) => $getChecklistTodoId(row))
        expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
        expect(new Set(ids).size).toBe(rows.length)

        // The compounding bug: a generated row that inherited the rule would
        // itself become overdue-and-recurring and generate on the next pass.
        expect(rows.slice(1).every((row) => $getChecklistRecurrence(row) === undefined)).toBe(true)
      },
      { discrete: true },
    )
  })

  it('generates nothing on a second pass, so the cap bounds a pass and not a backlog', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $seedRecurringRow(DEEP_BACKLOG)
      },
      { discrete: true },
    )

    let firstShape: ReturnType<typeof $shape> = []
    editor.update(
      () => {
        const first = $generateMissedChecklistOccurrences(settings(), NOW, LOCALE)
        expect(first).toMatchObject({ tasks: 1, generated: 12, summaries: 1, advanced: 1 })
        firstShape = $shape()
        // The live row's deadline is strictly after `now`, which is the whole
        // reason the next pass has nothing to enumerate.
        expect(Date.parse($getChecklistDueAt($rows()[0]) as string)).toBeGreaterThan(NOW)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const second = $generateMissedChecklistOccurrences(settings(), NOW, LOCALE)
        expect(second).toEqual({ examined: 1, tasks: 0, generated: 0, summaries: 0, advanced: 0 })
        expect(checklistGenerationChangedDocument(second)).toBe(false)
        expect($shape()).toEqual(firstShape)
      },
      { discrete: true },
    )
  })

  it('records what the cap left out, with no deadline and no rule of its own', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $seedRecurringRow(DEEP_BACKLOG)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        $generateMissedChecklistOccurrences(settings({ cap: 12 }), NOW, LOCALE)
        const rows = $rows()
        // live row + 12 generated + 1 record
        expect(rows).toHaveLength(14)

        const record = rows[13]
        const summary = $getChecklistOccurrenceSummary(record)
        expect(summary).toEqual({
          version: CHECKLIST_OCCURRENCE_SUMMARY_VERSION,
          missedCount: 15,
          oldestMissedAt: DEEP_BACKLOG,
          newestMissedAt: '2026-03-15T09:00:00.000Z',
          sourceTodoId: $getChecklistTodoId(rows[0]),
        })
        // Structurally incapable of reading as an occurrence.
        expect($getChecklistDueAt(record)).toBeUndefined()
        expect($getChecklistRecurrence(record)).toBeUndefined()

        const text = record.getTextContent()
        expect(text).toBe(checklistOccurrenceSummaryText(summary!, LOCALE, 'UTC'))
        expect(text).toContain('15 earlier occurrences were not generated')
        expect(text).toContain('oldest 15 Jan 2025')
        expect(text).toContain('newest 15 Mar 2026')
        // It claims only what it knows: no due date, and nothing destroyed.
        expect(text).not.toMatch(/missed|lost|Due/)
      },
      { discrete: true },
    )
  })

  it('updates its own record in place instead of appending a second one', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $seedRecurringRow(DEEP_BACKLOG)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        $generateMissedChecklistOccurrences(settings({ cap: 2 }), NOW, LOCALE)
      },
      { discrete: true },
    )

    let recordCount = 0
    editor.update(
      () => {
        const records = $rows().filter((row) => $getChecklistOccurrenceSummary(row) !== undefined)
        expect(records).toHaveLength(1)
        expect($getChecklistOccurrenceSummary(records[0])).toMatchObject({ missedCount: 25 })
        // The user has read it and ticked it off.
        records[0].setChecked(true)
        recordCount = records.length
      },
      { discrete: true },
    )
    expect(recordCount).toBe(1)

    // A year later the same task has fallen further behind.
    const LATER = Date.parse('2028-03-20T12:00:00.000Z')
    editor.update(
      () => {
        $generateMissedChecklistOccurrences(settings({ cap: 2 }), LATER, LOCALE)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const records = $rows().filter((row) => $getChecklistOccurrenceSummary(row) !== undefined)
        // Still exactly one record, found by its state key rather than appended.
        expect(records).toHaveLength(1)
        // Cumulative: 25 from the first pass plus the 10 this one truncated. The
        // two windows are disjoint, so the counts add and the bounds widen.
        expect($getChecklistOccurrenceSummary(records[0])).toMatchObject({
          missedCount: 35,
          oldestMissedAt: DEEP_BACKLOG,
          newestMissedAt: '2028-01-15T09:00:00.000Z',
        })
        // Reopened only because there is genuinely more to see now.
        expect(records[0].getChecked()).toBe(false)
      },
      { discrete: true },
    )
  })

  it('leaves a record it did not change ticked off', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $seedRecurringRow(DEEP_BACKLOG)
      },
      { discrete: true },
    )
    editor.update(
      () => {
        $generateMissedChecklistOccurrences(settings({ cap: 2 }), NOW, LOCALE)
        $rows()
          .filter((row) => $getChecklistOccurrenceSummary(row) !== undefined)
          .forEach((row) => row.setChecked(true))
      },
      { discrete: true },
    )

    editor.update(
      () => {
        // Nothing new is owed, so the pass is a no-op and must not re-surface a
        // record the user has already dismissed.
        expect($generateMissedChecklistOccurrences(settings({ cap: 2 }), NOW, LOCALE)).toMatchObject({ tasks: 0 })
        const records = $rows().filter((row) => $getChecklistOccurrenceSummary(row) !== undefined)
        expect(records.map((row) => row.getChecked())).toEqual([true])
      },
      { discrete: true },
    )
  })

  it('gives each recurring task its own record rather than one shared', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $seedRecurringRow(DEEP_BACKLOG, 'rent')
        const second = $createListItemNode(false)
        second.append($createTextNode('insurance'))
        $list().append(second)
        $setChecklistSchedule(second, DEEP_BACKLOG, monthly(DEEP_BACKLOG))
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const result = $generateMissedChecklistOccurrences(settings({ cap: 2 }), NOW, LOCALE)
        expect(result).toMatchObject({ examined: 2, tasks: 2, summaries: 2 })
        const records = $rows().filter((row) => $getChecklistOccurrenceSummary(row) !== undefined)
        expect(records).toHaveLength(2)
        const sources = records.map((row) => $getChecklistOccurrenceSummary(row)!.sourceTodoId)
        expect(new Set(sources).size).toBe(2)
        expect(sources.every((source) => typeof source === 'string')).toBe(true)
      },
      { discrete: true },
    )
  })

  it('reproduces a subtree for the live row’s roll only, never for a generated row', () => {
    const editor = createEditor()
    editor.update(
      () => {
        const row = $seedRecurringRow(THREE_OVERDUE)
        const subtask = $appendSubtask(row, 'transfer the money')
        subtask.setChecked(true)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        $generateMissedChecklistOccurrences(settings(), NOW, LOCALE)
        const rows = $rows()
        // The live row keeps its subtree; it is the occurrence the task is on.
        // The wrapper holding that subtree sits straight after the live row, and
        // the generated occurrences come AFTER it — a generated row inserted
        // between the two would take the subtree over.
        expect(isIndentWrapper(rows[1])).toBe(true)
        const subtasks = $subtasksOf(rows[0])
        expect(subtasks).toHaveLength(1)
        expect(subtasks[0].getChecked()).toBe(false)
        expect($getChecklistDueAt(subtasks[0])).toBe('2027-04-15T09:00:00.000Z')

        // Generated occurrences are bare: a past occurrence is not an invitation
        // to redo a whole subtree, and copying one would multiply the work.
        for (const row of rows.slice(2)) {
          expect(isIndentWrapper(row)).toBe(false)
          expect(row.getChildren().filter((child) => $isListNode(child))).toHaveLength(0)
          expect($subtasksOf(row)).toHaveLength(0)
        }
      },
      { discrete: true },
    )
  })

  it('is one occurrence for a subtree, even when the subtask recurs on its own', () => {
    const editor = createEditor()
    editor.update(
      () => {
        const row = $seedRecurringRow(THREE_OVERDUE)
        // A subtask overdue on its own monthly rule. Rolling the parent already
        // carries it forward, so the pass must not then treat it as its own
        // overdue candidate and write a second window inside the subtree.
        const subtask = $appendSubtask(row, 'transfer the money')
        $setChecklistSchedule(subtask, THREE_OVERDUE, monthly(THREE_OVERDUE))
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const result = $generateMissedChecklistOccurrences(settings(), NOW, LOCALE)
        // One task considered and one acted on: the subtask was carried by its
        // ancestor's roll, so the pass never considered it in its own right.
        expect(result).toEqual({ examined: 1, tasks: 1, generated: 3, summaries: 0, advanced: 1 })
        // Live row + the wrapper holding its subtask + three written occurrences.
        expect($rows()).toHaveLength(5)

        const subtasks = $subtasksOf($rows()[0])
        expect(subtasks).toHaveLength(1)
        expect($getChecklistDueAt(subtasks[0])).toBe('2027-04-15T09:00:00.000Z')
      },
      { discrete: true },
    )
  })

  it('never generates for a completed row, a plain row, or an existing record', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $seedRecurringRow(THREE_OVERDUE, 'already done', true)
        const plain = $createListItemNode(false)
        plain.append($createTextNode('no schedule at all'))
        $list().append(plain)
        const dated = $createListItemNode(false)
        dated.append($createTextNode('overdue but not recurring'))
        $list().append(dated)
        $setChecklistSchedule(dated, THREE_OVERDUE, undefined)
        const record = $createListItemNode(false)
        record.append($createTextNode('a record'))
        $list().append(record)
        $setChecklistOccurrenceSummary(record, {
          version: CHECKLIST_OCCURRENCE_SUMMARY_VERSION,
          missedCount: 3,
          oldestMissedAt: DEEP_BACKLOG,
          newestMissedAt: THREE_OVERDUE,
        })
      },
      { discrete: true },
    )

    editor.update(
      () => {
        expect($generateMissedChecklistOccurrences(settings(), NOW, LOCALE)).toEqual({
          examined: 0,
          tasks: 0,
          generated: 0,
          summaries: 0,
          advanced: 0,
        })
        expect($rows()).toHaveLength(4)
      },
      { discrete: true },
    )
  })

  it('does nothing while the automatic toggle is off, and runs when forced', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $seedRecurringRow(THREE_OVERDUE)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        expect($generateMissedChecklistOccurrences(settings({ autoGenerate: false }), NOW, LOCALE)).toMatchObject({
          tasks: 0,
          generated: 0,
        })
        expect($rows()).toHaveLength(1)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        // "Generate now" is a user instruction, not an automatic pass.
        const forced = readChecklistBackfillSettings({ getPreference: () => false }, true)
        expect(forced.autoGenerate).toBe(true)
        expect($generateMissedChecklistOccurrences(forced, NOW, LOCALE)).toMatchObject({ generated: 3 })
      },
      { discrete: true },
    )
  })
})

describe('reading the two synced preferences the pass depends on', () => {
  it('pins the key strings as literals so a stale generated bundle cannot blank them', () => {
    // The members exist in models/src but not yet in the models/dist artifact web
    // type-checks against, so reading PrefKey.X at runtime yields undefined and
    // the setting would silently do nothing. The literals are the enum's values.
    expect(String(CHECKLIST_AUTO_GENERATE_RECURRENCES_PREF)).toBe('checklistAutoGenerateRecurrences')
    expect(String(CHECKLIST_GENERATE_CAP_PREF)).toBe('checklistGenerateCap')
  })

  it('falls back to generate-on and a cap of 12 when the store has nothing', () => {
    expect(readChecklistBackfillSettings({ getPreference: () => undefined })).toEqual({
      autoGenerate: true,
      cap: 12,
    })
    expect(readChecklistBackfillSettings(undefined)).toEqual({ autoGenerate: true, cap: 12 })
  })

  it('clamps a cap another client wrote, and survives a throwing store', () => {
    const read = (value: unknown) => readChecklistBackfillSettings({ getPreference: () => value }).cap
    expect(read(0)).toBe(1)
    expect(read(-99)).toBe(1)
    expect(read(5000)).toBe(200)
    expect(read(7.9)).toBe(7)
    expect(read('twelve')).toBe(12)
    expect(read(Number.NaN)).toBe(12)

    expect(
      readChecklistBackfillSettings({
        getPreference: () => {
          throw new Error('preferences not ready')
        },
      }),
    ).toEqual({ autoGenerate: true, cap: 12 })
  })

  it('reads each key independently rather than guessing from one value', () => {
    const store = new Map<string, unknown>([
      ['checklistAutoGenerateRecurrences', false],
      ['checklistGenerateCap', 3],
    ])
    expect(readChecklistBackfillSettings({ getPreference: (key) => store.get(String(key)) })).toEqual({
      autoGenerate: false,
      cap: 3,
    })
  })
})
