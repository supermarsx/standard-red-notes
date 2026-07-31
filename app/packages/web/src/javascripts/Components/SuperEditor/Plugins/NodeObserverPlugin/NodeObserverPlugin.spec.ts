/**
 * @jest-environment jsdom
 */
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $nodesOfType,
  createEditor as createLexicalEditor,
} from 'lexical'
import { $createFileNode } from '../EncryptedFilePlugin/Nodes/FileUtils'
import { FileNode } from '../EncryptedFilePlugin/Nodes/FileNode'
import { $createBubbleNode } from '../ItemBubblePlugin/Nodes/BubbleUtils'
import { BubbleNode } from '../ItemBubblePlugin/Nodes/BubbleNode'
import { EditorReferenceChanges, registerEditorReferenceObserver } from './NodeObserverPlugin'

function createEditor() {
  const editor = createLexicalEditor({
    namespace: 'EditorReferenceObserverTest',
    nodes: [BubbleNode, FileNode],
    onError: (error) => {
      throw error
    },
  })
  editor.setRootElement(document.createElement('div'))
  return editor
}

function appendBubble(uuid: string) {
  $getRoot().append($createParagraphNode().append($createBubbleNode(uuid)))
}

function appendFile(uuid: string) {
  $getRoot().append($createFileNode(uuid))
}

describe('editor reference observation', () => {
  it('does not remove duplicate bubbles or files until the final reference disappears', () => {
    const editor = createEditor()
    editor.update(
      () => {
        appendBubble('note-1')
        appendBubble('note-1')
        appendFile('file-1')
        appendFile('file-1')
      },
      { discrete: true },
    )

    const changes: EditorReferenceChanges[] = []
    const unregister = registerEditorReferenceObserver(editor, (change) => changes.push(change))

    editor.update(
      () => {
        $nodesOfType(BubbleNode)[0].remove()
        $nodesOfType(FileNode)[0].remove()
      },
      { discrete: true },
    )
    expect(changes).toEqual([])

    editor.update(
      () => {
        $nodesOfType(BubbleNode)[0].remove()
        $nodesOfType(FileNode)[0].remove()
      },
      { discrete: true },
    )
    expect(changes).toEqual([{ added: [], removed: ['note-1', 'file-1'] }])

    unregister()
  })

  it('deduplicates a UUID represented by mixed bubble and file node types', () => {
    const editor = createEditor()
    editor.update(
      () => {
        appendBubble('shared-item')
        appendFile('shared-item')
      },
      { discrete: true },
    )

    const changes: EditorReferenceChanges[] = []
    const unregister = registerEditorReferenceObserver(editor, (change) => changes.push(change))

    editor.update(() => $nodesOfType(BubbleNode)[0].remove(), { discrete: true })
    expect(changes).toEqual([])

    editor.update(() => $nodesOfType(FileNode)[0].remove(), { discrete: true })
    expect(changes).toEqual([{ added: [], removed: ['shared-item'] }])

    unregister()
  })

  it('emits inverse set transitions for undo and redo without stale destroyed-node state', () => {
    const editor = createEditor()
    editor.update(() => appendBubble('undoable-note'), { discrete: true })
    const beforeRemoval = editor.getEditorState()

    const changes: EditorReferenceChanges[] = []
    const unregisterObserver = registerEditorReferenceObserver(editor, (change) => changes.push(change))

    editor.update(() => $nodesOfType(BubbleNode)[0].remove(), { discrete: true })
    const afterRemoval = editor.getEditorState()
    expect(changes).toEqual([{ added: [], removed: ['undoable-note'] }])

    editor.setEditorState(beforeRemoval, { tag: 'history-undo' })
    expect(changes).toEqual([
      { added: [], removed: ['undoable-note'] },
      { added: ['undoable-note'], removed: [] },
    ])

    editor.setEditorState(afterRemoval, { tag: 'history-redo' })
    expect(changes).toEqual([
      { added: [], removed: ['undoable-note'] },
      { added: ['undoable-note'], removed: [] },
      { added: [], removed: ['undoable-note'] },
    ])

    unregisterObserver()
  })

  it('emits one addition for duplicate nodes created in the same committed transaction', () => {
    const editor = createEditor()
    const changes: EditorReferenceChanges[] = []
    const unregister = registerEditorReferenceObserver(editor, (change) => changes.push(change))

    editor.update(
      () => {
        appendBubble('same-note')
        appendBubble('same-note')
        appendFile('same-file')
        appendFile('same-file')
      },
      { discrete: true },
    )

    expect(changes).toEqual([{ added: ['same-note', 'same-file'], removed: [] }])
    unregister()
  })

  it('does not scan or emit for ordinary text-only commits', () => {
    const editor = createEditor()
    editor.update(
      () => {
        appendBubble('stable-note')
        appendFile('stable-file')
        $getRoot().append($createParagraphNode().append($createTextNode('before typing')))
      },
      { discrete: true },
    )

    const changes: EditorReferenceChanges[] = []
    const unregister = registerEditorReferenceObserver(editor, (change) => changes.push(change))
    const getBubbleId = jest.spyOn(BubbleNode.prototype, 'getId')
    const getFileId = jest.spyOn(FileNode.prototype, 'getId')

    editor.update(
      () => {
        $getRoot().getAllTextNodes()[0].setTextContent('after ordinary typing')
      },
      { discrete: true },
    )

    expect(changes).toEqual([])
    expect(getBubbleId).not.toHaveBeenCalled()
    expect(getFileId).not.toHaveBeenCalled()
    getBubbleId.mockRestore()
    getFileId.mockRestore()
    unregister()
  })
})
