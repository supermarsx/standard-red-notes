/**
 * Behaviour contract for the three checklist bulk-completion actions:
 * mark-all-completed, mark-selected-completed, mark-selected-not-completed.
 *
 * Covers the edge cases the actions are most likely to be pointed at in anger:
 * an empty checklist, an all-already-checked checklist, a mixed-state checklist,
 * a selection that spans non-checklist content, a selection with no checklist at
 * all, nested sub-checklists, Lexical's indentation "wrapper" rows, recurring
 * rows (which advance rather than close), and the single-undo-step guarantee.
 *
 * Note on fixtures: two adjacent check ListNodes are MERGED by @lexical/list's
 * same-type sibling transform, so any fixture that needs two distinct checklists
 * must separate them with a paragraph — exactly as a real note would.
 */
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { createHeadlessEditor } from '@lexical/headless'
import { createEmptyHistoryState, registerHistory } from '@lexical/history'
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  ElementNode,
  LexicalEditor,
  RangeSelection,
} from 'lexical'
import {
  $setChecklistDueAt,
  $setChecklistRecurrence,
  $setChecklistSchedule,
  $getChecklistDueAt,
  $getChecklistRecurrence,
} from '../Lexical/Nodes/ChecklistItemNode'
import { advanceChecklistDueAt, createChecklistRecurrence } from './checklistRecurrence'
import {
  $getSelectedCheckLists,
  $getSelectedChecklistItems,
  $selectionHasChecklistItems,
  $setCheckedForAllInSelectedLists,
  $setCheckedForSelection,
} from './ChecklistBulkCompletion'

/** A daily rule anchored on DAILY_DUE_AT, plus the occurrence it rolls to. */
const DAILY_DUE_AT = '2026-08-16T09:00:00.000Z'
const COMPLETED_AT = Date.parse('2026-08-16T10:00:00.000Z')
const dailyRule = () => createChecklistRecurrence('daily', DAILY_DUE_AT, 'UTC')!
const NEXT_DUE_AT = advanceChecklistDueAt(DAILY_DUE_AT, dailyRule(), COMPLETED_AT)!

const createEditor = () =>
  createHeadlessEditor({
    namespace: 'checklist-bulk-completion-test',
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error
    },
  })

/** Append a check list of `states` rows (each with one text node) to the root. */
const $appendCheckList = (states: boolean[], labelPrefix = 'task'): ListNode => {
  const list = $createListNode('check')
  states.forEach((checked, index) => {
    const item = $createListItemNode(checked)
    item.append($createTextNode(`${labelPrefix} ${index}`))
    list.append(item)
  })
  $getRoot().append(list)
  return list
}

const $appendParagraph = (text: string): ElementNode => {
  const paragraph = $createParagraphNode()
  paragraph.append($createTextNode(text))
  $getRoot().append(paragraph)
  return paragraph
}

/**
 * Nodes are re-read from the root inside every update rather than captured
 * across closures (Lexical forbids reusing node references between closures).
 */
const $block = (index: number): ElementNode => $getRoot().getChildren()[index] as ElementNode
const $rows = (listIndex: number): ListItemNode[] => $block(listIndex).getChildren() as ListItemNode[]

/** A range selection covering the text of the first..last given rows. */
const $selectText = (from: ElementNode, to: ElementNode): RangeSelection => {
  const selection = $createRangeSelection()
  const first = from.getFirstChild()!
  const last = to.getFirstChild()!
  selection.anchor.set(first.getKey(), 0, 'text')
  selection.focus.set(last.getKey(), last.getTextContent().length, 'text')
  return selection
}

/** A collapsed caret one character into a row's text. */
const $caretIn = (row: ElementNode): RangeSelection => {
  const selection = $createRangeSelection()
  const text = row.getFirstChild()!
  selection.anchor.set(text.getKey(), 1, 'text')
  selection.focus.set(text.getKey(), 1, 'text')
  return selection
}

/** Indent a subtask under `parent`: a nested check list holding one new row. */
const $appendSubtask = (parent: ListItemNode, text: string): ListItemNode => {
  const list = $createListNode('check')
  const item = $createListItemNode(false)
  item.append($createTextNode(text))
  list.append(item)
  parent.append(list)
  return item
}

