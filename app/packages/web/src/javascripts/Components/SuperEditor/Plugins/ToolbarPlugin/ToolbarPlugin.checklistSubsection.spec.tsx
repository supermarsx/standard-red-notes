/**
 * @jest-environment jsdom
 *
 * VANISH GUARD for the Checklists subsection (t111 item 7).
 *
 * ChecklistSubsection.spec.tsx proves the card renders and that every control
 * calls back. That is NOT evidence the user can reach it: a toolbar group in this
 * very file has been added, typechecked clean, passed its logic tests and rendered
 * nowhere — killed by the "drop groups with nothing renderable" filter plus the
 * explicit `layout` array, in which a declared button that is missing renders
 * nowhere while Customize Toolbar still offers to hide it.
 *
 * So this mounts the REAL ToolbarPlugin inside the real composer, finds the
 * settings button in the Checklist group, OPENS it, and asserts the subsection's
 * controls are in the DOM.
 *
 * It also guards the preference-pinning rule, which is the other silent failure
 * mode here. Web consumes `PrefKey`'s RUNTIME value from a generated bundle where
 * both new members are still absent, so reading
 * `PrefKey.ChecklistAutoGenerateRecurrences` yields `undefined`: the preference
 * falls to its default forever and the control looks like it does nothing while
 * tsc stays green. The fake application below therefore answers only the LITERAL
 * key strings with non-default values, so a read or write that went through the
 * enum member would be visible immediately.
 */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { LocalPrefDefaults, PrefDefaults, PrefKey } from '@standardnotes/snjs'
import { BlocksEditorComposer } from '../../BlocksEditorComposer'
import ToolbarPlugin from './ToolbarPlugin'
import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import {
  CHECKLIST_AUTO_GENERATE_RECURRENCES_PREF_KEY,
  CHECKLIST_GENERATE_CAP_PREF_KEY,
} from '../../Checklist/checklistBackfill'

// Desktop layout; `alwaysShowToolbar` (below) then docks the full ribbon. Unlike
// the sibling toolbar specs this one also opens a Popover, which reads
// `MediaQueryBreakpoints.md` — so the mock must carry BOTH breakpoint maps, and
// answer true for the desktop query and false for the mobile one.
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
    useMediaQuery: (query: string) => query === MediaQueryBreakpoints.md,
  }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Stored values deliberately different from the hardcoded defaults (on, 12). */
const STORED_AUTO_GENERATE = false
const STORED_CAP = 3

let writes: { key: unknown; value: unknown }[] = []

