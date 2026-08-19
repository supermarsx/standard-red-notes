import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { createHeadlessEditor } from '@lexical/headless'
import { $createTextNode, $getRoot } from 'lexical'
import {
  $getChecklistDescendantItems,
  $getChecklistDueAt,
  $getChecklistRecurrence,
  $propagateChecklistRecurrenceToDescendants,
  $setChecklistSchedule,
  CHECKLIST_MAX_NESTING_DEPTH,
} from '../Lexical/Nodes/ChecklistItemNode'
import {
  advanceChecklistDueAt,
  createChecklistRecurrence,
  propagatedChecklistDescendantSchedule,
} from './checklistRecurrence'
import { $setCheckedForItems } from './ChecklistBulkCompletion'
import { $toggleChecklistItemChecked } from './ChecklistEditorMutations'

const PARENT_DUE_AT = '2026-08-16T09:00:00.000Z'
const COMPLETED_AT = Date.parse('2026-08-16T10:00:00.000Z')
const daily = createChecklistRecurrence('daily', PARENT_DUE_AT, 'UTC')!
const NEXT_DUE_AT = advanceChecklistDueAt(PARENT_DUE_AT, daily, COMPLETED_AT)!

const createEditor = () =>
  createHeadlessEditor({
    namespace: 'checklist-recurrence-propagation-test',
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error
    },
  })

const appendChild = (parent: ListItemNode, text: string, checked = false): ListItemNode => {
  const list = $createListNode('check')
  const item = $createListItemNode(checked)
  item.append($createTextNode(text))
  list.append(item)
  parent.append(list)
  return item
}

