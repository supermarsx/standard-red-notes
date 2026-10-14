/** @jest-environment jsdom */
import { act, useCallback, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  SKIP_DOM_SELECTION_TAG,
  type LexicalEditor,
} from 'lexical'
import { EditorResumePlugin } from './EditorResumePlugin'
import { readEditorResume, writeEditorResume } from './EditorResumeStorage'
import type { EditorResumeState } from './EditorResumeState'

jest.mock('./EditorResumeStorage', () => ({ readEditorResume: jest.fn(), writeEditorResume: jest.fn() }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const saved: EditorResumeState = {
  version: 1,
  scroll: { rootTop: 230, rootLeft: 0, outerTop: 0, outerLeft: 0 },
  selection: { anchor: { path: [0, 0], offset: 4, type: 'text' }, focus: { path: [0, 0], offset: 2, type: 'text' } },
}
let editor: LexicalEditor
function EditorRoot() {
  const [current] = useLexicalComposerContext()
  useEffect(() => {
    editor = current
  }, [current])
  const ref = useCallback((element: HTMLDivElement | null) => current.setRootElement(element), [current])
  return <div ref={ref} tabIndex={0} data-testid="resume-root" />
}
function Harness({ ready }: { ready: boolean }) {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'resume-plugin',
        onError: (error) => {
          throw error
        },
        editorState: () => {
          $getRoot().append($createParagraphNode().append($createTextNode('abcdefghij')))
        },
      }}
    >
      <EditorRoot />
      <EditorResumePlugin storageKey="account-device-note" ready={ready} />
    </LexicalComposer>
  )
}

