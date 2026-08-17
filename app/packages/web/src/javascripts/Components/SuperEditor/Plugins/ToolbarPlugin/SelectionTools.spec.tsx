/** @jest-environment jsdom */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { PrefKey } from '@standardnotes/snjs'
import { useApplication } from '@/Components/ApplicationProvider'
import { useResponsiveAppPane } from '@/Components/Panes/ResponsivePaneProvider'
import SelectionTools from './SelectionTools'

jest.mock('@/Components/ApplicationProvider', () => ({ useApplication: jest.fn() }))
jest.mock('@/Components/Panes/ResponsivePaneProvider', () => ({ useResponsiveAppPane: jest.fn() }))
jest.mock('@/Components/Icon/Icon', () => ({
  __esModule: true,
  default: ({ type }: { type: string }) => <span data-icon={type} />,
}))
jest.mock('@/Components/Popover/Popover', () => ({ __esModule: true, default: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const application = {
  addEventObserver: jest.fn(() => () => undefined),
  getPreference: jest.fn((key: PrefKey, fallback: unknown) => {
    return key === PrefKey.AssistantConnectionMode ? 'proxy' : fallback
  }),
  hasAccount: jest.fn(() => true),
}

describe('SelectionTools AI action subtabs', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    jest.mocked(useApplication).mockReturnValue(application as never)
    jest.mocked(useResponsiveAppPane).mockReturnValue({ presentPane: jest.fn() } as never)
    act(() => {
      root.render(<SelectionTools editor={{} as never} hasSelection noteUuid="note-1" />)
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.clearAllMocks()
  })

  const actionLabels = () =>
    Array.from(container.querySelectorAll('[role="tabpanel"] button')).map((button) => button.textContent)

  const selectTab = (label: string) => {
    const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (candidate) => candidate.textContent === label,
    )
    expect(tab).toBeDefined()
    act(() => tab!.click())
  }

  it('renders icon-and-label subtabs with text review actions in the requested line order', () => {
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'))
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Text review', 'Transforms', 'Assistant'])
    expect(tabs.map((tab) => tab.querySelector('[data-icon]')?.getAttribute('data-icon'))).toEqual([
      'pencil-filled',
      'arrows-sort-down',
      'dashboard',
    ])
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(actionLabels()).toEqual(['Refine', 'Expand', 'Summarize'])
  })

  it('switches to transforms and assistant directives without mixing groups', () => {
    selectTab('Transforms')
    expect(actionLabels()).toEqual(['Translate…', 'Organize'])

    selectTab('Assistant')
    expect(actionLabels()).toEqual(['Ask AI…', 'Explain in-depth'])
  })
})
