/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { $createParagraphNode, $createTextNode, $getRoot, $isElementNode, createEditor, LexicalEditor } from 'lexical'
import { CommentsPlugin } from './CommentsPlugin'
import type { CommentAnchor } from '@/Comments/comments'
import { ContentType } from '@standardnotes/snjs'

let mockEditor: LexicalEditor
let mockVisible = true
let mockAuthorized = true
let mockReadCount = 0
let mockShared: { anchor: CommentAnchor; authorshipStatus: 'legacy' | 'verified' }[] = []
let mockPrivate: { anchor: CommentAnchor }[] = []
const mockUpdates = new Set<() => void>()
type ItemChange = { uuid: string; content_type: string }
type ItemEvent = { changed: ItemChange[]; inserted: ItemChange[]; removed: ItemChange[] }
const mockItemUpdates = new Set<(event: ItemEvent) => void>()
const mockApplication = {
  getPreference: () => mockVisible,
  isAuthorizedToRenderItem: () => mockAuthorized,
  items: {
    findItem: () => ({ uuid: 'note' }),
    addObserver: (_types: unknown, callback: (event: ItemEvent) => void) => {
      mockItemUpdates.add(callback)
      return () => mockItemUpdates.delete(callback)
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
  mockItemUpdates.clear()
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
    const setAttribute = jest.spyOn(editorElement, 'setAttribute')
    setAttribute.mockClear()
    mockEditor.update(
      () => {
        $getRoot().getFirstChild()?.selectEnd()
      },
      { discrete: true },
    )
    expect(mockReadCount).toBe(1)
    expect(setAttribute).not.toHaveBeenCalled()
    const emit = (item: ItemChange, kind: keyof ItemEvent = 'changed') => {
      const event: ItemEvent = { changed: [], inserted: [], removed: [] }
      event[kind].push(item)
      mockItemUpdates.forEach((callback) => callback(event))
    }
    emit({ uuid: 'unrelated-note', content_type: ContentType.TYPES.Note })
    expect(mockReadCount).toBe(1)
    expect(setAttribute).not.toHaveBeenCalled()
    emit({ uuid: 'note', content_type: ContentType.TYPES.Note })
    expect(mockReadCount).toBe(2)
    // Private preferences and contact trust changes must still re-read and
    // cryptographically verify the currently displayed shared comments.
    emit({ uuid: 'preferences', content_type: ContentType.TYPES.UserPrefs })
    emit({ uuid: 'contact', content_type: ContentType.TYPES.TrustedContact }, 'removed')
    expect(mockReadCount).toBe(4)
    mockEditor.update(
      () => {
        const block = $getRoot().getFirstChild()
        if ($isElementNode(block)) {
          block.append($createTextNode(' changed'))
        }
      },
      { discrete: true },
    )
    expect(setAttribute).toHaveBeenCalled()
    expect(editorElement.querySelector('[data-note-comment-indicator]')).not.toBeNull()
    setAttribute.mockRestore()
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
    expect(mockItemUpdates.size).toBe(0)
  }
})
