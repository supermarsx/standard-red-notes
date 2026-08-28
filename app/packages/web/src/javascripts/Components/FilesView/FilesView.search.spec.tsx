/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { PrefKey, SystemViewId } from '@standardnotes/snjs'
import FilesView from './FilesView'
import { Table as TableContract } from '@/Components/Table/CommonTypes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

jest.mock('mobx-react-lite', () => ({ observer: (component: unknown) => component }))
jest.mock('@standardnotes/filepicker', () => ({ formatSizeToReadableString: (size: number) => `${size} bytes` }))
jest.mock('@/Components/Icon/Icon', () => ({ type }: { type: string }) => <i data-icon={type} />)
jest.mock('@/Components/FilePreview/getFileIconComponent', () => ({ getFileIconComponent: () => null }))
jest.mock('@/Utils/Items/Icons/getIconForFileType', () => ({ getIconForFileType: () => 'file' }))
jest.mock('@/Components/ContentTableView/ContentTableView', () => ({
  ContextMenuCell: () => <button type="button">Options</button>,
  ItemLinksCell: () => <button type="button">Links</button>,
}))
jest.mock('@/Components/Menu/Menu', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => children,
}))
jest.mock('@/Components/Menu/MenuItem', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/FileContextMenu/FileMenuOptions', () => () => null)
jest.mock('@/Components/ContentTableView/ItemOptionsMenu', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/Popover/Popover', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/FileDragNDropProvider', () => ({
  useFileDragNDrop: () => ({ addDragTarget: jest.fn(), removeDragTarget: jest.fn() }),
}))
jest.mock('@/Utils/DateUtils', () => ({ formatDateForContextMenu: () => 'Jan 1, 2026' }))
jest.mock('@standardnotes/toast', () => ({ ToastType: { Success: 'success', Error: 'error' }, addToast: jest.fn() }))
jest.mock('@/Hooks/useMediaQuery', () => ({
  MutuallyExclusiveMediaQueryBreakpoints: { sm: 'sm', md: 'md', lg: 'lg' },
  useMediaQuery: () => false,
}))
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
jest.mock('@standardnotes/icons', () => ({ FilesIllustration: () => <div data-testid="files-illustration" /> }))
// Marker rather than null, so the vault badge's presence in the name cell is provable.
jest.mock('@/Components/ContentListView/ListItemVaultInfo', () => ({
  __esModule: true,
  default: () => <span data-testid="vault-info" />,
}))
jest.mock('@/Utils/DirectoryPicker', () => ({ selectDirectoryFiles: jest.fn() }))
jest.mock('@/Utils/FolderUpload', () => ({ uploadFilesWithFolderStructure: jest.fn() }))

/** Renders each row's Name cell so the badges inside it are inspectable. */
jest.mock('@/Components/Table/Table', () => ({
  __esModule: true,
  default: ({ table }: { table: TableContract<unknown> }) => (
    <div data-testid="rendered-table">
      {table.rows.map((row) => (
        <div data-row={row.id} key={row.id}>
          {row.cells[0]?.render as React.ReactNode}
        </div>
      ))}
    </div>
  ),
}))

type TestFile = {
  uuid: string
  name: string
  protected: boolean
  mimeType: string
  decryptedSize: number
  description?: string
  created_at: Date
  userModifiedDate: Date
}

const createFile = (uuid: string, name: string, extra: Partial<TestFile> = {}): TestFile => ({
  uuid,
  name,
  protected: false,
  mimeType: 'text/plain',
  decryptedSize: 12,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  userModifiedDate: new Date('2026-01-02T00:00:00.000Z'),
  ...extra,
})

const REPORT = createFile('file-1', 'quarterly-report.txt', { description: 'finance summary' })
const PHOTO = createFile('file-2', 'holiday.png', { mimeType: 'image/png' })
const LOCKED = createFile('file-3', 'secrets.txt', { protected: true })

const createApplication = (files: TestFile[], options: { storedPreferences?: unknown; backedUp?: boolean } = {}) => {
  let sortBy = 'name'
  let sortDirection = 'asc'
  const setPreference = jest.fn(async () => undefined)

  const itemListController = {
    get filesViewSortBy() {
      return sortBy
    },
    get filesViewSortDirection() {
      return sortDirection
    },
    filesViewSelectedUuids: new Set<string>(),
    filesFolderFilter: 'all',
    setFilesFolderFilter: jest.fn(),
    pruneFilesViewSelection: jest.fn(),
    selectAllFilesViewFiles: jest.fn(),
    clearFilesViewSelection: jest.fn(),
    toggleFilesViewSortDirection: jest.fn(() => {
      sortDirection = sortDirection === 'asc' ? 'dsc' : 'asc'
    }),
    setFilesViewSortBy: jest.fn((next: string) => {
      sortBy = next
    }),
  }

  return {
    items: { getDisplayableFiles: () => files, streamItems: () => () => undefined },
    itemListController,
    navigationController: {
      folders: [],
      allLocalRootFolders: [],
      getFolderChildren: () => [],
      createFolder: jest.fn(),
    },
    filesController: { handleFileAction: jest.fn(), selectAndUploadNewFiles: jest.fn() },
    entitledToFiles: true,
    showPremiumModal: jest.fn(),
    // The view binds the create shortcut to upload while it is mounted.
    commands: { addWithShortcut: () => () => undefined },
    getPreference: (key: string) => (key === PrefKey.SystemViewPreferences ? options.storedPreferences : undefined),
    setPreference,
    fileBackups: options.backedUp ? { getFileBackupInfo: async () => ({ backedUp: true }) } : undefined,
  }
}

describe('FilesView search, badges and sort persistence', () => {
  let container: HTMLElement
  let root: Root

  const render = (application: ReturnType<typeof createApplication>) => {
    act(() => root.render(createElement(FilesView, { application: application as never })))
  }

  const searchInput = () => container.querySelector<HTMLInputElement>('input[type="search"]')

  const search = (application: ReturnType<typeof createApplication>, query: string) => {
    const input = searchInput()
    if (!input) {
      throw new Error('no search input rendered')
    }
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, query)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    render(application)
  }

  const renderedRowIds = () =>
    Array.from(container.querySelectorAll('[data-row]')).map((element) => element.getAttribute('data-row'))

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders a search field on the merged tab', () => {
    render(createApplication([REPORT, PHOTO]))

    expect(searchInput()).not.toBeNull()
    expect(renderedRowIds()).toEqual(['file-2', 'file-1'])
  })

  it('narrows rows by name', () => {
    const application = createApplication([REPORT, PHOTO])
    render(application)

    search(application, 'holiday')

    expect(renderedRowIds()).toEqual(['file-2'])
  })

  it('matches description and type, not just the file name', () => {
    const application = createApplication([REPORT, PHOTO])
    render(application)

    search(application, 'finance')
    expect(renderedRowIds()).toEqual(['file-1'])

    search(application, 'image/png')
    expect(renderedRowIds()).toEqual(['file-2'])
  })

  it('AND-combines terms rather than matching either', () => {
    const application = createApplication([REPORT, PHOTO])
    render(application)

    search(application, 'holiday finance')

    expect(renderedRowIds()).toEqual([])
  })

  it('says a search found nothing instead of claiming the account is empty', () => {
    const application = createApplication([REPORT])
    render(application)

    search(application, 'nothingmatchesthis')

    expect(container.textContent).toContain('No files match')
    expect(container.querySelector('[data-testid="files-illustration"]')).toBeNull()
  })

  it('marks protected files and carries the vault badge in the name cell', () => {
    render(createApplication([LOCKED]))

    const row = container.querySelector('[data-row="file-3"]')
    expect(row?.querySelector('[data-icon="lock-filled"]')).not.toBeNull()
    expect(row?.querySelector('[data-testid="vault-info"]')).not.toBeNull()
  })

  it('shows the local-backup badge only when a backup exists', async () => {
    const withBackup = createApplication([REPORT], { backedUp: true })
    await act(async () => {
      root.render(createElement(FilesView, { application: withBackup as never }))
    })

    expect(container.querySelector('[data-icon="check-circle-filled"]')).not.toBeNull()

    act(() => root.unmount())
    root = createRoot(container)

    render(createApplication([REPORT]))
    expect(container.querySelector('[data-icon="check-circle-filled"]')).toBeNull()
  })

  it('adopts the sort the Files smart view had persisted', () => {
    const application = createApplication([REPORT, PHOTO], {
      storedPreferences: { [SystemViewId.Files]: { sortBy: 'decryptedSize', sortReverse: true } },
    })

    render(application)

    expect(application.itemListController.setFilesViewSortBy).toHaveBeenCalledWith('size')
    // Stored reversed means ascending; the tab starts ascending, so no toggle.
    expect(application.itemListController.toggleFilesViewSortDirection).not.toHaveBeenCalled()
  })

  it('persists a sort change back to the same preference key', () => {
    const application = createApplication([REPORT, PHOTO])
    render(application)

    const select = container.querySelector('select')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, 'size')
      select?.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(application.setPreference).toHaveBeenCalledWith(PrefKey.SystemViewPreferences, {
      [SystemViewId.Files]: { sortBy: 'decryptedSize', sortReverse: true },
    })
  })
})
