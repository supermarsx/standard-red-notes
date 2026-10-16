import { createEmptyHistoryState, registerHistory } from '@lexical/history'
import { createHeadlessEditor } from '@lexical/headless'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { $createHeadingNode, HeadingNode } from '@lexical/rich-text'
import {
  $createTextNode,
  $createParagraphNode,
  $getRoot,
  $createRangeSelection,
  $setSelection,
  $getSelection,
} from 'lexical'
import { $organizeCompletedTasks } from './ChecklistTaskOrganization'
import {
  $setChecklistFlags,
  $getChecklistFlags,
  $setChecklistTodoId,
  $getChecklistTodoId,
} from '../Lexical/Nodes/ChecklistItemNode'
import { $setChecklistPerPerson, $setChecklistPersonalTick, $getChecklistPersonalTicks } from './checklistPersonalTicks'
const editor = () =>
  createHeadlessEditor({
    namespace: 'task-organization',
    nodes: [ListNode, ListItemNode, HeadingNode],
    onError: (error) => {
      throw error
    },
  })
const task = (name: string, checked = false) => $createListItemNode(checked).append($createTextNode(name))
const heading = (name: string, tag: 'h2' | 'h3' = 'h2') => $createHeadingNode(tag).append($createTextNode(name))
function range(start: ListItemNode, end = start) {
  const selection = $createRangeSelection()
  selection.anchor.set(start.getFirstChildOrThrow().getKey(), 0, 'text')
  selection.focus.set(end.getFirstChildOrThrow().getKey(), end.getFirstChildOrThrow().getTextContentSize(), 'text')
  $setSelection(selection)
  return selection
}
const names = (list: ListNode) => list.getChildren().map((node) => node.getTextContent())

it('stable-partitions only selected task slots and preserves original metadata and node identity', () => {
  const instance = editor()
  instance.update(
    () => {
      const done = task('done', true),
        open = task('open'),
        untouched = task('untouched', true)
      const list = $createListNode('check').append(untouched, done, open)
      $getRoot().append(list)
      $setChecklistTodoId(done, 'persistent-todo')
      $setChecklistFlags(done, { pinned: true, priority: 'high' })
      const originalKey = done.getKey()
      expect($organizeCompletedTasks(range(done, open), 'selection')).toBe(2)
      expect(names(list)).toEqual(['untouched', 'open', 'done'])
      expect(done.getKey()).toBe(originalKey)
      expect($getChecklistTodoId(done)).toBe('persistent-todo')
      expect($getChecklistFlags(done)).toMatchObject({ pinned: true, priority: 'high' })
      expect($organizeCompletedTasks($getSelection(), 'selection')).toBe(0)
    },
    { discrete: true },
  )
})

it('organizes the current heading section including lower headings, but never crosses its next peer heading', () => {
  const instance = editor()
  instance.update(
    () => {
      const first = $createListNode('check').append(task('done', true), task('open'))
      const nestedSection = $createListNode('check').append(task('child done', true), task('child open'))
      const next = $createListNode('check').append(task('next done', true), task('next open'))
      $getRoot().append(heading('Current'), first, heading('Subsection', 'h3'), nestedSection, heading('Next'), next)
      $organizeCompletedTasks(range(first.getFirstChild() as ListItemNode), 'section')
      expect(names(first)).toEqual(['open'])
      expect(names(nestedSection)).toEqual(['child open', 'done', 'child done'])
      expect(names(next)).toEqual(['next done', 'next open'])
    },
    { discrete: true },
  )
})

it('moves completed task and its indentation wrapper together without recreating nested tasks', () => {
  const instance = editor()
  instance.update(
    () => {
      const done = task('done', true),
        child = task('nested open')
      const nested = $createListNode('check').append(child)
      const wrapper = $createListItemNode().append(nested)
      const list = $createListNode('check').append(done, wrapper, task('open'))
      $getRoot().append(heading('Tasks'), list)
      const childKey = child.getKey()
      $organizeCompletedTasks(range(done), 'section')
      expect(list.getChildren().map((node) => node.getKey())).toEqual([
        list.getFirstChild()!.getKey(),
        done.getKey(),
        wrapper.getKey(),
      ])
      expect(list.getFirstChild()!.getTextContent()).toBe('open')
      expect(nested.getFirstChild()!.getKey()).toBe(childKey)
    },
    { discrete: true },
  )
})

it('never treats personal ticks as globally complete, including malformed old shared checked state', () => {
  const instance = editor()
  instance.update(
    () => {
      const personal = task('personal'),
        done = task('done', true)
      const list = $createListNode('check').append(done, personal, task('open'))
      $getRoot().append(list)
      $setChecklistPerPerson(personal, true)
      $setChecklistPersonalTick(personal, 'person-1', true)
      personal.setChecked(true)
      $organizeCompletedTasks(range(done, list.getLastChild() as ListItemNode), 'selection')
      expect(names(list)).toEqual(['personal', 'open', 'done'])
      expect($getChecklistPersonalTicks(personal)).toEqual(['person-1'])
      $organizeCompletedTasks(range(personal), 'completed-section')
      expect(personal.getParent()!.getKey()).toBe(list.getKey())
    },
    { discrete: true },
  )
})

