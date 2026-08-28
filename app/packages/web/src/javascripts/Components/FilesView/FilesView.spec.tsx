/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { UuidGenerator } from '@standardnotes/snjs'
import FilesView from './FilesView'
import { Table as TableContract } from '@/Components/Table/CommonTypes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let mockRenderedTable: TableContract<unknown> | undefined
let mockEllipsisItems: unknown[] = []
let mockRowMenuProps: { items: unknown[]; closeMenu: () => void; anchorPoint: { x: number; y: number } } | undefined

jest.mock('mobx-react-lite', () => ({ observer: (component: unknown) => component }))
jest.mock('@standardnotes/filepicker', () => ({ formatSizeToReadableString: (size: number) => `${size} bytes` }))
jest.mock('@/Components/Icon/Icon', () => () => null)
// Reads the app from context; these cases render FilesView without a provider.
jest.mock('@/Components/ContentListView/ListItemVaultInfo', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/FilePreview/getFileIconComponent', () => ({ getFileIconComponent: () => null }))
jest.mock('@/Utils/Items/Icons/getIconForFileType', () => ({ getIconForFileType: () => 'file' }))
jest.mock('@/Components/ContentTableView/ContentTableView', () => ({
  ContextMenuCell: ({ items }: { items: unknown[] }) => {
    mockEllipsisItems = items
    return <button type="button">Options</button>
  },
  ItemLinksCell: () => <button type="button">Links</button>,
}))
jest.mock('@/Components/Menu/Menu', () => ({
  __esModule: true,
  default: ({ children }: { children: unknown }) => children,
}))
jest.mock('@/Components/FileContextMenu/FileMenuOptions', () => () => null)
jest.mock('@/Components/ContentTableView/ItemOptionsMenu', () => ({
  __esModule: true,
  default: (props: { items: unknown[]; closeMenu: () => void; anchorPoint: { x: number; y: number } }) => {
    mockRowMenuProps = props
    return <div data-testid="row-options" />
  },
}))
jest.mock('@/Components/Popover/Popover', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/FileDragNDropProvider', () => ({
  useFileDragNDrop: () => ({ addDragTarget: jest.fn(), removeDragTarget: jest.fn() }),
}))
jest.mock('@/Utils/DateUtils', () => ({ formatDateForContextMenu: () => 'Jan 1, 2026' }))

let activeBreakpoint: 'sm' | 'md' | 'lg' | 'xl' = 'xl'
jest.mock('@/Hooks/useMediaQuery', () => ({
  MutuallyExclusiveMediaQueryBreakpoints: {
    sm: 'breakpoint-sm',
    md: 'breakpoint-md',
    lg: 'breakpoint-lg',
  },
  useMediaQuery: (query: string) => query === `breakpoint-${activeBreakpoint}`,
}))

jest.mock('@/Components/Table/Table', () => ({
  __esModule: true,
  default: ({ table }: { table: TableContract<unknown> }) => {
    mockRenderedTable = table
    return (
      <div data-testid="rendered-table">
        <div>
          {table.headers
            .filter((header) => !header.hidden)
            .map((header) => (
              <span data-column={header.name} key={header.name}>
                {header.name}
              </span>
            ))}
        </div>
        {table.rows.map((row) => (
          <div data-row={row.id} key={row.id}>
            {row.cells
              .filter((cell) => !cell.hidden)
              .map((cell) => (
                <div data-cell={table.headers[cell.colIndex]?.name} key={cell.colIndex}>
                  {cell.render}
                </div>
              ))}
            {row.rowActions}
          </div>
        ))}
      </div>
    )
  },
}))

const createFile = (description?: string) =>
  ({
    uuid: 'file-1',
    name: 'document.txt',
    description,
    mimeType: 'text/plain',
    decryptedSize: 12,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    userModifiedDate: new Date('2026-01-02T00:00:00.000Z'),
  }) as never

