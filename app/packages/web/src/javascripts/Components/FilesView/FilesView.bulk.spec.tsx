/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { UuidGenerator } from '@standardnotes/snjs'
import FilesView from './FilesView'
import { Table as TableContract } from '@/Components/Table/CommonTypes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let mockRenderedTable: TableContract<unknown> | undefined

jest.mock('mobx-react-lite', () => ({ observer: (component: unknown) => component }))
jest.mock('@standardnotes/filepicker', () => ({ formatSizeToReadableString: (size: number) => `${size} bytes` }))
jest.mock('@/Components/Icon/Icon', () => () => null)
jest.mock('@/Components/FilePreview/getFileIconComponent', () => ({ getFileIconComponent: () => null }))
jest.mock('@/Utils/Items/Icons/getIconForFileType', () => ({ getIconForFileType: () => 'file' }))
jest.mock('@/Components/ContentTableView/ContentTableView', () => ({
  ContextMenuCell: () => <button type="button">Options</button>,
  ItemLinksCell: () => <button type="button">Links</button>,
}))
jest.mock('@/Components/Menu/Menu', () => ({
  __esModule: true,
  default: ({ children }: { children: unknown }) => children,
}))
jest.mock('@/Components/FileContextMenu/FileMenuOptions', () => () => null)
jest.mock('@/Components/ContentTableView/ItemOptionsMenu', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/Popover/Popover', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/FileDragNDropProvider', () => ({
  useFileDragNDrop: () => ({ addDragTarget: jest.fn(), removeDragTarget: jest.fn() }),
}))
jest.mock('@/Utils/DateUtils', () => ({ formatDateForContextMenu: () => 'Jan 1, 2026' }))
const mockToasts: { type: string; message: string }[] = []
jest.mock('@standardnotes/toast', () => ({
  ToastType: { Success: 'success', Error: 'error' },
  addToast: (toast: { type: string; message: string }) => {
    mockToasts.push(toast)
    return 'toast-id'
  },
}))
jest.mock('@/Hooks/useMediaQuery', () => ({
  MutuallyExclusiveMediaQueryBreakpoints: { sm: 'sm', md: 'md', lg: 'lg' },
  useMediaQuery: () => false,
}))

