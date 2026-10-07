import { $createListItemNode, $createListNode, $isListNode, ListItemNode, ListNode } from '@lexical/list'
import { createHeadlessEditor } from '@lexical/headless'
import { $createTextNode, $getRoot, $isElementNode, LexicalNode } from 'lexical'
import {
  $getChecklistAncestorItems,
  $getChecklistDescendantItems,
  $getChecklistDueAt,
  $getChecklistItemText,
  $getChecklistOccurrenceSummary,
  $getChecklistRecurrence,
  $getChecklistRowSubtreeEnd,
  $isChecklistIndentWrapper,
  $isChecklistItemNode,
  $propagateChecklistRecurrenceToDescendants,
  $setChecklistOccurrenceSummary,
  $setChecklistSchedule,
  CHECKLIST_MAX_NESTING_DEPTH,
  CHECKLIST_OCCURRENCE_SUMMARY_VERSION,
} from '../Lexical/Nodes/ChecklistItemNode'
import {
  advanceChecklistDueAt,
  createChecklistRecurrence,
  propagatedChecklistDescendantSchedule,
} from './checklistRecurrence'
import { $setCheckedForItems } from './ChecklistBulkCompletion'
import { $toggleChecklistItemChecked } from './ChecklistEditorMutations'
import { $generateMissedChecklistOccurrences } from './checklistGeneration'

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

/** One seeded row: its label, how far it is indented, and its checkbox. */
type SeedRow = { text: string; indent?: number; checked?: boolean }

/**
 * Build one check list the way the EDITOR really builds it.
 *
 * Every row is appended flat and then indented with `ListItemNode.setIndent` —
 * the one API Tab, the toolbar's indent command and the markdown importer all
 * go through. Lexical's `$handleIndent` then moves the indented row into a new
 * list inside a new TEXT-LESS listitem, and inserts that wrapper as a SIBLING
 * of the row above. The sub-list is therefore NOT a child of its parent task.
 *
 * Nothing in this file may hand-build `{ listitem: [text, nestedList] }`. That
 * shape is not one Lexical produces, so a test written against it keeps passing
 * while the feature under test is dead on every real document — which is exactly
 * what happened here. `the shape Lexical actually builds` below is the guard
 * that keeps this helper honest.
 */
const $seedChecklist = (rows: SeedRow[]): ListItemNode[] => {
  const list = $createListNode('check')
  const created: ListItemNode[] = []
  for (const row of rows) {
    const item = $createListItemNode(false)
    item.append($createTextNode(row.text))
    list.append(item)
    created.push(item)
  }
  $getRoot().append(list)
  // Indent after the whole list exists: `setIndent` reads the row's siblings to
  // decide where the wrapper goes, exactly as it does when the user presses Tab.
  rows.forEach((row, index) => {
    if (row.indent) {
      created[index].setIndent(row.indent)
    }
  })
  // Checkboxes last: `$setChecklistSchedule` reopens a checked recurring row, so
  // a caller that schedules then checks would otherwise be fighting this helper.
  rows.forEach((row, index) => {
    if (row.checked) {
      created[index].setChecked(true)
    }
  })
  return created
}

/** The top-level list's first row — the parent task in every fixture here. */
const $firstRow = (): ListItemNode => ($getRoot().getFirstChild() as ListNode).getFirstChild() as ListItemNode

/** Every checkable row in the document, in document order. */
const $allTasks = (): ListItemNode[] => {
  const tasks: ListItemNode[] = []
  const stack: LexicalNode[] = [...$getRoot().getChildren()].reverse()
  while (stack.length > 0) {
    const node = stack.pop() as LexicalNode
    if ($isChecklistItemNode(node)) {
      tasks.push(node)
    }
    if ($isElementNode(node)) {
      const children = node.getChildren()
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index])
      }
    }
  }
  return tasks
}

/** Every listitem in the document, wrappers included, in document order. */
const $allRows = (): ListItemNode[] => {
  const rows: ListItemNode[] = []
  const stack: LexicalNode[] = [...$getRoot().getChildren()].reverse()
  while (stack.length > 0) {
    const node = stack.pop() as LexicalNode
    if (node instanceof ListItemNode) {
      rows.push(node)
    }
    if ($isElementNode(node)) {
      const children = node.getChildren()
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index])
      }
    }
  }
  return rows
}

