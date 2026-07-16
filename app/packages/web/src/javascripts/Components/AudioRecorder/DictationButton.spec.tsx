/**
 * @jest-environment jsdom
 *
 * Render contract for the editor toolbar `DictationButton` (task t65): its idle
 * "voice" glyph must be the monochrome microphone SVG (`MicIcon`, `mic`), NOT the
 * `file-music` music-note glyph it used before — that glyph read as an odd,
 * decorative "colored emoji" among the app's line icons.
 *
 * We render the REAL `Icon` (so `mic` genuinely resolves to `MicIcon`) and mock
 * only the dictation settings/recognition modules so the button leaves its
 * self-hiding state and renders in the idle state. This proves the microphone
 * renders at runtime, not merely that the name typechecks (repo memory: web
 * tsc/tests green != it renders).
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import DictationButton from '@/Components/AudioRecorder/DictationButton'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// DictationButton returns null unless dictation is opted-in AND the browser
// supports SpeechRecognition. Mock both so it renders in the idle state; keep the
// real Icon so `mic` actually resolves to MicIcon.
jest.mock('@/Assistant/dictationSettings', () => ({
  loadDictationSettings: () => ({ dictationEnabled: true, language: '' }),
}))
jest.mock('@/Assistant/transcription', () => ({
  getSpeechRecognitionCtor: () => function () {},
}))
jest.mock('@/Assistant/dictation', () => ({
  startDictation: () => ({ stop() {} }),
}))
jest.mock('@/Assistant/insertEditorText', () => ({
  insertTextIntoActiveEditor: () => true,
}))

// MicIcon's first (signature) path — MediaIcons.tsx:36. FileMusicIcon (the old
// glyph) has no such path, so its presence proves the microphone rendered.
const MIC_SIGNATURE_PATH = 'M12 14a3 3'

let container: HTMLElement
let root: Root

beforeEach(() => {
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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = () => {
  act(() => {
    root.render(createElement(DictationButton))
  })
}

describe('DictationButton idle voice icon', () => {
  it('renders the mic toggle in the idle state', () => {
    render()
    const button = container.querySelector('button[aria-label="Start dictation"]')
    expect(button).not.toBeNull()
  })

  it('renders the microphone SVG (MicIcon), not the file-music glyph', () => {
    render()
    const micPath = container.querySelector(`svg path[d^="${MIC_SIGNATURE_PATH}"]`)
    expect(micPath).not.toBeNull()
  })

  it('resolves the icon to a real SVG (no emoji/text <label> fallback)', () => {
    render()
    // Icon.tsx renders a <label> holding the raw name only when the name does not
    // resolve to an SVG. `mic` resolves, so there must be no such fallback.
    expect(container.querySelector('label')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })
})