it('collects section completions in one reusable destination, preserving order and open tasks', () => {
  const instance = editor()
  instance.update(
    () => {
      const one = task('done one', true),
        two = task('done two', true),
        open = task('open')
      const list = $createListNode('check').append(one, open, two)
      $getRoot().append(heading('Tasks'), list)
      expect($organizeCompletedTasks(range(one), 'completed-section')).toBe(2)
      expect(names(list)).toEqual(['open'])
      const destination = $getRoot().getLastChild() as ListNode
      expect(names(destination)).toEqual(['done one', 'done two'])
      expect(
        $getRoot()
          .getChildren()
          .filter((node) => node.getTextContent() === 'Completed tasks'),
      ).toHaveLength(1)
      open.setChecked(true)
      expect($organizeCompletedTasks(range(open), 'completed-section')).toBe(1)
      expect(names(destination)).toEqual(['done one', 'done two', 'open'])
      expect(list.isAttached()).toBe(false)
    },
    { discrete: true },
  )
})

it('does not duplicate completed children when moving their completed parent subtree', () => {
  const instance = editor()
  instance.update(
    () => {
      const parent = task('parent', true),
        child = task('child', true)
      const wrapper = $createListItemNode().append($createListNode('check').append(child))
      const list = $createListNode('check').append(parent, wrapper)
      $getRoot().append(heading('Tasks'), list)
      expect($organizeCompletedTasks(range(parent), 'completed-section')).toBe(1)
      const target = $getRoot().getLastChild() as ListNode
      expect(target.getChildren()).toHaveLength(2)
      expect(child.getParent()!.getParent()!.getKey()).toBe(wrapper.getKey())
    },
    { discrete: true },
  )
})

it('does not create a destination for no completed tasks or an absent selection', () => {
  const instance = editor()
  instance.update(
    () => {
      const open = task('open')
      $getRoot().append($createListNode('check').append(open))
      expect($organizeCompletedTasks(null, 'section')).toBe(0)
      expect($organizeCompletedTasks(range(open), 'completed-section')).toBe(0)
      expect($getRoot().getChildren()).toHaveLength(1)
    },
    { discrete: true },
  )
})

it('sinks section completions below intervening prose and creates a final checklist before the next heading', () => {
  const instance = editor()
  instance.update(
    () => {
      const done = task('done', true),
        open = task('open')
      const list = $createListNode('check').append(done, open)
      const prose = $createParagraphNode().append($createTextNode('Keep this prose'))
      const next = heading('Next')
      $getRoot().append(heading('Current'), list, prose, next)
      $organizeCompletedTasks(range(done), 'section')
      expect(names(list)).toEqual(['open'])
      const destination = prose.getNextSibling() as ListNode
      expect(names(destination)).toEqual(['done'])
      expect(destination.getNextSibling()!.getKey()).toBe(next.getKey())
      expect(prose.getTextContent()).toBe('Keep this prose')
    },
    { discrete: true },
  )
})

it('sinks selected completions across lists while leaving unselected ends and prose in place', () => {
  const instance = editor()
  instance.update(
    () => {
      const prefix = task('untouched prefix', true),
        done = task('selected done', true)
      const first = $createListNode('check').append(prefix, done)
      const prose = $createParagraphNode().append($createTextNode('Middle prose'))
      const open = task('selected open'),
        suffix = task('untouched suffix')
      const last = $createListNode('check').append(open, suffix)
      $getRoot().append(first, prose, last)
      $organizeCompletedTasks(range(done, open), 'selection')
      expect(names(first)).toEqual(['untouched prefix'])
      expect(names(last)).toEqual(['selected open', 'selected done', 'untouched suffix'])
      expect(first.getNextSibling()!.getKey()).toBe(prose.getKey())
      expect(prose.getNextSibling()!.getKey()).toBe(last.getKey())
    },
    { discrete: true },
  )
})

it('keeps a completed child under its active parent when organizing section or destination', () => {
  const instance = editor()
  instance.update(
    () => {
      const parent = task('active parent'),
        child = task('completed child', true),
        open = task('open child')
      const nested = $createListNode('check').append(child, open)
      const wrapper = $createListItemNode().append(nested)
      const list = $createListNode('check').append(parent, wrapper)
      $getRoot().append(heading('Tasks'), list)
      $organizeCompletedTasks(range(parent), 'section')
      expect(names(nested)).toEqual(['open child', 'completed child'])
      expect(child.getParent()!.getKey()).toBe(nested.getKey())
      expect(wrapper.getParent()!.getKey()).toBe(list.getKey())
      expect($organizeCompletedTasks(range(parent), 'completed-section')).toBe(0)
      expect($getRoot().getChildren()).toHaveLength(2)
    },
    { discrete: true },
  )
})

it('creates one history entry for an entire section organization', () => {
  const instance = editor()
  const history = createEmptyHistoryState()
  const stop = registerHistory(instance, history, 0)
  instance.update(
    () => {
      const list = $createListNode('check').append(task('done one', true), task('open'), task('done two', true))
      $getRoot().append(heading('Tasks'), list)
      range(list.getFirstChild() as ListItemNode)
    },
    { discrete: true },
  )
  const before = history.undoStack.length
  instance.update(
    () => {
      $organizeCompletedTasks($getSelection(), 'completed-section')
    },
    { discrete: true },
  )
  expect(history.undoStack.length - before).toBe(1)
  stop()
})
