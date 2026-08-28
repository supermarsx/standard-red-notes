/**
 * @jest-environment jsdom
 *
 * The Files tab must bind the create shortcut to "upload file".
 *
 * The Files smart view used to register CREATE_NEW_NOTE_KEYBOARD_COMMAND as
 * 'Upload file' -> selectAndUploadNewFiles from ContentListView, behind an
 * `isFilesSmartView` branch. When the Files surface moved to its own tab that
 * branch was collapsed away and nothing took it over, so the create shortcut
 * created a NOTE on the Files tab and there was no keyboard route to upload at
 * all. This pins the registration, its teardown, and the entitlement gate.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { UuidGenerator } from '@standardnotes/snjs'
import { CREATE_NEW_NOTE_KEYBOARD_COMMAND } from '@standardnotes/ui-services'
import FilesView from './FilesView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

jest.mock('mobx-react-lite', () => ({ observer: (component: unknown) => component }))
jest.mock('@standardnotes/filepicker', () => ({ formatSizeToReadableString: (size: number) => `${size} bytes` }))
jest.mock('@/Components/Icon/Icon', () => () => null)
jest.mock('@/Components/ContentListView/ListItemVaultInfo', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/FilePreview/getFileIconComponent', () => ({ getFileIconComponent: () => null }))
jest.mock('@/Utils/Items/Icons/getIconForFileType', () => ({ getIconForFileType: () => 'file' }))
jest.mock('@/Components/ContentTableView/ContentTableView', () => ({
  ContextMenuCell: () => null,
  ItemLinksCell: () => null,
}))
jest.mock('@/Components/Menu/Menu', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/FileContextMenu/FileMenuOptions', () => () => null)
jest.mock('@/Components/ContentTableView/ItemOptionsMenu', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/Popover/Popover', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/FileDragNDropProvider', () => ({
  useFileDragNDrop: () => ({ addDragTarget: jest.fn(), removeDragTarget: jest.fn() }),
}))
jest.mock('@/Utils/DateUtils', () => ({ formatDateForContextMenu: () => 'Jan 1, 2026' }))
jest.mock('@/Hooks/useMediaQuery', () => ({
  MutuallyExclusiveMediaQueryBreakpoints: { sm: 'breakpoint-sm', md: 'breakpoint-md', lg: 'breakpoint-lg' },
  useMediaQuery: () => false,
}))
jest.mock('@/Components/Table/Table', () => ({ __esModule: true, default: () => null }))

type Registration = {
  command: symbol
  category: string
  description: string
  handler: (event?: KeyboardEvent) => void
  icon?: string
  dispose: jest.Mock
}

let registrations: Registration[]

const createApplication = (overrides: { entitledToFiles?: boolean } = {}) => {
  const file = {
    uuid: 'file-1',
    name: 'document.txt',
    mimeType: 'text/plain',
    decryptedSize: 12,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    userModifiedDate: new Date('2026-01-02T00:00:00.000Z'),
  }

  return {
    items: { getDisplayableFiles: () => [file], streamItems: () => () => undefined },
    itemListController: {
      filesViewSortBy: 'date',
      filesViewSortDirection: 'dsc',
      filesViewSelectedUuids: new Set<string>(),
      pruneFilesViewSelection: jest.fn(),
      selectAllFilesViewFiles: jest.fn(),
      clearFilesViewSelection: jest.fn(),
      toggleFilesViewSortDirection: jest.fn(),
      setFilesViewSortBy: jest.fn(),
      filesFolderFilter: 'all',
      setFilesFolderFilter: jest.fn(),
    },
    navigationController: {
      folders: [],
      allLocalRootFolders: [],
      getFolderChildren: () => [],
      createFolder: jest.fn(),
    },
    filesController: { handleFileAction: jest.fn(), selectAndUploadNewFiles: jest.fn() },
    commands: {
      addWithShortcut: (
        command: symbol,
        category: string,
        description: string,
        handler: (event?: KeyboardEvent) => void,
        icon?: string,
      ) => {
        const dispose = jest.fn()
        registrations.push({ command, category, description, handler, icon, dispose })
        return dispose
      },
    },
    entitledToFiles: overrides.entitledToFiles ?? true,
    showPremiumModal: jest.fn(),
    getPreference: () => undefined,
    setPreference: jest.fn(async () => undefined),
    fileBackups: undefined,
  } as never
}

const createRegistrations = () => registrations.filter((r) => r.command === CREATE_NEW_NOTE_KEYBOARD_COMMAND)

let container: HTMLElement
let root: Root

beforeEach(() => {
  UuidGenerator.SetGenerator(() => 'files-view-upload-shortcut-test')
  registrations = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  container.remove()
})

describe('FilesView create-shortcut binding', () => {
  it('registers the create shortcut as an upload while the Files tab is mounted', () => {
    const application = createApplication()
    act(() => root.render(createElement(FilesView, { application })))

    const registered = createRegistrations()
    expect(registered).toHaveLength(1)
    expect(registered[0].description).toBe('Upload file')
    expect(registered[0].category).toBe('General')
    expect(registered[0].icon).toBe('upload')

    act(() => root.unmount())
  })

  it('uploads rather than creating a note when the shortcut fires', () => {
    const application = createApplication()
    act(() => root.render(createElement(FilesView, { application })))

    const preventDefault = jest.fn()
    act(() => createRegistrations()[0].handler({ preventDefault } as unknown as KeyboardEvent))

    expect(
      (application as unknown as { filesController: { selectAndUploadNewFiles: jest.Mock } }).filesController
        .selectAndUploadNewFiles,
    ).toHaveBeenCalledTimes(1)
    expect(preventDefault).toHaveBeenCalled()

    act(() => root.unmount())
  })

  it('shows the premium modal instead of uploading when files are not entitled', () => {
    const application = createApplication({ entitledToFiles: false })
    act(() => root.render(createElement(FilesView, { application })))

    act(() => createRegistrations()[0].handler())

    const app = application as unknown as {
      filesController: { selectAndUploadNewFiles: jest.Mock }
      showPremiumModal: jest.Mock
    }
    expect(app.showPremiumModal).toHaveBeenCalled()
    expect(app.filesController.selectAndUploadNewFiles).not.toHaveBeenCalled()

    act(() => root.unmount())
  })

  it('tears the registration down on unmount, so it cannot fire from the notes view', () => {
    act(() => root.render(createElement(FilesView, { application: createApplication() })))

    const registered = createRegistrations()
    expect(registered).toHaveLength(1)
    expect(registered[0].dispose).not.toHaveBeenCalled()

    act(() => root.unmount())

    expect(registered[0].dispose).toHaveBeenCalledTimes(1)
  })
})
