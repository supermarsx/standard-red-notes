/** @jest-environment jsdom */
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Toolbar } from '@ariakit/react'
import { createHeadlessEditor } from '@lexical/headless'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { $createTextNode, $getRoot, $createParagraphNode, $setSelection } from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ChecklistPanel } from './ChecklistPanel'
import { useApplicationOrNull } from '@/Components/ApplicationProvider'
import { $getChecklistPersonalTicks, $setChecklistPersonalTick, $isChecklistPerPerson } from './checklistPersonalTicks'
import {
  $getChecklistFlags,
  $getChecklistTodoId,
  $setChecklistFlags,
  $setChecklistTodoId,
} from '../Lexical/Nodes/ChecklistItemNode'

jest.mock('@/Hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
  MutuallyExclusiveMediaQueryBreakpoints: { sm: 'sm' },
}))

jest.mock('@lexical/react/LexicalComposerContext', () => ({ useLexicalComposerContext: jest.fn() }))
jest.mock('@/Components/ApplicationProvider', () => ({ useApplicationOrNull: jest.fn(() => undefined) }))
jest.mock('@/Components/Comments/CommentsPanel', () => ({
  __esModule: true,
  default: ({ anchor }: { anchor?: { todoId: string } }) => (
    <div data-comment-target={anchor?.todoId ?? 'whole-note'} />
  ),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const flushChanges = jest.fn()
const openReview = jest.fn()
beforeEach(() => {
  jest.mocked(useApplicationOrNull).mockReturnValue(undefined)
  flushChanges.mockClear()
  openReview.mockClear()
})

function Sections() {
  const [section, setSection] = useState<'checklist' | 'review'>('checklist')
  return (
    <Toolbar>
      <ChecklistPanel
        note={{ uuid: 'note-1' } as never}
        activeSection={section}
        onOpenReview={() => {
          openReview()
          setSection('review')
        }}
        flushChanges={flushChanges}
      />
    </Toolbar>
  )
}

it('does not assign a task identity after readonly changes before a queued comment-target update', async () => {
  const editor = createHeadlessEditor({
    namespace: 'panel-deferred',
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error
    },
  })
  editor.update(
    () =>
      $getRoot().append(
        $createListNode('check').append($createListItemNode(false).append($createTextNode('Legacy task'))),
      ),
    { discrete: true },
  )
  editor.update(() => ($getRoot().getFirstChild() as ListNode).getFirstChild()!.selectEnd(), { discrete: true })
  jest.spyOn(editor, 'getRootElement').mockReturnValue(null)
  jest.mocked(useLexicalComposerContext).mockReturnValue([editor, {} as never])
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<Sections />))
  const originalUpdate = editor.update.bind(editor)
  let pending: (() => void) | undefined
  const queuedUpdate = jest.spyOn(editor, 'update').mockImplementation((callback) => {
    pending = callback
  })
  await act(async () =>
    [...container.querySelectorAll('button')]
      .find((button) => button.getAttribute('aria-label') === 'Item comments')!
      .click(),
  )
  expect(pending).toBeDefined()
  await act(async () => {
    editor.setEditable(false)
    originalUpdate(() => pending!(), { discrete: true })
  })
  editor.getEditorState().read(() => {
    expect(
      $getChecklistTodoId(($getRoot().getFirstChild() as ListNode).getFirstChild() as ListItemNode),
    ).toBeUndefined()
  })
  expect(container.querySelector('[data-comment-target]')).toBeNull()
  expect(openReview).not.toHaveBeenCalled()
  queuedUpdate.mockRestore()
  await act(async () => root.unmount())
  container.remove()
})