describe('recurring checklist parents reproduce their subtasks', () => {
  it('rolls the whole tree onto the parent occurrence, keeping schedules a subtask owns', () => {
    expect(NEXT_DUE_AT).toBe('2026-08-17T09:00:00.000Z')

    // No schedule of its own: it becomes due with the occurrence it belongs to.
    expect(propagatedChecklistDescendantSchedule(NEXT_DUE_AT, daily, {}, COMPLETED_AT)).toMatchObject({
      dueAt: NEXT_DUE_AT,
      recurrence: { frequency: 'daily' },
    })

    // Its own rule survives; only the deadline moves onto the new cycle.
    const weekly = createChecklistRecurrence('weekly', '2026-08-16T17:00:00.000Z', 'UTC')!
    expect(
      propagatedChecklistDescendantSchedule(
        NEXT_DUE_AT,
        daily,
        { dueAt: '2026-08-16T17:00:00.000Z', recurrence: weekly },
        COMPLETED_AT,
      ),
    ).toEqual({ dueAt: '2026-08-23T17:00:00.000Z', recurrence: weekly })

    // A deliberate deadline without a rule becomes recurring on its own hour.
    expect(
      propagatedChecklistDescendantSchedule(NEXT_DUE_AT, daily, { dueAt: '2026-08-16T17:00:00.000Z' }, COMPLETED_AT),
    ).toMatchObject({ dueAt: '2026-08-17T17:00:00.000Z', recurrence: { frequency: 'daily' } })

    // Already due past the new occurrence: made recurring, never rescheduled.
    expect(
      propagatedChecklistDescendantSchedule(NEXT_DUE_AT, daily, { dueAt: '2026-08-20T17:00:00.000Z' }, COMPLETED_AT),
    ).toMatchObject({ dueAt: '2026-08-20T17:00:00.000Z', recurrence: { frequency: 'daily' } })
  })

  it('is idempotent and fails closed on schedules it cannot resolve', () => {
    const first = propagatedChecklistDescendantSchedule(NEXT_DUE_AT, daily, {}, COMPLETED_AT)!
    expect(propagatedChecklistDescendantSchedule(NEXT_DUE_AT, daily, first, COMPLETED_AT)).toBeUndefined()

    const weekly = createChecklistRecurrence('weekly', '2026-08-16T17:00:00.000Z', 'UTC')!
    const advanced = propagatedChecklistDescendantSchedule(
      NEXT_DUE_AT,
      daily,
      { dueAt: '2026-08-16T17:00:00.000Z', recurrence: weekly },
      COMPLETED_AT,
    )!
    expect(propagatedChecklistDescendantSchedule(NEXT_DUE_AT, daily, advanced, COMPLETED_AT)).toBeUndefined()

    expect(propagatedChecklistDescendantSchedule('not-a-date', daily, {}, COMPLETED_AT)).toBeUndefined()
    expect(
      propagatedChecklistDescendantSchedule(NEXT_DUE_AT, { ...daily, frequency: 'hourly' } as never, {}, COMPLETED_AT),
    ).toBeUndefined()
    expect(propagatedChecklistDescendantSchedule(NEXT_DUE_AT, daily, {}, Number.NaN)).toBeUndefined()
  })

  it('reopens and reschedules every nested task in one editor update', () => {
    const editor = createEditor()
    const updates: number[] = []
    editor.registerUpdateListener(() => {
      updates.push(1)
    })
    const weekly = createChecklistRecurrence('weekly', '2026-08-16T17:00:00.000Z', 'UTC')!

    editor.update(
      () => {
        const list = $createListNode('check')
        const parent = $createListItemNode(false)
        parent.append($createTextNode('Parent'))
        list.append(parent)
        $getRoot().append(list)
        $setChecklistSchedule(parent, PARENT_DUE_AT, daily)

        const child = appendChild(parent, 'Child', true)
        const grandchild = appendChild(child, 'Grandchild', true)
        $setChecklistSchedule(grandchild, '2026-08-16T17:00:00.000Z', weekly)
        grandchild.setChecked(true)
      },
      { discrete: true },
    )

    const updatesBefore = updates.length
    editor.update(
      () => {
        const parent = $getRoot().getFirstChild<ListNode>()!.getFirstChild<ListItemNode>()!
        const descendants = $getChecklistDescendantItems(parent)
        expect(descendants).toHaveLength(2)
        expect(descendants.map((item) => item.getTextContent().slice(0, 5))).toEqual(['Child', 'Grand'])
        expect(descendants.every((item) => item.getChecked())).toBe(true)

        expect($propagateChecklistRecurrenceToDescendants(parent, NEXT_DUE_AT, daily, COMPLETED_AT)).toBe(2)

        const [child, grandchild] = descendants
        expect(child.getChecked()).toBe(false)
        expect($getChecklistDueAt(child)).toBe(NEXT_DUE_AT)
        expect($getChecklistRecurrence(child)).toMatchObject({ frequency: 'daily' })
        expect(grandchild.getChecked()).toBe(false)
        expect($getChecklistDueAt(grandchild)).toBe('2026-08-23T17:00:00.000Z')
        expect($getChecklistRecurrence(grandchild)).toEqual(weekly)

        // Rolling the same occurrence again must not compound either schedule.
        expect($propagateChecklistRecurrenceToDescendants(parent, NEXT_DUE_AT, daily, COMPLETED_AT)).toBe(0)
        expect($getChecklistDueAt(child)).toBe(NEXT_DUE_AT)
        expect($getChecklistDueAt(grandchild)).toBe('2026-08-23T17:00:00.000Z')
      },
      { discrete: true },
    )

    // A whole subtree is one undoable step, not one per descendant.
    expect(updates.length - updatesBefore).toBe(1)
  })

  it('advances a nested recurring task once when a bulk action completes it alongside its parent', () => {
    const editor = createEditor()

    editor.update(
      () => {
        const list = $createListNode('check')
        const parent = $createListItemNode(false)
        parent.append($createTextNode('Parent'))
        list.append(parent)
        $getRoot().append(list)
        $setChecklistSchedule(parent, PARENT_DUE_AT, daily)

        const child = appendChild(parent, 'Child')
        $setChecklistSchedule(child, PARENT_DUE_AT, daily)
        appendChild(child, 'Grandchild')
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const parent = $getRoot().getFirstChild<ListNode>()!.getFirstChild<ListItemNode>()!
        const rows = [parent, ...$getChecklistDescendantItems(parent)]
        $setCheckedForItems(rows, true, COMPLETED_AT)

        // One bulk action is one occurrence for the whole tree. A subtask must
        // not roll once for its parent and again for its own turn in the loop.
        expect(rows.map((row) => $getChecklistDueAt(row))).toEqual([NEXT_DUE_AT, NEXT_DUE_AT, NEXT_DUE_AT])
        expect(rows.some((row) => row.getChecked())).toBe(false)

        // Twice over must not drift the levels apart.
        $setCheckedForItems(rows, true, Date.parse('2026-08-17T10:00:00.000Z'))
        expect(rows.map((row) => $getChecklistDueAt(row))).toEqual([
          '2026-08-18T09:00:00.000Z',
          '2026-08-18T09:00:00.000Z',
          '2026-08-18T09:00:00.000Z',
        ])
      },
      { discrete: true },
    )
  })

  it('reproduces the subtasks when the user simply ticks a recurring parent', () => {
    const editor = createEditor()
    const updates: number[] = []
    editor.registerUpdateListener(() => {
      updates.push(1)
    })

    editor.update(
      () => {
        const list = $createListNode('check')
        const parent = $createListItemNode(false)
        parent.append($createTextNode('Water the plants'))
        list.append(parent)
        $getRoot().append(list)
        $setChecklistSchedule(parent, PARENT_DUE_AT, daily)

        const child = appendChild(parent, 'Front room', true)
        appendChild(child, 'Fern', true)
      },
      { discrete: true },
    )

    const updatesBefore = updates.length
    editor.update(
      () => {
        const parent = $getRoot().getFirstChild<ListNode>()!.getFirstChild<ListItemNode>()!
        // Exactly what clicking the checkbox does, via the canonical mutation.
        expect($toggleChecklistItemChecked(parent, COMPLETED_AT)).toBe(true)

        const rows = [parent, ...$getChecklistDescendantItems(parent)]
        expect(rows).toHaveLength(3)
        expect(rows.map((row) => $getChecklistDueAt(row))).toEqual([NEXT_DUE_AT, NEXT_DUE_AT, NEXT_DUE_AT])
        expect(rows.every((row) => $getChecklistRecurrence(row) !== undefined)).toBe(true)
        expect(rows.some((row) => row.getChecked())).toBe(false)
      },
      { discrete: true },
    )

    expect(updates.length - updatesBefore).toBe(1)
  })

  it('completes every subtask of an ordinary parent, which carries nothing with it', () => {
    const editor = createEditor()

    editor.update(
      () => {
        const list = $createListNode('check')
        const parent = $createListItemNode(false)
        parent.append($createTextNode('Pack'))
        list.append(parent)
        $getRoot().append(list)

        const child = appendChild(parent, 'Passport')
        appendChild(child, 'Boarding pass')
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const parent = $getRoot().getFirstChild<ListNode>()!.getFirstChild<ListItemNode>()!
        const rows = [parent, ...$getChecklistDescendantItems(parent)]
        $setCheckedForItems(rows, true, COMPLETED_AT)

        expect(rows.every((row) => row.getChecked())).toBe(true)
      },
      { discrete: true },
    )
  })

  it('completes the subtasks of a recurring row that has run out of occurrences', () => {
    const editor = createEditor()
    // A yearly rule anchored at the last supported year cannot roll again.
    const exhausted = createChecklistRecurrence('yearly', '9999-08-16T09:00:00.000Z', 'UTC')!

    editor.update(
      () => {
        const list = $createListNode('check')
        const parent = $createListItemNode(false)
        parent.append($createTextNode('Final'))
        list.append(parent)
        $getRoot().append(list)
        $setChecklistSchedule(parent, '9999-08-16T09:00:00.000Z', exhausted)

        appendChild(parent, 'Subtask')
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const parent = $getRoot().getFirstChild<ListNode>()!.getFirstChild<ListItemNode>()!
        const rows = [parent, ...$getChecklistDescendantItems(parent)]
        $setCheckedForItems(rows, true, Date.parse('9999-08-16T10:00:00.000Z'))

        // Nothing was carried, so the subtask must not be orphaned unchecked.
        expect(rows.every((row) => row.getChecked())).toBe(true)
        expect($getChecklistRecurrence(parent)).toBeUndefined()
      },
      { discrete: true },
    )
  })

  it('lands a mixed recurring/ordinary tree on one occurrence and never compounds', () => {
    const editor = createEditor()
    const weekly = createChecklistRecurrence('weekly', PARENT_DUE_AT, 'UTC')!

    editor.update(
      () => {
        const list = $createListNode('check')
        const parent = $createListItemNode(false)
        parent.append($createTextNode('Recurring parent'))
        list.append(parent)
        $getRoot().append(list)
        $setChecklistSchedule(parent, PARENT_DUE_AT, daily)

        // Ordinary middle row with a recurring row of its own beneath it.
        const child = appendChild(parent, 'Ordinary child')
        const grandchild = appendChild(child, 'Recurring grandchild')
        $setChecklistSchedule(grandchild, PARENT_DUE_AT, weekly)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const parent = $getRoot().getFirstChild<ListNode>()!.getFirstChild<ListItemNode>()!
        const rows = [parent, ...$getChecklistDescendantItems(parent)]
        $setCheckedForItems(rows, true, COMPLETED_AT)

        const [, child, grandchild] = rows
        expect($getChecklistDueAt(parent)).toBe(NEXT_DUE_AT)
        expect($getChecklistDueAt(child)).toBe(NEXT_DUE_AT)
        // The grandchild keeps its own weekly cadence, moved onto the cycle.
        expect($getChecklistDueAt(grandchild)).toBe('2026-08-23T09:00:00.000Z')
        expect($getChecklistRecurrence(grandchild)).toEqual(weekly)
        expect(rows.some((row) => row.getChecked())).toBe(false)

        // A second bulk action advances the tree together, never apart.
        $setCheckedForItems(rows, true, Date.parse('2026-08-17T10:00:00.000Z'))
        expect($getChecklistDueAt(parent)).toBe('2026-08-18T09:00:00.000Z')
        expect($getChecklistDueAt(child)).toBe('2026-08-18T09:00:00.000Z')
        expect($getChecklistDueAt(grandchild)).toBe('2026-08-23T09:00:00.000Z')
      },
      { discrete: true },
    )
  })

  it('walks nesting deeper than any recursive descent could and stops at the parser bound', () => {
    const editor = createEditor()
    const depth = 200

    editor.update(
      () => {
        const list = $createListNode('check')
        const parent = $createListItemNode(false)
        parent.append($createTextNode('Parent'))
        list.append(parent)
        $getRoot().append(list)

        let current = parent
        for (let level = 1; level <= depth; level += 1) {
          current = appendChild(current, `Level ${level}`, true)
        }
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const parent = $getRoot().getFirstChild<ListNode>()!.getFirstChild<ListItemNode>()!
        expect($getChecklistDescendantItems(parent)).toHaveLength(CHECKLIST_MAX_NESTING_DEPTH)
        expect($getChecklistDescendantItems(parent, 4)).toHaveLength(4)
        expect($propagateChecklistRecurrenceToDescendants(parent, NEXT_DUE_AT, daily, COMPLETED_AT)).toBe(
          CHECKLIST_MAX_NESTING_DEPTH,
        )
      },
      { discrete: true },
    )
  })
})
