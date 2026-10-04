/**
 * @jest-environment jsdom
 *
 * The table action menu's submenu, mounted inside the REAL `Menu` with its real
 * keyboard navigation.
 *
 * The regression this guards is specific: a submenu that is unreachable by
 * keyboard. `useListKeyboardNavigation` collects items with
 * `querySelectorAll('button, div[role="button"]')` on the menu element and
 * re-collects from a `subtree: true` MutationObserver — so an IN-PLACE disclosure
 * joins Up/Down navigation when it opens, and a portaled one never would. That is
 * asserted here by driving real ArrowDown events and watching focus walk INTO the
 * revealed items, not by inspecting markup and assuming.
 */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import Menu from '@/Components/Menu/Menu'
import MenuItem from '@/Components/Menu/MenuItem'
import { TableActionSubmenu } from './TableActionSubmenu'

jest.mock('@/Hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
  MutuallyExclusiveMediaQueryBreakpoints: { sm: 'sm', md: 'md' },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
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
      <Menu a11yLabel="Table actions menu" shouldAutoFocus={false}>
        <MenuItem onClick={() => undefined}>Delete row</MenuItem>
        <TableActionSubmenu label="Headers and whole table">
          <MenuItem onClick={() => undefined}>Add row header</MenuItem>
          <MenuItem onClick={() => undefined}>Delete table</MenuItem>
        </TableActionSubmenu>
      </Menu>,
    )
    await Promise.resolve()
  })
}

const menuElement = (): HTMLElement => {
  const menu = container.querySelector('menu')
  if (menu === null) {
    throw new Error('no menu rendered')
  }
  return menu
}

const toggle = (): HTMLButtonElement => {
  const button = Array.from(menuElement().querySelectorAll('button')).find(
    (candidate) => candidate.getAttribute('aria-expanded') !== null,
  )
  if (button === undefined) {
    throw new Error('no disclosure toggle rendered')
  }
  return button
}

const labels = () => Array.from(menuElement().querySelectorAll('button')).map((button) => button.textContent ?? '')

const pressOn = async (element: Element, key: string) => {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    await Promise.resolve()
  })
}

describe('the table action submenu', () => {
  it('starts collapsed, hiding the rarer actions', async () => {
    await mount()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(labels().some((label) => label.includes('Delete table'))).toBe(false)
    // ...while the frequent action stays one click away.
    expect(labels().some((label) => label.includes('Delete row'))).toBe(true)
  })

  it('reveals them on click and hides them again', async () => {
    await mount()
    await act(async () => {
      toggle().click()
    })
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(labels().some((label) => label.includes('Delete table'))).toBe(true)
    await act(async () => {
      toggle().click()
    })
    expect(labels().some((label) => label.includes('Delete table'))).toBe(false)
  })

  it('opens with ArrowRight and closes with ArrowLeft', async () => {
    await mount()
    await pressOn(toggle(), 'ArrowRight')
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    await pressOn(toggle(), 'ArrowLeft')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
  })

  it('puts the revealed items inside the same menu element, where the keyboard navigation looks', async () => {
    await mount()
    await act(async () => {
      toggle().click()
    })
    const revealed = Array.from(menuElement().querySelectorAll('button')).filter((button) =>
      (button.textContent ?? '').includes('Add row header'),
    )
    expect(revealed).toHaveLength(1)
    // Not portaled out: the keyboard hook queries the <menu> subtree only.
    expect(menuElement().contains(revealed[0])).toBe(true)
  })

  it('lets Up/Down actually walk into the revealed items', async () => {
    await mount()
    await act(async () => {
      toggle().click()
    })
    const menu = menuElement()
    const focused: string[] = []
    // The hook starts at index 0 and steps forward; four ArrowDowns must reach the
    // two revealed items rather than skipping straight past the disclosure.
    for (let step = 0; step < 4; step++) {
      await pressOn(menu, 'ArrowDown')
      focused.push(document.activeElement?.textContent ?? '')
    }
    expect(focused.some((label) => label.includes('Add row header'))).toBe(true)
    expect(focused.some((label) => label.includes('Delete table'))).toBe(true)
  })

  it('returns focus to the toggle when ArrowLeft collapses from inside', async () => {
    await mount()
    await act(async () => {
      toggle().click()
    })
    const inner = Array.from(menuElement().querySelectorAll('button')).find((button) =>
      (button.textContent ?? '').includes('Add row header'),
    )
    expect(inner).toBeDefined()
    await pressOn(inner!, 'ArrowLeft')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle())
  })
})
