/** @jest-environment jsdom */
// Exercise Lexical's real beforeinput listener; JSDOM omits this browser capability.
jest.mock('lexical', () => {
  Object.defineProperty(InputEvent.prototype, 'getTargetRanges', { configurable: true, value: () => [] })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect() })
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
  return jest.requireActual('lexical')
})
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { registerRichText } from '@lexical/rich-text'
import { createEmptyHistoryState, registerHistory } from '@lexical/history'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  BEFORE_INPUT_COMMAND,
  COMMAND_PRIORITY_NORMAL,
  CONTROLLED_TEXT_INSERTION_COMMAND,
  KEY_BACKSPACE_COMMAND,
  UNDO_COMMAND,
  REDO_COMMAND,
  type LexicalEditor,
} from 'lexical'
import AutoPairPlugin from './AutoPairPlugin'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AutoPairPlugin native input', () => {
  let editor: LexicalEditor
  let editable: HTMLDivElement
  let root: Root
  let container: HTMLDivElement

  function Fixture() {
    const [current] = useLexicalComposerContext()
    useEffect(() => {
      editor = current
      editable = document.createElement('div')
      editable.contentEditable = 'true'
      editable.tabIndex = 0
      document.body.append(editable)
      editor.setRootElement(editable)
      const stop = registerRichText(editor)
      const stopHistory = registerHistory(editor, createEmptyHistoryState(), 250)
      return () => {
        stopHistory()
        stop()
        editor.setRootElement(null)
        editable.remove()
      }
    }, [current])
    return createElement(AutoPairPlugin)
  }

  beforeEach(async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        createElement(
          LexicalComposer,
          {
            initialConfig: {
              namespace: 'NativeAutoPair',
              onError: (error: Error) => {
                throw error
              },
            },
          },
          createElement(Fixture),
        ),
      )
    })
    editable.focus()
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const type = async (data: string) => {
    const event = new InputEvent('beforeinput', { inputType: 'insertText', data, bubbles: true, cancelable: true })
    await act(async () => {
      editable.dispatchEvent(event)
      editor.update(() => {}, { discrete: true })
    })
    return event
  }
  const text = () => editor.getEditorState().read(() => $getRoot().getTextContent())

  it('inserts exactly two quotes in an empty paragraph and types over the closer', async () => {
    editor.update(
      () => {
        const paragraph = $createParagraphNode()
        $getRoot().clear().append(paragraph)
        paragraph.select()
      },
      { discrete: true },
    )
    await type('"')
    expect(text()).toBe('""')
    await type('"')
    expect(text()).toBe('""')
  })

  it('wraps a selected word once instead of deleting it or adding a third quote', async () => {
    editor.update(
      () => {
        const word = $createTextNode('hello')
        $getRoot().clear().append($createParagraphNode().append(word))
        word.select(0, 5)
      },
      { discrete: true },
    )
    await type('"')
    expect(text()).toBe('"hello"')
    expect(editor.getEditorState().read(() => $getSelection()?.getTextContent())).toBe('hello')
  })

  it('wraps across formatting runs while preserving both formats and selected text', async () => {
    editor.update(
      () => {
        const first = $createTextNode('hello ').toggleFormat('bold')
        const last = $createTextNode('world').toggleFormat('italic')
        $getRoot().clear().append($createParagraphNode().append(first, last))
        const selection = first.select(0, 0)
        selection.focus.set(last.getKey(), 5, 'text')
      },
      { discrete: true },
    )
    await type('"')
    expect(text()).toBe('"hello world"')
    expect(editor.getEditorState().read(() => $getSelection()?.getTextContent())).toBe('hello world')
    expect(
      editor.getEditorState().read(() =>
        $getRoot()
          .getAllTextNodes()
          .filter((node) => node.hasFormat('bold'))
          .map((node) => node.getTextContent())
          .join(''),
      ),
    ).toContain('hello')
    expect(
      editor.getEditorState().read(() =>
        $getRoot()
          .getAllTextNodes()
          .filter((node) => node.hasFormat('italic'))
          .map((node) => node.getTextContent())
          .join(''),
      ),
    ).toContain('world')
  })

  it.each(["'", '"', '`', '('])('wraps backward selections with %s and preserves their direction', async (open) => {
    editor.update(
      () => {
        const word = $createTextNode('before hello after')
        $getRoot().clear().append($createParagraphNode().append(word))
        word.select(12, 7)
      },
      { discrete: true },
    )
    await type(open)
    expect(text()).toBe(`before ${open}hello${open === '(' ? ')' : open} after`)
    expect(editor.getEditorState().read(() => $getSelection()?.getTextContent())).toBe('hello')
    expect(
      editor.getEditorState().read(() => {
        const selection = $getSelection()
        return $isRangeSelection(selection) && selection.isBackward()
      }),
    ).toBe(true)
  })

  it('wraps text across paragraphs while preserving the block boundaries', async () => {
    editor.update(
      () => {
        const first = $createTextNode('first')
        const last = $createTextNode('last')
        $getRoot().clear().append($createParagraphNode().append(first), $createParagraphNode().append(last))
        const selection = first.select(0, 0)
        selection.focus.set(last.getKey(), 4, 'text')
      },
      { discrete: true },
    )
    await type('"')
    expect(text()).toBe('"first\n\nlast"')
    expect(editor.getEditorState().read(() => $getRoot().getChildrenSize())).toBe(2)
  })

  it('makes wrapping one undo step and restores it with redo', async () => {
    editor.update(
      () => {
        const word = $createTextNode('hello')
        $getRoot().clear().append($createParagraphNode().append(word))
        word.select(0, 5)
      },
      { discrete: true },
    )
    await type('"')
    await act(async () => {
      editor.dispatchCommand(UNDO_COMMAND, undefined)
    })
    expect(text()).toBe('hello')
    await act(async () => {
      editor.dispatchCommand(REDO_COMMAND, undefined)
    })
    expect(text()).toBe('"hello"')
  })

  it('handles controlled input once and removes an empty pair with one backspace', async () => {
    editor.update(
      () => {
        const p = $createParagraphNode()
        $getRoot().clear().append(p)
        p.select()
      },
      { discrete: true },
    )
    await act(async () => {
      editor.dispatchCommand(CONTROLLED_TEXT_INSERTION_COMMAND, '"')
    })
    expect(text()).toBe('""')
    await act(async () => {
      editor.dispatchCommand(KEY_BACKSPACE_COMMAND, new KeyboardEvent('keydown', { key: 'Backspace' }))
    })
    expect(text()).toBe('')
  })

  it.each(['insertReplacementText', 'insertFromPaste', 'insertCompositionText'])(
    'does not auto-pair %s events',
    (inputType) => {
      editor.update(
        () => {
          const word = $createTextNode('hello')
          $getRoot().clear().append($createParagraphNode().append(word))
          word.select(0, 5)
        },
        { discrete: true },
      )
      const event = new InputEvent('beforeinput', { inputType, data: '"', cancelable: true })
      // Stop after our listener if it declines, so this checks only pairing (not JSDOM's IME implementation).
      const stop = editor.registerCommand(BEFORE_INPUT_COMMAND, () => true, COMMAND_PRIORITY_NORMAL)
      editor.dispatchCommand(BEFORE_INPUT_COMMAND, event)
      editor.update(() => {}, { discrete: true })
      stop()
      expect(text()).toBe('hello')
      expect(event.defaultPrevented).toBe(false)
    },
  )
})