describe('canonical editor resume lifecycle', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()
    jest.mocked(readEditorResume).mockReturnValue(saved)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.replaceChildren()
    jest.useRealTimers()
  })

  it('waits for canonical readiness and its paint, preserving focus outside the editor', async () => {
    const button = document.createElement('button')
    document.body.append(button)
    button.focus()
    await act(async () => root.render(<Harness ready={false} />))
    await act(async () => jest.advanceTimersByTime(32))
    expect(editor.getRootElement()!.scrollTop).toBe(0)
    expect(readEditorResume).not.toHaveBeenCalled()
    await act(async () => root.render(<Harness ready />))
    expect(editor.getRootElement()!.scrollTop).toBe(0)
    await act(async () => jest.advanceTimersByTime(32))
    expect(editor.getRootElement()!.scrollTop).toBe(230)
    expect(document.activeElement).toBe(button)
    editor.getEditorState().read(() => expect($getSelection()).toBeNull())
    // Genuine focus (for example Tab from the note list) applies the staged
    // caret without letting a background document update take focus first.
    editor.getRootElement()!.focus()
    editor.getEditorState().read(() => {
      const selection = $getSelection()
      expect($isRangeSelection(selection) && selection.anchor.offset).toBe(4)
      expect($isRangeSelection(selection) && selection.focus.offset).toBe(2)
    })
  })

  it('captures the latest selection and scrolling during root teardown even before a pending paint', async () => {
    await act(async () => root.render(<Harness ready />))
    await act(async () => jest.advanceTimersByTime(32))
    editor.getRootElement()!.focus()
    editor.getRootElement()!.dispatchEvent(new Event('pointerdown'))
    editor.update(
      () => {
        const key = $getRoot().getFirstDescendant()!.getKey()
        const selection = $createRangeSelection()
        selection.anchor.set(key, 7, 'text')
        selection.focus.set(key, 7, 'text')
        $setSelection(selection)
      },
      { discrete: true, tag: SKIP_DOM_SELECTION_TAG },
    )
    editor.getRootElement()!.scrollTop = 290
    editor.getRootElement()!.dispatchEvent(new Event('scroll'))
    await act(async () => root.render(null))
    const last = jest.mocked(writeEditorResume).mock.calls.at(-1)!
    expect(last[0]).toBe('account-device-note')
    expect(last[1].scroll.rootTop).toBe(290)
    expect(last[1].selection!.anchor.offset).toBe(7)
  })

  it('does not replay an old position on an ordinary transport reconnect in the same editor', async () => {
    await act(async () => root.render(<Harness ready />))
    await act(async () => jest.advanceTimersByTime(32))
    editor.getRootElement()!.scrollTop = 80
    await act(async () => root.render(<Harness ready={false} />))
    await act(async () => root.render(<Harness ready />))
    await act(async () => jest.advanceTimersByTime(32))
    expect(editor.getRootElement()!.scrollTop).toBe(80)
  })

  it('does not give a background remote update or its teardown ownership of the bookmark', async () => {
    await act(async () => root.render(<Harness ready />))
    await act(async () => jest.advanceTimersByTime(48))
    editor.update(
      () => {
        $getRoot().append($createParagraphNode().append($createTextNode('Remote addition')))
      },
      { discrete: true, tag: 'collaboration' },
    )
    await act(async () => jest.advanceTimersByTime(32))
    await act(async () => root.render(null))
    expect(writeEditorResume).not.toHaveBeenCalled()
  })

  it('preserves the last live viewport when Lexical clears DOM and the browser clamps scroll before root teardown', async () => {
    await act(async () => root.render(<Harness ready />))
    await act(async () => jest.advanceTimersByTime(48))
    const content = editor.getRootElement()!
    let liveTop = 230
    Object.defineProperty(content, 'scrollTop', {
      configurable: true,
      get: () => (content.hasChildNodes() ? liveTop : 0),
      set: (value) => {
        liveTop = value
      },
    })
    content.focus()
    content.scrollTop = 460
    content.dispatchEvent(new Event('scroll'))
    // Actual Lexical teardown clears root children before invoking root listeners.
    editor.setRootElement(null)
    expect(content.scrollTop).toBe(0)
    expect(jest.mocked(writeEditorResume).mock.calls.at(-1)![1].scroll.rootTop).toBe(460)
  })

  it('does not flush a browser-clamped empty root during passive cleanup or a queued capture', async () => {
    await act(async () => root.render(<Harness ready />))
    await act(async () => jest.advanceTimersByTime(48))
    const content = editor.getRootElement()!
    content.focus()
    content.scrollTop = 520
    content.dispatchEvent(new Event('scroll'))
    await act(async () => jest.advanceTimersByTime(32))
    const lastGood = jest.mocked(writeEditorResume).mock.calls.at(-1)![1]
    expect(lastGood.scroll.rootTop).toBe(520)
    content.replaceChildren()
    content.scrollTop = 0
    // This event exercises the passive flush while Lexical still references
    // the cleared root, before its later root-null teardown callback.
    window.dispatchEvent(new Event('pagehide'))
    expect(jest.mocked(writeEditorResume).mock.calls.at(-1)![1]).toEqual(lastGood)
    editor.setRootElement(null)
    expect(jest.mocked(writeEditorResume).mock.calls.at(-1)![1].scroll.rootTop).toBe(520)
  })

  it('keeps the latest intentional viewport when native focus clamps before applying the staged caret', async () => {
    const button = document.createElement('button')
    document.body.append(button)
    button.focus()
    await act(async () => root.render(<Harness ready />))
    await act(async () => jest.advanceTimersByTime(48))
    const content = editor.getRootElement()!
    expect(content.scrollTop).toBe(230)
    // The reader scrolls after reopening, before entering the editor. This new
    // position must win over the original saved viewport.
    content.scrollTop = 410
    content.dispatchEvent(new Event('scroll'))
    await act(async () => jest.advanceTimersByTime(32))
    // Chromium can move to zero as native focus enters a new editable root.
    content.scrollTop = 0
    content.focus()
    expect(content.scrollTop).toBe(410)
    editor.getEditorState().read(() => {
      const selection = $getSelection()
      expect($isRangeSelection(selection) && selection.anchor.offset).toBe(4)
    })
    expect(document.activeElement).toBe(content)
  })
})
