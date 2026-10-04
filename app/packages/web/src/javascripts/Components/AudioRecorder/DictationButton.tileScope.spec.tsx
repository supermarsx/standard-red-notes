/**
 * @jest-environment jsdom
 *
 * Standard Red Notes (t112): live dictation must type into the note whose toolbar the mic
 * was pressed in.
 *
 * DictationButton is rendered once per open note (editor toolbar, inside a NoteView
 * tile), and from the second open tab onward every tile stays mounted. The button holds
 * no note identity, so it identifies its note by its own DOM position — the real
 * `insertEditorText` is used here, unmocked, precisely so that threading is proven end to
 * end rather than assumed.
 *
 * Two tiles are mounted in every test: with one tile the document-wide editor lookup and
 * the tile-scoped one return the same element and the bug is invisible.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { ElementIds } from '@/Constants/ElementIDs'
import { PRINT_NOTE_VIEW_ATTRIBUTE } from '@/Components/NoteView/Print/PrintNote'
import DictationButton from '@/Components/AudioRecorder/DictationButton'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

jest.mock('@/Assistant/dictationSettings', () => ({
  loadDictationSettings: () => ({ dictationEnabled: true, language: '' }),
}))
jest.mock('@/Assistant/transcription', () => ({
  getSpeechRecognitionCtor: () => function () {},
}))

/** Captures the recogniser callback the button installs, so a final segment can be fed in. */
let onFinalText: ((text: string) => void) | undefined
jest.mock('@/Assistant/dictation', () => ({
  startDictation: (options: { onFinalText: (text: string) => void }) => {
    onFinalText = options.onFinalText
    return { stop() {} }
  },
}))

type Tile = { root: HTMLElement; textarea: HTMLTextAreaElement }

const mountTile = (uuid: string): Tile => {
  const root = document.createElement('div')
  root.setAttribute(PRINT_NOTE_VIEW_ATTRIBUTE, uuid)
  const textarea = document.createElement('textarea')
  textarea.id = ElementIds.NoteTextEditor
  root.appendChild(textarea)
  document.body.appendChild(root)
  return { root, textarea }
}

let root: Root

beforeEach(() => {
  document.body.innerHTML = ''
  onFinalText = undefined
  // StyledTooltip -> useMediaQuery reads window.matchMedia, absent in jsdom.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  // execCommand is absent in jsdom; reporting failure exercises the manual textarea
  // splice, which makes the written-to element observable by its own value.
  Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
})

afterEach(() => {
  act(() => root.unmount())
})

describe('dictation from the second open note’s toolbar', () => {
  it('types into its own tile’s editor, not the first open note’s', () => {
    const first = mountTile('note-1')
    const second = mountTile('note-2')
    // The toolbar the user pressed belongs to the second tile.
    const container = document.createElement('div')
    second.root.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(createElement(DictationButton))
    })
    // The premise: an id lookup cannot tell the tiles apart and answers the first.
    expect(document.getElementById(ElementIds.NoteTextEditor)).toBe(first.textarea)

    const button = container.querySelector('button[aria-label="Start dictation"]') as HTMLButtonElement
    act(() => {
      button.click()
    })
    expect(onFinalText).toBeDefined()
    act(() => {
      onFinalText?.('spoken words')
    })

    expect(second.textarea.value).toBe('spoken words')
    expect(first.textarea.value).toBe('')
  })
})