/** The single subtask indented under `row`. */
const $subtaskOf = (row: ListItemNode): ListItemNode =>
  (row.getLastChild() as ListNode).getChildren()[0] as ListItemNode

const checkedStates = (list: ListNode): boolean[] =>
  list.getChildren().map((child) => Boolean((child as ListItemNode).getChecked()))

describe('checklist bulk completion — mark all items completed', () => {
  it('completes every row of the checklist the caret sits in, leaving other checklists alone', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $appendCheckList([false, true, false], 'a')
        $appendParagraph('divider')
        $appendCheckList([false, false], 'b')
      },
      { discrete: true },
    )

    editor.update(
      () => {
        // Two of the three rows in list A were open, so exactly two rows change.
        expect($setCheckedForAllInSelectedLists($caretIn($rows(0)[0]), true)).toBe(2)
        expect(checkedStates($block(0) as ListNode)).toEqual([true, true, true])
        expect(checkedStates($block(2) as ListNode)).toEqual([false, false])
      },
      { discrete: true },
    )
  })

  it('completes every checklist a multi-list selection spans', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $appendCheckList([false, false], 'a')
        $appendParagraph('divider')
        $appendCheckList([false, false], 'b')
      },
      { discrete: true },
    )

    editor.update(
      () => {
        // Selection starts in the LAST row of list A and ends in the FIRST row
        // of list B: both lists are touched, so both are completed in full.
        const selection = $selectText($rows(0)[1], $rows(2)[0])
        expect($setCheckedForAllInSelectedLists(selection, true)).toBe(4)
        expect(checkedStates($block(0) as ListNode)).toEqual([true, true])
        expect(checkedStates($block(2) as ListNode)).toEqual([true, true])
      },
      { discrete: true },
    )
  })

  it('is a no-op on an all-already-completed checklist', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $appendCheckList([true, true, true])
      },
      { discrete: true },
    )

    editor.update(
      () => {
        expect($setCheckedForAllInSelectedLists($caretIn($rows(0)[0]), true)).toBe(0)
        expect(checkedStates($block(0) as ListNode)).toEqual([true, true, true])
      },
      { discrete: true },
    )
  })

  it('is a no-op for an empty checklist (no rows to complete, no throw)', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $getRoot().append($createListNode('check'))
        $appendParagraph('after')
      },
      { discrete: true },
    )

    editor.update(
      () => {
        // The caret can only sit in the paragraph — an empty checklist has no
        // row to place it in — so nothing is touched and nothing throws.
        const selection = $caretIn($block(1))
        expect($selectionHasChecklistItems(selection)).toBe(false)
        expect($setCheckedForAllInSelectedLists(selection, true)).toBe(0)
      },
      { discrete: true },
    )
  })

  it('descends into the sub-list hanging off a row that also has its own text', () => {
    // The common shape once a user indents under a task: the parent row keeps
    // its text AND gains a nested list, so it is a real task with subtasks
    // rather than one of Lexical's structural wrapper rows.
    const editor = createEditor()
    editor.update(
      () => {
        const outer = $createListNode('check')
        const parent = $createListItemNode(false)
        parent.append($createTextNode('parent'))
        outer.append(parent)
        $getRoot().append(outer)

        const inner = $createListNode('check')
        const child = $createListItemNode(false)
        child.append($createTextNode('child'))
        inner.append(child)
        parent.append(inner)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        expect($setCheckedForAllInSelectedLists($caretIn($rows(0)[0]), true)).toBe(2)
        expect($rows(0)[0].getChecked()).toBe(true)
        const inner = $rows(0)[0].getLastChild() as ListNode
        expect((inner.getChildren()[0] as ListItemNode).getChecked()).toBe(true)
      },
      { discrete: true },
    )
  })

  it('descends into a nested sub-checklist and skips the wrapper row', () => {
    const editor = createEditor()
    editor.update(
      () => {
        const outer = $createListNode('check')
        const task = $createListItemNode(false)
        task.append($createTextNode('parent'))
        outer.append(task)

        // Lexical models indentation as a wrapper item whose only child is a list.
        const wrapper = $createListItemNode(false)
        const inner = $createListNode('check')
        const nestedTask = $createListItemNode(false)
        nestedTask.append($createTextNode('child'))
        inner.append(nestedTask)
        wrapper.append(inner)
        outer.append(wrapper)

        $getRoot().append(outer)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        // The parent task and the nested task change; the WRAPPER row is
        // structure, not a task, and must stay untouched.
        expect($setCheckedForAllInSelectedLists($caretIn($rows(0)[0]), true)).toBe(2)
        expect($rows(0)[0].getChecked()).toBe(true)
        expect($rows(0)[1].getChecked()).toBeFalsy()
        const inner = $rows(0)[1].getFirstChild() as ListNode
        expect((inner.getChildren()[0] as ListItemNode).getChecked()).toBe(true)
      },
      { discrete: true },
    )
  })
})

