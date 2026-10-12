/**
 * @jest-environment jsdom
 *
 * Standard Red Notes — the collapsible ribbon, wired into the REAL toolbar.
 *
 * `useToolbarAutoHide.spec.tsx` proves the decision logic against a stand-in.
 * This file mounts the real ToolbarPlugin — with the real `Popover`, a real
 * Lexical editor and a real contenteditable inside a `#super-editor` — and
 * proves the things a stand-in cannot:
 *
 *  1. EXPANDED, THE ONLY THING THAT CHANGED IS ONE BUTTON. Expanded is the
 *     default, so it is what every existing user gets. The toolbar root's class
 *     attribute and the command panel's are compared byte for byte with the
 *     strings they had before this feature existed, their attribute lists are
 *     compared exactly, the tab row's children are listed, and the documented
 *     shortcut is driven through its old docked <-> floating behaviour.
 *  2. THE SETTING IS READ, and only an explicit `true` collapses. A default-OFF
 *     boolean passes "off works" with the preference completely unwired, so the
 *     collapsed path is the one asserted in detail — including that the button
 *     on the bar writes the very preference the toolbar reads.
 *  3. THE REAL DROPDOWNS HOLD THE PANEL OPEN. The signal the hook relies on is
 *     `aria-expanded` on a popover's anchor, which only the real `Popover`
 *     produces — so it is left unmocked here and real ribbon dropdowns are
 *     opened, every one of them.
 *
 * WHAT THIS CANNOT SHOW: where anything is drawn. jsdom has no layout and no
 * hover, so "hidden" here means the attributes and classes that hide the panel
 * are on it — not that a browser hides it. That half was measured, and
 * photographed, in Firefox and Chrome against a real build.
 */
import { act, useEffect } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { LexicalEditor } from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { ApplicationEvent, LocalPrefDefaults, PrefDefaults, PrefKey } from '@standardnotes/snjs'
import { SUPER_TOGGLE_TOOLBAR } from '@standardnotes/ui-services'
import { BlocksEditorComposer } from '../../BlocksEditorComposer'
import ToolbarPlugin from './ToolbarPlugin'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import { ElementIds } from '@/Constants/ElementIDs'
import { SuperEditorContentId } from '../../Constants'
import { useResponsiveAppPane } from '@/Components/Panes/ResponsivePaneProvider'
import { SUPER_TOOLBAR_AUTO_HIDE_PREF_KEY } from './ToolbarAutoHidePreference'
import {
  TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS,
  TOOLBAR_AUTO_HIDE_REVEALED,
  TOOLBAR_AUTO_HIDE_REVEAL_DELAY_MS,
  TOOLBAR_AUTO_HIDE_STATE_ATTRIBUTE,
} from './useToolbarAutoHide'

/**
 * `isMobile` reads the MUTUALLY EXCLUSIVE `sm` query; the unmocked Popover picks
 * its positioned (desktop) variant off the plain `md` one. The mock carries both
 * maps so each can be answered on its own, and `mockMobileLayout` flips the
 * whole thing to the phone layout for the one test that needs it.
 */
let mockMobileLayout = false
jest.mock('@/Hooks/useMediaQuery', () => {
  const MediaQueryBreakpoints = {
    sm: 'q-sm',
    md: 'q-md',
    lg: 'q-lg',
    xl: 'q-xl',
    '2xl': 'q-2xl',
    pointerFine: 'q-fine',
  }
  const MutuallyExclusiveMediaQueryBreakpoints = {
    sm: 'x-sm',
    md: 'x-md',
    lg: 'x-lg',
    xl: 'x-xl',
    '2xl': 'x-2xl',
    pointerFine: 'x-fine',
  }
  return {
    MediaQueryBreakpoints,
    MutuallyExclusiveMediaQueryBreakpoints,
    useMediaQuery: (query: string) => {
      if (mockMobileLayout) {
        return query === MutuallyExclusiveMediaQueryBreakpoints.sm
      }
      return query === MediaQueryBreakpoints.md
    },
  }
})