const createApplication = (file: ReturnType<typeof createFile>) =>
  ({
    items: {
      getDisplayableFiles: () => [file],
      streamItems: () => () => undefined,
    },
    itemListController: {
      filesViewSortBy: 'date',
      filesViewSortDirection: 'dsc',
      filesViewSelectedUuids: new Set<string>(),
      pruneFilesViewSelection: jest.fn(),
      selectAllFilesViewFiles: jest.fn(),
      clearFilesViewSelection: jest.fn(),
      toggleFilesViewSortDirection: jest.fn(),
      setFilesViewSortBy: jest.fn(),
      // 'all' is the default chip, under which filterItemsByFolder is a pass-through,
      // so the folder bar does not change what these cases assert about the table.
      filesFolderFilter: 'all',
      setFilesFolderFilter: jest.fn(),
    },
    navigationController: {
      folders: [],
      allLocalRootFolders: [],
      getFolderChildren: () => [],
      createFolder: jest.fn(),
    },
    filesController: {
      handleFileAction: jest.fn(),
      selectAndUploadNewFiles: jest.fn(),
    },
    entitledToFiles: true,
    showPremiumModal: jest.fn(),
    // The view binds the create shortcut to upload while it is mounted.
    commands: { addWithShortcut: () => () => undefined },
    // No stored sort preference and no local backup service in these cases, so
    // the table renders from the controller defaults exactly as before.
    getPreference: () => undefined,
    setPreference: jest.fn(async () => undefined),
    fileBackups: undefined,
  }) as never

let container: HTMLElement
let root: Root

beforeEach(() => {
  UuidGenerator.SetGenerator(() => 'files-view-table-test')
  activeBreakpoint = 'xl'
  mockRenderedTable = undefined
  mockEllipsisItems = []
  mockRowMenuProps = undefined
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (description?: string) => {
  act(() => root.render(createElement(FilesView, { application: createApplication(createFile(description)) })))
}

describe('FilesView description column', () => {
  it('renders a bounded visual preview as inert text', () => {
    const description = 'First line\n<img src=x onerror=alert(1)>'
    render(description)

    const descriptionCell = container.querySelector('[data-cell="Description"]') as HTMLElement
    const preview = descriptionCell.querySelector('span') as HTMLElement
    expect(preview.textContent).toBe(description)
    expect(preview.className).toContain('line-clamp-2')
    expect(preview.title).toBe(description)
    expect(descriptionCell.querySelector('img')).toBeNull()
  })

  it('keeps legacy files without a description readable', () => {
    render(undefined)

    const descriptionCell = container.querySelector('[data-cell="Description"]') as HTMLElement
    expect(descriptionCell.textContent).toBe('No description')
    expect(descriptionCell.querySelector('span')?.className).toContain('italic')
  })
})

describe('FilesView responsive columns', () => {
  it.each([
    ['sm', ['Name', 'Size']],
    ['md', ['Name', 'Type', 'Size', 'Uploaded']],
    ['lg', ['Name', 'Description', 'Type', 'Size', 'Uploaded']],
    ['xl', ['Name', 'Description', 'Type', 'Size', 'Uploaded', 'Modified']],
  ] as const)('shows the intended %s columns', (breakpoint, expectedColumns) => {
    activeBreakpoint = breakpoint
    render('Description')

    const columns = Array.from(container.querySelectorAll('[data-column]')).map((column) =>
      column.getAttribute('data-column'),
    )
    expect(columns).toEqual(expectedColumns)
  })
})

describe('FilesView row context actions', () => {
  it('targets the right-clicked file with the same action item and restores trigger focus on close', () => {
    render('Description')
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    act(() => mockRenderedTable!.handleRowContextMenu('file-1', 12, 24, trigger))

    expect(mockRowMenuProps?.items).toEqual(mockEllipsisItems)
    expect(mockRowMenuProps?.anchorPoint).toEqual({ x: 12, y: 24 })
    act(() => mockRowMenuProps!.closeMenu())
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})
