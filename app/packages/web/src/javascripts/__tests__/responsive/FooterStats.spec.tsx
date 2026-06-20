/**
 * @jest-environment jsdom
 *
 * Footer note-stats / connection-status chips.
 *
 * jsdom LIMITATION: the footer gates the verbose note-stats chip to `lg+` with
 * a Tailwind `hidden ... lg:flex` wrapper, and each chip hides parts of itself
 * with `lg:hidden` / `hidden lg:inline`. jsdom does not evaluate that CSS, so we
 * CANNOT assert real visibility at a width. What we verify instead is the
 * *class contract* the responsive design depends on (the elements carry the
 * expected responsive tokens) plus the behavioral guarantee that the
 * connection-status element renders at ALL widths (it is never gated), while the
 * note-stats word/full variants are both present in the DOM for CSS to pick from.
 *
 * Both chips are real components driven by `useNoteStats` / `useConnectionStatus`
 * which only need a tiny slice of WebApplication, so we mount them directly with
 * a minimal fake application rather than the full Footer (an AbstractComponent
 * needing the whole app).
 */
import { createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { act } from 'react'
import NoteStats from '@/Components/Footer/NoteStats'
import ConnectionStatusIndicator from '@/Components/Footer/ConnectionStatus'
import { setViewport, TARGET_WIDTHS } from '@/TestUtils/viewport'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type ActiveControllerObserver = (controller: unknown) => void

const makeNoteStatsApp = (note?: { text: string; noteType?: string }) => {
  let observer: ActiveControllerObserver | undefined
  return {
    app: {
      itemControllerGroup: {
        addActiveControllerChangeObserver: (cb: ActiveControllerObserver) => {
          observer = cb
          return () => {
            observer = undefined
          }
        },
      },
    } as never,
    emitActive: (controller: unknown) => observer?.(controller),
    hasNote: !!note,
  }
}

const makeConnectionApp = (overrides: { online?: boolean; signedOut?: boolean } = {}) =>
  ({
    sync: {
      getSyncStatus: () => ({ hasError: () => false }),
      isOutOfSync: () => false,
      getLastSyncDate: () => undefined,
    },
    sessions: {
      isSignedOut: () => overrides.signedOut ?? true,
    },
    addEventObserver: () => () => undefined,
  }) as never

let container: HTMLElement
let root: Root
let cleanupViewport: () => void = () => undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  cleanupViewport()
})

describe('ConnectionStatus chip (never gated by width)', () => {
  describe.each(TARGET_WIDTHS)('at %ipx', (width) => {
    beforeEach(() => {
      cleanupViewport = setViewport(width)
    })

    it('always renders a status element with a colored dot', () => {
      act(() => {
        root.render(createElement(ConnectionStatusIndicator, { application: makeConnectionApp() }))
      })

      const status = container.querySelector('[role="status"]')
      expect(status).not.toBeNull()
      // The connection dot is always present at every width...
      const dot = status?.querySelector('span.rounded-full')
      expect(dot).not.toBeNull()
      // ...but the textual label is gated to lg by a class contract (the only way
      // jsdom can observe "hide below lg" is the token, not computed display).
      const label = Array.from(status?.querySelectorAll('span') ?? []).find((el) =>
        el.className.includes('lg:inline'),
      )
      expect(label?.className).toContain('hidden')
      expect(label?.className).toContain('lg:inline')
    })
  })
})

describe('NoteStats chip class contract', () => {
  describe.each(TARGET_WIDTHS)('at %ipx', (width) => {
    beforeEach(() => {
      cleanupViewport = setViewport(width)
    })

    it('renders both a narrow (word-only) and wide (full) variant for CSS to choose', () => {
      const { app, emitActive } = makeNoteStatsApp()
      act(() => {
        root.render(createElement(NoteStats, { application: app }))
      })
      // Drive the hook with a note-like active controller so stats compute.
      act(() => {
        emitActive(makeActiveNoteController('hello world\nsecond line'))
      })

      const status = container.querySelector('[role="status"]')
      expect(status).not.toBeNull()

      const spans = Array.from(status?.querySelectorAll('span') ?? [])
      const narrow = spans.find((el) => el.className.includes('lg:hidden'))
      const wide = spans.find((el) => el.className.includes('lg:inline'))

      // Narrow variant: word count only, shown below lg (class contract).
      expect(narrow).toBeDefined()
      expect(narrow?.textContent).toMatch(/\bwords\b/)

      // Wide variant: full compact line, shown at lg+ (class contract).
      expect(wide).toBeDefined()
      expect(wide?.className).toContain('hidden')
      expect(wide?.textContent).toMatch(/chars/)
    })
  })

  it('hides itself entirely when the active item is not a note', () => {
    cleanupViewport = setViewport(1024)
    const { app, emitActive } = makeNoteStatsApp()
    act(() => {
      root.render(createElement(NoteStats, { application: app }))
    })
    act(() => {
      // Emitting a non-note controller should clear stats -> component renders null.
      emitActive({ notANote: true })
    })
    expect(container.querySelector('[role="status"]')).toBeNull()
  })
})

/**
 * Build an object that passes `useNoteStats`' `instanceof NoteViewController`
 * check is NOT possible without the real controller; instead this helper relies
 * on the fact that the hook calls `addNoteInnerValueChangeObserver`. We import
 * the real controller class lazily to satisfy the instanceof guard.
 */
function makeActiveNoteController(text: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { NoteViewController } = require('@/Components/NoteView/Controller/NoteViewController')
  const controller = Object.create(NoteViewController.prototype)
  controller.addNoteInnerValueChangeObserver = (cb: (note: { text: string; noteType?: string }) => void) => {
    cb({ text, noteType: undefined })
    return () => undefined
  }
  return controller
}
