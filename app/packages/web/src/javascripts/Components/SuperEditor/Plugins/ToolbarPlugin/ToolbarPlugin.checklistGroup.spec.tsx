/**
 * @jest-environment jsdom
 *
 * VANISH GUARD for the checklist bulk-completion group (task t91).
 *
 * A toolbar group in this file has twice been added, typechecked clean, passed
 * its unit tests — and then silently failed to render, because the group-level
 * "drop groups with nothing renderable" filter in ToolbarPlugin deleted a group
 * whose buttons were all special-cased. Green tsc + green logic tests are
 * therefore NOT evidence that a toolbar button exists.
 *
 * This test mounts the REAL ToolbarPlugin (inside the real composer) and asserts
 * the Checklist group and its three buttons are actually in the DOM, after the
 * whole pipeline has run: applyToolbarConfig -> the renderable-group filter ->
 * groupsBySuperGroup tab partitioning -> the explicit `layout` row resolution
 * (a button missing from a group's `layout` array renders nowhere, even though
 * it is listed in `buttons`).
 */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { LocalPrefDefaults, PrefDefaults, PrefKey } from '@standardnotes/snjs'
import { BlocksEditorComposer } from '../../BlocksEditorComposer'
import ToolbarPlugin from './ToolbarPlugin'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import { ToolbarButtonId, ToolbarGroupId, DEFAULT_TOOLBAR_GROUPS } from './ToolbarConfig'

// Desktop layout; `alwaysShowToolbar` (below) then docks the full ribbon, which
// is the surface the three buttons live on.
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

const fakeApp = {
  // Docks the ribbon so every group renders (rather than the floating
  // selection mini-toolbar).
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
  // Render authorization (useItemAuthorization) subscribes to these on mount.
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

const checklistGroup = () => container.querySelector('[role="group"][aria-label="Checklist"]')

describe('checklist bulk-completion toolbar group renders', () => {
  it('puts the Checklist group in the real rendered toolbar', async () => {
    await mount()
    expect(checklistGroup()).not.toBeNull()
  })

  it('renders all three bulk-completion buttons inside that group', async () => {
    await mount()
    const group = checklistGroup()
    expect(group).not.toBeNull()
    // Three real buttons (the divider is an aria-hidden separator, not a button).
    const buttons = group!.querySelectorAll('button')
    expect(buttons).toHaveLength(3)
    expect(group!.querySelector('[role="separator"]')).not.toBeNull()
  })

  it('renders the group caption so the user can find it', async () => {
    await mount()
    expect(checklistGroup()!.textContent).toContain('Checklist')
  })

  it('renders the buttons as reachable toolbar items rather than inert markup', async () => {
    await mount()
    const buttons = Array.from(checklistGroup()!.querySelectorAll('button'))
    // Every button must be a real, clickable toolbar item. With no checklist
    // under the (empty) initial document they are aria-disabled — but they use
    // aria-disabled, NOT the native attribute, so they stay focusable and their
    // tooltip still explains them.
    for (const button of buttons) {
      expect(button.getAttribute('aria-disabled')).toBe('true')
      expect(button.hasAttribute('disabled')).toBe(false)
    }
  })

  it('keeps every button present in the group layout, not just its button list', () => {
    // Guards the second half of the failure mode: a group with an explicit
    // `layout` renders ONLY the ids named in that layout, so a button listed in
    // `buttons` but forgotten in `layout` is invisible.
    const group = DEFAULT_TOOLBAR_GROUPS.find((candidate) => candidate.id === ToolbarGroupId.Checklist)
    expect(group).toBeDefined()
    const laidOut = new Set((group!.layout ?? []).flat())
    for (const button of group!.buttons) {
      expect(laidOut.has(button.id)).toBe(true)
    }
    expect(laidOut.has(ToolbarButtonId.CompleteAllChecklistItems)).toBe(true)
    expect(laidOut.has(ToolbarButtonId.CompleteSelectedChecklistItems)).toBe(true)
    expect(laidOut.has(ToolbarButtonId.UncompleteSelectedChecklistItems)).toBe(true)
  })
})
