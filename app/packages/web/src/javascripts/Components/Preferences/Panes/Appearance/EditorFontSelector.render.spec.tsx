/**
 * @jest-environment jsdom
 *
 * Standard Red Notes: VANISH GUARD for the editor-font picker in
 * Preferences → Appearance.
 *
 * `editorFont.spec.ts` proves the resolution and loading helpers behave. It
 * proves nothing about whether a user can SEE or REACH the bundled fonts: this
 * is the only surface that offers them, so if the control is not in this pane
 * the feature does not exist. This repo has twice shipped a control that
 * typechecked, passed its unit tests and rendered nowhere.
 *
 * It also pins the LEGACY-VALUE behaviour at the UI level: a preference saved as
 * `google:Open Sans` by an older build must open on the bundled "Open Sans"
 * entry, not on an empty box, and must not be rewritten just by opening the
 * pane.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { PrefKey } from '@standardnotes/snjs'

const prefs = new Map<string, unknown>()
const localPrefs = new Map<string, unknown>()
const setPreference = jest.fn(async () => undefined)

const application = {
  getPreference: (key: string, defaultValue?: unknown) => (prefs.has(key) ? prefs.get(key) : defaultValue),
  setPreference,
  addEventObserver: () => () => undefined,
  preferences: {
    getLocalValue: (key: string, defaultValue?: unknown) => (localPrefs.has(key) ? localPrefs.get(key) : defaultValue),
    setLocalValue: jest.fn(),
  },
} as unknown as import('@/Application/WebApplication').WebApplication

jest.mock('@/Components/ApplicationProvider', () => ({
  useApplication: () => application,
}))

import EditorAppearance from './EditorAppearance'
import { BundledEditorFonts } from '@/Utils/editorFont'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

const mount = () => {
  act(() => {
    root = createRoot(container)
    root.render(createElement(EditorAppearance, { application }))
  })
}

beforeAll(() => {
  // The pane's media-query and native-mobile touchpoints are absent in jsdom.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  })
})

beforeEach(() => {
  prefs.clear()
  localPrefs.clear()
  setPreference.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** The visible text of every <option>/listbox row the pane rendered. */
const renderedText = () => container.textContent ?? ''

describe('EditorFontSelector renders the bundled-font path', () => {
  it('offers a "Bundled font" source, and no longer offers the Google Font source', () => {
    mount()
    const text = renderedText()
    expect(text).toContain('Bundled font')
    // The removed network path must not come back by accident.
    expect(text).not.toContain('Google Font')
    expect(text).not.toContain('fonts.googleapis.com')
  })

  it('opens on the bundled picker for a LEGACY google: preference, showing that family', () => {
    prefs.set(PrefKey.EditorFontFamily, 'google:Open Sans')
    mount()

    const text = renderedText()
    // The mode dropdown's button shows the selected source...
    expect(text).toContain('Bundled font')
    // ...and the font dropdown's button shows the mapped family, NOT a blank.
    expect(text).toContain('Open Sans')
  })

  it('does not rewrite a stored legacy value merely by rendering the pane', () => {
    prefs.set(PrefKey.EditorFontFamily, 'google:Open Sans')
    mount()
    expect(setPreference).not.toHaveBeenCalled()
  })

  it('opens on the bundled picker for a stored stack written by this build', () => {
    prefs.set(PrefKey.EditorFontFamily, "'JetBrains Mono', monospace")
    mount()

    const text = renderedText()
    expect(text).toContain('Bundled font')
    expect(text).toContain('JetBrains Mono')
  })

  it('still offers the local/system and built-in sources', () => {
    mount()
    const text = renderedText()
    expect(text).toContain('Local / system font')
    expect(text).toContain('Built-in font')
    expect(text).toContain('Default (theme)')
  })

  it('states how many bundled fonts are offered, matching the catalog', () => {
    prefs.set(PrefKey.EditorFontFamily, 'google:Open Sans')
    mount()
    expect(BundledEditorFonts.length).toBeGreaterThan(30)
    expect(renderedText()).toContain(`${BundledEditorFonts.length} open-source fonts`)
  })
})
