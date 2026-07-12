/**
 * @jest-environment jsdom
 *
 * The disabled-reason contract for the shared button components. A native
 * `disabled` <button> swallows pointer events, so its tooltip never fires — the
 * fix swaps the native attribute for `aria-disabled` + `title` when (and only
 * when) a reason is given, keeping the button hoverable while inert. jsdom does
 * not render tooltips, so we assert the DOM/attribute contract that produces
 * them, plus the click guard. Backward compat (native `disabled`, no reason) is
 * regression-guarded here too. Convention mirrors Skeleton.spec.tsx: no
 * @testing-library, just createRoot + act + attribute assertions.
 */
import { createElement, act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import Button from '@/Components/Button/Button'
import IconButton from '@/Components/Button/IconButton'
import { IconType } from '@standardnotes/snjs'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

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
})

const REASON = 'Sign in to export an encrypted backup.'

describe('Button disabledReason', () => {
  it('disabled + reason → aria-disabled, NO native disabled attribute, title === reason', () => {
    act(() => {
      root.render(createElement(Button, { disabled: true, disabledReason: REASON, label: 'Export' }))
    })
    const button = container.querySelector('button') as HTMLButtonElement
    expect(button.getAttribute('aria-disabled')).toBe('true')
    // The native attribute must be gone, or the tooltip would never fire.
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(button.disabled).toBe(false)
    expect(button.getAttribute('title')).toBe(REASON)
    // Greyed styling is preserved regardless of which disabled mechanism is used.
    expect(button.className).toContain('cursor-not-allowed')
  })

  it('disabled + reason → onClick does NOT fire when clicked (guard works)', () => {
    const onClick = jest.fn()
    act(() => {
      root.render(createElement(Button, { disabled: true, disabledReason: REASON, onClick, label: 'Export' }))
    })
    const button = container.querySelector('button') as HTMLButtonElement
    act(() => {
      button.click()
    })
    expect(onClick).not.toHaveBeenCalled()
  })

  it('disabled WITHOUT reason → native disabled attribute present, NO aria-disabled, no reason title (backward compat)', () => {
    act(() => {
      root.render(createElement(Button, { disabled: true, label: 'Export' }))
    })
    const button = container.querySelector('button') as HTMLButtonElement
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-disabled')).toBeNull()
    expect(button.getAttribute('title')).toBeNull()
  })

  it('enabled + reason → no aria-disabled, reason not applied as title, onClick fires', () => {
    const onClick = jest.fn()
    act(() => {
      root.render(createElement(Button, { disabled: false, disabledReason: REASON, onClick, label: 'Export' }))
    })
    const button = container.querySelector('button') as HTMLButtonElement
    expect(button.getAttribute('aria-disabled')).toBeNull()
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(button.getAttribute('title')).toBeNull()
    act(() => {
      button.click()
    })
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('preserves an explicitly passed title when not showing a reason', () => {
    act(() => {
      root.render(createElement(Button, { disabled: false, title: 'A plain tooltip', label: 'Export' }))
    })
    const button = container.querySelector('button') as HTMLButtonElement
    expect(button.getAttribute('title')).toBe('A plain tooltip')
  })
})

describe('IconButton disabledReason', () => {
  const baseProps = {
    icon: 'download' as IconType,
    focusable: true,
    title: 'Download',
    onClick: () => undefined,
  }

  it('disabled + reason → aria-disabled + title === reason, no native disabled attribute', () => {
    act(() => {
      root.render(createElement(IconButton, { ...baseProps, disabled: true, disabledReason: REASON }))
    })
    const button = container.querySelector('button') as HTMLButtonElement
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(button.getAttribute('title')).toBe(REASON)
    // aria-label still names the control; the reason lives in title.
    expect(button.getAttribute('aria-label')).toBe('Download')
  })

  it('disabled + reason → onClick does NOT fire when clicked (guard works)', () => {
    const onClick = jest.fn()
    act(() => {
      root.render(createElement(IconButton, { ...baseProps, onClick, disabled: true, disabledReason: REASON }))
    })
    const button = container.querySelector('button') as HTMLButtonElement
    act(() => {
      button.click()
    })
    expect(onClick).not.toHaveBeenCalled()
  })

  it('disabled WITHOUT reason → native disabled attribute present, keeps its own title (backward compat)', () => {
    act(() => {
      root.render(createElement(IconButton, { ...baseProps, disabled: true }))
    })
    const button = container.querySelector('button') as HTMLButtonElement
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.getAttribute('aria-disabled')).toBeNull()
    expect(button.getAttribute('title')).toBe('Download')
  })
})
