/**
 * @jest-environment jsdom
 *
 * The ribbon tab strip is CENTRED on the utility bar, and falls back to flush
 * right only when the bar is too narrow to spend space on centring (t111-e8,
 * job 3). The point is mouse travel: the tabs are a frequent target and the right
 * edge of a wide editor is a long trip from the text.
 *
 * Centring is pure CSS — two symmetric flexible siblings around the strip, with a
 * container query hiding the trailing one below a 56rem bar. It is deliberately
 * NOT a measured width: jsdom has no layout engine (every width reads 0), so a JS
 * breakpoint could not be gated in jest at all, and a width-measuring effect in
 * this file is the shape of bug that becomes "Maximum update depth exceeded".
 *
 * So what jsdom CAN prove is asserted here, on the mounted real ToolbarPlugin:
 * the three flex children exist, in the order that makes the arithmetic work, and
 * carry the exact utilities the centring depends on. What jsdom cannot prove —
 * that those utilities compile to CSS at all — is the silent-failure mode of this
 * change (Tailwind v4 emits a utility only when it appears LITERALLY in a scanned
 * file, and tailwind.config.js scans only .tsx under src/javascripts), so the
 * class strings are asserted as literals present in the source too. They were
 * additionally compiled through the project's own Tailwind pipeline, which emits
 * `@container utility-bar (width < 56rem) { display: none }` for the spacer and
 * nothing at all for a breakpoint that is not written in the source.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { LocalPrefDefaults, LocalPrefKey, PrefDefaults, PrefKey } from '@standardnotes/snjs'
import { BlocksEditorComposer } from '../../BlocksEditorComposer'
import ToolbarPlugin from './ToolbarPlugin'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import { ToolbarButtonId } from './ToolbarConfig'

jest.mock('@/Hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
  MutuallyExclusiveMediaQueryBreakpoints: { sm: 'sm', md: 'md' },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Everything outside the Home tab, so only one ribbon tab survives. */
const NON_HOME_BUTTON_IDS: string[] = [
  ToolbarButtonId.Link,
  ToolbarButtonId.NoteFromSelection,
  ToolbarButtonId.Dictation,
  ToolbarButtonId.AI,
  ToolbarButtonId.PageSize,
  ToolbarButtonId.PageOrientation,
  ToolbarButtonId.PageMargins,
  ToolbarButtonId.PageColumns,
  ToolbarButtonId.PageHeaderFooter,
  ToolbarButtonId.Search,
  ToolbarButtonId.FindReplace,
  ToolbarButtonId.FindNext,
  ToolbarButtonId.TableOfContents,
  ToolbarButtonId.SelectAll,
  ToolbarButtonId.SelectAllText,
  ToolbarButtonId.Deselect,
  ToolbarButtonId.FormatPainter,
  ToolbarButtonId.CustomizeToolbar,
]

const makeFakeApp = (toolbarConfig?: unknown) =>
  ({
    getPreference: (key: string, fallback: unknown) => {
      if (key === PrefKey.AlwaysShowSuperToolbar) {
        return true
      }
      return PrefDefaults[key as PrefKey] ?? fallback
    },
    preferences: {
      getLocalValue: (key: string, fallback: unknown) => {
        if (key === LocalPrefKey.SuperToolbarConfig && toolbarConfig !== undefined) {
          return toolbarConfig
        }
        return LocalPrefDefaults[key as never] ?? fallback
      },
      setLocalValue: () => undefined,
    },
    addEventObserver: () => () => undefined,
    addAndroidBackHandlerEventListener: () => () => undefined,
    setAndroidBackHandlerFallbackListener: () => undefined,
    addNativeMobileEventListener: () => () => undefined,
    isAuthorizedToRenderItem: () => true,
    vaultLocks: { addEventObserver: () => () => undefined },
    items: { streamItems: () => () => undefined, addObserver: () => () => undefined },
    keyboardService: { addCommandHandler: () => () => undefined },
  }) as never

let container: HTMLElement
let root: Root

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const mount = async (toolbarConfig?: unknown) => {
  const app = makeFakeApp(toolbarConfig)
  await act(async () => {
    root.render(
      <ApplicationProvider application={app}>
        <AndroidBackHandlerProvider application={app}>
          <BlocksEditorComposer initialValue={undefined}>
            <ToolbarPlugin />
          </BlocksEditorComposer>
        </AndroidBackHandlerProvider>
      </ApplicationProvider>,
    )
    await Promise.resolve()
  })
}

/**
 * The two class names this file is about, assembled from fragments ON PURPOSE.
 *
 * tailwind.config.js's `content` glob covers every .tsx under src/javascripts —
 * spec files included — so a spec that spelled these out as literals would itself
 * keep Tailwind emitting them, and would go on passing even after the component
 * stopped containing a literal. Built from pieces, this file contributes nothing
 * to the scanner and the assertions below are only ever satisfied by the
 * component's own source.
 */
