/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { $createParagraphNode, $createTextNode, $getRoot, createEditor, LexicalEditor } from 'lexical'
import { CommentsPlugin } from './CommentsPlugin'
import type { CommentAnchor } from '@/Comments/comments'

let mockEditor: LexicalEditor
let mockVisible = true
let mockAuthorized = true
let mockReadCount = 0
let mockShared: { anchor: CommentAnchor; authorshipStatus: 'legacy' | 'verified' }[] = []
let mockPrivate: { anchor: CommentAnchor }[] = []
const mockUpdates = new Set<() => void>()
const mockApplication = {
  getPreference: () => mockVisible,
  isAuthorizedToRenderItem: () => mockAuthorized,
  items: {
    findItem: () => ({ uuid: 'note' }),
    streamItems: (_types: unknown, callback: () => void) => {
      mockUpdates.add(callback)
      return () => mockUpdates.delete(callback)
    },
  },
  addEventObserver: (callback: () => void) => {
    mockUpdates.add(callback)
    return () => mockUpdates.delete(callback)
  },
}
jest.mock('@lexical/react/LexicalComposerContext', () => ({ useLexicalComposerContext: () => [mockEditor] }))
jest.mock('@/Components/ApplicationProvider', () => ({ useApplicationOrNull: () => mockApplication }))
jest.mock('@/Comments/PrivateNoteComments', () => ({ readPrivateNoteComments: () => mockPrivate }))
jest.mock('@/Comments/CommentAuthorship', () => ({
  readDisplayNoteComments: () => {
    mockReadCount++
    return { comments: mockShared }
  },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  mockVisible = true
  mockAuthorized = true
  mockReadCount = 0
  mockShared = []
  mockPrivate = []
  mockUpdates.clear()
})

it('hides indicators live without hiding comment content, then restores private and verified shared anchors', async () => {
  mockEditor = createEditor({
    namespace: 'indicator-test',
    onError: (error) => {
      throw error
    },
  })
  const editorElement = document.createElement('div')
  document.body.append(editorElement)
  mockEditor.setRootElement(editorElement)
  let key = ''
  mockEditor.update(
    () => {
      const block = $createParagraphNode().append($createTextNode('Visible comment context'))
      key = block.getKey()
      $getRoot().append(block)
    },
    { discrete: true },
  )
  const anchor: CommentAnchor = { kind: 'super', blockKey: key }
  mockPrivate = [{ anchor }]
  const element = document.createElement('div')
  const root = createRoot(element)
  try {
    await act(async () => root.render(<CommentsPlugin note={{ uuid: 'note' } as never} />))
    expect(editorElement.querySelector('[data-note-comment-indicator]')).not.toBeNull()
    expect(mockReadCount).toBe(1)
    mockEditor.update(
      () => {
        $getRoot().getFirstChild()?.selectEnd()
      },
      { discrete: true },
    )
    expect(mockReadCount).toBe(1)
    mockVisible = false
    await act(async () => mockUpdates.forEach((callback) => callback()))
    expect(editorElement.dataset.commentIndicators).toBe('hidden')
    expect(editorElement.querySelector('[data-note-comment-indicator]')).toBeNull()
    expect(editorElement.textContent).toContain('Visible comment context')
    mockVisible = true
    mockPrivate = []
    mockShared = [{ anchor, authorshipStatus: 'legacy' }]
    await act(async () => mockUpdates.forEach((callback) => callback()))
    expect(editorElement.querySelector('[data-note-comment-indicator]')).toBeNull()
    mockShared = [{ anchor, authorshipStatus: 'verified' }]
    await act(async () => mockUpdates.forEach((callback) => callback()))
    expect(editorElement.querySelector('[data-note-comment-indicator]')).not.toBeNull()
    mockAuthorized = false
    await act(async () => mockUpdates.forEach((callback) => callback()))
    expect(editorElement.querySelector('[data-note-comment-indicator]')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    mockEditor.setRootElement(null)
    editorElement.remove()
    expect(mockUpdates.size).toBe(0)
  }
})
