/**
 * @jest-environment jsdom
 *
 * UI-render guard for the SuperExportModal export-format additions (task t46):
 * the new "OpenDocument (.odt)" option and its hint must actually render. This
 * repo has twice shipped toolbar/menu options that were silently filtered out of
 * the DOM (MEMORY: "verify UI render paths"), so we render the real modal and
 * assert the odt path is present end-to-end:
 *  - the export-format Select button shows the selected "OpenDocument (.odt)"
 *    label (proves `odt` is a real item in the dropdown list), and
 *  - the odt-specific hint renders when the format is odt (proves the
 *    `=== 'odt'` branch is reachable).
 * The dialog renders into a body portal, so we assert against document.body.
 */
import { createElement, act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { PrefKey, PrefDefaults } from '@standardnotes/snjs'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import SuperExportModal from './SuperExportModal'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class MockResizeObserver {
  constructor(_cb: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const makeFakeApp = (exportFormat: string) =>
  ({
    getPreference: (key: PrefKey, def: unknown) => (key === PrefKey.SuperNoteExportFormat ? exportFormat : def),
    addEventObserver: () => () => undefined,
    setPreference: () => Promise.resolve(),
    notesController: {
      selectedNotes: [{ text: '' }],
      shouldShowSuperExportModal: true,
      closeSuperExportModal: () => undefined,
      downloadSelectedNotes: () => Promise.resolve(),
    },
    // AndroidBackHandlerProvider deps
    addAndroidBackHandlerEventListener: () => () => undefined,
    setAndroidBackHandlerFallbackListener: () => undefined,
    addNativeMobileEventListener: () => () => undefined,
  }) as never

let container: HTMLElement
let root: Root
let originalAnimate: typeof Element.prototype.animate

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
  // Report prefers-reduced-motion so the modal's enter animation short-circuits
  // (jsdom has no Element.prototype.animate); all other media queries → false.
  window.matchMedia = ((query: string) => ({
    matches: /prefers-reduced-motion/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  // Belt-and-suspenders: jsdom lacks WAAPI; return a resolved fake Animation.
  originalAnimate = Element.prototype.animate
  Element.prototype.animate = function () {
    return {
      finished: Promise.resolve(),
      cancel: () => undefined,
      finish: () => undefined,
      currentTime: 0,
    } as unknown as Animation
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.querySelectorAll('[data-dialog-portal]').forEach((el) => el.remove())
  Element.prototype.animate = originalAnimate
})

const render = (exportFormat: string) => {
  const fakeApp = makeFakeApp(exportFormat)
  act(() => {
    root.render(
      createElement(ApplicationProvider, {
        application: fakeApp,
        children: createElement(AndroidBackHandlerProvider, {
          application: fakeApp,
          children: createElement(SuperExportModal),
        }),
      }),
    )
  })
}

// Sanity: PrefDefaults still resolves (the widened union kept a valid default).
it('keeps a valid default export format', () => {
  expect(['json', 'md', 'html', 'pdf', 'docx', 'odt']).toContain(PrefDefaults[PrefKey.SuperNoteExportFormat])
})

describe('SuperExportModal odt export option', () => {
  it('renders the OpenDocument (.odt) option as the selected format label', () => {
    render('odt')
    // The dialog portal is appended to document.body.
    expect(document.body.textContent).toContain('OpenDocument (.odt)')
  })

  it('renders the odt-specific hint when odt is selected', () => {
    render('odt')
    expect(document.body.textContent).toContain('OpenDocument Text file (.odt)')
  })

  it('does NOT show the odt hint for a different format (guards the hint is conditional)', () => {
    render('md')
    expect(document.body.textContent).not.toContain('OpenDocument Text file (.odt)')
    // ...but the modal itself still rendered.
    expect(document.body.textContent).toContain('Choose export format')
  })
})