const CONTAINER_CLASS = '@container' + '/utility-bar'
const NARROW_FALLBACK_CLASS = '@max-' + '4xl' + '/utility-bar:hidden'

const bar = () => container.querySelector('[data-super-toolbar-utility-bar]') as HTMLElement
const utilityHalf = () => bar().querySelector('[aria-label="Clipboard and history tools"]') as HTMLElement
const tabStrip = () => bar().querySelector('[role="tablist"][aria-label="Formatting groups"]') as HTMLElement
const spacer = () => bar().querySelector('[data-super-toolbar-tabs-spacer]') as HTMLElement

describe('ribbon tab strip is centred on the utility bar', () => {
  it('renders the bar as its own query container, so the fallback can be asked about the BAR width', async () => {
    await mount()
    // Without a container of its own the @max-4xl variant would resolve against
    // some unrelated ancestor (or nothing), and the right-align fallback would
    // trigger at the wrong moment or never.
    expect(bar().className).toContain(CONTAINER_CLASS)
  })

  it('renders exactly three flex children: utility half, tab strip, trailing spacer — in that order', async () => {
    await mount()
    const children = Array.from(bar().children)
    expect(children).toHaveLength(3)
    // Order is load-bearing: a spacer placed BEFORE the strip would push it hard
    // right at every width, which is the behaviour being replaced.
    expect(children[0]).toBe(utilityHalf())
    expect(children[1]).toBe(tabStrip())
    expect(children[2]).toBe(spacer())
  })

  it('gives the utility half and the spacer the same growth, which is what centres the strip', async () => {
    await mount()
    // flex-1 is `flex: 1 1 0%` on both, so the free space splits evenly and the
    // strip lands on the bar's true centre line — not merely centred in the space
    // the clipboard actions happen to leave over.
    expect(utilityHalf().className).toContain('flex-1')
    expect(spacer().className).toContain('flex-1')
  })

  it('never pins the strip right with an auto margin', async () => {
    await mount()
    // An auto margin consumes all free space BEFORE flex-grow runs, so a stray
    // ml-auto here would starve the spacer and silently restore right alignment
    // while every other assertion in this file still passed.
    expect(tabStrip().className).not.toContain('ml-auto')
    expect(tabStrip().className).not.toContain('mx-auto')
  })

  it('hides the spacer on a narrow bar, which is the right-aligned fallback', async () => {
    await mount()
    // The whole fallback is this one utility: with the spacer gone the utility
    // half takes all the slack and the strip sits flush right, with the full bar
    // left for the clipboard actions.
    expect(spacer().className).toContain(NARROW_FALLBACK_CLASS)
  })

  it('keeps the strip reachable rather than clipped when the bar is narrower than the strip itself', async () => {
    await mount()
    expect(tabStrip().className).toContain('overflow-x-auto')
    expect(tabStrip().className).toContain('max-w-full')
    expect(tabStrip().className).toContain('flex-shrink-0')
  })

  it('renders no spacer when there is no tab strip to centre', async () => {
    // One surviving tab means no strip; a spacer rendered outside that condition
    // would still claim half the bar and squeeze the clipboard actions into the
    // other half for no visible reason.
    await mount({ groupOrder: [], hiddenButtonIds: NON_HOME_BUTTON_IDS })
    expect(tabStrip()).toBeNull()
    expect(spacer()).toBeNull()
    expect(utilityHalf()).not.toBeNull()
  })
})

describe('the centring utilities survive the Tailwind scanner (static source assertion)', () => {
  // Tailwind v4 generates a utility ONLY when it occurs literally in a scanned
  // file, and tailwind.config.js's `content` glob covers .tsx under
  // src/javascripts. Interpolating either class name, or moving it into a .ts
  // module, emits no CSS whatsoever: the spacer then never hides, the strip never
  // right-aligns on a narrow bar, and neither tsc nor the DOM assertions above
  // would notice, because the class would still be on the element.
  const source = readFileSync(join(__dirname, 'ToolbarPlugin.tsx'), 'utf8')

  it('writes the container declaration as a plain literal', () => {
    expect(source).toContain(CONTAINER_CLASS + ' flex w-full')
  })

  it('writes the narrow-bar fallback as a plain literal', () => {
    expect(source).toContain(NARROW_FALLBACK_CLASS)
  })

  it('never builds either class name by interpolation', () => {
    expect(source).not.toMatch(/@max-\$\{/)
    expect(source).not.toMatch(/@container\/\$\{/)
  })
})
