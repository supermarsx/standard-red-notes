/**
 * @jest-environment jsdom
 *
 * Standard Red Notes (t112): a PlainEditor must focus ITS OWN textarea.
 *
 * The tiled editor mounts one NoteView — and therefore one PlainEditor — per open note,
 * and all of them render `ElementIds.NoteTextEditor`. While `focusEditor()` was
 * `document.getElementById(ElementIds.NoteTextEditor)?.focus()` it focused whichever
 * note was FIRST in the document, even though both routes that reach it are already
 * per instance: `useImperativeHandle` (NoteView's `plainEditorRef`, which is how pressing
 * Enter in the title moves down into the body) and the template-note autofocus effect.
 * Renaming a title and pressing Enter therefore put the cursor into a DIFFERENT note's
 * text — the same user-visible "it unfocuses me mid writing" as NoteView#focusTitle, one
 * component further down.
 *
 * Every test here mounts TWO editors, because with one textarea in the document an id
 * lookup and a ref are indistinguishable.
 */
import { WebApplication } from '@/Application/WebApplication'
import { SNNote } from '@standardnotes/snjs'
import { act, createElement, createRef, RefObject } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { NoteViewController } from '../Controller/NoteViewController'
import { PlainEditor, PlainEditorInterface } from './PlainEditor'

jest.mock('@/Utils/getPlaintextFontSize', () => ({
  useResponsiveEditorFontSize: () => '',
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Tile = {
  ref: RefObject<PlainEditorInterface | null>
  textarea: () => HTMLTextAreaElement | null
  application: WebApplication
  root: Root
  container: HTMLElement
  showPreview: () => void
}

const mounted: Tile[] = []

/** One open note: its own controller, its own PlainEditor, its own container. */
const mountEditor = ({ uuid, autofocus = false }: { uuid: string; autofocus?: boolean }): Tile => {
  const note = {
    uuid,
    text: '',
    locked: false,
    editorIdentifier: 'org.standardnotes.plain-editor',
    noteType: 'plain',
  } as unknown as SNNote

  const controller = {
    item: note,
    isTemplateNote: autofocus,
    templateNoteOptions: autofocus ? { autofocusBehavior: 'editor' } : undefined,
    addNoteInnerValueChangeObserver: jest.fn(() => jest.fn()),
    saveAndAwaitLocalPropagation: jest.fn(),
  } as unknown as NoteViewController

  const application = {
    notifyWebEvent: jest.fn(),
    addWebEventObserver: jest.fn(() => jest.fn()),
    addEventObserver: jest.fn(() => jest.fn()),
    preferences: { getLocalValue: jest.fn(() => undefined) },
    keyboardService: { addCommandHandler: jest.fn(() => jest.fn()) },
  } as unknown as WebApplication

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const ref = createRef<PlainEditorInterface>()

  act(() => {
    root.render(
      createElement(PlainEditor, {
        ref,
        application,
        controller,
        spellcheck: false,
        locked: false,
        onFocus: jest.fn(),
        onBlur: jest.fn(),
      }),
    )
  })

  const tile: Tile = {
    ref,
    textarea: () => container.querySelector('textarea'),
    application,
    root,
    container,
    showPreview: () => {
      const toggle = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Markdown preview',
      )
      if (!toggle) {
        throw new Error('The markdown preview toggle is not rendered')
      }
      act(() => toggle.click())
    },
  }
  mounted.push(tile)
  return tile
}

/** The element this tile actually attached its Tab-to-spaces handler to. */
const tabHandlerElementOf = (tile: Tile): HTMLElement | undefined => {
  const calls = jest.mocked(tile.application.keyboardService.addCommandHandler).mock.calls
  expect(calls).toHaveLength(1)
  return calls[0][0].element as HTMLElement | undefined
}

const textareaOf = (tile: Tile): HTMLTextAreaElement => {
  const element = tile.textarea()
  if (!element) {
    throw new Error('This tile is not showing a textarea')
  }
  return element
}

afterEach(() => {
  act(() => {
    while (mounted.length > 0) {
      const tile = mounted.pop()
      tile?.root.unmount()
      tile?.container.remove()
    }
  })
  jest.clearAllMocks()
})

describe('focusing the plain body with more than one note open', () => {
  it('focuses the second tile’s own textarea, leaving the first tile untouched', () => {
    const first = mountEditor({ uuid: 'note-1' })
    const second = mountEditor({ uuid: 'note-2' })

    // The premise, asserted so it cannot quietly stop holding: both tiles render the
    // same id, and an id lookup answers the first tile.
    expect(document.querySelectorAll('#note-text-editor')).toHaveLength(2)
    expect(document.getElementById('note-text-editor')).toBe(textareaOf(first))

    act(() => second.ref.current?.focus())

    expect(document.activeElement).toBe(textareaOf(second))
    expect(document.activeElement).not.toBe(textareaOf(first))
  })

  it('focuses the first tile’s textarea when it is the first tile asking', () => {
    const first = mountEditor({ uuid: 'note-1' })
    const second = mountEditor({ uuid: 'note-2' })

    act(() => second.ref.current?.focus())
    expect(document.activeElement).toBe(textareaOf(second))

    act(() => first.ref.current?.focus())

    expect(document.activeElement).toBe(textareaOf(first))
  })

  it('autofocuses a new note’s own body rather than the note already open', () => {
    // The real sequence behind the bug: a note is already open, a new plain note opens
    // beside it and autofocuses its editor.
    const alreadyOpen = mountEditor({ uuid: 'note-1' })
    const brandNew = mountEditor({ uuid: 'note-2', autofocus: true })

    expect(document.activeElement).toBe(textareaOf(brandNew))
    expect(document.activeElement).not.toBe(textareaOf(alreadyOpen))
  })

  it('installs each tile’s tab handler on that tile’s own textarea', () => {
    const first = mountEditor({ uuid: 'note-1' })
    const second = mountEditor({ uuid: 'note-2' })

    // `toBe`, not `toHaveBeenCalledWith(objectContaining(...))`: two freshly mounted
    // textareas are structurally identical, so jest's deep equality cannot tell them
    // apart and that assertion passes against the wrong element.
    expect(tabHandlerElementOf(first)).toBe(textareaOf(first))
    expect(tabHandlerElementOf(second)).toBe(textareaOf(second))
  })

  it('focuses nothing at all while this tile is showing its markdown preview', () => {
    // "Nothing of mine to focus" is the honest answer; the id lookup's answer was
    // "focus someone else's".
    const first = mountEditor({ uuid: 'note-1' })
    const second = mountEditor({ uuid: 'note-2' })
    second.showPreview()
    expect(second.textarea()).toBeNull()

    act(() => second.ref.current?.focus())

    expect(document.activeElement).not.toBe(textareaOf(first))
  })
})
