/** @jest-environment jsdom */
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createHeadlessEditor } from '@lexical/headless'
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { $createTextNode, $getRoot } from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ChecklistPanel } from './ChecklistPanel'
import {
  $getChecklistFlags,
  $getChecklistTodoId,
  $setChecklistFlags,
  $setChecklistTodoId,
} from '../Lexical/Nodes/ChecklistItemNode'

jest.mock('@lexical/react/LexicalComposerContext', () => ({ useLexicalComposerContext: jest.fn() }))
jest.mock('@/Components/Comments/CommentsPanel', () => ({
  __esModule: true,
  default: ({ anchor }: { anchor?: { todoId: string } }) => (
    <div data-comment-target={anchor?.todoId ?? 'whole-note'} />
  ),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const flushChanges = jest.fn()

function Sections() {
  const [section, setSection] = useState<'checklist' | 'review'>('checklist')
  return (
    <ChecklistPanel
      note={{ uuid: 'note-1' } as never}
      activeSection={section}
      onOpenReview={() => setSection('review')}
      flushChanges={flushChanges}
    />
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
    [...container.querySelectorAll('button')].find((button) => button.textContent === 'Comments')!.click(),
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
  expect(container.querySelector('[aria-label="Review comments"]')?.hasAttribute('hidden')).toBe(true)
  queuedUpdate.mockRestore()
  await act(async () => root.unmount())
  container.remove()
})

it('shows a dedicated sorted task panel, pins without reordering the document, and targets comments by persistent task ID', async () => {
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
  jest.mocked(useLexicalComposerContext).mockReturnValue([editor, {} as never])
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<Sections />))
  const selects = [...container.querySelectorAll('[aria-label="Checklist tasks"] select')]
  expect(selects.map((select) => select.getAttribute('aria-label'))).toEqual([
    'Priority for Important task',
    'Priority for First task',
  ])
  const firstRow = selects[1].parentElement!
  flushChanges.mockClear()
  await act(async () =>
    [...firstRow.querySelectorAll('button')].find((button) => button.textContent === 'Pin')!.click(),
  )
  editor.getEditorState().read(() => {
    const list = $getRoot().getFirstChild() as ListNode
    expect(list.getFirstChild()?.getTextContent()).toBe('First task')
    expect($getChecklistFlags(list.getFirstChild() as ListItemNode).pinned).toBe(true)
  })
  expect(flushChanges).toHaveBeenCalledTimes(1)
  await act(async () =>
    [...firstRow.querySelectorAll('button')].find((button) => button.textContent === 'Comments')!.click(),
  )
  expect(container.querySelector('[data-comment-target]')?.getAttribute('data-comment-target')).toBe('todo-first')
  expect(container.querySelector('[aria-label="Checklist tasks"]')?.hasAttribute('hidden')).toBe(true)
  expect(container.querySelector('[aria-label="Review comments"]')?.hasAttribute('hidden')).toBe(false)
  await act(async () => editor.setEditable(false))
  expect(
    [...container.querySelectorAll<HTMLSelectElement>('[aria-label="Checklist tasks"] select')].every(
      (select) => select.disabled,
    ),
  ).toBe(true)
  await act(async () => root.unmount())
  container.remove()
})
