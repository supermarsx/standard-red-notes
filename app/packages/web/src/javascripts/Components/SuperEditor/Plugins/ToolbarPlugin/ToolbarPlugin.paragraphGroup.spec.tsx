/**
 * @jest-environment jsdom
 *
 * VANISH GUARD for "Change case" in the Paragraph group (task t101).
 *
 * It was declared in the group's `buttons`, had a working renderer, and appeared
 * in the Customize Toolbar dialog as a button you could show or hide — but it was
 * missing from that group's explicit `layout`, and a group with a `layout`
 * renders only the ids that layout names. So it rendered nowhere, and the setting
 * offering to hide it was a setting about nothing.
 *
 * The config-level invariant ("every declared button appears in its own group's
 * layout") is now checked for EVERY group in ToolbarConfig.spec.ts. This file is
 * the other half: proof that the fix reaches the DOM, because a green config
 * assertion is not evidence that a button renders — that is the exact gap this
 * toolbar has fallen through twice before.
 */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { LocalPrefDefaults, PrefDefaults, PrefKey } from '@standardnotes/snjs'
import { BlocksEditorComposer } from '../../BlocksEditorComposer'
import ToolbarPlugin from './ToolbarPlugin'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'

// Desktop layout; `alwaysShowToolbar` (below) then docks the full ribbon.
jest.mock('@/Hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
  MutuallyExclusiveMediaQueryBreakpoints: { sm: 'sm', md: 'md' },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
/**
 * Mounting the real 5000-line ToolbarPlugin in jsdom costs several seconds per
 * test, and under a full parallel `yarn test` run it crossed jest's 5s default and
 * failed as a TIMEOUT rather than an assertion — a flake that reads exactly like a
 * broken toolbar. Six specs in this directory mount it, so the cause is shared and
 * the timeout is raised in all of them (precedent: the Collaboration integration
 * specs). This is headroom for a slow mount, not a wait for anything async.
 */
jest.setTimeout(30000)

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const fakeApp = {
  getPreference: (key: string, fallback: unknown) => {
    if (key === PrefKey.AlwaysShowSuperToolbar) {
      return true
    }
    return PrefDefaults[key as PrefKey] ?? fallback
  },
  preferences: {
    getLocalValue: (key: string, fallback: unknown) => LocalPrefDefaults[key as never] ?? fallback,
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
} as never

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

const mount = async () => {
  await act(async () => {
    root.render(
      <ApplicationProvider application={fakeApp}>
        <AndroidBackHandlerProvider application={fakeApp}>
          <BlocksEditorComposer initialValue={undefined}>
            <ToolbarPlugin />
          </BlocksEditorComposer>
        </AndroidBackHandlerProvider>
      </ApplicationProvider>,
    )
    await Promise.resolve()
  })
}

const paragraphGroup = () => container.querySelector('[role="group"][aria-label="Paragraph & lists"]')

/** Change case is icon-less: it renders the glyph "aA" plus a chevron. */
const changeCaseButton = () =>
  Array.from(paragraphGroup()?.querySelectorAll('button') ?? []).find((button) => button.textContent?.includes('aA'))

describe('the Paragraph group renders Change case', () => {
  it('renders the Paragraph group at all', async () => {
    await mount()
    expect(paragraphGroup()).not.toBeNull()
  })

  it('puts a Change case control in it', async () => {
    await mount()
    expect(changeCaseButton()).toBeDefined()
  })

  it('renders it as a reachable toolbar item, not inert markup', async () => {
    await mount()
    const button = changeCaseButton()
    expect(button).toBeDefined()
    // Not natively disabled — Change case opens its own menu and is always usable.
    expect(button!.hasAttribute('disabled')).toBe(false)
  })

  it('renders exactly one of it, in that group and nowhere else', async () => {
    await mount()
    const everywhere = Array.from(container.querySelectorAll('button')).filter((button) =>
      button.textContent?.includes('aA'),
    )
    expect(everywhere).toHaveLength(1)
    expect(paragraphGroup()!.contains(everywhere[0])).toBe(true)
  })

  it('bites: the query finds nothing once the control is taken out of the DOM', async () => {
    // A guard that cannot fail is not a guard — before the layout fix this is
    // exactly the state the toolbar was in, and this is what it looks like.
    await mount()
    changeCaseButton()!.remove()
    expect(changeCaseButton()).toBeUndefined()
  })
})
