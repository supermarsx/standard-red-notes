/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

/**
 * A hidden folder only reaches this row while the sidebar's reveal toggle is on, so the row
 * has to say which of the rows on screen are the hidden ones — otherwise the user cannot tell
 * what they came here to unhide. These cases pin that marker, and pin that it says hiding
 * keeps the row out of a list rather than implying the notes are protected.
 *
 * jsdom has no layout engine, so nothing here measures a box: the assertions are on presence,
 * accessible name and class.
 */
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
    isTemplateItem: jest.fn(() => false),
  },
}

jest.mock('../ApplicationProvider', () => ({
  useApplication: () => mockApplication,
}))

import { FoldersListItem } from './FoldersListItem'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const HIDDEN_MARKER_LABEL = 'Hidden from the sidebar list'

describe('FoldersListItem hidden marker', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    mockApplication.items.isTemplateItem.mockReturnValue(false)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const renderRow = async (isHidden: boolean) => {
    const folder = {
      uuid: 'folder-1',
      title: 'Receipts',
      expanded: false,
      noteCount: 0,
      noteReferences: [],
    }

    await act(async () => {
      root.render(
        createElement(FoldersListItem, {
          folder: folder as never,
          navigationController: {
            addingSubfolderTo: undefined,
            contextMenuFolder: undefined,
            contextMenuOpen: false,
            contextMenuTagSection: 'folders',
            editingFolder: undefined,
            getFolderChildren: jest.fn(() => []),
            isFolderHidden: jest.fn(() => isHidden),
            renameFolder: jest.fn(async () => undefined),
            selectedFolder: undefined,
            selectedLocation: 'folders',
            setFolderExpanded: jest.fn(),
            setSelectedFolder: jest.fn(async () => undefined),
          } as never,
          features: { hasFolders: true } as never,
          linkingController: {} as never,
          level: 0,
          onContextMenu: jest.fn(),
        }),
      )
    })
  }

  it('marks a hidden folder so it can be told apart while hidden rows are revealed', async () => {
    await renderRow(true)

    const marker = container.querySelector(`[aria-label="${HIDDEN_MARKER_LABEL}"]`)
    expect(marker).toBeTruthy()
    expect(container.querySelector('.tag')?.className).toContain('opacity-60')
  })

  it('says hiding keeps the row out of a list, and does not claim the notes are protected', async () => {
    await renderRow(true)

    const marker = container.querySelector(`[aria-label="${HIDDEN_MARKER_LABEL}"]`) as HTMLElement
    const tooltip = marker.getAttribute('title') ?? ''

    expect(tooltip).toContain('Hidden from the sidebar list')
    expect(tooltip).toContain('All Notes')
    expect(tooltip).not.toMatch(/private|protect|secure|encrypt|lock/i)
  })

  it('leaves an ordinary folder row unmarked', async () => {
    await renderRow(false)

    expect(container.querySelector(`[aria-label="${HIDDEN_MARKER_LABEL}"]`)).toBeNull()
    expect(container.querySelector('.tag')?.className).not.toContain('opacity-60')
  })
})