const fakeApp = {
  getPreference: (key: string, fallback: unknown) => {
    if (key === PrefKey.AlwaysShowSuperToolbar) {
      return true
    }
    // Answered ONLY for the literal strings: a read through the (runtime-absent)
    // enum member arrives here as `undefined` and gets the default instead, which
    // the assertions below would catch.
    if (key === CHECKLIST_AUTO_GENERATE_RECURRENCES_PREF_KEY) {
      return STORED_AUTO_GENERATE
    }
    if (key === CHECKLIST_GENERATE_CAP_PREF_KEY) {
      return STORED_CAP
    }
    return PrefDefaults[key as PrefKey] ?? fallback
  },
  setPreference: (key: unknown, value: unknown) => {
    writes.push({ key, value })
    return Promise.resolve()
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
  writes = []
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

const checklistGroup = () => document.querySelector('[role="group"][aria-label="Checklist"]')
/** The subsection opener: the last button of the Checklist group's single row. */
const settingsButton = () => {
  const buttons = Array.from(checklistGroup()!.querySelectorAll('button'))
  return buttons[buttons.length - 1]
}
const openSubsection = async () => {
  await act(async () => {
    settingsButton().click()
    await Promise.resolve()
  })
}
const card = () => document.querySelector('[data-super-toolbar-checklist-subsection]')
const cardCheckbox = (labelText: string) => {
  const label = Array.from(card()!.querySelectorAll('label')).find((element) =>
    element.textContent?.includes(labelText),
  ) as HTMLLabelElement | undefined
  return label?.querySelector('input[type="checkbox"]') as HTMLInputElement
}
const cardButton = (label: string) =>
  Array.from(card()!.querySelectorAll('button')).find((element) => element.textContent?.trim() === label)
const capInput = () => card()!.querySelector('input[type="number"]') as HTMLInputElement

describe('the Checklists subsection is reachable from the real toolbar', () => {
  it('renders nothing until the settings button is pressed', async () => {
    await mount()
    expect(checklistGroup()).not.toBeNull()
    expect(card()).toBeNull()
  })

  it('opens the subsection card from the Checklist group', async () => {
    await mount()
    await openSubsection()
    expect(card()).not.toBeNull()
  })

  it('hosts the smart-checklist toggle, restore, the three bulk actions, the cap and Generate now', async () => {
    await mount()
    await openSubsection()

    expect(cardCheckbox('Move completed tasks out of the way')).toBeTruthy()
    expect(cardCheckbox('Write down missed occurrences')).toBeTruthy()
    for (const label of [
      'Restore completed',
      'Complete all',
      'Complete selected',
      'Uncomplete selected',
      'Generate now',
    ]) {
      expect(cardButton(label)).toBeDefined()
    }
    expect(capInput()).toBeTruthy()
  })

  it('states the two deliberate limits a user cannot otherwise discover', async () => {
    await mount()
    await openSubsection()
    const text = card()!.textContent ?? ''
    expect(text).toContain('Subtasks of a generated occurrence are')
    expect(text).toContain('reproduced')
    expect(text).toContain('month-end deadline keeps its own day')
  })
})

describe('the subsection reads and writes the two synced preferences by their literal keys', () => {
  it('shows the STORED values, proving the read does not go through a runtime-absent enum member', async () => {
    await mount()
    await openSubsection()

    // Both differ from the hardcoded defaults (on, 12). Reading through
    // `PrefKey.ChecklistAutoGenerateRecurrences` would pass `undefined` to
    // getPreference, miss both branches of the fake, and render the defaults.
    expect(cardCheckbox('Write down missed occurrences').checked).toBe(STORED_AUTO_GENERATE)
    expect(capInput().value).toBe(String(STORED_CAP))
  })

  it('writes the auto-generate toggle under its literal key, never under undefined', async () => {
    await mount()
    await openSubsection()

    await act(async () => {
      cardCheckbox('Write down missed occurrences').click()
      await Promise.resolve()
    })

    expect(writes).toHaveLength(1)
    expect(writes[0].key).toBe(CHECKLIST_AUTO_GENERATE_RECURRENCES_PREF_KEY)
    expect(writes[0].key).not.toBeUndefined()
    // Stored value was false, so the toggle turns it on.
    expect(writes[0].value).toBe(true)
  })

  it('clamps a cap written from the control, and writes it under its literal key', async () => {
    await mount()
    await openSubsection()

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(capInput(), '9999')
    await act(async () => {
      capInput().dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })

    expect(writes).toHaveLength(1)
    expect(writes[0].key).toBe(CHECKLIST_GENERATE_CAP_PREF_KEY)
    expect(writes[0].value).toBe(200)
  })
})

describe('Generate now runs the shared generation pass', () => {
  it('runs without a checklist in the note and reports that nothing was owed', async () => {
    await mount()
    await openSubsection()

    await act(async () => {
      cardButton('Generate now')!.click()
      await Promise.resolve()
    })

    // An empty note owes nothing; the pass must say so rather than claim work.
    const result = card()!.querySelector('[data-super-toolbar-checklist-generation-result]')
    expect(result).not.toBeNull()
    expect(result!.textContent).toContain('Nothing was owed')
    // And it must not have written a preference as a side effect.
    expect(writes).toEqual([])
  })
})
