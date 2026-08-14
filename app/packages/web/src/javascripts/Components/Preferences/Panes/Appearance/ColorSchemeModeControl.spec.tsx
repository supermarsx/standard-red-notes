/**
 * @jest-environment jsdom
 */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

const mockApplication = {}
const mockSelectColorSchemeMode = jest.fn()

jest.mock('@/Components/ApplicationProvider', () => ({
  useApplication: () => mockApplication,
}))

jest.mock('./ThemeSelection', () => ({
  selectColorSchemeMode: mockSelectColorSchemeMode,
}))

jest.mock('@/Hooks/usePreference', () => ({
  useLocalPreference: () => ['manual'],
}))

jest.mock('@/Components/RadioButtonGroup/RadioButtonGroup', () => ({
  __esModule: true,
  default: ({
    items,
    value,
    onChange,
  }: {
    items: { label: string; value: string }[]
    value: string
    onChange: (value: string) => void
  }) =>
    createElement(
      'div',
      null,
      items.map((item) =>
        createElement(
          'button',
          {
            key: item.value,
            'data-selected': item.value === value ? 'true' : 'false',
            onClick: () => onChange(item.value),
          },
          item.label,
        ),
      ),
    ),
}))

import ColorSchemeModeControl from './ColorSchemeModeControl'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ColorSchemeModeControl', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('surfaces the persisted Manual mode and routes mode changes through the durable selection boundary', () => {
    act(() => root.render(createElement(ColorSchemeModeControl)))

    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.map((button) => button.textContent)).toEqual(['Manual', 'Auto', 'Light', 'Dark'])
    expect(buttons[0].dataset.selected).toBe('true')

    act(() => buttons[1].click())
    expect(mockSelectColorSchemeMode).toHaveBeenCalledWith(mockApplication, 'auto')
  })
})