describe('checklist bulk completion — selection scoped actions', () => {
  it('completes only the rows the selection touches', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $appendCheckList([false, false, false])
      },
      { discrete: true },
    )

    editor.update(
      () => {
        expect($setCheckedForSelection($selectText($rows(0)[0], $rows(0)[1]), true)).toBe(2)
        expect(checkedStates($block(0) as ListNode)).toEqual([true, true, false])
      },
      { discrete: true },
    )
  })

  it('treats a partial selection of one row as selecting that whole row', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $appendCheckList([false, false])
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const text = $rows(0)[0].getFirstChild()!
        const selection = $createRangeSelection()
        // Two characters in the middle of "task 0" — a task cannot be half done.
        selection.anchor.set(text.getKey(), 1, 'text')
        selection.focus.set(text.getKey(), 3, 'text')
        expect($setCheckedForSelection(selection, true)).toBe(1)
        expect(checkedStates($block(0) as ListNode)).toEqual([true, false])
      },
      { discrete: true },
    )
  })

  it('reopens only the selected rows of a fully completed list', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $appendCheckList([true, true, true])
      },
      { discrete: true },
    )

    editor.update(
      () => {
        expect($setCheckedForSelection($selectText($rows(0)[1], $rows(0)[2]), false)).toBe(2)
        expect(checkedStates($block(0) as ListNode)).toEqual([true, false, false])
      },
      { discrete: true },
    )
  })

  it('completes only the open rows of a mixed-state selection and reports the real count', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $appendCheckList([false, true, false, true])
      },
      { discrete: true },
    )

    editor.update(
      () => {
        expect($setCheckedForSelection($selectText($rows(0)[0], $rows(0)[3]), true)).toBe(2)
        expect(checkedStates($block(0) as ListNode)).toEqual([true, true, true, true])
      },
      { discrete: true },
    )
  })

  it('ignores non-checklist content inside the selection', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $appendParagraph('intro')
        const bullets = $createListNode('bullet')
        const bullet = $createListItemNode()
        bullet.append($createTextNode('bullet'))
        bullets.append(bullet)
        $getRoot().append(bullets)
        $appendCheckList([false, false])
      },
      { discrete: true },
    )

    editor.update(
      () => {
        // The selection runs from a paragraph, through a bulleted list, into the
        // checklist. Only the checklist rows may change.
        const selection = $selectText($block(0), $rows(2)[1])
        expect($setCheckedForSelection(selection, true)).toBe(2)
        expect(checkedStates($block(2) as ListNode)).toEqual([true, true])
        // The bulleted row has no check state and must not have gained one.
        expect(($block(1).getChildren()[0] as ListItemNode).getChecked()).toBeFalsy()
        expect($block(0).getTextContent()).toBe('intro')
      },
      { discrete: true },
    )
  })

  it('is a no-op when the selection contains no checklist at all', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $appendParagraph('just prose')
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const selection = $selectText($block(0), $block(0))
        expect($getSelectedChecklistItems(selection)).toEqual([])
        expect($getSelectedCheckLists(selection)).toEqual([])
        expect($selectionHasChecklistItems(selection)).toBe(false)
        expect($setCheckedForSelection(selection, true)).toBe(0)
        expect($setCheckedForAllInSelectedLists(selection, true)).toBe(0)
      },
      { discrete: true },
    )
  })

  it('treats a null selection as selecting nothing', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $appendCheckList([false, false])
        expect($getSelectedChecklistItems(null)).toEqual([])
        expect($selectionHasChecklistItems(null)).toBe(false)
        expect($setCheckedForSelection(null, true)).toBe(0)
        expect($setCheckedForAllInSelectedLists(null, true)).toBe(0)
        expect(checkedStates($block(0) as ListNode)).toEqual([false, false])
      },
      { discrete: true },
    )
  })

  it('reports a checklist selection so the toolbar can enable its buttons', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $appendCheckList([false, false])
        $appendParagraph('prose')
      },
      { discrete: true },
    )

    editor.update(
      () => {
        expect($selectionHasChecklistItems($caretIn($rows(0)[0]))).toBe(true)
        expect($selectionHasChecklistItems($caretIn($block(1)))).toBe(false)
      },
      { discrete: true },
    )
  })

  it('keeps a three-level recurring tree in lockstep across repeated bulk actions', () => {
    // The drift this guards against compounds: before the batch guard a
    // parent/child/grandchild landed on three consecutive days, and each further
    // bulk action pushed them a day further apart.
    const editor = createEditor()
    editor.update(
      () => {
        const outer = $createListNode('check')
        const parent = $createListItemNode(false).append($createTextNode('parent'))
        outer.append(parent)
        $getRoot().append(outer)
        $setChecklistSchedule(parent, DAILY_DUE_AT, dailyRule())

        const child = $appendSubtask(parent, 'child')
        $setChecklistSchedule(child, DAILY_DUE_AT, dailyRule())
        const grandchild = $appendSubtask(child, 'grandchild')
        $setChecklistSchedule(grandchild, DAILY_DUE_AT, dailyRule())
      },
      { discrete: true },
    )

    const dueDates = (): (string | undefined)[] => {
      const parent = $rows(0)[0]
      const child = $subtaskOf(parent)
      return [$getChecklistDueAt(parent), $getChecklistDueAt(child), $getChecklistDueAt($subtaskOf(child))]
    }

    editor.update(
      () => {
        $setCheckedForAllInSelectedLists($caretIn($rows(0)[0]), true, COMPLETED_AT)
        expect(dueDates()).toEqual([NEXT_DUE_AT, NEXT_DUE_AT, NEXT_DUE_AT])
      },
      { discrete: true },
    )

    editor.update(
      () => {
        // A second bulk action a day later must move the tree together again,
        // not spread it out.
        $setCheckedForAllInSelectedLists($caretIn($rows(0)[0]), true, Date.parse('2026-08-17T10:00:00Z'))
        const [first, second, third] = dueDates()
        expect(second).toBe(first)
        expect(third).toBe(first)
        expect(first).not.toBe(NEXT_DUE_AT)
      },
      { discrete: true },
    )
  })

  it('rolls a mixed recurring / non-recurring / recurring tree onto one occurrence', () => {
    const editor = createEditor()
    const weekly = createChecklistRecurrence('weekly', '2026-08-16T17:00:00.000Z', 'UTC')!
    editor.update(
      () => {
        const outer = $createListNode('check')
        const parent = $createListItemNode(false).append($createTextNode('parent'))
        outer.append(parent)
        $getRoot().append(outer)
        $setChecklistSchedule(parent, DAILY_DUE_AT, dailyRule())

        // Middle row has no schedule at all; the leaf carries its own rule.
        const child = $appendSubtask(parent, 'child')
        const grandchild = $appendSubtask(child, 'grandchild')
        $setChecklistSchedule(grandchild, '2026-08-16T17:00:00.000Z', weekly)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        $setCheckedForAllInSelectedLists($caretIn($rows(0)[0]), true, COMPLETED_AT)
        const parent = $rows(0)[0]
        const child = $subtaskOf(parent)
        const grandchild = $subtaskOf(child)

        expect($getChecklistDueAt(parent)).toBe(NEXT_DUE_AT)
        // The unscheduled middle row becomes due with the occurrence it belongs to.
        expect($getChecklistDueAt(child)).toBe(NEXT_DUE_AT)
        // The leaf keeps its OWN rule; only its deadline moves onto the new cycle.
        expect($getChecklistRecurrence(grandchild)).toEqual(weekly)
        expect($getChecklistDueAt(grandchild)).toBe('2026-08-23T17:00:00.000Z')
        // A rolled occurrence stays open all the way down.
        for (const row of [parent, child, grandchild]) {
          expect(row.getChecked()).toBeFalsy()
        }
      },
      { discrete: true },
    )
  })

  it('still completes the subtasks of a recurring row that cannot roll any further', () => {
    // A schedule at the supported calendar ceiling has no next occurrence, so
    // the row COMPLETES rather than advancing. It therefore carries nothing with
    // it, and its subtasks must be completed on their own — the case a
    // "skip descendants of anything recurring" guard would silently leave open.
    const editor = createEditor()
    const atCeiling = '9999-06-01T09:00:00.000Z'
    const yearly = createChecklistRecurrence('yearly', atCeiling, 'UTC')!
    editor.update(
      () => {
        const outer = $createListNode('check')
        const parent = $createListItemNode(false).append($createTextNode('parent'))
        outer.append(parent)
        $getRoot().append(outer)
        $setChecklistSchedule(parent, atCeiling, yearly)
        $appendSubtask(parent, 'child')
      },
      { discrete: true },
    )

    editor.update(
      () => {
        expect($setCheckedForAllInSelectedLists($caretIn($rows(0)[0]), true, Date.parse('9999-06-01T10:00:00Z'))).toBe(
          2,
        )
        const parent = $rows(0)[0]
        expect(parent.getChecked()).toBe(true)
        expect($subtaskOf(parent).getChecked()).toBe(true)
      },
      { discrete: true },
    )
  })

  it('rolls a recurring parent and its recurring subtask exactly one occurrence', () => {
    // A recurring row that ADVANCES carries its whole subtree onto that one new
    // occurrence. Without the batch guard the subtask would advance a second
    // time on its own turn in the loop, landing a day further out than its
    // parent, and would be re-closed after the parent reopened it.
    const editor = createEditor()
    editor.update(
      () => {
        const outer = $createListNode('check')
        const parent = $createListItemNode(false)
        parent.append($createTextNode('parent'))
        outer.append(parent)
        $getRoot().append(outer)
        $setChecklistSchedule(parent, DAILY_DUE_AT, dailyRule())

        const inner = $createListNode('check')
        const child = $createListItemNode(false)
        child.append($createTextNode('child'))
        inner.append(child)
        parent.append(inner)
        $setChecklistSchedule(child, DAILY_DUE_AT, dailyRule())
      },
      { discrete: true },
    )

    editor.update(
      () => {
        $setCheckedForAllInSelectedLists($caretIn($rows(0)[0]), true, COMPLETED_AT)
        const parent = $rows(0)[0]
        const child = (parent.getLastChild() as ListNode).getChildren()[0] as ListItemNode
        expect($getChecklistDueAt(parent)).toBe(NEXT_DUE_AT)
        expect($getChecklistDueAt(child)).toBe(NEXT_DUE_AT)
        // A rolled occurrence stays OPEN — nothing in the tree ends up checked.
        expect(parent.getChecked()).toBeFalsy()
        expect(child.getChecked()).toBeFalsy()
      },
      { discrete: true },
    )
  })

  it('does not let a NON-recurring parent stand in for completing its subtasks', () => {
    // Only an advance carries a subtree. A parent that merely closes leaves its
    // subtasks to be completed on their own.
    const editor = createEditor()
    editor.update(
      () => {
        const outer = $createListNode('check')
        const parent = $createListItemNode(false)
        parent.append($createTextNode('parent'))
        outer.append(parent)
        $getRoot().append(outer)

        const inner = $createListNode('check')
        const child = $createListItemNode(false)
        child.append($createTextNode('child'))
        inner.append(child)
        parent.append(inner)
      },
      { discrete: true },
    )

    editor.update(
      () => {
        expect($setCheckedForAllInSelectedLists($caretIn($rows(0)[0]), true, COMPLETED_AT)).toBe(2)
        const parent = $rows(0)[0]
        const child = (parent.getLastChild() as ListNode).getChildren()[0] as ListItemNode
        expect(parent.getChecked()).toBe(true)
        expect(child.getChecked()).toBe(true)
      },
      { discrete: true },
    )
  })

  it('advances a recurring row instead of closing it', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $appendCheckList([false, false])
        const recurring = $rows(0)[0]
        $setChecklistDueAt(recurring, '2026-08-01T09:00:00.000Z')
        $setChecklistRecurrence(recurring, createChecklistRecurrence('daily', '2026-08-01T09:00:00.000Z', 'UTC'))
      },
      { discrete: true },
    )

    editor.update(
      () => {
        const selection = $selectText($rows(0)[0], $rows(0)[1])
        expect($setCheckedForSelection(selection, true, Date.parse('2026-08-01T10:00:00Z'))).toBe(2)
        // The recurring row rolls to its next occurrence and stays OPEN — the
        // same outcome as clicking its checkbox. The plain row simply closes.
        expect($rows(0)[0].getChecked()).toBeFalsy()
        expect($getChecklistDueAt($rows(0)[0])).toBe('2026-08-02T09:00:00.000Z')
        expect($rows(0)[1].getChecked()).toBe(true)
      },
      { discrete: true },
    )
  })
})

