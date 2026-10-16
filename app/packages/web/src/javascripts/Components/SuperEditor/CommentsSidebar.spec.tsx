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
import { ContentType } from '@standardnotes/snjs'
import type { CommentAnchor } from '@/Comments/comments'
import * as CommentTargets from '@/Comments/CommentTargets'
let mockCommentsFailure = false
let mockPrivateComments = 0
let mockSharedComments = 0
let mockNavigate: ((anchor: CommentAnchor) => void) | undefined
let mockValidateTarget: ((scope: 'private' | 'collaborative', replying: boolean) => void) | undefined
const mockCommentUpdates = new Set<() => void>()
type ItemChanges = {
  changed: { uuid: string; content_type: string }[]
  inserted: { uuid: string; content_type: string }[]
  removed: { uuid: string; content_type: string }[]
  unerrored: { uuid: string; content_type: string }[]
}
const mockItemUpdates = new Set<(changes: ItemChanges) => void>()
const mockReadPrivateComments = jest.fn(() => Array.from({ length: mockPrivateComments }))
const mockReadSharedComments = jest.fn(() => ({
  comments: Array.from({ length: mockSharedComments }),
  quarantinedCount: 0,
}))
const mockApplication = {
  items: {
    findItem: (uuid: string) => ({ uuid }),
    addObserver: (_types: unknown, changed: (changes: ItemChanges) => void) => {
      mockItemUpdates.add(changed)
      return () => mockItemUpdates.delete(changed)
    },
  },
  isAuthorizedToRenderItem: jest.fn(() => true),
  addEventObserver: (changed: () => void) => {
    mockCommentUpdates.add(changed)
    return () => mockCommentUpdates.delete(changed)
  },
}

jest.mock('@/Components/ApplicationProvider', () => ({ useApplication: () => mockApplication }))
jest.mock('@/Comments/PrivateNoteComments', () => ({
  readPrivateNoteComments: (...args: unknown[]) => mockReadPrivateComments(...(args as [])),
}))
jest.mock('@/Comments/CommentAuthorship', () => ({
  readDisplayNoteComments: (...args: unknown[]) => mockReadSharedComments(...(args as [])),
}))
beforeEach(() => {
  mockPrivateComments = 0
  mockSharedComments = 0
  mockReadPrivateComments.mockImplementation(() => Array.from({ length: mockPrivateComments }))
  mockReadSharedComments.mockImplementation(() => ({
    comments: Array.from({ length: mockSharedComments }),
    quarantinedCount: 0,
  }))
  mockReadPrivateComments.mockClear()
  mockReadSharedComments.mockClear()
  mockApplication.isAuthorizedToRenderItem.mockReturnValue(true)
})