jest.mock('@/Components/Panes/ResponsivePaneProvider', () => ({ useResponsiveAppPane: jest.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// Mounting the real ToolbarPlugin costs several seconds in jsdom, and one test
// here mounts it twice. Headroom for a slow mount, not a wait for anything async.
jest.setTimeout(60000)

/**
 * The toolbar root's class attribute as measured in a real browser BEFORE this
 * feature existed (docked, desktop, editable). Typed out rather than derived, so
 * that a change to how the classes are assembled has to be made here on purpose.
 * The run of three spaces is real: `classNames` keeps empty strings.
 */
const DOCKED_CLASS_BEFORE_THE_FEATURE = 'bg-contrast   border-border bg-default border-b w-full px-1 py-1'
/** The same root for a locked note, which hides it. */
const LOCKED_CLASS_BEFORE_THE_FEATURE =
  'bg-contrast hidden opacity-0  border-border bg-default border-b w-full px-1 py-1'
/** The command panel's class attribute before this feature existed. */
const PANEL_CLASS_BEFORE_THE_FEATURE = 'flex w-full'

const AUTO_HIDE_KEY = SUPER_TOOLBAR_AUTO_HIDE_PREF_KEY as unknown as string

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** What is stored under the collapse key. `undefined` is "never set". */
let storedAutoHide: unknown
/** PrefKey.AlwaysShowSuperToolbar. */
let docked = true
const preferenceObservers = new Set<() => Promise<void>>()
/** As much of a KeyboardService command handler as the toolbar registers. */
type CommandHandler = { command: unknown; onKeyDown?: (event: KeyboardEvent) => boolean | void }
const commandHandlers = new Set<CommandHandler>()
const preferenceWrites: [string, unknown][] = []

const announcePreferences = async () => {
  for (const observer of Array.from(preferenceObservers)) {
    await observer()
  }
}

const fakeApp = {
  getPreference: (key: string, fallback: unknown) => {
    if (key === PrefKey.AlwaysShowSuperToolbar) {
      return docked
    }
    if (key === AUTO_HIDE_KEY) {
      return storedAutoHide ?? fallback
    }
    return PrefDefaults[key as PrefKey] ?? fallback
  },
  // Writes the way the app does: store, then announce.
  setPreference: async (key: string, value: unknown) => {
    preferenceWrites.push([key, value])
    if (key === AUTO_HIDE_KEY) {
      storedAutoHide = value
    }
    await announcePreferences()
  },
  preferences: {
    getLocalValue: (key: string, fallback: unknown) => LocalPrefDefaults[key as never] ?? fallback,
    setLocalValue: () => undefined,
  },
  addEventObserver: (callback: () => Promise<void>, event: ApplicationEvent) => {
    if (event !== ApplicationEvent.PreferencesChanged) {
      return () => undefined
    }
    preferenceObservers.add(callback)
    return () => preferenceObservers.delete(callback)
  },
  addAndroidBackHandlerEventListener: () => () => undefined,
  setAndroidBackHandlerFallbackListener: () => undefined,
  addNativeMobileEventListener: () => () => undefined,
  isAuthorizedToRenderItem: () => true,
  vaultLocks: { addEventObserver: () => () => undefined },
  items: { streamItems: () => () => undefined, addObserver: () => () => undefined },
  keyboardService: {
    addCommandHandler: (handler: CommandHandler) => {
      commandHandlers.add(handler)
      return () => commandHandlers.delete(handler)
    },
  },
} as never

type Tile = {
  superEditor: HTMLElement
  note: HTMLElement
  editor: LexicalEditor
  unmount: () => Promise<void>
}

const tiles: Tile[] = []

/** One open note: its own `#super-editor`, its own editor, its own toolbar. */
const mountTile = async (): Promise<Tile> => {
  const superEditor = document.createElement('div')
  superEditor.id = ElementIds.SuperEditor
  document.body.appendChild(superEditor)
  const root: Root = createRoot(superEditor)

  let captured: LexicalEditor | undefined
  const CaptureEditor = () => {
    const [lexicalEditor] = useLexicalComposerContext()
    useEffect(() => {
      captured = lexicalEditor
    }, [lexicalEditor])
    return null
  }

  await act(async () => {
    root.render(
      <ApplicationProvider application={fakeApp}>
        <AndroidBackHandlerProvider application={fakeApp}>
          <BlocksEditorComposer initialValue={undefined}>
            <ToolbarPlugin />
            <div>
              <ContentEditable id={SuperEditorContentId} />
            </div>
            <CaptureEditor />
          </BlocksEditorComposer>
        </AndroidBackHandlerProvider>
      </ApplicationProvider>,
    )
    await Promise.resolve()
  })

  const tile: Tile = {
    superEditor,
    note: superEditor.querySelector<HTMLElement>(`#${SuperEditorContentId}`) as HTMLElement,
    editor: captured as LexicalEditor,
    unmount: async () => {
      await act(async () => root.unmount())
      superEditor.remove()
    },
  }
  tiles.push(tile)
  return tile
}

const bar = (tile: Tile) => tile.superEditor.querySelector<HTMLElement>('#super-mobile-toolbar') as HTMLElement
/** The tab row: the utility actions and the tab strip. */
const tabRow = (tile: Tile) => bar(tile).querySelector<HTMLElement>('[data-super-toolbar-utility-bar]') as HTMLElement
/** The command panel: the groups of the active tab. It is the row's next sibling. */
const panel = (tile: Tile) => tabRow(tile).nextElementSibling as HTMLElement
const collapseButton = (tile: Tile) =>
  tile.superEditor.querySelector<HTMLButtonElement>('button[data-super-toolbar-collapse]')
const tab = (tile: Tile, label: string) =>
  Array.from(tabRow(tile).querySelectorAll<HTMLElement>('[role="tab"]')).find(
    (candidate) => candidate.textContent === label,
  ) as HTMLElement
const selectedTab = (tile: Tile) =>
  Array.from(tabRow(tile).querySelectorAll('[role="tab"]'))
    .filter((candidate) => candidate.getAttribute('aria-selected') === 'true')
    .map((candidate) => candidate.textContent)
const group = (tile: Tile, label: string) => panel(tile).querySelector(`[role="group"][aria-label="${label}"]`)
const state = (tile: Tile) => panel(tile).getAttribute(TOOLBAR_AUTO_HIDE_STATE_ATTRIBUTE)
const classes = (element: Element) => (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
const attributeNames = (element: Element) =>
  Array.from(element.attributes)
    .map((attribute) => attribute.name)
    .sort()
const isFloating = (tile: Tile) => classes(bar(tile)).includes('fixed')

const pointer = (type: 'pointerover' | 'pointerenter' | 'pointerleave') => {
  const event = new Event(type, { bubbles: type === 'pointerover' })
  Object.defineProperty(event, 'pointerType', { value: 'mouse' })
  Object.defineProperty(event, 'buttons', { value: 0 })
  return event
}

const dispatch = async (target: Element, event: Event) => {
  await act(async () => {
    target.dispatchEvent(event)
    await Promise.resolve()
  })
}

const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms)
    await Promise.resolve()
    await Promise.resolve()
  })
}

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const focus = async (element: HTMLElement) => {
  await act(async () => {
    element.focus()
    await Promise.resolve()
  })
}