describe('checklist bulk completion — undo granularity', () => {
  /** Commit a bulk action the way the toolbar does: inside ONE editor.update(). */
  const runBulk = (
    editor: LexicalEditor,
    apply: (selection: RangeSelection) => void,
    $selection: () => RangeSelection = () => $caretIn($rows(0)[0]),
  ) => {
    editor.update(
      () => {
        apply($selection())
      },
      { discrete: true },
    )
  }

  /** Every row of the first checklist, i.e. what a "select all" drag produces. */
  const $allRows = (): RangeSelection => $selectText($rows(0)[0], $rows(0)[$rows(0).length - 1])

  it('commits a whole bulk change as ONE editor state', () => {
    const editor = createEditor()
    editor.update(
      () => {
        $appendCheckList([false, false, false, false, false])
      },
      { discrete: true },
    )

    let updates = 0
    const unregister = editor.registerUpdateListener(() => {
      updates++
    })
    runBulk(editor, (selection) => {
      $setCheckedForAllInSelectedLists(selection, true)
    })
    unregister()

    // Five rows changed, but Lexical coalesces everything inside one update into
    // a single editor-state commit — the unit Lexical's history undoes.
    expect(updates).toBe(1)
    editor.getEditorState().read(() => {
      expect(checkedStates($block(0) as ListNode)).toEqual([true, true, true, true, true])
    })
  })

  it.each([
    [
      'mark all completed',
      (selection: RangeSelection) => $setCheckedForAllInSelectedLists(selection, true),
      false,
      // A collapsed caret is enough for the mark-all action.
      undefined as (() => RangeSelection) | undefined,
    ],
    [
      'mark selected completed',
      (selection: RangeSelection) => $setCheckedForSelection(selection, true),
      false,
      $allRows,
    ],
    [
      'mark selected not completed',
      (selection: RangeSelection) => $setCheckedForSelection(selection, false),
      true,
      $allRows,
    ],
  ])('pushes exactly one undo entry for %s across many rows', (_label, apply, initial, $selection) => {
    const editor = createEditor()
    const historyState = createEmptyHistoryState()
    const unregisterHistory = registerHistory(editor, historyState, 0)

    editor.update(
      () => {
        $appendCheckList([initial, initial, initial, initial, initial])
      },
      { discrete: true },
    )
    const before = historyState.undoStack.length

    runBulk(
      editor,
      (selection) => {
        // Sanity: the action really did mutate every row, so a per-row history
        // entry would have been visible as a jump of 5.
        expect(apply(selection)).toBe(5)
      },
      $selection,
    )
    unregisterHistory()

    expect(historyState.undoStack.length - before).toBe(1)
  })
})
