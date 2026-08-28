/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import FilesView from './FilesView'
import { Table as TableContract } from '@/Components/Table/CommonTypes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
jest.mock('@/Components/Menu/MenuItem', () => ({
  __esModule: true,
  default: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}))
jest.mock('@/Components/FileContextMenu/FileMenuOptions', () => () => null)
jest.mock('@/Components/ContentTableView/ItemOptionsMenu', () => ({ __esModule: true, default: () => null }))
// Rendered open so the Upload menu's contents are actually inspectable.
jest.mock('@/Components/Popover/Popover', () => ({
  __esModule: true,
  default: ({ children, open }: { children: unknown; open: boolean }) => (open ? children : null),
}))
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

const mockCameraSupported = jest.fn()
jest.mock('@/Controllers/Moments/PhotoRecorder', () => ({
  PhotoRecorder: { isSupported: () => mockCameraSupported() },
}))
jest.mock('@/Components/Modal/ModalOverlay', () => ({
  __esModule: true,
  default: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) => {
    return isOpen ? <div data-testid="capture-modal">{children}</div> : null
  },
}))
jest.mock('@/Components/CameraCaptureModal/PhotoCaptureModal', () => ({
  __esModule: true,
  default: () => <div data-testid="photo-capture" />,
}))
jest.mock('@/Components/CameraCaptureModal/VideoCaptureModal', () => ({
  __esModule: true,
  default: () => <div data-testid="video-capture" />,
}))

const mockSelectDirectoryFiles = jest.fn()
const mockUploadFilesWithFolderStructure = jest.fn()
jest.mock('@/Utils/DirectoryPicker', () => ({ selectDirectoryFiles: () => mockSelectDirectoryFiles() }))
jest.mock('@/Utils/FolderUpload', () => ({
  uploadFilesWithFolderStructure: (...args: unknown[]) => mockUploadFilesWithFolderStructure(...args),
}))

