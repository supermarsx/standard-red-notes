/** @jest-environment jsdom */
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  createEditor,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical'
import {
  createBinding,
  initLocalState,
  syncLexicalUpdateToYjs,
  syncYjsChangesToLexical,
  type Provider,
} from '@lexical/yjs'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { captureEditorResume, restoreEditorResume } from './EditorResumeState'
import {
  clearEditorResumeCollaboration,
  trackEditorResumeCollaboration,
  trackEditorResumeProvider,
} from './EditorResumeCollaboration'

it('resolves the saved caret after a real peer insertion rather than restoring the stale numeric offset', async () => {
  const root = document.createElement('div')
  document.body.append(root)
  const editor = createEditor({
    namespace: 'resume-collab',
    onError: (error) => {
      throw error
    },
  })
  editor.setRootElement(root)
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  const provider = { awareness } as unknown as Provider
  const binding = createBinding(editor, provider, 'note', doc, new Map([['note', doc]]))
  initLocalState(provider, 'Alice', '#123456', false, {})
  trackEditorResumeProvider(editor, provider)
  const unregister = editor.registerUpdateListener(
    ({ editorState, prevEditorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
      syncLexicalUpdateToYjs(
        binding,
        provider,
        prevEditorState,
        editorState,
        dirtyElements,
        dirtyLeaves,
        normalizedNodes,
        tags,
      )
    },
  )
  const remoteUpdate = (events: Parameters<typeof syncYjsChangesToLexical>[2], transaction: Y.Transaction) => {
    if (transaction.origin !== binding) {
      syncYjsChangesToLexical(binding, provider, events, false)
    }
  }
  binding.root.getSharedType().observeDeep(remoteUpdate)
  editor.update(
    () => {
      const text = $createTextNode('abcdef')
      $getRoot().append($createParagraphNode().append(text))
      const selection = $createRangeSelection()
      selection.anchor.set(text.getKey(), 2, 'text')
      selection.focus.set(text.getKey(), 2, 'text')
      $setSelection(selection)
    },
    { discrete: true, tag: SKIP_DOM_SELECTION_TAG },
  )
  const saved = captureEditorResume(editor)!
  expect(saved.selection?.relative).toBeDefined()
  trackEditorResumeCollaboration(binding, provider)
  expect(captureEditorResume(editor)!.selection?.relative).toEqual(saved.selection?.relative)
  const peerDoc = new Y.Doc()
  Y.applyUpdate(peerDoc, Y.encodeStateAsUpdate(doc))
  const position = Y.decodeRelativePosition(
    Uint8Array.from(atob(saved.selection!.relative!.anchor), (c) => c.charCodeAt(0)),
  )
  const peerEndpoint = Y.createAbsolutePositionFromRelativePosition(position, peerDoc)!
  expect(peerEndpoint.type).toBeInstanceOf(Y.XmlText)
  ;(peerEndpoint.type as Y.XmlText).insert(1, 'XX')
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peerDoc))
  await Promise.resolve()
  await Promise.resolve()
  editor.update(() => $setSelection(null), { discrete: true, tag: SKIP_DOM_SELECTION_TAG })
  restoreEditorResume(editor, saved)
  editor.getEditorState().read(() => {
    expect($getRoot().getTextContent()).toBe('XXabcdef')
    const selection = $getSelection()
    expect($isRangeSelection(selection) && selection.anchor.offset).toBe(4)
    expect($isRangeSelection(selection) && selection.focus.offset).toBe(4)
  })
  unregister()
  binding.root.getSharedType().unobserveDeep(remoteUpdate)
  clearEditorResumeCollaboration(editor)
  awareness.destroy()
  doc.destroy()
  peerDoc.destroy()
  editor.setRootElement(null)
  root.remove()
})
