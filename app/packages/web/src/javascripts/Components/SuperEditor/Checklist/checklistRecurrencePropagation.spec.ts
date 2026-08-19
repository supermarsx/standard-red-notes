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