jest.mock('@lexical/react/LexicalComposerContext', () => ({ useLexicalComposerContext: jest.fn() }))
jest.mock('@/Components/Comments/CommentsPanel', () => ({
  __esModule: true,
  default: ({
    anchor,
    onNavigate,
    validateTarget,
  }: {
    anchor?: { todoId?: string }
    onNavigate: typeof mockNavigate
    validateTarget: typeof mockValidateTarget
  }) => {
    mockNavigate = onNavigate
    mockValidateTarget = validateTarget
    const [value, setValue] = useState('')
    if (mockCommentsFailure) {
      throw new Error('comments unavailable')
    }
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

it('ignores unrelated note traffic while waiting to reveal comments, but observes note insertion and preference changes', async () => {
  const editor = createHeadlessEditor({
    onError: (error) => {
      throw error
    },
  })
  jest.mocked(useLexicalComposerContext).mockReturnValue([editor, {} as never])
  const element = document.createElement('div')
  const root = createRoot(element)
  const emit = (field: keyof ItemChanges, uuid: string, content_type: string) =>
    mockItemUpdates.forEach((callback) =>
      callback({ changed: [], inserted: [], removed: [], unerrored: [], [field]: [{ uuid, content_type }] }),
    )
  try {
    await act(async () =>
      root.render(
        <EditorControlsProvider identity={{}}>
          <CommentsSidebar note={{ uuid: 'current' } as never} />
        </EditorControlsProvider>,
      ),
    )
    expect(mockReadPrivateComments).toHaveBeenCalledTimes(1)
    mockReadPrivateComments.mockClear()
    mockReadSharedComments.mockClear()
    await act(async () => {
      for (let index = 0; index < 100; index++) {
        emit('changed', `other-${index}`, ContentType.TYPES.Note)
      }
    })
    expect(mockReadPrivateComments).not.toHaveBeenCalled()
    expect(mockReadSharedComments).not.toHaveBeenCalled()
    await act(async () => emit('inserted', 'current', ContentType.TYPES.Note))
    expect(mockReadPrivateComments).toHaveBeenCalledTimes(1)
    await act(async () => emit('removed', 'current', ContentType.TYPES.Note))
    expect(mockReadPrivateComments).toHaveBeenCalledTimes(2)
    await act(async () => emit('changed', 'prefs', ContentType.TYPES.UserPrefs))
    expect(mockReadPrivateComments).toHaveBeenCalledTimes(3)
    mockSharedComments = 1
    await act(async () => emit('changed', 'contact', ContentType.TYPES.TrustedContact))
    expect(element.querySelector('aside')?.hidden).toBe(false)
  } finally {
    await act(async () => root.unmount())
  }
  expect(mockItemUpdates.size).toBe(0)
})

it.each(['private', 'shared'] as const)('automatically opens for existing %s comments', async (scope) => {
  const editor = createHeadlessEditor({
    onError: (error) => {
      throw error
    },
  })
  jest.mocked(useLexicalComposerContext).mockReturnValue([editor, {} as never])
  if (scope === 'private') {
    mockPrivateComments = 1
  } else {
    mockSharedComments = 1
  }
  const element = document.createElement('div')
  const root = createRoot(element)
  try {
    await act(async () =>
      root.render(
        <EditorControlsProvider identity={{}}>
          <CommentsSidebar note={{ uuid: 'existing' } as never} />
        </EditorControlsProvider>,
      ),
    )
    expect(element.querySelector('aside')?.hidden).toBe(false)
  } finally {
    await act(async () => root.unmount())
  }
})

it.each(['private', 'shared'] as const)(
  'opens when %s comments arrive, respects closing across updates and composer replacement, and reopens for a new note',
  async (scope) => {
    const editor = createHeadlessEditor({
      onError: (error) => {
        throw error
      },
    })
    jest.mocked(useLexicalComposerContext).mockReturnValue([editor, {} as never])
    const element = document.createElement('div')
    const root = createRoot(element)
    const identity = {}
    const render = (owner: object, composer: string, uuid = 'late') =>
      root.render(
        <EditorControlsProvider identity={owner}>
          <CommentsSidebar key={composer} note={{ uuid } as never} />
        </EditorControlsProvider>,
      )
    try {
      await act(async () => render(identity, 'first'))
      expect(element.querySelector('aside')).toBeNull()
      await act(async () => {
        if (scope === 'private') {
          mockPrivateComments = 1
        } else {
          mockSharedComments = 1
        }
        mockCommentUpdates.forEach((changed) => changed())
      })
      expect(element.querySelector('aside')?.hidden).toBe(false)
      await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Close comments sidebar"]')!.click())
      await act(async () => mockCommentUpdates.forEach((changed) => changed()))
      expect(element.querySelector('aside')?.hidden).toBe(true)
      await act(async () => render(identity, 'replacement'))
      expect(element.querySelector('aside')).toBeNull()
      await act(async () => render({}, 'replacement', 'next-note'))
      expect(element.querySelector('aside')?.hidden).toBe(false)
    } finally {
      await act(async () => root.unmount())
    }
    expect(mockCommentUpdates.size).toBe(0)
  },
)

it('does not reveal comments from a note the current account cannot render', async () => {
  const editor = createHeadlessEditor({
    onError: (error) => {
      throw error
    },
  })
  jest.mocked(useLexicalComposerContext).mockReturnValue([editor, {} as never])
  mockPrivateComments = mockSharedComments = 1
  mockApplication.isAuthorizedToRenderItem.mockReturnValue(false)
  const element = document.createElement('div')
  const root = createRoot(element)
  try {
    await act(async () =>
      root.render(
        <EditorControlsProvider identity={{}}>
          <CommentsSidebar note={{ uuid: 'unavailable' } as never} />
        </EditorControlsProvider>,
      ),
    )
    expect(element.querySelector('aside')).toBeNull()
  } finally {
    await act(async () => root.unmount())
  }
})

it('refuses ambiguous checklist navigation and never turns a stale item target into a whole-note comment', async () => {
  const editor = createHeadlessEditor({
    nodes: [ListNode, ListItemNode],
    onError: (error) => {
      throw error
    },
  })
  let uniqueKey = ''
  editor.update(
    () => {
      const first = $createListItemNode(false).append($createTextNode('First'))
      const second = $createListItemNode(false).append($createTextNode('Second'))
      const unique = $createListItemNode(false).append($createTextNode('Unique'))
      $setChecklistTodoId(first, 'duplicate')
      $setChecklistTodoId(second, 'duplicate')
      $setChecklistTodoId(unique, 'unique-todo')
      uniqueKey = unique.getKey()
      $getRoot().append($createListNode('check').append(first, second, unique))
    },
    { discrete: true },
  )
  jest.mocked(useLexicalComposerContext).mockReturnValue([editor, {} as never])
  const target = document.createElement('div')
  target.scrollIntoView = jest.fn()
  const getElement = jest.spyOn(editor, 'getElementByKey').mockReturnValue(target)
  jest.spyOn(CommentTargets, 'captureAssistantCommentTarget').mockReturnValue({ assertCurrent: jest.fn() })
  let controls!: ReturnType<typeof createEditorControlsState>
  function Harness() {
    controls = useEditorControlsState()
    return <CommentsSidebar note={{ uuid: 'note' } as never} />
  }
  const element = document.createElement('div')
  const root = createRoot(element)
  try {
    await act(async () =>
      root.render(
        <EditorControlsProvider identity={{}}>
          <Harness />
        </EditorControlsProvider>,
      ),
    )
    await act(async () => controls.openComments())
    await act(async () => mockNavigate!({ kind: 'checklist', todoId: 'duplicate' }))
    expect(getElement).not.toHaveBeenCalled()
    expect(element.textContent).toContain('The commented text has moved or is no longer in this note.')
    await act(async () => mockNavigate!({ kind: 'checklist', todoId: 'unique-todo' }))
    expect(getElement).toHaveBeenCalledWith(uniqueKey)
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1)
    await act(async () => controls.setCommentTarget('duplicate'))
    expect(element.textContent).toContain('This task is no longer in the note.')
    expect(element.querySelector('textarea')).toBeNull()
    await act(async () => controls.setCommentTarget('unique-todo'))
    expect(() => mockValidateTarget!('private', false)).not.toThrow()
  } finally {
    await act(async () => root.unmount())
  }
})

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
