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
  captureEditorResume,
  parseEditorResume,
  restoreEditorResume,
  type EditorResumeState,
} from './EditorResumeState'
import { editorResumeStorageKey, readEditorResume, writeEditorResume } from './EditorResumeStorage'

function fixture(text = 'Private note body') {
  const root = document.createElement('div')
  document.body.append(root)
  const editor = createEditor({
    namespace: 'resume-test',
    onError: (error) => {
      throw error
    },
  })
  editor.setRootElement(root)
  editor.update(
    () => {
      $getRoot().append($createParagraphNode().append($createTextNode(text)))
    },
    { discrete: true },
  )
  return { root, editor }
}

function select(editor: ReturnType<typeof createEditor>, anchor: number, focus: number) {
  editor.update(
    () => {
      const key = $getRoot().getFirstDescendant()!.getKey()
      const selection = $createRangeSelection()
      selection.anchor.set(key, anchor, 'text')
      selection.focus.set(key, focus, 'text')
      $setSelection(selection)
    },
    { discrete: true, tag: SKIP_DOM_SELECTION_TAG },
  )
}

describe('local Super editor resume state', () => {
  afterEach(() => {
    document.body.replaceChildren()
    localStorage.clear()
  })

  it('reopens and reloads a backward selection and scroll despite new Lexical node keys, without focusing', () => {
    const first = fixture()
    select(first.editor, 9, 3)
    first.root.scrollTop = 240
    first.root.scrollLeft = 12
    const saved = captureEditorResume(first.editor)!
    const key = editorResumeStorageKey('app', 'account-a', 'note-a')
    writeEditorResume(key, saved)
    first.editor.setRootElement(null)
    first.root.remove()

    const reopened = fixture()
    const unrelated = document.createElement('button')
    document.body.append(unrelated)
    unrelated.focus()
    restoreEditorResume(reopened.editor, readEditorResume(key)!)
    expect(document.activeElement).toBe(unrelated)
    expect(reopened.root.scrollTop).toBe(240)
    expect(reopened.root.scrollLeft).toBe(12)
    reopened.editor.getEditorState().read(() => {
      const selection = $getSelection()
      expect($isRangeSelection(selection)).toBe(true)
      if ($isRangeSelection(selection)) {
        expect(selection.anchor.offset).toBe(9)
        expect(selection.focus.offset).toBe(3)
        expect(selection.anchor.key).toBe($getRoot().getFirstDescendant()!.getKey())
      }
    })
    expect(JSON.stringify(saved)).not.toContain('Private')
  })

  it('clamps deleted or shortened ordinary content and preserves last selection after blur', () => {
    const first = fixture()
    select(first.editor, 12, 12)
    const saved = captureEditorResume(first.editor)!
    first.editor.update(() => $setSelection(null), { discrete: true })
    first.root.scrollTop = 450
    const blurred = captureEditorResume(first.editor, saved)!
    expect(blurred.selection).toEqual(saved.selection)
    expect(blurred.scroll.rootTop).toBe(450)
    const changed = fixture('Short')
    restoreEditorResume(changed.editor, blurred)
    changed.editor.getEditorState().read(() => {
      const selection = $getSelection()
      expect($isRangeSelection(selection) && selection.anchor.offset).toBe(5)
    })
  })

  it('scopes each note to its account, application and local device', () => {
    const base = editorResumeStorageKey('app', 'account-a', 'note-a')
    const keys = [
      base,
      editorResumeStorageKey('app', 'account-b', 'note-a'),
      editorResumeStorageKey('other-app', 'account-a', 'note-a'),
      editorResumeStorageKey('app', 'account-a', 'note-b'),
    ]
    expect(new Set(keys).size).toBe(4)
    expect(editorResumeStorageKey('app', 'account-a', 'note-a')).toBe(base)
    const state: EditorResumeState = { version: 1, scroll: { rootTop: 4, rootLeft: 0, outerTop: 0, outerLeft: 0 } }
    writeEditorResume(base, state)
    expect(readEditorResume(keys[1])).toBeUndefined()
  })

  it('keeps the active tab bookmark when an older tab flushes after a remote update or unmount', () => {
    const key = editorResumeStorageKey('app', 'account-a', 'tab-shared-note')
    const active: EditorResumeState = {
      version: 1,
      lastInteractionAt: 2000,
      scroll: { rootTop: 600, rootLeft: 0, outerTop: 0, outerLeft: 0 },
    }
    writeEditorResume(key, active)
    writeEditorResume(key, {
      version: 1,
      lastInteractionAt: 1000,
      scroll: { rootTop: 20, rootLeft: 0, outerTop: 0, outerLeft: 0 },
    })
    expect(readEditorResume(key)).toEqual(active)
  })

  it('rejects corrupt or oversized metadata and strips arbitrary content fields', () => {
    expect(parseEditorResume('{')).toBeUndefined()
    expect(parseEditorResume(JSON.stringify({ version: 1, scroll: { rootTop: -1 } }))).toBeUndefined()
    expect(parseEditorResume('x'.repeat(12001))).toBeUndefined()
    const value = {
      version: 1,
      text: 'plaintext',
      scroll: { rootTop: 1, rootLeft: 0, outerTop: 0, outerLeft: 0, secret: 'plaintext' },
      selection: {
        anchor: { path: [0, 0], offset: 2, type: 'text', text: 'plaintext' },
        focus: { path: [0, 0], offset: 2, type: 'text' },
      },
    }
    expect(JSON.stringify(parseEditorResume(JSON.stringify(value)))).not.toContain('plaintext')
    value.selection.anchor.offset = -2
    expect(parseEditorResume(JSON.stringify(value))).toBeUndefined()
  })
})
