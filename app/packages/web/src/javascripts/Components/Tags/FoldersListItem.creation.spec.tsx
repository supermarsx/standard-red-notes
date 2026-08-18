/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('@/Components/Icon/Icon', () => ({
  __esModule: true,
  default: () => null,
}))

jest.mock('@/Hooks/usePremiumModal', () => ({
  usePremiumModal: () => ({ activate: jest.fn() }),
}))

jest.mock('@/Logging', () => ({
  LoggingDomain: { NavigationList: 'navigation-list' },
  log: jest.fn(),
}))

const mockApplication = {
  items: {
    isTemplateItem: jest.fn(() => true),
  },
}

jest.mock('../ApplicationProvider', () => ({
  useApplication: () => mockApplication,
}))

import { FoldersListItem } from './FoldersListItem'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('FoldersListItem folder submission guard', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    mockApplication.items.isTemplateItem.mockReturnValue(true)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('submits a template once when blur is delivered repeatedly while sync is pending', async () => {
    const neverSettles = new Promise<void>(() => undefined)
    const createFolder = jest.fn(() => neverSettles)
    const folder = {
      uuid: 'template-folder',
      title: 'Projects',
      expanded: false,
      noteCount: 0,
      noteReferences: [],
    }
    const navigationController = {
      addingSubfolderTo: undefined,
      contextMenuFolder: undefined,
      contextMenuOpen: false,
      contextMenuTagSection: 'folders',
      createFolder,
      editingFolder: folder,
      getFolderChildren: jest.fn(() => []),
      renameFolder: jest.fn(async () => undefined),
      selectedFolder: undefined,
      selectedLocation: 'folders',
      setFolderExpanded: jest.fn(),
      setSelectedFolder: jest.fn(async () => undefined),
    }

    await act(async () => {
      root.render(
        createElement(FoldersListItem, {
          folder: folder as never,
          navigationController: navigationController as never,
          features: { hasFolders: true } as never,
          linkingController: {} as never,
          level: 0,
          onContextMenu: jest.fn(),
        }),
      )
    })

    const input = container.querySelector('input') as HTMLInputElement
    expect(input).toBeTruthy()

    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })

    expect(createFolder).toHaveBeenCalledTimes(1)
    expect(createFolder).toHaveBeenCalledWith('Projects')
  })
})