const labels = (items: ListItemNode[]): string[] => items.map((item) => $getChecklistItemText(item))

describe('the shape Lexical actually builds', () => {
  it('hangs a sub-checklist off a text-less wrapper that is a SIBLING of the parent task', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $seedChecklist([{ text: 'Parent' }, { text: 'Child', indent: 1 }])
      },
      { discrete: true },
    )

    editor.read(() => {
      const list = $getRoot().getFirstChild() as ListNode
      const children = list.getChildren() as ListItemNode[]
      expect(children).toHaveLength(2)

      const [parent, wrapper] = children
      expect($getChecklistItemText(parent)).toBe('Parent')
      // The parent task carries NO list of its own. Anything that looks for a
      // sub-list among a row's children finds nothing on a real document.
      expect(parent.getChildren().some((child) => $isListNode(child))).toBe(false)

      // The second row is pure structure: no text, not a task, not checkable.
      expect($getChecklistItemText(wrapper)).toBe('')
      expect($isChecklistIndentWrapper(wrapper)).toBe(true)
      expect($isChecklistItemNode(wrapper)).toBe(false)
      expect(wrapper.getChildren().every((child) => $isListNode(child))).toBe(true)

      const child = (wrapper.getFirstChild() as ListNode).getFirstChild() as ListItemNode
      expect($getChecklistItemText(child)).toBe('Child')
      expect(child.getIndent()).toBe(1)
      // The parent task is not among the child's ANCESTOR NODES, which is why a
      // `getParent()` walk can never find it.
      let ancestor: LexicalNode | null = child.getParent()
      const ancestorKeys: string[] = []
      while (ancestor) {
        ancestorKeys.push(ancestor.getKey())
        ancestor = ancestor.getParent()
      }
      expect(ancestorKeys).not.toContain(parent.getKey())
      expect(ancestorKeys).toContain(wrapper.getKey())
    })
  })

  it('resolves descendants and ancestors through the wrapper at four levels, wrappers excluded', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $seedChecklist([
          { text: 'A' },
          { text: 'B', indent: 1 },
          { text: 'C', indent: 2 },
          { text: 'D', indent: 3 },
          { text: 'B2', indent: 1 },
          { text: 'A2' },
        ])
      },
      { discrete: true },
    )

    editor.read(() => {
      const byLabel = new Map(labels($allTasks()).map((text, index) => [text, $allTasks()[index]]))
      const descendants = (text: string) => labels($getChecklistDescendantItems(byLabel.get(text)!))
      const ancestors = (text: string) => labels($getChecklistAncestorItems(byLabel.get(text)!))

      // Document order, every level, nothing from a sibling branch.
      expect(descendants('A')).toEqual(['B', 'C', 'D', 'B2'])
      expect(descendants('B')).toEqual(['C', 'D'])
      expect(descendants('C')).toEqual(['D'])
      expect(descendants('D')).toEqual([])
      expect(descendants('B2')).toEqual([])
      expect(descendants('A2')).toEqual([])

      expect(ancestors('D')).toEqual(['C', 'B', 'A'])
      expect(ancestors('B2')).toEqual(['A'])
      expect(ancestors('A')).toEqual([])
      expect(ancestors('A2')).toEqual([])

      // Depth counts indent levels below the row, so `1` is its own children.
      expect(labels($getChecklistDescendantItems(byLabel.get('A')!, 1))).toEqual(['B', 'B2'])
      expect(labels($getChecklistDescendantItems(byLabel.get('A')!, 2))).toEqual(['B', 'C', 'B2'])
      expect(labels($getChecklistAncestorItems(byLabel.get('D')!, 1))).toEqual(['C'])
      expect($getChecklistDescendantItems(byLabel.get('A')!, 0)).toEqual([])

      // Three of the six listitems are wrappers, and not one of them is ever
      // returned as a task by either direction of the walk.
      const wrappers = $allRows().filter((row) => $isChecklistIndentWrapper(row))
      expect(wrappers).toHaveLength(3)
      const wrapperKeys = new Set(wrappers.map((row) => row.getKey()))
      for (const task of $allTasks()) {
        for (const related of [...$getChecklistDescendantItems(task), ...$getChecklistAncestorItems(task)]) {
          expect(wrapperKeys.has(related.getKey())).toBe(false)
        }
      }
    })
  })

  it('still finds a subtask indented two levels in one go, under no intermediate task', () => {
    const editor = createEditor()
    // Pressing Tab twice on the row under `T` leaves a wrapper holding nothing
    // but another wrapper: there is no task at the level in between.
    editor.update(
      () => {
        $seedChecklist([{ text: 'T' }, { text: 'B', indent: 2 }, { text: 'C', indent: 1 }])
      },
      { discrete: true },
    )

    editor.read(() => {
      const tasks = $allTasks()
      expect(labels(tasks)).toEqual(['T', 'B', 'C'])
      expect(labels($getChecklistDescendantItems(tasks[0]))).toEqual(['B', 'C'])
      expect(labels($getChecklistAncestorItems(tasks[1]))).toEqual(['T'])
      // The empty level is still a level: `B` is two indents down, so a cap of
      // one does not reach it while `C` at one indent is reached.
      expect(labels($getChecklistDescendantItems(tasks[0], 1))).toEqual(['C'])
      expect($getChecklistAncestorItems(tasks[1], 1)).toEqual([])
    })
  })

  it('reads every wrapper in the run, as an HTML paste can leave two side by side', () => {
    const editor = createEditor()
    // `$normalizeChildren` moves each nested list out of a pasted `<li>` into a
    // wrapper of its own, so one task can be followed by SEVERAL wrappers. All
    // of them are its subtree, and the climb back up has to see past them.
    editor.update(
      () => {
        const outer = $createListNode('check')
        const task = $createListItemNode(false)
        task.append($createTextNode('A'))
        outer.append(task)
        for (const text of ['X', 'Y']) {
          const wrapper = $createListItemNode(false)
          const inner = $createListNode('check')
          const row = $createListItemNode(false)
          row.append($createTextNode(text))
          inner.append(row)
          wrapper.append(inner)
          outer.append(wrapper)
        }
        $getRoot().append(outer)
      },
      { discrete: true },
    )

    editor.read(() => {
      const rows = ($getRoot().getFirstChild() as ListNode).getChildren() as ListItemNode[]
      expect(rows.map((row) => $isChecklistIndentWrapper(row))).toEqual([false, true, true])
      expect(labels($getChecklistDescendantItems(rows[0]))).toEqual(['X', 'Y'])
      const [, firstWrapper, secondWrapper] = rows
      const y = (secondWrapper.getFirstChild() as ListNode).getFirstChild() as ListItemNode
      // `Y` is behind TWO wrappers, so a climb that inspects only the wrapper's
      // immediate previous sibling finds another wrapper and gives up.
      expect(labels($getChecklistAncestorItems(y))).toEqual(['A'])

      // `A`'s subtree ends at the LAST wrapper of its run, so that is where a
      // new sibling row of `A` has to be inserted.
      expect($getChecklistRowSubtreeEnd(rows[0]).getKey()).toBe(secondWrapper.getKey())
      // A wrapper owns only what is inside it. The wrapper after it is another
      // of `A`'s subtrees, not one of this wrapper's — a run belongs to the task
      // that opened it, and treating a wrapper as the owner of the rest of the
      // run would nest two of `A`'s branches inside each other.
      expect($getChecklistRowSubtreeEnd(firstWrapper).getKey()).toBe(firstWrapper.getKey())
      expect($getChecklistRowSubtreeEnd(secondWrapper).getKey()).toBe(secondWrapper.getKey())
    })
  })

  it('treats an EMPTY leaf row as a task, never as an indent wrapper', () => {
    const editor = createEditor()
    // An empty row is where the user is about to type, so it is a task and can
    // own a subtree. Only a row whose children are ALL lists is structure.
    editor.update(
      () => {
        const outer = $createListNode('check')
        const first = $createListItemNode(false)
        first.append($createTextNode('A'))
        const blank = $createListItemNode(false)
        const indented = $createListItemNode(false)
        indented.append($createTextNode('B'))
        outer.append(first, blank, indented)
        $getRoot().append(outer)
        indented.setIndent(1)
      },
      { discrete: true },
    )

    editor.read(() => {
      const rows = ($getRoot().getFirstChild() as ListNode).getChildren() as ListItemNode[]
      const [first, blank, wrapper] = rows
      expect(blank.getChildrenSize()).toBe(0)
      expect($isChecklistIndentWrapper(blank)).toBe(false)
      expect($isChecklistItemNode(blank)).toBe(true)
      expect($isChecklistIndentWrapper(wrapper)).toBe(true)

      // `B` was indented under the BLANK row, which is the row above it. Reading
      // the blank row as structure would hand `B` to `A` instead.
      expect($getChecklistDescendantItems(first)).toEqual([])
      expect(labels($getChecklistDescendantItems(blank))).toEqual(['B'])
      const b = (wrapper.getFirstChild() as ListNode).getFirstChild() as ListItemNode
      expect($getChecklistAncestorItems(b).map((row) => row.getKey())).toEqual([blank.getKey()])
    })
  })

  it('is the exact inverse of itself at every depth cap, on nesting no UI would produce', () => {
    const editor = createEditor()
    const DEPTH = 400
    editor.update(
      () => {
        $seedChecklist(Array.from({ length: DEPTH }, (_, index) => ({ text: `r${index}`, indent: index })))
      },
      { discrete: true },
    )

    editor.read(() => {
      const tasks = $allTasks()
      expect(tasks).toHaveLength(DEPTH)
      expect(tasks[DEPTH - 1].getIndent()).toBe(DEPTH - 1)

      // Iterative and bounded: 400 levels is far past anything the UI makes and
      // past the parser's own 128-level bound, and nothing here recurses.
      expect($getChecklistDescendantItems(tasks[0])).toHaveLength(CHECKLIST_MAX_NESTING_DEPTH)
      expect($getChecklistAncestorItems(tasks[DEPTH - 1])).toHaveLength(CHECKLIST_MAX_NESTING_DEPTH)
      expect($getChecklistDescendantItems(tasks[0], 4)).toHaveLength(4)

      // `t` is an ancestor of `r` exactly when `r` is a descendant of `t`, for
      // the SAME cap — which is what lets the completion path trust that a row
      // reported as "beneath something advanced" really was carried forward.
      for (const cap of [1, 2, 4, CHECKLIST_MAX_NESTING_DEPTH, 1000]) {
        const descendantKeys = new Map(
          tasks.map((task) => [
            task.getKey(),
            new Set($getChecklistDescendantItems(task, cap).map((row) => row.getKey())),
          ]),
        )
        let mismatches = 0
        for (const row of tasks) {
          const ancestorKeys = new Set($getChecklistAncestorItems(row, cap).map((item) => item.getKey()))
          for (const task of tasks) {
            if (descendantKeys.get(task.getKey())!.has(row.getKey()) !== ancestorKeys.has(task.getKey())) {
              mismatches += 1
            }
          }
        }
        expect(mismatches).toBe(0)
      }
    })
  })
})

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
        const [parent, , grandchild] = $seedChecklist([
          { text: 'Parent' },
          { text: 'Child', indent: 1, checked: true },
          { text: 'Grandchild', indent: 2, checked: true },
        ])
        $setChecklistSchedule(parent, PARENT_DUE_AT, daily)
        $setChecklistSchedule(grandchild, '2026-08-16T17:00:00.000Z', weekly)
        grandchild.setChecked(true)
      },
      { discrete: true },
    )

    const updatesBefore = updates.length
    editor.update(
      () => {
        const parent = $firstRow()
        const descendants = $getChecklistDescendantItems(parent)
        expect(descendants).toHaveLength(2)
        expect(labels(descendants)).toEqual(['Child', 'Grandchild'])
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

  it('never turns an occurrence-summary record indented under the row into an occurrence', () => {
    const editor = createEditor()
    editor.update(
      () => {
        const [parent, record] = $seedChecklist([
          { text: 'Parent' },
          { text: '3 earlier occurrences were not listed', indent: 1, checked: true },
          { text: 'Real subtask', indent: 1, checked: true },
        ])
        $setChecklistSchedule(parent, PARENT_DUE_AT, daily)
        expect(
          $setChecklistOccurrenceSummary(record, {
            version: CHECKLIST_OCCURRENCE_SUMMARY_VERSION,
            missedCount: 3,
            oldestMissedAt: '2026-05-16T09:00:00.000Z',
            newestMissedAt: '2026-07-16T09:00:00.000Z',
          }),
        ).toBeDefined()
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const parent = $firstRow()
        const [record, subtask] = $getChecklistDescendantItems(parent)
        // Only the real subtask is carried: a record is one row, not two.
        expect($propagateChecklistRecurrenceToDescendants(parent, NEXT_DUE_AT, daily, COMPLETED_AT)).toBe(1)

        // A record stays a record. It owes its "cannot be mistaken for an
        // occurrence" property to having no deadline and no rule, so writing
        // this occurrence's schedule onto it would destroy exactly that.
        expect($getChecklistOccurrenceSummary(record)?.missedCount).toBe(3)
        expect($getChecklistDueAt(record)).toBeUndefined()
        expect($getChecklistRecurrence(record)).toBeUndefined()
        expect(record.getChecked()).toBe(true)

        expect($getChecklistDueAt(subtask)).toBe(NEXT_DUE_AT)
        expect(subtask.getChecked()).toBe(false)
      },
      { discrete: true },
    )
  })

  it('advances a nested recurring task once when a bulk action completes it alongside its parent', () => {
    const editor = createEditor()

    editor.update(
      () => {
        const [parent, child] = $seedChecklist([
          { text: 'Parent' },
          { text: 'Child', indent: 1 },
          { text: 'Grandchild', indent: 2 },
        ])
        $setChecklistSchedule(parent, PARENT_DUE_AT, daily)
        $setChecklistSchedule(child, PARENT_DUE_AT, daily)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const parent = $firstRow()
        const rows = [parent, ...$getChecklistDescendantItems(parent)]
        expect(labels(rows)).toEqual(['Parent', 'Child', 'Grandchild'])
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

  it('suppresses a whole four-level subtree behind the one row that advanced', () => {
    const editor = createEditor()
    editor.update(
      () => {
        const [parent] = $seedChecklist([
          { text: 'Parent' },
          { text: 'B', indent: 1 },
          { text: 'C', indent: 2 },
          { text: 'D', indent: 3 },
          { text: 'Sibling' },
        ])
        $setChecklistSchedule(parent, PARENT_DUE_AT, daily)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const parent = $firstRow()
        const rows = $allTasks()
        expect(labels(rows)).toEqual(['Parent', 'B', 'C', 'D', 'Sibling'])

        // Two rows changed, not five: the parent (which advanced) and `Sibling`.
        // B, C and D were skipped outright, so they contribute nothing.
        expect($setCheckedForItems(rows, true, COMPLETED_AT)).toBe(2)
        // The parent advanced and so stands in for its subtree: B, C and D were
        // reopened onto the new occurrence by the propagation and must NOT then
        // be completed in their own turn of the loop.
        expect($getChecklistDueAt(parent)).toBe(NEXT_DUE_AT)
        expect(parent.getChecked()).toBe(false)
        for (const row of rows.slice(1, 4)) {
          expect(row.getChecked()).toBe(false)
          expect($getChecklistDueAt(row)).toBe(NEXT_DUE_AT)
        }
        // `Sibling` is not beneath the parent, so it is completed normally.
        expect(rows[4].getChecked()).toBe(true)
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
        const [parent] = $seedChecklist([
          { text: 'Water the plants' },
          { text: 'Front room', indent: 1, checked: true },
          { text: 'Fern', indent: 2, checked: true },
        ])
        $setChecklistSchedule(parent, PARENT_DUE_AT, daily)
      },
      { discrete: true },
    )

    const updatesBefore = updates.length
    editor.update(
      () => {
        const parent = $firstRow()
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
        $seedChecklist([{ text: 'Pack' }, { text: 'Passport', indent: 1 }, { text: 'Boarding pass', indent: 2 }])
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const parent = $firstRow()
        const rows = [parent, ...$getChecklistDescendantItems(parent)]
        expect(rows).toHaveLength(3)
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
        const [parent] = $seedChecklist([{ text: 'Final' }, { text: 'Subtask', indent: 1 }])
        $setChecklistSchedule(parent, '9999-08-16T09:00:00.000Z', exhausted)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const parent = $firstRow()
        const rows = [parent, ...$getChecklistDescendantItems(parent)]
        expect(rows).toHaveLength(2)
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
        // Ordinary middle row with a recurring row of its own beneath it.
        const [parent, , grandchild] = $seedChecklist([
          { text: 'Recurring parent' },
          { text: 'Ordinary child', indent: 1 },
          { text: 'Recurring grandchild', indent: 2 },
        ])
        $setChecklistSchedule(parent, PARENT_DUE_AT, daily)
        $setChecklistSchedule(grandchild, PARENT_DUE_AT, weekly)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const parent = $firstRow()
        const rows = [parent, ...$getChecklistDescendantItems(parent)]
        expect(labels(rows)).toEqual(['Recurring parent', 'Ordinary child', 'Recurring grandchild'])
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
    const depth = 400

    editor.update(
      () => {
        const rows = $seedChecklist([
          { text: 'Parent' },
          ...Array.from({ length: depth }, (_, index) => ({
            text: `Level ${index + 1}`,
            indent: index + 1,
            checked: true,
          })),
        ])
        expect(rows).toHaveLength(depth + 1)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const parent = $firstRow()
        expect($getChecklistDescendantItems(parent)).toHaveLength(CHECKLIST_MAX_NESTING_DEPTH)
        expect($getChecklistDescendantItems(parent, 4)).toHaveLength(4)
        expect($propagateChecklistRecurrenceToDescendants(parent, NEXT_DUE_AT, daily, COMPLETED_AT)).toBe(
          CHECKLIST_MAX_NESTING_DEPTH,
        )
        // Beyond the bound nothing was touched, and nothing threw on the way.
        expect($allTasks()).toHaveLength(depth + 1)
        expect($getChecklistDueAt($allTasks()[CHECKLIST_MAX_NESTING_DEPTH + 1])).toBeUndefined()
      },
      { discrete: true },
    )
  })
})

/**
 * The generation pass rolls a live row forward, and that roll carries the row's
 * subtree with it — the same propagation the completion path uses. Two routes into
 * one mechanism is exactly where a subtask could advance twice for one parent
 * occurrence, so this is the guard for it: generation must be worth exactly one
 * occurrence to a subtree, and must not leave the subtree somewhere a later
 * completion then advances from again.
 */
const MONTHLY_DUE_AT = '2027-01-15T09:00:00.000Z'
const GENERATION_NOW = Date.parse('2027-03-20T12:00:00.000Z')
const monthly = createChecklistRecurrence('monthly', MONTHLY_DUE_AT, 'UTC')!
const GENERATION_SETTINGS = { autoGenerate: true, cap: 12 }

describe('generation and completion do not compound on a subtree', () => {
  const seed = () => {
    const editor = createEditor()
    editor.update(
      () => {
        const [parent] = $seedChecklist([{ text: 'quarterly review' }, { text: 'collect the numbers', indent: 1 }])
        $setChecklistSchedule(parent, MONTHLY_DUE_AT, monthly)
      },
      { discrete: true },
    )
    return editor
  }

  const $parent = (): ListItemNode => $firstRow()
  const $subtask = (): ListItemNode => $getChecklistDescendantItems($parent())[0]

  it('keeps the subtree attached to the live row and writes the occurrences below it', () => {
    const editor = seed()
    editor.update(
      () => {
        $generateMissedChecklistOccurrences(GENERATION_SETTINGS, GENERATION_NOW)

        // The top-level list is: the live row, the wrapper holding its subtree,
        // then the generated occurrences. A generated row inserted directly
        // after the live row would sit BETWEEN the row and its wrapper and would
        // take ownership of the subtree — the live row would be left with no
        // descendants at all, and the user's subtask would appear indented under
        // a generated occurrence.
        const children = ($getRoot().getFirstChild() as ListNode).getChildren() as ListItemNode[]
        expect(children.map((row) => $getChecklistItemText(row))).toEqual([
          'quarterly review',
          '',
          'quarterly review',
          'quarterly review',
          'quarterly review',
        ])
        expect($isChecklistIndentWrapper(children[1])).toBe(true)
        expect(labels($getChecklistDescendantItems($parent()))).toEqual(['collect the numbers'])
        for (const generated of children.slice(2)) {
          expect($getChecklistDescendantItems(generated)).toEqual([])
          expect(labels($getChecklistAncestorItems(generated))).toEqual([])
        }
        expect(labels($getChecklistAncestorItems($subtask()))).toEqual(['quarterly review'])
        expect($getChecklistAncestorItems($subtask())[0].getKey()).toBe($parent().getKey())
      },
      { discrete: true },
    )
  })

  it('advances a subtask exactly one occurrence for one generation pass', () => {
    const editor = seed()
    editor.update(
      () => {
        $generateMissedChecklistOccurrences(GENERATION_SETTINGS, GENERATION_NOW)
        // One occurrence forward — not one per occurrence the pass wrote out.
        expect($getChecklistDueAt($parent())).toBe('2027-04-15T09:00:00.000Z')
        expect($getChecklistDueAt($subtask())).toBe('2027-04-15T09:00:00.000Z')
        // The subtree gained exactly one row — the one it already had. A pass
        // that treated the just-propagated subtask as its own overdue candidate
        // would have written a second set of occurrences inside it.
        expect($getChecklistDescendantItems($parent())).toHaveLength(1)
        // The live row, the wrapper holding its one subtask, and three written
        // occurrences — the subtask is NOT a top-level row.
        expect(($getRoot().getFirstChild() as ListNode).getChildren()).toHaveLength(5)
      },
      { discrete: true },
    )
  })

  it('does not move the subtask again on a second pass', () => {
    const editor = seed()
    editor.update(() => $generateMissedChecklistOccurrences(GENERATION_SETTINGS, GENERATION_NOW), { discrete: true })
    editor.update(
      () => {
        // The live row is in the future now, so there is nothing to enumerate and
        // nothing to propagate. The propagation itself is also idempotent against
        // the same occurrence, so even reaching it would be a no-op.
        expect($generateMissedChecklistOccurrences(GENERATION_SETTINGS, GENERATION_NOW)).toMatchObject({ tasks: 0 })
        expect($getChecklistDueAt($subtask())).toBe('2027-04-15T09:00:00.000Z')
      },
      { discrete: true },
    )
  })

  it('leaves the subtree where exactly one later completion advances it once', () => {
    const editor = seed()
    editor.update(() => $generateMissedChecklistOccurrences(GENERATION_SETTINGS, GENERATION_NOW), { discrete: true })
    editor.update(
      () => {
        // The user ticks the rolled-forward row on its new due date.
        $toggleChecklistItemChecked($parent(), Date.parse('2027-04-15T10:00:00.000Z'))
        expect($getChecklistDueAt($parent())).toBe('2027-05-15T09:00:00.000Z')
        expect($getChecklistDueAt($subtask())).toBe('2027-05-15T09:00:00.000Z')
      },
      { discrete: true },
    )
  })

  it('gives a generated occurrence no subtree to propagate into', () => {
    const editor = seed()
    editor.update(
      () => {
        $generateMissedChecklistOccurrences(GENERATION_SETTINGS, GENERATION_NOW)
        const generated = (($getRoot().getFirstChild() as ListNode).getChildren() as ListItemNode[]).slice(2)
        expect(generated).toHaveLength(3)
        for (const row of generated) {
          // No rule and nothing beneath it: propagation can never be reached
          // from here, which keeps exactly one rule in play for the subtree.
          expect($getChecklistRecurrence(row)).toBeUndefined()
          expect(row.getChildren().filter((child) => $isListNode(child))).toHaveLength(0)
          expect($getChecklistDescendantItems(row)).toEqual([])
        }
      },
      { discrete: true },
    )
  })
})