/** Change the stored setting from outside, the way a sync from another device does. */
const storeAutoHide = async (value: unknown) => {
  storedAutoHide = value
  await act(async () => {
    await announcePreferences()
  })
}

/** Press Cmd/Ctrl+Shift+K: every mounted toolbar hears it, newest first, as KeyboardService does. */
const pressToggleToolbar = async () => {
  const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, shiftKey: true, cancelable: true })
  await act(async () => {
    for (const handler of Array.from(commandHandlers).reverse()) {
      if (handler.command === SUPER_TOGGLE_TOOLBAR) {
        handler.onKeyDown?.(event)
      }
    }
    await Promise.resolve()
  })
  return event
}

const LONG = TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS * 5

let originalAnimate: typeof HTMLElement.prototype.animate

/** Rest the pointer on a tab until it counts, which opens the panel on that tab. */
const pointAtTab = async (tile: Tile, label: string) => {
  await dispatch(bar(tile), pointer('pointerenter'))
  await dispatch(tab(tile, label), pointer('pointerover'))
  await advance(TOOLBAR_AUTO_HIDE_REVEAL_DELAY_MS)
}
const leaveBar = (tile: Tile) => dispatch(bar(tile), pointer('pointerleave'))

beforeEach(() => {
  mockMobileLayout = false
  storedAutoHide = undefined
  docked = true
  preferenceObservers.clear()
  commandHandlers.clear()
  preferenceWrites.length = 0
  jest.mocked(useResponsiveAppPane).mockReturnValue({ presentPane: jest.fn() } as never)
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
  // jsdom has no matchMedia, and the Popover's own hooks call it directly rather
  // than through the mocked useMediaQuery.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as never
  // jsdom has no Web Animations API, and the real Popover plays an exit animation
  // when it closes. Resolved at once, so a closed dropdown is closed.
  originalAnimate = HTMLElement.prototype.animate
  HTMLElement.prototype.animate = (() =>
    ({
      currentTime: 0,
      finished: Promise.resolve(),
      cancel: () => undefined,
    }) as unknown as Animation) as typeof HTMLElement.prototype.animate
  // Microtasks stay real: MutationObserver and React both deliver on them.
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] })
})

afterEach(async () => {
  for (const tile of tiles.splice(0, tiles.length).reverse()) {
    await tile.unmount()
  }
  document.body.innerHTML = ''
  HTMLElement.prototype.animate = originalAnimate
  jest.useRealTimers()
})

