/**
 * @jest-environment jsdom
 *
 * Column contract for the "Organize folders & tags" table — the permanent reveal path
 * for hidden folders and tags.
 *
 * The bug this pins: every cell in that table carried vertical padding only, so the
 * note count sat flush against the Sidebar toggle's edge and the two header labels
 * touched. Measured in headless Chrome, the clearance between the digits and the
 * toggle was 0.00px at every modal width; it is now 24.00px, and a single unbroken
 * title no longer drags the table from 606px to 1740px inside a 638px scrolling area.
 *
 * jsdom HAS NO LAYOUT ENGINE — every rect here would read 0 and no stylesheet is
 * loaded, so nothing in this file measures a box or resolves a utility. What it can
 * hold, and what it does hold, is the declared contract the geometry depends on:
 * that both halves of each column (header cell and body cell) carry the SAME
 * horizontal padding, that the two right-hand columns refuse to wrap, that the two
 * columns which absorb the leftover width may break inside a word, and that the
 * toggle keeps the pressed state and the two tooltip strings that are the only
 * explanation of what hiding does. The rendered boxes are verified separately in
 * real --headless=new Chrome over CDP.
 */
import { createElement, act } from 'react'
import { createRoot, Root } from 'react-dom/client'

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
jest.mock('@/Components/Popover/Popover', () => () => null)

import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import BulkOrganizeModal from './BulkOrganizeModal'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const SHOWN_TOOLTIP = 'Shown in the sidebar list. Click to keep it out of that list.'
const HIDDEN_TOOLTIP = 'Hidden from the sidebar list. Click to show it there again.'

const COLUMNS = ['select', 'title', 'parent', 'notes', 'sidebar', 'delete'] as const

type Folder = {
  uuid: string
  title: string
  parentId: string | undefined
  noteReferences: unknown[]
  ownFlagHidden: boolean
  inHiddenSubtree: boolean
}

const folders: Folder[] = [
  {
    uuid: 'f0',
    title: 'Receipts',
    parentId: undefined,
    noteReferences: [1, 2, 3],
    ownFlagHidden: false,
    inHiddenSubtree: false,
  },
  {
    uuid: 'f1',
    title: 'Tax returns and every supporting invoice for the upstairs bathroom renovation',
    parentId: 'f0',
    noteReferences: [1],
    ownFlagHidden: true,
    inHiddenSubtree: true,
  },
  // Hidden only because an ancestor is: this is the row whose Sidebar cell is two
  // lines tall, because it also renders the "parent hidden" sub-label.
  {
    uuid: 'f2',
    title: 'Warranties',
    parentId: 'f1',
    noteReferences: [],
    ownFlagHidden: false,
    inHiddenSubtree: true,
  },
]

const makeApp = () =>
  ({
    navigationController: {
      folders,
      tags: [],
      isFolderHidden: (folder: Folder) => folder.ownFlagHidden,
      isFolderInHiddenSubtree: (folder: Folder) => folder.inHiddenSubtree,
      isTagHidden: () => false,
      isTagInHiddenSubtree: () => false,
      getTagParentForDisplay: () => undefined,
      getNotesCount: () => 0,
      bulkSetFoldersHidden: jest.fn(async () => undefined),
      bulkSetTagsHidden: jest.fn(async () => undefined),
      bulkDeleteFolders: jest.fn(async () => undefined),
      bulkDeleteTags: jest.fn(async () => undefined),
      bulkMoveFolders: jest.fn(async () => undefined),
      bulkMoveTags: jest.fn(async () => undefined),
      renameFolder: jest.fn(async () => undefined),
      save: jest.fn(async () => undefined),
    },
    addAndroidBackHandlerEventListener: () => () => undefined,
    setAndroidBackHandlerFallbackListener: () => undefined,
    addNativeMobileEventListener: () => () => undefined,
    getValue: () => false,
    mobileDevice: { exitApp: () => undefined },
  }) as never

