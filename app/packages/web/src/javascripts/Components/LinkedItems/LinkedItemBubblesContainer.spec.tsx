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
jest.mock('../Vaults/VaultNameBadge', () => ({ __esModule: true, default: () => null }))
jest.mock('../Vaults/LastEditedByBadge', () => ({ __esModule: true, default: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

describe('LinkedItemBubblesContainer', () => {
  let container: HTMLElement
  let root: Root

  const component = (readonly = true) =>
    createElement(LinkedItemBubblesContainer, {
      item: { uuid: 'source-note', content_type: 'Note' } as never,
      linkingController: { unlinkItems: jest.fn(), activateItem: jest.fn() } as never,
      readonly,
    })

  const render = (readonly = true) => {
    act(() => root.render(component(readonly)))
  }

  beforeEach(() => {
    mockLinks = links(0)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.clearAllMocks()
  })

  it('always shows every linked item without a collapsed control or hidden overflow row', () => {
    mockLinks = links(8)
    render()

    expect(linkedContainer(container).classList.contains('flex-wrap')).toBe(true)
    expect(linkedContainer(container).classList.contains('overflow-x-auto')).toBe(false)
    expect(container.querySelector('.note-view-linking-toggle')).toBeNull()
    expect(container.querySelectorAll('[data-link-id]')).toHaveLength(8)
    expect(container.textContent).not.toContain('more...')
  })

  it('keeps outgoing links and backlinks reachable in their labeled groups', () => {
    mockLinks = links(2)
    mockLinks.notesLinkingToItem = [{ id: 'backlink-1', item: { uuid: 'backlink-note', content_type: 'Note' } }]
    render()

    expect(container.textContent).toContain('Links (2)')
    expect(container.textContent).toContain('Linked By (1)')
    expect(container.querySelectorAll('[data-link-id]')).toHaveLength(3)
  })

  it('keeps the functional inline link input reachable for editable notes', () => {
    mockLinks = links(0)
    render(false)

    expect(container.querySelector('[data-link-input]')).not.toBeNull()
    expect(container.querySelector('.note-view-linking-toggle')).toBeNull()
  })
})