jest.mock('@/Components/Table/Table', () => ({
  __esModule: true,
  default: ({ table }: { table: TableContract<unknown> }) => (
    <div data-testid="rendered-table">
      {table.rows.map((row) => (
        <div data-row={row.id} key={row.id} />
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

const WORK_FILE = createFile('file-1', 'alpha.txt')
const OTHER_FILE = createFile('file-2', 'beta.txt')

/** A folder that references only the files whose uuids it was built with. */
const folder = (uuid: string, title: string, memberUuids: string[]) => ({
  uuid,
  title,
  isReferencingItem: (item: { uuid: string }) => memberUuids.includes(item.uuid),
})

const WORK_FOLDER = folder('folder-work', 'Work', [WORK_FILE.uuid])
const EMPTY_FOLDER = folder('folder-empty', 'Empty', [])

const createApplication = (files: TestFile[], initialFilter = 'all') => {
  let filter = initialFilter
  let selected = new Set<string>()

  const itemListController = {
    filesViewSortBy: 'name',
    filesViewSortDirection: 'asc',
    get filesViewSelectedUuids() {
      return selected
    },
    get filesFolderFilter() {
      return filter
    },
    setFilesFolderFilter: jest.fn((next: string) => {
      filter = next
    }),
    pruneFilesViewSelection: jest.fn(),
    selectAllFilesViewFiles: jest.fn((uuids: string[]) => {
      selected = new Set(uuids)
    }),
    clearFilesViewSelection: jest.fn(() => {
      selected = new Set()
    }),
    toggleFilesViewSortDirection: jest.fn(),
    setFilesViewSortBy: jest.fn(),
  }

  return {
    items: {
      getDisplayableFiles: () => files,
      streamItems: () => () => undefined,
    },
    itemListController,
    navigationController: {
      folders: [WORK_FOLDER, EMPTY_FOLDER],
      allLocalRootFolders: [WORK_FOLDER, EMPTY_FOLDER],
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
    getPreference: () => undefined,
    setPreference: jest.fn(async () => undefined),
    fileBackups: undefined,
  }
}

describe('FilesView folder management (ported from the Files smart view)', () => {
  let container: HTMLElement
  let root: Root

  const render = (application: ReturnType<typeof createApplication>) => {
    act(() => root.render(createElement(FilesView, { application: application as never })))
  }

  const buttonByText = (text: string) =>
    Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes(text))

  const renderedRowIds = () =>
    Array.from(container.querySelectorAll('[data-row]')).map((element) => element.getAttribute('data-row'))

  beforeEach(() => {
    mockSelectDirectoryFiles.mockReset()
    mockUploadFilesWithFolderStructure.mockReset()
    mockCameraSupported.mockReset()
    mockCameraSupported.mockResolvedValue(false)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders the folder chips inside the Files tab', () => {
    render(createApplication([WORK_FILE, OTHER_FILE]))

    // The chips are the smart view's folder affordance; the whole point of S2 is
    // that they now exist on this surface.
    expect(buttonByText('allFiles')).toBeDefined()
    expect(buttonByText('noFolder')).toBeDefined()
    expect(buttonByText('Work')).toBeDefined()
    expect(buttonByText('newFolder')).toBeDefined()
  })

  it('shows every file under the default All files chip', () => {
    render(createApplication([WORK_FILE, OTHER_FILE]))

    expect(renderedRowIds()).toEqual(['file-1', 'file-2'])
  })

  it('narrows the table to the selected folder', () => {
    const application = createApplication([WORK_FILE, OTHER_FILE])
    render(application)

    act(() => {
      buttonByText('Work')?.click()
    })
    render(application)

    expect(application.itemListController.setFilesFolderFilter).toHaveBeenCalledWith('folder-work')
    expect(renderedRowIds()).toEqual(['file-1'])
  })

  it('prunes the selection to the visible folder so a bulk action cannot reach a hidden file', () => {
    // The hazard this guards: select files under All files, switch to a folder,
    // then hit Delete -- without this the selection still holds the hidden file.
    const application = createApplication([WORK_FILE, OTHER_FILE], 'folder-work')
    render(application)

    expect(application.itemListController.pruneFilesViewSelection).toHaveBeenCalledWith(new Set(['file-1']))
  })

  it('offers upload-folder alongside upload-files, and runs the folder upload', async () => {
    const picked = [{ path: 'photos/a.jpg' }]
    mockSelectDirectoryFiles.mockResolvedValue(picked)
    const application = createApplication([WORK_FILE])
    render(application)

    act(() => {
      buttonByText('Upload')?.click()
    })

    expect(buttonByText('uploadFiles')).toBeDefined()

    await act(async () => {
      buttonByText('uploadFolder')?.click()
    })

    expect(mockSelectDirectoryFiles).toHaveBeenCalled()
    expect(mockUploadFilesWithFolderStructure).toHaveBeenCalledWith(
      picked,
      expect.objectContaining({ navigationController: application.navigationController }),
    )
  })

  it('keeps camera capture, which used to exist only in the Files smart view', async () => {
    // Take photo / Record video were reachable ONLY from the smart view's
    // add-item menu. If the consolidation dropped them, this is the only place
    // that would notice.
    mockCameraSupported.mockResolvedValue(true)
    const application = createApplication([WORK_FILE])
    await act(async () => {
      root.render(createElement(FilesView, { application: application as never }))
    })

    act(() => {
      buttonByText('Upload')?.click()
    })

    expect(buttonByText('takePhoto')).toBeDefined()
    expect(buttonByText('recordVideo')).toBeDefined()

    act(() => {
      buttonByText('takePhoto')?.click()
    })

    expect(container.querySelector('[data-testid="photo-capture"]')).not.toBeNull()
  })

  it('hides camera capture when the device has no camera', async () => {
    const application = createApplication([WORK_FILE])
    await act(async () => {
      root.render(createElement(FilesView, { application: application as never }))
    })

    act(() => {
      buttonByText('Upload')?.click()
    })

    expect(buttonByText('takePhoto')).toBeUndefined()
  })

  it('distinguishes an empty folder from an account with no files', () => {
    const emptyFolder = createApplication([WORK_FILE], 'folder-empty')
    render(emptyFolder)

    expect(container.textContent).toContain('noFilesInFolder')
    expect(container.querySelector('[data-testid="files-illustration"]')).toBeNull()

    act(() => root.unmount())
    root = createRoot(container)

    const noFilesAtAll = createApplication([])
    render(noFilesAtAll)

    // The shared illustrated empty state, whose artwork follows the theme.
    expect(container.querySelector('[data-testid="files-illustration"]')).not.toBeNull()
    expect(container.textContent).not.toContain('noFilesInFolder')
  })
})