it('shows only the current task controls, pins without reordering, and follows caret-only changes', async () => {
  const editor = createHeadlessEditor({
    namespace: 'panel',
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error
    },
  })
  editor.update(
    () => {
      const list = $createListNode('check')
      const first = $createListItemNode(false).append($createTextNode('First task'))
      const second = $createListItemNode(false).append($createTextNode('Important task'))
      $setChecklistTodoId(first, 'todo-first')
      $setChecklistTodoId(second, 'todo-important')
      $setChecklistFlags(second, { priority: 'high' })
      list.append(first, second)
      $getRoot().append(list)
    },
    { discrete: true },
  )
  editor.update(() => ($getRoot().getFirstChild() as ListNode).getFirstChild()!.selectEnd(), { discrete: true })
  jest.spyOn(editor, 'getRootElement').mockReturnValue(null)
  jest.mocked(useLexicalComposerContext).mockReturnValue([editor, {} as never])
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<Sections />))
  const dropdown = (label: string) =>
    [...container.querySelectorAll<HTMLElement>('[role="combobox"]')].find(
      (button) => document.getElementById(button.getAttribute('aria-labelledby')!)?.textContent === label,
    )
  expect(container.querySelectorAll('[role="combobox"]')).toHaveLength(2)
  expect(dropdown('Priority for First task')).toBeDefined()
  expect(container.textContent).not.toContain('Important task')
  const firstRow = container
  flushChanges.mockClear()
  await act(async () =>
    [...firstRow.querySelectorAll('button')]
      .find((button) => button.getAttribute('aria-label') === 'Pin item')!
      .click(),
  )
  editor.getEditorState().read(() => {
    const list = $getRoot().getFirstChild() as ListNode
    expect(list.getFirstChild()?.getTextContent()).toBe('First task')
    expect($getChecklistFlags(list.getFirstChild() as ListItemNode).pinned).toBe(true)
  })
  expect(flushChanges).toHaveBeenCalledTimes(1)
  await act(async () =>
    editor.update(() => ($getRoot().getFirstChild() as ListNode).getLastChild()!.selectEnd(), { discrete: true }),
  )
  expect(dropdown('Priority for Important task')).toBeDefined()
  expect(dropdown('Priority for First task')).toBeUndefined()
  // A dropdown may take focus; a null selection must retain its target.
  await act(async () => editor.update(() => $setSelection(null), { discrete: true }))
  expect(dropdown('Priority for Important task')).toBeDefined()
  await act(async () =>
    editor.update(() => ($getRoot().getFirstChild() as ListNode).getFirstChild()!.selectEnd(), { discrete: true }),
  )
  await act(async () =>
    [...firstRow.querySelectorAll('button')]
      .find((button) => button.getAttribute('aria-label') === 'Item comments')!
      .click(),
  )
  expect(openReview).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[data-comment-target]')).toBeNull()
  expect(container.querySelector('[aria-label="Checklist tasks"]')?.hasAttribute('hidden')).toBe(true)
  expect(container.querySelector('[aria-label="Review comments"]')).toBeNull()
  await act(async () => editor.setEditable(false))
  expect(
    [...container.querySelectorAll<HTMLButtonElement>('[role="combobox"]')].every((select) => select.disabled),
  ).toBe(true)
  await act(async () => {
    editor.setEditable(true)
    editor.update(
      () => {
        const paragraph = $createParagraphNode().append($createTextNode('Outside tasks'))
        $getRoot().append(paragraph)
        paragraph.selectEnd()
      },
      { discrete: true },
    )
  })
  expect(container.querySelector('[aria-label="Selected checklist item"]')).toBeNull()
  expect(container.textContent).toContain('Place the cursor')
  await act(async () =>
    editor.update(() => ($getRoot().getFirstChild() as ListNode).getFirstChild()!.selectEnd(), { discrete: true }),
  )
  await act(async () =>
    editor.update(
      () => {
        $setSelection(null)
        ;($getRoot().getFirstChild() as ListNode).getFirstChild()!.remove()
      },
      { discrete: true },
    ),
  )
  expect(container.querySelector('[aria-label="Selected checklist item"]')).toBeNull()
  await act(async () => root.unmount())
  container.remove()
})

it('shows every personal tick, lets you toggle only yours, and preserves shared completion', async () => {
  let userUuid = 'alice'
  jest.mocked(useApplicationOrNull).mockReturnValue({
    sessions: { getUser: () => ({ uuid: userUuid }) },
    contacts: {
      findContact: (userId: string) => ({
        name: userId === 'bob' ? 'Bob' : 'Alice',
      }),
    },
  } as never)
  const editor = createHeadlessEditor({
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error
    },
  })
  editor.update(
    () => {
      const item = $createListItemNode(false).append($createTextNode('Review release'))
      $setChecklistTodoId(item, 'todo-release')
      $setChecklistPersonalTick(item, 'bob', true)
      $getRoot().append($createListNode('check').append(item))
    },
    { discrete: true },
  )
  editor.update(() => ($getRoot().getFirstChild() as ListNode).getFirstChild()!.selectEnd(), { discrete: true })
  jest.spyOn(editor, 'getRootElement').mockReturnValue(null)
  jest.mocked(useLexicalComposerContext).mockReturnValue([editor, {} as never])
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Sections />))
    const tick = () => container.querySelector<HTMLButtonElement>('[aria-label="Complete Review release"]')!
    const mode = container.querySelector<HTMLButtonElement>('[role="combobox"]')!
    expect(mode.textContent).toContain('Single tick')
    expect(container.textContent).not.toContain('Ticked by Bob')
    await act(async () => mode.click())
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((option) => option.textContent === 'Per person (multi-tick)')!
        .click(),
    )
    editor
      .getEditorState()
      .read(() =>
        expect($isChecklistPerPerson(($getRoot().getFirstChild() as ListNode).getFirstChild() as ListItemNode)).toBe(
          true,
        ),
      )
    expect(container.textContent).toContain('Ticked by Bob')
    flushChanges.mockClear()
    await act(async () => tick().click())
    expect(tick().getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelectorAll('[aria-label="Selected checklist item"]')).toHaveLength(1)
    expect(container.textContent).toContain('Ticked by You, Bob')
    expect(flushChanges).toHaveBeenCalledTimes(1)
    await act(async () => tick().click())
    editor.getEditorState().read(() => {
      const item = ($getRoot().getFirstChild() as ListNode).getFirstChild() as ListItemNode
      expect($getChecklistPersonalTicks(item)).toEqual(['bob'])
      expect(item.getChecked()).toBe(false)
    })
    userUuid = 'different-account'
    await act(async () => tick().click())
    editor
      .getEditorState()
      .read(() =>
        expect(
          $getChecklistPersonalTicks(($getRoot().getFirstChild() as ListNode).getFirstChild() as ListItemNode),
        ).toEqual(['bob']),
      )
    await act(async () => editor.setEditable(false))
    expect(tick().getAttribute('aria-disabled')).toBe('true')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
