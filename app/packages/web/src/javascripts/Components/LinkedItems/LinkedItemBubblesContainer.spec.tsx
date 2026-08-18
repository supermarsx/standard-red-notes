/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import LinkedItemBubblesContainer from './LinkedItemBubblesContainer'

type MockLink = {
  id: string
  item: { uuid: string; content_type: string }
}

type MockLinks = {
  notesLinkedToItem: MockLink[]
  filesLinkedToItem: MockLink[]
  tagsLinkedToItem: MockLink[]
  notesLinkingToItem: MockLink[]
  filesLinkingToItem: MockLink[]
}

let mockLinks: MockLinks

const mockApplication = {
  keyboardService: {
    addCommandHandler: () => () => undefined,
    keyboardShortcutForCommand: () => ({}) as never,
  },
  commands: { add: () => () => undefined },
  navigationController: {
    getNoteFolder: () => undefined,
    setSelectedFolder: () => Promise.resolve(),
  },
}

jest.mock('mobx-react-lite', () => ({ observer: (component: unknown) => component }))
jest.mock('@/Components/ApplicationProvider', () => ({ useApplication: () => mockApplication }))
jest.mock('@/Hooks/useItemLinks', () => ({ useItemLinks: () => mockLinks }))
jest.mock('@/Hooks/useItemVaultInfo', () => ({
  useItemVaultInfo: () => ({ vault: undefined, lastEditedByContact: undefined }),
}))
jest.mock('../Panes/ResponsivePaneProvider', () => ({ useResponsiveAppPane: () => ({ toggleAppPane: jest.fn() }) }))
jest.mock('../../Hooks/mergeRegister', () => ({ __esModule: true, default: () => () => undefined }))
jest.mock('@standardnotes/ui-services', () => ({
  FOCUS_TAGS_INPUT_COMMAND: 'focus-tags-input',
  keyboardStringForShortcut: () => 'Ctrl+L',
}))
jest.mock('./ItemLinkAutocompleteInput', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    __esModule: true,
    default: React.forwardRef<HTMLInputElement>(() => React.createElement('input', { 'data-link-input': true })),
  }
})
jest.mock('./LinkedItemBubble', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    __esModule: true,
    default: ({ link }: { link: MockLink }) => React.createElement('span', { 'data-link-id': link.id }, link.id),
  }
})
jest.mock('../Icon/Icon', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    __esModule: true,
    default: ({ type }: { type: string }) => React.createElement('span', { 'data-icon': type }),
  }
})
jest.mock('../Button/RoundIconButton', () => {
  const React = jest.requireActual<typeof import('react')>('react')
  return {
    __esModule: true,
    default: ({ label, icon: _icon, ...props }: { label: string; icon: string } & React.ComponentProps<'button'>) =>
      React.createElement('button', { ...props, 'aria-label': label }),
  }
})
jest.mock('../Vaults/VaultNameBadge', () => ({ __esModule: true, default: () => null }))
jest.mock('../Vaults/LastEditedByBadge', () => ({ __esModule: true, default: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class MockResizeObserver {
  static instances: MockResizeObserver[] = []
  element?: Element
  disconnected = false

  constructor(private readonly callback: ResizeObserverCallback) {
    MockResizeObserver.instances.push(this)
  }

  observe(element: Element): void {
    this.element = element
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true
  }

  trigger(): void {
    this.callback([], this as unknown as ResizeObserver)
  }

  static latestFor(element: Element): MockResizeObserver {
    const observer = [...MockResizeObserver.instances]
      .reverse()
      .find((candidate) => candidate.element === element && !candidate.disconnected)
    if (!observer) {
      throw new Error('No active ResizeObserver found for linked-items container')
    }
    return observer
  }
}

const links = (count: number): MockLinks => ({
  notesLinkedToItem: Array.from({ length: count }, (_, index) => ({
    id: `link-${index}`,
    item: { uuid: `item-${index}`, content_type: 'Note' },
  })),
  filesLinkedToItem: [],
  tagsLinkedToItem: [],
  notesLinkingToItem: [],
  filesLinkingToItem: [],
})

const linkedContainer = (container: HTMLElement): HTMLDivElement =>
  container.querySelector<HTMLDivElement>('.note-view-linking-container')!

const setLayoutMetrics = (container: HTMLElement) => {
  const metrics = { clientHeight: 20, clientWidth: 200, scrollWidth: 200, firstChildHeight: 20 }
  Object.defineProperties(container, {
    clientHeight: { configurable: true, get: () => metrics.clientHeight },
    clientWidth: { configurable: true, get: () => metrics.clientWidth },
    scrollWidth: { configurable: true, get: () => metrics.scrollWidth },
  })
  Object.defineProperty(container.firstElementChild!, 'clientHeight', {
    configurable: true,
    get: () => metrics.firstChildHeight,
  })
  return metrics
}

describe('LinkedItemBubblesContainer collapse control', () => {
  let container: HTMLElement
  let root: Root
  let originalResizeObserver: typeof ResizeObserver | undefined

  const component = (key = 'linked-items') =>
    createElement(LinkedItemBubblesContainer, {
      key,
      item: { uuid: `source-${key}`, content_type: 'Note' } as never,
      linkingController: { unlinkItems: jest.fn(), activateItem: jest.fn() } as never,
      readonly: true,
    })

  const render = () => {
    act(() => root.render(component()))
  }

  beforeEach(() => {
    mockLinks = links(0)
    MockResizeObserver.instances = []
    originalResizeObserver = globalThis.ResizeObserver
    ;(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
      MockResizeObserver as unknown as typeof ResizeObserver
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    ;(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = originalResizeObserver
    jest.clearAllMocks()
  })

  it('assigns unique toggle and controlled-container ids to simultaneous instances', () => {
    mockLinks = links(6)
    act(() => root.render(createElement('div', null, component('first'), component('second'))))

    const toggles = Array.from(container.querySelectorAll<HTMLButtonElement>('.note-view-linking-toggle'))
    expect(toggles).toHaveLength(2)
    expect(new Set(toggles.map((toggle) => toggle.id)).size).toBe(2)

    const controlledIds = toggles.map((toggle) => toggle.getAttribute('aria-controls'))
    expect(new Set(controlledIds).size).toBe(2)
    toggles.forEach((toggle, index) => {
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(controlledIds[index]).not.toBeNull()
      expect(container.contains(document.getElementById(controlledIds[index]!))).toBe(true)
    })
  })

  it('expands and removes a count-only toggle when the link count falls to the collapsed budget', () => {
    mockLinks = links(6)
    render()
    expect(linkedContainer(container).classList.contains('overflow-x-auto')).toBe(true)
    expect(container.querySelector('.note-view-linking-toggle')).not.toBeNull()

    mockLinks = links(5)
    render()

    expect(linkedContainer(container).classList.contains('flex-wrap')).toBe(true)
    expect(linkedContainer(container).classList.contains('overflow-x-auto')).toBe(false)
    expect(container.querySelector('.note-view-linking-toggle')).toBeNull()
  })

  it('keeps a wrapped-layout toggle reversible, then removes it when a resize makes collapsing a no-op', () => {
    mockLinks = links(3)
    render()
    const linkContainer = linkedContainer(container)
    const metrics = setLayoutMetrics(linkContainer)

    metrics.clientHeight = 48
    act(() => MockResizeObserver.latestFor(linkContainer).trigger())

    let toggle = container.querySelector<HTMLButtonElement>('.note-view-linking-toggle')!
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    metrics.clientWidth = 100
    metrics.scrollWidth = 180
    act(() => toggle.click())
    toggle = container.querySelector<HTMLButtonElement>('.note-view-linking-toggle')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(linkContainer.classList.contains('overflow-x-auto')).toBe(true)

    metrics.clientWidth = 220
    metrics.scrollWidth = 180
    metrics.clientHeight = 20
    act(() => MockResizeObserver.latestFor(linkContainer).trigger())

    expect(linkContainer.classList.contains('flex-wrap')).toBe(true)
    expect(container.querySelector('.note-view-linking-toggle')).toBeNull()
  })

  it('falls back to a window resize listener when ResizeObserver is unavailable', () => {
    ;(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = undefined
    mockLinks = links(3)
    render()
    const linkContainer = linkedContainer(container)
    const metrics = setLayoutMetrics(linkContainer)
    metrics.clientHeight = 48

    act(() => window.dispatchEvent(new Event('resize')))

    expect(container.querySelector('.note-view-linking-toggle')).not.toBeNull()
  })
})
