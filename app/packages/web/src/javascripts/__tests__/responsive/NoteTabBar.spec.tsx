/**
 * @jest-environment jsdom
 *
 * NoteTabBar is the browser-style tab strip rendered above the tiled editor on
 * every viewport (it is the primary way to switch the visible note on phones,
 * where the tile grid is gated off). It is a pure presentational component, so
 * unlike most responsive surfaces it CAN be fully mounted in jsdom.
 *
 * We assert the accessibility/structure contract that makes it testable and
 * switchable: a `role="tablist"` containing one `role="tab"` per open
 * controller, correct `aria-selected` on the active tab, and that clicking a tab
 * / the close / the add buttons invokes the right callbacks. The suite renders
 * at every target width to prove the structure is width-independent (the tab bar
 * is always present; only Tailwind sizing tokens differ, which jsdom can't see).
 */
import { createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { act } from 'react'
import NoteTabBar from '@/Components/NoteGroupView/NoteTabBar'
import { setViewport, TARGET_WIDTHS } from '@/TestUtils/viewport'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type FakeController = {
  runtimeId: string
  item?: { title?: string }
}

const makeController = (runtimeId: string, title?: string): FakeController => ({
  runtimeId,
  item: title === undefined ? undefined : { title },
})

let container: HTMLElement
let root: Root
let cleanupViewport: () => void = () => undefined

const mount = (element: React.ReactElement) => {
  act(() => {
    root.render(element)
  })
}

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

describe('NoteTabBar structure', () => {
  describe.each(TARGET_WIDTHS)('at %ipx', (width) => {
    beforeEach(() => {
      cleanupViewport = setViewport(width)
    })

    it('renders a tablist with one tab per controller', () => {
      const controllers = [makeController('a', 'Alpha'), makeController('b', 'Beta')]
      mount(
        createElement(NoteTabBar as never, {
          controllers,
          activeControllerRuntimeId: 'a',
          onSelect: () => undefined,
          onClose: () => undefined,
          onAddTab: () => undefined,
          canAddTab: true,
        }),
      )

      const tablist = container.querySelector('[role="tablist"]')
      expect(tablist).not.toBeNull()

      const tabs = container.querySelectorAll('[role="tab"]')
      expect(tabs).toHaveLength(2)
      expect(tabs[0].textContent).toContain('Alpha')
      expect(tabs[1].textContent).toContain('Beta')
    })

    it('marks the active controller as the selected tab', () => {
      const controllers = [makeController('a', 'Alpha'), makeController('b', 'Beta')]
      mount(
        createElement(NoteTabBar as never, {
          controllers,
          activeControllerRuntimeId: 'b',
          onSelect: () => undefined,
          onClose: () => undefined,
          onAddTab: () => undefined,
          canAddTab: true,
        }),
      )

      const tabs = Array.from(container.querySelectorAll('[role="tab"]'))
      expect(tabs[0].getAttribute('aria-selected')).toBe('false')
      expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    })

    it('falls back to "Untitled" for an empty title', () => {
      mount(
        createElement(NoteTabBar as never, {
          controllers: [makeController('a', '   '), makeController('b')],
          activeControllerRuntimeId: 'a',
          onSelect: () => undefined,
          onClose: () => undefined,
          onAddTab: () => undefined,
          canAddTab: true,
        }),
      )
      const tabs = container.querySelectorAll('[role="tab"]')
      expect(tabs[0].textContent).toContain('Untitled')
      expect(tabs[1].textContent).toContain('Untitled')
    })
  })
})

describe('NoteTabBar interaction (switching active note)', () => {
  beforeEach(() => {
    cleanupViewport = setViewport(375)
  })

  it('selects a controller when its tab is clicked', () => {
    const selected: string[] = []
    const controllers = [makeController('a', 'Alpha'), makeController('b', 'Beta')]
    mount(
      createElement(NoteTabBar as never, {
        controllers,
        activeControllerRuntimeId: 'a',
        onSelect: (c: FakeController) => selected.push(c.runtimeId),
        onClose: () => undefined,
        onAddTab: () => undefined,
        canAddTab: true,
      }),
    )

    const secondTab = container.querySelectorAll('[role="tab"]')[1] as HTMLElement
    act(() => {
      secondTab.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(selected).toEqual(['b'])
  })

  it('selects a controller via keyboard (Enter)', () => {
    const selected: string[] = []
    const controllers = [makeController('a', 'Alpha'), makeController('b', 'Beta')]
    mount(
      createElement(NoteTabBar as never, {
        controllers,
        activeControllerRuntimeId: 'a',
        onSelect: (c: FakeController) => selected.push(c.runtimeId),
        onClose: () => undefined,
        onAddTab: () => undefined,
        canAddTab: true,
      }),
    )

    const secondTab = container.querySelectorAll('[role="tab"]')[1] as HTMLElement
    act(() => {
      secondTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(selected).toEqual(['b'])
  })

  it('closes a controller via its close button without selecting it', () => {
    const selected: string[] = []
    const closed: string[] = []
    const controllers = [makeController('a', 'Alpha'), makeController('b', 'Beta')]
    mount(
      createElement(NoteTabBar as never, {
        controllers,
        activeControllerRuntimeId: 'a',
        onSelect: (c: FakeController) => selected.push(c.runtimeId),
        onClose: (c: FakeController) => closed.push(c.runtimeId),
        onAddTab: () => undefined,
        canAddTab: true,
      }),
    )

    const closeButton = container.querySelector('button[aria-label="Close note"]') as HTMLElement
    act(() => {
      closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(closed).toEqual(['a'])
    // stopPropagation must prevent the tab's own onSelect from firing.
    expect(selected).toEqual([])
  })

  it('invokes onAddTab from the add button only when enabled', () => {
    let added = 0
    const controllers = [makeController('a', 'Alpha')]

    mount(
      createElement(NoteTabBar as never, {
        controllers,
        activeControllerRuntimeId: 'a',
        onSelect: () => undefined,
        onClose: () => undefined,
        onAddTab: () => {
          added += 1
        },
        canAddTab: false,
      }),
    )
    const addButtonDisabled = container.querySelector(
      'button[aria-label="New note tab"]',
    ) as HTMLButtonElement
    expect(addButtonDisabled.disabled).toBe(true)

    mount(
      createElement(NoteTabBar as never, {
        controllers,
        activeControllerRuntimeId: 'a',
        onSelect: () => undefined,
        onClose: () => undefined,
        onAddTab: () => {
          added += 1
        },
        canAddTab: true,
      }),
    )
    const addButtonEnabled = container.querySelector(
      'button[aria-label="New note tab"]',
    ) as HTMLButtonElement
    expect(addButtonEnabled.disabled).toBe(false)
    act(() => {
      addButtonEnabled.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(added).toBe(1)
  })
})