let container: HTMLElement
let root: Root
let originalAnimate: typeof Element.prototype.animate

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
  window.matchMedia = ((query: string) => ({
    matches: /prefers-reduced-motion/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  originalAnimate = Element.prototype.animate
  Element.prototype.animate = function () {
    return {
      finished: Promise.resolve(),
      cancel: () => undefined,
      finish: () => undefined,
      currentTime: 0,
    } as unknown as Animation
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.querySelectorAll('[data-dialog-portal]').forEach((el) => el.remove())
  Element.prototype.animate = originalAnimate
})

const render = () => {
  const app = makeApp()
  act(() => {
    root.render(
      createElement(ApplicationProvider, {
        application: app,
        children: createElement(AndroidBackHandlerProvider, {
          application: app,
          children: createElement(BulkOrganizeModal, { isOpen: true, close: () => undefined }),
        }),
      }),
    )
  })
}

const tokensOf = (cell: Element): string[] => (cell.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)

/** Throws rather than returning undefined, so no assertion can run against a missing cell. */
const cellsOfRow = (row: Element | null, what: string): Element[] => {
  if (!row) {
    throw new Error(`${what} did not render`)
  }
  const cells = Array.from(row.children)
  if (cells.length !== COLUMNS.length) {
    throw new Error(`${what} rendered ${cells.length} cells, expected ${COLUMNS.length}`)
  }
  return cells
}

const headerCells = () => cellsOfRow(document.body.querySelector('table thead tr'), 'the header row')

const bodyRows = () => {
  const rows = Array.from(document.body.querySelectorAll('table tbody tr'))
  if (rows.length !== folders.length) {
    throw new Error(`the body rendered ${rows.length} rows, expected ${folders.length}`)
  }
  return rows
}

describe('BulkOrganizeModal column contract', () => {
  it('pads every cell horizontally, with the header matching its own column', () => {
    render()

    const header = headerCells()
    const first = cellsOfRow(bodyRows()[0], 'body row 0')

    COLUMNS.forEach((column, index) => {
      const headerPadding = tokensOf(header[index]).filter((token) => token.startsWith('px-'))
      const bodyPadding = tokensOf(first[index]).filter((token) => token.startsWith('px-'))

      // Exactly one horizontal-padding utility per cell: two would make which one
      // wins depend on stylesheet order, and none is the bug.
      expect({ column, headerPadding }).toEqual({ column, headerPadding: [expect.any(String)] })
      expect({ column, bodyPadding }).toEqual({ column, bodyPadding: [expect.any(String)] })
      // Equal on both halves, or the header label drifts off its column's content.
      expect({ column, headerPadding, bodyPadding }).toEqual({ column, headerPadding, bodyPadding: headerPadding })
    })
  })

  it('pads every body row the same way, including the two-line row with the parent-hidden sub-label', () => {
    render()

    const rows = bodyRows()
    const reference = cellsOfRow(rows[0], 'body row 0').map((cell) =>
      tokensOf(cell).filter((token) => token.startsWith('px-')),
    )

    rows.forEach((row, rowIndex) => {
      const padding = cellsOfRow(row, `body row ${rowIndex}`).map((cell) =>
        tokensOf(cell).filter((token) => token.startsWith('px-')),
      )
      expect({ rowIndex, padding }).toEqual({ rowIndex, padding: reference })
    })

    // The sub-label is what makes that one cell two lines tall; it must be present,
    // so the padding assertion above is covering the two-line case too.
    const subLabelRow = rows[2]
    expect(cellsOfRow(subLabelRow, 'body row 2')[4].textContent).toContain('parent hidden')
    expect(cellsOfRow(rows[0], 'body row 0')[4].textContent).not.toContain('parent hidden')
  })

  it('keeps the Notes and Sidebar columns from wrapping, in the header and the body', () => {
    render()

    const header = headerCells()
    expect(tokensOf(header[3])).toContain('whitespace-nowrap')
    expect(tokensOf(header[4])).toContain('whitespace-nowrap')

    bodyRows().forEach((row, rowIndex) => {
      const cells = cellsOfRow(row, `body row ${rowIndex}`)
      expect({ rowIndex, notes: tokensOf(cells[3]).includes('whitespace-nowrap') }).toEqual({ rowIndex, notes: true })
      expect({ rowIndex, sidebar: tokensOf(cells[4]).includes('whitespace-nowrap') }).toEqual({
        rowIndex,
        sidebar: true,
      })
    })
  })

  it('lets Title and Parent break inside a word, so a long title cannot push the other columns around', () => {
    render()

    bodyRows().forEach((row, rowIndex) => {
      const cells = cellsOfRow(row, `body row ${rowIndex}`)
      expect({ rowIndex, title: tokensOf(cells[1]).includes('wrap-anywhere') }).toEqual({ rowIndex, title: true })
      expect({ rowIndex, parent: tokensOf(cells[2]).includes('wrap-anywhere') }).toEqual({ rowIndex, parent: true })
    })
  })

  it('keeps the toggle pressed state and both tooltips, which carry the only explanation of hiding', () => {
    render()

    const toggles = bodyRows().map((row, rowIndex) => {
      const button = cellsOfRow(row, `body row ${rowIndex}`)[4].querySelector('button')
      if (!button) {
        throw new Error(`body row ${rowIndex} rendered no Sidebar toggle`)
      }
      return button
    })

    expect(toggles.map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false'])
    expect(toggles.map((button) => (button.textContent ?? '').trim())).toEqual(['Shown', 'Hidden', 'Shown'])
    expect(toggles.map((button) => button.getAttribute('title'))).toEqual([
      SHOWN_TOOLTIP,
      HIDDEN_TOOLTIP,
      SHOWN_TOOLTIP,
    ])
  })
})