describe('expanded (the default)', () => {
  it('is the same toolbar as before: same class attributes, same attributes, on the bar and on the panel', async () => {
    const tile = await mountTile()
    expect(bar(tile).getAttribute('class')).toBe(DOCKED_CLASS_BEFORE_THE_FEATURE)
    expect(attributeNames(bar(tile))).toEqual(['class', 'id', 'style'])
    expect(panel(tile).getAttribute('class')).toBe(PANEL_CLASS_BEFORE_THE_FEATURE)
    expect(attributeNames(panel(tile))).toEqual(['class'])
  })

  it('leaves the tab row exactly as it was: nothing is added to it', async () => {
    // The row is already overfull on a bar of ordinary width. A button there
    // clipped the utility actions by its own width, so it does not go there.
    const tile = await mountTile()
    expect(
      Array.from(tabRow(tile).children).map(
        (child) => child.getAttribute('aria-label') ?? child.getAttribute('role') ?? child.className,
      ),
    ).toEqual([
      'Clipboard and history tools',
      'Formatting groups',
      expect.stringContaining('super-toolbar-tabs-spacer'),
    ])
    expect(tabRow(tile).querySelector('[data-super-toolbar-collapse]')).toBeNull()
  })

  it('adds exactly one thing to the panel — the collapse button, in a box at its end', async () => {
    const tile = await mountTile()
    const children = Array.from(panel(tile).children)
    const corner = children[children.length - 1]
    expect(corner.hasAttribute('data-super-toolbar-collapse-corner')).toBe(true)
    // Before the feature the panel held one thing on desktop: the toolbar of groups.
    expect(children).toHaveLength(2)
    expect(children[0].getAttribute('role')).toBe('toolbar')
    expect(corner.querySelectorAll('button')).toHaveLength(1)
    expect(corner.querySelector('button')).toBe(collapseButton(tile))
    expect(tile.superEditor.querySelectorAll('[data-super-toolbar-collapse]')).toHaveLength(1)
  })

  it('draws the button in the corner from a zero-width box, so no command has less room than it had', async () => {
    const tile = await mountTile()
    const corner = panel(tile).querySelector('[data-super-toolbar-collapse-corner]') as Element
    // The box takes no width in the row of groups, and is what the button is placed against.
    expect(classes(corner)).toEqual(expect.arrayContaining(['w-0', 'relative', 'flex-shrink-0']))
    expect(classes(collapseButton(tile) as Element)).toEqual(
      expect.arrayContaining(['absolute', 'right-0', 'bottom-0']),
    )
  })

  it('names the button for what it will do, and draws it as an icon', async () => {
    const tile = await mountTile()
    const button = collapseButton(tile)
    expect(button).not.toBeNull()
    expect(button?.getAttribute('type')).toBe('button')
    // Under test the i18n layer echoes the key; in the app this reads "Collapse the toolbar".
    expect(button?.getAttribute('aria-label')).toBe('collapseToolbar')
    expect(button?.getAttribute('aria-pressed')).toBe('false')
    // An icon type that is not in the icon map renders its own NAME as text
    // instead of a picture, and neither tsc nor an Icon mock notices.
    expect(button?.querySelector('svg')).not.toBeNull()
    expect(button?.textContent?.trim()).toBe('')
  })

  it('collapses when that button is clicked, by writing the preference the toolbar reads', async () => {
    const tile = await mountTile()
    await click(collapseButton(tile) as HTMLElement)
    expect(preferenceWrites).toEqual([['superToolbarAutoHide', true]])
    // ...and the toolbar it belongs to is now collapsed: the write is the wiring.
    expect(state(tile)).toBe('hidden')
  })

  it('does not take the caret out of the note when the button is clicked', async () => {
    const tile = await mountTile()
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    await dispatch(collapseButton(tile) as HTMLElement, mouseDown)
    expect(mouseDown.defaultPrevented).toBe(true)
  })

  it('treats every stored value except an explicit true as expanded', async () => {
    // A synced value another client may have written. `'true'` and `1` are the
    // ones a loose truthiness check would let through.
    for (const stored of [false, null, 'true', 1, {}, []]) {
      storedAutoHide = stored
      const tile = await mountTile()
      expect(bar(tile).getAttribute('class')).toBe(DOCKED_CLASS_BEFORE_THE_FEATURE)
      expect(panel(tile).getAttribute('class')).toBe(PANEL_CLASS_BEFORE_THE_FEATURE)
      expect(collapseButton(tile)?.getAttribute('aria-pressed')).toBe('false')
      await tiles.pop()?.unmount()
    }
  })

  it('does nothing new when a tab is pointed at: no switching, nothing hidden', async () => {
    const tile = await mountTile()
    await pointAtTab(tile, 'Tools')
    await leaveBar(tile)
    await advance(LONG)
    expect(selectedTab(tile)).toEqual(['Home'])
    expect(panel(tile).getAttribute('class')).toBe(PANEL_CLASS_BEFORE_THE_FEATURE)
    expect(attributeNames(panel(tile))).toEqual(['class'])
  })

  it('leaves Cmd/Ctrl+Shift+K doing what it always did: docked <-> floating', async () => {
    const tile = await mountTile()
    expect(isFloating(tile)).toBe(false)

    const first = await pressToggleToolbar()
    expect(first.defaultPrevented).toBe(true)
    expect(isFloating(tile)).toBe(true)
    // The floating toolbar has no tab row, so it has no collapse button either.
    expect(collapseButton(tile)).toBeNull()

    await pressToggleToolbar()
    expect(isFloating(tile)).toBe(false)
    expect(bar(tile).getAttribute('class')).toBe(DOCKED_CLASS_BEFORE_THE_FEATURE)
  })

  it('still hides the toolbar of a locked note exactly as before', async () => {
    const tile = await mountTile()
    await act(async () => tile.editor.setEditable(false))
    expect(bar(tile).getAttribute('class')).toBe(LOCKED_CLASS_BEFORE_THE_FEATURE)
  })
})

