/** @jest-environment jsdom */
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createHeadlessEditor } from '@lexical/headless'
import { ListItemNode, ListNode, $createListItemNode, $createListNode } from '@lexical/list'
import { $createTextNode, $getRoot } from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { CommentsSidebar } from './CommentsSidebar'
import { createEditorControlsState, EditorControlsProvider, useEditorControlsState } from './EditorControlsContext'
import { $setChecklistTodoId } from './Lexical/Nodes/ChecklistItemNode'
let mockCommentsFailure = false

jest.mock('@lexical/react/LexicalComposerContext', () => ({ useLexicalComposerContext: jest.fn() }))
jest.mock('@/Components/Comments/CommentsPanel', () => ({
  __esModule: true,
  default: ({ anchor }: { anchor?: { todoId?: string } }) => {
    const [value, setValue] = useState('')
    if (mockCommentsFailure) throw new Error('comments unavailable')
    return (
      <textarea
        aria-label={`Draft ${anchor?.todoId ?? 'note'}`}
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    )
  },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('does not load comments during startup and contains a comment rendering failure without replacing the document', async () => {
  const editor = createHeadlessEditor({
    onError: (error) => {
      throw error
    },
  })
  jest.mocked(useLexicalComposerContext).mockReturnValue([editor, {} as never])
  let controls!: ReturnType<typeof createEditorControlsState>
  function Harness() {
    controls = useEditorControlsState()
    return (
      <>
        <main>Editor is ready</main>
        <CommentsSidebar note={{ uuid: 'failure-note' } as never} />
      </>
    )
  }
  const element = document.createElement('div')
  const root = createRoot(element)
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  mockCommentsFailure = true
  try {
    await act(async () =>
      root.render(
        <EditorControlsProvider identity={{}}>
          <Harness />
        </EditorControlsProvider>,
      ),
    )
    const documentNode = element.querySelector('main')
    expect(element.textContent).toBe('Editor is ready')
    await act(async () => controls.openComments())
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('Comments could not be loaded')
    expect(element.querySelector('main')).toBe(documentNode)
  } finally {
    mockCommentsFailure = false
    await act(async () => root.unmount())
    error.mockRestore()
  }
})

it('keeps comments beside the document, supports collapse, expand, close and keyboard resize, and retains the mounted draft', async () => {
  const editor = createHeadlessEditor({
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error
    },
  })
  editor.update(
    () => {
      const task = $createListItemNode(false).append($createTextNode('Task'))
      $setChecklistTodoId(task, 'todo-test')
      $getRoot().append($createListNode('check').append(task))
    },
    { discrete: true },
  )
  jest.mocked(useLexicalComposerContext).mockReturnValue([editor, {} as never])
  let controls!: ReturnType<typeof createEditorControlsState>
  function Harness() {
    controls = useEditorControlsState()
    return (
      <div className="flex">
        <main data-document>Document remains mounted</main>
        <CommentsSidebar note={{ uuid: 'note' } as never} />
      </div>
    )
  }
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  const click = async (label: string) =>
    act(async () => {
      element.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()
    })
  try {
    await act(async () =>
      root.render(
        <EditorControlsProvider identity={{}}>
          <Harness />
        </EditorControlsProvider>,
      ),
    )
    expect(element.querySelector('aside')).toBeNull()
    const documentNode = element.querySelector('[data-document]')
    await act(async () => controls.openComments())
    const sidebar = element.querySelector('aside')!
    expect(documentNode?.nextElementSibling).toBe(sidebar)
    const draft = element.querySelector('textarea')!
    expect(draft).not.toBeNull()
    await click('Collapse comments sidebar')
    expect(sidebar.style.width).toBe('44px')
    await click('Restore comments sidebar')
    expect(element.querySelector('textarea')).toBe(draft)
    await click('Expand comments sidebar')
    expect(sidebar.style.width).toBe('600px')
    await click('Restore comments width')
    expect(sidebar.style.width).toBe('320px')
    await act(async () =>
      element
        .querySelector('[role="separator"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })),
    )
    expect(sidebar.style.width).toBe('600px')
    await click('Close comments sidebar')
    expect(sidebar.hidden).toBe(true)
    await act(async () => controls.openComments())
    expect(element.querySelector('textarea')).toBe(draft)
    expect(element.querySelector('[data-document]')).toBe(documentNode)
    await act(async () => {
      controls.setCommentTarget('todo-test')
      controls.openComments()
    })
    expect(element.querySelector('[aria-label="Draft todo-test"]')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    element.remove()
  }
})