jest.mock('@/Components/Table/Table', () => ({
  __esModule: true,
  default: ({ table }: { table: TableContract<unknown> }) => {
    mockRenderedTable = table
    return (
      <div data-testid="rendered-table">
        {table.rows.map((row) => (
          <div data-row={row.id} data-selected={row.isSelected} key={row.id} />
        ))}
      </div>
    )
  },
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

const createFile = (uuid: string, name: string): TestFile => ({
  uuid,
  name,
  protected: false,
  mimeType: 'text/plain',
  decryptedSize: 12,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  userModifiedDate: new Date('2026-01-02T00:00:00.000Z'),
})

const createFiles = (): TestFile[] => [
  createFile('file-1', 'alpha.txt'),
  createFile('file-2', 'beta.txt'),
  createFile('file-3', 'gamma.txt'),
]

const createApplication = (files: TestFile[], filesController: Record<string, unknown>) => {
  let selected = new Set<string>()
  const itemListController = {
    filesViewSortBy: 'name',
    filesViewSortDirection: 'asc',
    get filesViewSelectedUuids() {
      return selected
    },
    pruneFilesViewSelection: jest.fn(),
    selectAllFilesViewFiles: jest.fn((uuids: string[]) => {
      selected = new Set(uuids)
    }),
    clearFilesViewSelection: jest.fn(() => {
      selected = new Set()
    }),
    toggleFilesViewSortDirection: jest.fn(),
    setFilesViewSortBy: jest.fn(),
    // 'all' is the default chip, under which filterItemsByFolder is a pass-through,
    // so the folder bar does not change what these bulk cases exercise.
    filesFolderFilter: 'all',
    setFilesFolderFilter: jest.fn(),
  }

  return {
    items: {
      getDisplayableFiles: () => files,
      streamItems: () => () => undefined,
    },
    itemListController,
    navigationController: {
      folders: [],
      allLocalRootFolders: [],
      getFolderChildren: () => [],
      createFolder: jest.fn(),
    },
    filesController: {
      handleFileAction: jest.fn(),
      selectAndUploadNewFiles: jest.fn(),
      ...filesController,
    },
    entitledToFiles: true,
    showPremiumModal: jest.fn(),
    // The view binds the create shortcut to upload while it is mounted.
    commands: { addWithShortcut: () => () => undefined },
    // No stored sort preference and no local backup service in these cases, so
    // the bulk behaviour under test is unaffected by either.
    getPreference: () => undefined,
    setPreference: jest.fn(async () => undefined),
    fileBackups: undefined,
  }
}

let container: HTMLElement
let root: Root
let application: ReturnType<typeof createApplication>

const render = () => {
  act(() => root.render(createElement(FilesView, { application: application as never })))
}

const rerender = () => {
  act(() => {
    root.render(createElement(FilesView, { application: application as never }))
  })
}

const bar = () => container.querySelector('[data-testid="bulk-file-action-bar"]') as HTMLElement | null

const buttonNamed = (label: string) =>
  Array.from(bar()?.querySelectorAll('button') ?? []).find((button) =>
    (button.textContent ?? '').trim().startsWith(label),
  ) as HTMLButtonElement | undefined

/**
 * Each entry is a discrete click: plain for the first, ctrl/cmd-toggle for the
 * rest. The re-render between them mirrors the real event loop — the table reads
 * the current selection from props, so batching them would compound stale state.
 */
const selectRows = (uuids: string[]) => {
  uuids.forEach((uuid, index) => {
    act(() => {
      if (index === 0) {
        mockRenderedTable!.selectRow(uuid)
      } else {
        mockRenderedTable!.multiSelectRow(uuid)
      }
    })
    rerender()
  })
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  UuidGenerator.SetGenerator(() => 'files-view-bulk-test')
  mockRenderedTable = undefined
  mockToasts.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('FilesView bulk selection', () => {
  it('shows no action bar until something is selected', () => {
    application = createApplication(createFiles(), {})
    render()

    expect(bar()).toBeNull()
  })

  it('renders the action bar with an accessible name carrying the selection count', () => {
    application = createApplication(createFiles(), {})
    render()

    selectRows(['file-1', 'file-2'])

    const actionBar = bar()
    expect(actionBar).not.toBeNull()
    expect(actionBar!.getAttribute('aria-label')).toBe('Bulk file actions — 2 files selected')
    expect(container.querySelector('[data-testid="bulk-selection-count"]')?.textContent).toBe('2 files selected')
  })

  it('selects a contiguous range with shift-click semantics', () => {
    application = createApplication(createFiles(), {})
    render()

    act(() => mockRenderedTable!.selectRow('file-1'))
    rerender()
    act(() => mockRenderedTable!.rangeSelectUpToRow('file-3'))
    rerender()

    expect(container.querySelector('[data-testid="bulk-selection-count"]')?.textContent).toBe('3 files selected')
  })

  it('toggles a single file off with ctrl/cmd-click semantics', () => {
    application = createApplication(createFiles(), {})
    render()

    selectRows(['file-1', 'file-2'])
    act(() => mockRenderedTable!.multiSelectRow('file-2'))
    rerender()

    expect(container.querySelector('[data-testid="bulk-selection-count"]')?.textContent).toBe('1 file selected')
  })

  it('selects every file from the bar', () => {
    application = createApplication(createFiles(), {})
    render()

    selectRows(['file-1'])
    act(() => buttonNamed('Select all')!.click())
    rerender()

    expect(container.querySelector('[data-testid="bulk-selection-count"]')?.textContent).toBe('3 files selected')
  })
})

describe('FilesView bulk actions', () => {
  it('applies a bulk action to every selected file and deselects them all on success', async () => {
    const downloadFiles = jest.fn(async (files: TestFile[]) => ({ succeeded: files, failed: [] }))
    application = createApplication(createFiles(), { downloadFiles })
    render()

    selectRows(['file-1', 'file-2', 'file-3'])
    act(() => buttonNamed('Download')!.click())
    await flush()
    rerender()

    expect(downloadFiles).toHaveBeenCalledTimes(1)
    expect(downloadFiles.mock.calls[0][0].map((file) => file.uuid)).toEqual(['file-1', 'file-2', 'file-3'])
    // Everything succeeded, so nothing is left selected and the bar retires —
    // the confirmation has to survive that, so it is also announced as a toast.
    expect(bar()).toBeNull()
    expect(mockToasts).toEqual([{ type: 'success', message: 'Downloaded 3 files.' }])
  })

  it('surfaces which files failed and why, and keeps only those selected', async () => {
    const files = createFiles()
    const downloadFiles = jest.fn(async () => ({
      succeeded: [files[0]],
      failed: [
        { uuid: 'file-2', name: 'beta.txt', message: 'Network unreachable' },
        { uuid: 'file-3', name: 'gamma.txt', message: 'File server rejected the request' },
      ],
    }))
    application = createApplication(files, { downloadFiles })
    render()

    selectRows(['file-1', 'file-2', 'file-3'])
    act(() => buttonNamed('Download')!.click())
    await flush()
    rerender()

    const headline = container.querySelector('[data-testid="bulk-failure-headline"]')?.textContent
    expect(headline).toContain('Downloaded 1 of 3 files.')
    expect(headline).toContain('2 failed and remain selected')

    const failures = Array.from(container.querySelectorAll('[data-testid="bulk-failure-item"]')).map(
      (item) => item.textContent,
    )
    expect(failures).toEqual(['beta.txt — Network unreachable', 'gamma.txt — File server rejected the request'])

    // The two failures stay selected so a retry does not redo the one that worked.
    expect(container.querySelector('[data-testid="bulk-selection-count"]')?.textContent).toBe('2 files selected')
    expect(container.querySelector('[data-row="file-1"]')?.getAttribute('data-selected')).toBe('false')
    expect(container.querySelector('[data-row="file-2"]')?.getAttribute('data-selected')).toBe('true')
  })

  it('reports every file as failed when the whole operation throws', async () => {
    const downloadFiles = jest.fn(async () => {
      throw new Error('Storage quota exceeded')
    })
    application = createApplication(createFiles(), { downloadFiles })
    render()

    selectRows(['file-1', 'file-2'])
    act(() => buttonNamed('Download')!.click())
    await flush()
    rerender()

    const failures = Array.from(container.querySelectorAll('[data-testid="bulk-failure-item"]')).map(
      (item) => item.textContent,
    )
    expect(failures).toEqual(['alpha.txt — Storage quota exceeded', 'beta.txt — Storage quota exceeded'])
    expect(container.querySelector('[data-testid="bulk-selection-count"]')?.textContent).toBe('2 files selected')
  })

  it('leaves the selection untouched when a bulk delete is declined at the confirmation', async () => {
    // deleteFilesPermanently resolves undefined when the user cancels the dialog.
    const deleteFilesPermanently = jest.fn(async () => undefined)
    application = createApplication(createFiles(), { deleteFilesPermanently })
    render()

    selectRows(['file-1', 'file-2'])
    act(() => buttonNamed('Delete')!.click())
    await flush()
    rerender()

    expect(deleteFilesPermanently).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="bulk-summary"]')).toBeNull()
    expect(container.querySelector('[data-testid="bulk-selection-count"]')?.textContent).toBe('2 files selected')
  })

  it('shows progress while a long batch runs and disables the actions', async () => {
    let release: (() => void) | undefined
    const deleteFilesPermanently = jest.fn(
      async (files: TestFile[], { onProgress }: { onProgress: (p: unknown) => void }) => {
        onProgress({ completed: 1, total: files.length })
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return { succeeded: files, failed: [] }
      },
    )
    application = createApplication(createFiles(), { deleteFilesPermanently })
    render()

    selectRows(['file-1', 'file-2', 'file-3'])
    act(() => buttonNamed('Delete')!.click())
    await flush()

    const progress = container.querySelector('[data-testid="bulk-progress"]')
    expect(progress?.textContent).toBe('Deleting 1 of 3…')
    expect(progress?.getAttribute('aria-live')).toBe('polite')
    expect(buttonNamed('Delete')!.disabled).toBe(true)
    expect(buttonNamed('Clear')!.disabled).toBe(true)

    act(() => release!())
    await flush()
    rerender()

    expect(container.querySelector('[data-testid="bulk-progress"]')).toBeNull()
  })

  it('offers protect and unprotect against the files that actually need it', async () => {
    const files = createFiles()
    files[0].protected = true
    const setProtectionForFiles = jest.fn(async () => undefined)
    application = createApplication(files, { setProtectionForFiles })
    render()

    selectRows(['file-1', 'file-2', 'file-3'])
    expect(buttonNamed('Protect')).toBeDefined()
    expect(buttonNamed('Unprotect')).toBeDefined()

    act(() => buttonNamed('Protect')!.click())
    await flush()

    // Already-protected file-1 is not re-protected.
    expect(setProtectionForFiles).toHaveBeenCalledWith(true, [files[1], files[2]])
  })
})