describe('collapsed', () => {
  beforeEach(() => {
    storedAutoHide = true
  })

  describe('at rest', () => {
    it('keeps the tab row: every tab and the utility actions are all still there', async () => {
      const tile = await mountTile()
      expect(Array.from(tabRow(tile).querySelectorAll('[role="tab"]')).map((item) => item.textContent)).toEqual([
        'Home',
        'Insert',
        'Layout',
        'AI',
        'Tools',
      ])
      expect(tabRow(tile).querySelector('[aria-label="Clipboard and history tools"]')).not.toBeNull()
      expect(tabRow(tile).closest('[inert]')).toBeNull()
    })

    it('puts the command panel away: marked hidden, inert, invisible, and taking no pointer events', async () => {
      const tile = await mountTile()
      expect(state(tile)).toBe('hidden')
      // `inert` is what keeps invisible controls out of the tab order.
      expect(panel(tile).hasAttribute('inert')).toBe(true)
      // Hidden is what the panel's classes say with no help from the attribute, so
      // it is hidden from its first paint and stays hidden if the attribute is lost.
      expect(classes(panel(tile))).toEqual(expect.arrayContaining(['invisible', 'opacity-0', 'pointer-events-none']))
      expect(classes(panel(tile))).not.toContain('visible')
      // The commands are still mounted, just not shown: nothing was thrown away.
      expect(group(tile, 'Font')).not.toBeNull()
    })

    it('takes the panel out of the flow, under the tab row, so opening it cannot push the note down', async () => {
      const tile = await mountTile()
      expect(classes(panel(tile))).toEqual(expect.arrayContaining(['absolute', 'top-full', 'left-0']))
      // The bar is what it is positioned against, and stays in the flow itself.
      expect(classes(bar(tile))).toContain('relative')
      expect(classes(bar(tile))).not.toContain('absolute')
    })

    it('only adds to the toolbar it already was', async () => {
      const tile = await mountTile()
      expect(bar(tile).getAttribute('class')).toBe(`${DOCKED_CLASS_BEFORE_THE_FEATURE} relative !border-b-0 !pb-0`)
      expect(panel(tile).getAttribute('class')?.startsWith(`${PANEL_CLASS_BEFORE_THE_FEATURE} `)).toBe(true)
      expect(attributeNames(bar(tile))).toEqual(['class', 'id', 'style'])
    })

    it('keys the revealed look on exactly the attribute and value the hook writes', async () => {
      // The classes live in ToolbarPlugin.tsx and the attribute is written by
      // useToolbarAutoHide.ts. If the two names drifted apart the panel would be
      // "revealed" in every assertion in this file and invisible in the browser.
      const tile = await mountTile()
      const revealedVariant = `data-[${TOOLBAR_AUTO_HIDE_STATE_ATTRIBUTE.replace(/^data-/, '')}=${TOOLBAR_AUTO_HIDE_REVEALED}]:`
      expect(classes(panel(tile))).toEqual(
        expect.arrayContaining([
          `${revealedVariant}visible`,
          `${revealedVariant}opacity-100`,
          `${revealedVariant}pointer-events-auto`,
        ]),
      )
      // And every attribute-keyed class on the panel uses that one variant.
      const keyed = classes(panel(tile)).filter((name) => name.includes('data-['))
      expect(keyed.length).toBeGreaterThan(0)
      expect(keyed.filter((name) => !name.includes(revealedVariant))).toEqual([])
    })

    it('respects reduced motion on the panel in both states', async () => {
      const tile = await mountTile()
      const names = classes(panel(tile))
      // Hidden, and — separately, because the attribute selector outranks the
      // plain class — revealed.
      expect(names).toContain('motion-reduce:transition-none')
      expect(names.filter((name) => /^motion-reduce:data-\[.+\]:transition-none$/.test(name))).toHaveLength(1)
    })

    it('turns the button into the pin that keeps the toolbar open, still an icon', async () => {
      const tile = await mountTile()
      const button = collapseButton(tile)
      expect(button?.getAttribute('aria-label')).toBe('keepToolbarOpen')
      expect(button?.getAttribute('aria-pressed')).toBe('true')
      expect(button?.querySelector('svg')).not.toBeNull()
      expect(button?.textContent?.trim()).toBe('')
    })

    it('expands for good when that button is clicked, restoring the original toolbar exactly', async () => {
      const tile = await mountTile()
      await click(collapseButton(tile) as HTMLElement)
      expect(preferenceWrites).toEqual([['superToolbarAutoHide', false]])
      expect(bar(tile).getAttribute('class')).toBe(DOCKED_CLASS_BEFORE_THE_FEATURE)
      expect(panel(tile).getAttribute('class')).toBe(PANEL_CLASS_BEFORE_THE_FEATURE)
      expect(attributeNames(panel(tile))).toEqual(['class'])
    })
  })

  describe('opening the panel', () => {
    it('opens when the pointer rests on a tab, not before', async () => {
      const tile = await mountTile()
      await dispatch(bar(tile), pointer('pointerenter'))
      await dispatch(tab(tile, 'Home'), pointer('pointerover'))
      await advance(TOOLBAR_AUTO_HIDE_REVEAL_DELAY_MS - 1)
      expect(state(tile)).toBe('hidden')
      await advance(1)
      expect(state(tile)).toBe('revealed')
      expect(panel(tile).hasAttribute('inert')).toBe(false)
    })

    it('shows the commands of the tab that is pointed at, and of the next one the pointer moves to', async () => {
      const tile = await mountTile()
      await pointAtTab(tile, 'Tools')
      expect(state(tile)).toBe('revealed')
      expect(selectedTab(tile)).toEqual(['Tools'])
      expect(group(tile, 'Find')).not.toBeNull()
      expect(group(tile, 'Font')).toBeNull()

      await dispatch(tab(tile, 'Home'), pointer('pointerover'))
      await advance(TOOLBAR_AUTO_HIDE_REVEAL_DELAY_MS)
      expect(selectedTab(tile)).toEqual(['Home'])
      expect(group(tile, 'Font')).not.toBeNull()
      // Switching re-rendered the toolbar; the panel is still open through it.
      expect(state(tile)).toBe('revealed')
    })

    it('closes a short delay after the pointer leaves the bar', async () => {
      const tile = await mountTile()
      await pointAtTab(tile, 'Home')
      await leaveBar(tile)
      await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS - 1)
      expect(state(tile)).toBe('revealed')
      await advance(1)
      expect(state(tile)).toBe('hidden')
      expect(panel(tile).hasAttribute('inert')).toBe(true)
    })

    it('opens on a click of a tab and stays until the user returns to the note', async () => {
      // Touch and keyboard have no hover: activating a tab is their way in.
      const tile = await mountTile()
      await click(tab(tile, 'Insert'))
      expect(selectedTab(tile)).toEqual(['Insert'])
      await advance(LONG)
      expect(state(tile)).toBe('revealed')

      await dispatch(tile.note, new Event('pointerdown', { bubbles: true }))
      await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
      expect(state(tile)).toBe('hidden')
    })

    it('stays open while keyboard focus is inside the panel', async () => {
      const tile = await mountTile()
      await pointAtTab(tile, 'Home')
      await focus(panel(tile).querySelector<HTMLElement>('button') as HTMLElement)
      await leaveBar(tile)
      await advance(LONG)
      expect(panel(tile).contains(document.activeElement)).toBe(true)
      expect(state(tile)).toBe('revealed')

      await focus(tile.note)
      await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
      expect(state(tile)).toBe('hidden')
    })

    it('keeps its state when the toolbar re-renders for some other reason', async () => {
      // The state is an attribute React does not set. A re-render of the toolbar
      // must leave it alone in both directions, or the panel would snap shut
      // every time the selection changed.
      const tile = await mountTile()
      await click(tab(tile, 'Insert'))
      expect(state(tile)).toBe('revealed')
      await click(tab(tile, 'Layout'))
      expect(selectedTab(tile)).toEqual(['Layout'])
      expect(state(tile)).toBe('revealed')
      expect(panel(tile).hasAttribute('inert')).toBe(false)

      await dispatch(tile.note, new Event('pointerdown', { bubbles: true }))
      await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
      expect(state(tile)).toBe('hidden')
      // Still mounted and re-rendering while hidden: the stored setting announced again.
      await storeAutoHide(true)
      expect(state(tile)).toBe('hidden')
      expect(panel(tile).hasAttribute('inert')).toBe(true)
    })
  })

  describe('while something the panel opened is open', () => {
    /** A real ribbon dropdown: the first button in the PANEL the real Popover has marked as an anchor. */
    const firstDropdownAnchor = (tile: Tile) =>
      panel(tile).querySelector<HTMLElement>('[aria-haspopup="true"]') as HTMLElement
    const openPopovers = () => document.querySelectorAll('[data-popover]')

    it('keeps the panel when the pointer leaves the bar for a dropdown that is rendered outside it', async () => {
      const tile = await mountTile()
      await pointAtTab(tile, 'Home')
      const anchor = firstDropdownAnchor(tile)
      expect(anchor).not.toBeNull()

      await click(anchor)

      // Preconditions, without which the rest proves nothing: the real Popover
      // opened, it marked its anchor, and it is NOT inside the bar — so leaving
      // the bar for it is a real exit.
      expect(anchor.getAttribute('aria-expanded')).toBe('true')
      expect(openPopovers()).toHaveLength(1)
      expect(bar(tile).contains(openPopovers()[0])).toBe(false)

      await leaveBar(tile)
      await advance(LONG)
      expect(state(tile)).toBe('revealed')
      expect(panel(tile).hasAttribute('inert')).toBe(false)
    })

    it('closes the panel once that dropdown is closed', async () => {
      const tile = await mountTile()
      await pointAtTab(tile, 'Home')
      const anchor = firstDropdownAnchor(tile)
      await click(anchor)
      await leaveBar(tile)
      await advance(LONG)
      expect(state(tile)).toBe('revealed')

      // Close it the way the toolbar does: the same button toggles it.
      await click(anchor)
      expect(anchor.hasAttribute('aria-expanded')).toBe(false)
      await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS - 1)
      expect(state(tile)).toBe('revealed')
      await advance(1)
      expect(state(tile)).toBe('hidden')
    })

    it('would have closed with no dropdown open — the same pointer moves, minus the click', async () => {
      // The control. Without it the two tests above could be passing because the
      // panel never closes in this fixture at all.
      const tile = await mountTile()
      await pointAtTab(tile, 'Home')
      await leaveBar(tile)
      await advance(LONG)
      expect(state(tile)).toBe('hidden')
    })

    it('holds for EVERY dropdown anchor in the panel, not just the first', async () => {
      // The hook knows nothing about individual menus, so this must hold for all
      // of them — including the ones whose open flag lives in a child component
      // the toolbar cannot see.
      const tile = await mountTile()
      await pointAtTab(tile, 'Home')
      const anchors = Array.from(panel(tile).querySelectorAll<HTMLElement>('[aria-haspopup="true"]')).filter(
        (anchor) => !anchor.hasAttribute('disabled') && anchor.getAttribute('aria-disabled') !== 'true',
      )
      expect(anchors.length).toBeGreaterThan(5)

      const held: string[] = []
      for (const anchor of anchors) {
        await dispatch(bar(tile), pointer('pointerenter'))
        await click(anchor)
        if (anchor.getAttribute('aria-expanded') !== 'true') {
          continue
        }
        await leaveBar(tile)
        await advance(LONG)
        expect(state(tile)).toBe('revealed')
        held.push(anchor.getAttribute('aria-label') ?? anchor.textContent ?? '')
        await click(anchor)
        expect(anchor.hasAttribute('aria-expanded')).toBe(false)
      }
      // Every one of them opened, and so every one of them was put to the test.
      expect(held).toHaveLength(anchors.length)
      // And one of them is the block-style gallery's overflow, whose open flag
      // lives inside the gallery where the toolbar cannot read it. ORing the
      // toolbar's own "is open" flags together would have missed exactly this.
      expect(held.filter((label) => /more block styles$/.test(label))).toHaveLength(1)
    })

    it('does not open the panel for a dropdown that belongs to the tab row', async () => {
      // Paste options, undo history: they hang off the row, which is always
      // there, and need nothing from the panel.
      const tile = await mountTile()
      const rowAnchor = tabRow(tile).querySelector<HTMLElement>('[aria-haspopup="true"]') as HTMLElement
      expect(rowAnchor).not.toBeNull()
      await click(rowAnchor)
      expect(rowAnchor.getAttribute('aria-expanded')).toBe('true')
      await advance(LONG)
      expect(state(tile)).toBe('hidden')
    })
  })

  describe('Cmd/Ctrl+Shift+K', () => {
    it('opens the panel and moves focus into it, instead of switching to the floating toolbar', async () => {
      const tile = await mountTile()
      await focus(tile.note)
      expect(state(tile)).toBe('hidden')

      const event = await pressToggleToolbar()

      expect(event.defaultPrevented).toBe(true)
      expect(state(tile)).toBe('revealed')
      expect(panel(tile).contains(document.activeElement)).toBe(true)
      expect(isFloating(tile)).toBe(false)
      await advance(LONG)
      expect(state(tile)).toBe('revealed')
    })

    it('hands focus back to the note when pressed from inside the panel, and the panel then closes', async () => {
      const tile = await mountTile()
      await pressToggleToolbar()
      expect(panel(tile).contains(document.activeElement)).toBe(true)
      const focusEditor = jest.spyOn(tile.editor, 'focus')

      await pressToggleToolbar()

      expect(focusEditor).toHaveBeenCalledTimes(1)
      expect(isFloating(tile)).toBe(false)
      // jsdom does not move DOM focus for Lexical's `editor.focus()`, so the
      // return to the note is completed by hand before the clock is advanced.
      await focus(tile.note)
      await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
      expect(state(tile)).toBe('hidden')
    })

    it('is answered only by the note the keystroke was made in', async () => {
      const first = await mountTile()
      const second = await mountTile()
      await focus(second.note)

      await pressToggleToolbar()

      expect(state(second)).toBe('revealed')
      expect(state(first)).toBe('hidden')
    })
  })

  describe('where it does not apply', () => {
    it('shows nothing of it on a locked note, and hides the toolbar exactly as before', async () => {
      const tile = await mountTile()
      expect(state(tile)).toBe('hidden')

      await act(async () => tile.editor.setEditable(false))

      expect(bar(tile).getAttribute('class')).toBe(LOCKED_CLASS_BEFORE_THE_FEATURE)
      expect(panel(tile).getAttribute('class')).toBe(PANEL_CLASS_BEFORE_THE_FEATURE)
      expect(attributeNames(panel(tile))).toEqual(['class'])
    })

    it('leaves the floating selection toolbar alone', async () => {
      docked = false
      const tile = await mountTile()
      expect(isFloating(tile)).toBe(true)
      expect(collapseButton(tile)).toBeNull()
      expect(classes(bar(tile))).not.toContain('relative')
      expect(bar(tile).querySelector(`[${TOOLBAR_AUTO_HIDE_STATE_ATTRIBUTE}]`)).toBeNull()
      expect(bar(tile).querySelector('[inert]')).toBeNull()
      expect(bar(tile).querySelector('.invisible')).toBeNull()
    })

    it('leaves the mobile toolbar alone', async () => {
      mockMobileLayout = true
      const tile = await mountTile()
      expect(collapseButton(tile)).toBeNull()
      expect(panel(tile).getAttribute('class')).toBe(PANEL_CLASS_BEFORE_THE_FEATURE)
      expect(bar(tile).querySelector(`[${TOOLBAR_AUTO_HIDE_STATE_ATTRIBUTE}]`)).toBeNull()
      expect(bar(tile).querySelector('[inert]')).toBeNull()
    })
  })
})

describe('the setting changing while a note is open', () => {
  it('takes effect at once in both directions, and expanding restores the original toolbar exactly', async () => {
    const tile = await mountTile()
    expect(state(tile)).toBeNull()

    await storeAutoHide(true)
    expect(state(tile)).toBe('hidden')
    expect(collapseButton(tile)?.getAttribute('aria-pressed')).toBe('true')

    await storeAutoHide(false)
    expect(bar(tile).getAttribute('class')).toBe(DOCKED_CLASS_BEFORE_THE_FEATURE)
    expect(attributeNames(bar(tile))).toEqual(['class', 'id', 'style'])
    expect(panel(tile).getAttribute('class')).toBe(PANEL_CLASS_BEFORE_THE_FEATURE)
    expect(attributeNames(panel(tile))).toEqual(['class'])
    expect(collapseButton(tile)?.getAttribute('aria-pressed')).toBe('false')
  })

  it('does not come back already open after being expanded while held open', async () => {
    storedAutoHide = true
    const tile = await mountTile()
    await click(tab(tile, 'Home'))
    expect(state(tile)).toBe('revealed')

    await storeAutoHide(false)
    await storeAutoHide(true)
    await advance(LONG)
    expect(state(tile)).toBe('hidden')
  })
})
