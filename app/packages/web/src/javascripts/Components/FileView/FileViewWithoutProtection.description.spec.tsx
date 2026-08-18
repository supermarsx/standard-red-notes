/** @jest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { FileItem } from '@standardnotes/models'
import { VaultUserServiceEvent } from '@standardnotes/snjs'
import { FileDescriptionSaveDebounceMs } from './FileDescriptionEditor'
import FileViewWithoutProtection from './FileViewWithoutProtection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mockVault = { sharing: { sharedVaultUuid: 'vault-1' } }

jest.mock('@/Components/FilePreview/FilePreview', () => () => null)
jest.mock('@/Components/FileContextMenu/FileOptionsPanel', () => () => null)
jest.mock('@/Components/LinkedItems/LinkedItemsButton', () => () => null)
jest.mock('@/Components/LinkedItems/LinkedItemBubblesContainer', () => () => null)
jest.mock('@/Components/Popover/Popover', () => () => null)
jest.mock('@/Components/FilePreview/FilePreviewInfoPanel', () => () => null)
jest.mock('@/Components/NoteGroupView/MobileItemsListButton', () => () => null)
jest.mock('./SuggestTagsForFileModal', () => () => null)
jest.mock('@/Components/Icon/Icon', () => () => null)
jest.mock('@/Components/Button/RoundIconButton', () => {
  const actualReact = jest.requireActual<typeof import('react')>('react')
  return {
    __esModule: true,
    default: actualReact.forwardRef<HTMLButtonElement, { label: string }>(({ label }, ref) =>
      actualReact.createElement('button', { ref, 'aria-label': label }),
    ),
  }
})
jest.mock('@/Components/FileDragNDropProvider', () => ({
  useFileDragNDrop: () => ({ addDragTarget: () => undefined, removeDragTarget: () => undefined }),
}))
jest.mock('@/Hooks/useItemVaultInfo', () => ({ useItemVaultInfo: () => ({ vault: mockVault }) }))
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { count?: number; max?: number }) => {
      return key === 'fileDescriptionCharacterCount' ? `${values?.count} / ${values?.max}` : key
    },
  }),
}))

const setFileDescription = jest.fn<Promise<FileItem>, [FileItem, string | undefined]>()
const sync = jest.fn<Promise<void>, [{ onPresyncSave?: () => void }?]>()
const isCurrentUserReadonlyVaultMember = jest.fn<boolean, [unknown]>()
let vaultObserver: ((event: VaultUserServiceEvent, data?: unknown) => void) | undefined

const application = {
  vaultUsers: {
    isCurrentUserReadonlyVaultMember,
    addEventObserver: (observer: (event: VaultUserServiceEvent, data?: unknown) => void) => {
      vaultObserver = observer
      return () => undefined
    },
  },
  sessions: { isSignedOut: () => false },
  mutator: {
    renameFile: async () => undefined,
    setFileDescription,
  },
  sync: { sync },
  linkingController: { linkItems: async () => undefined },
  itemListController: {},
} as never

const file = {
  uuid: 'file-1',
  name: 'document.txt',
  description: 'Existing description',
  protected: false,
} as FileItem

let container: HTMLElement
let root: Root

beforeEach(() => {
  jest.useFakeTimers()
  setFileDescription.mockImplementation(async (targetFile, description) => ({ ...targetFile, description }) as FileItem)
  sync.mockImplementation(async (options) => {
    options?.onPresyncSave?.()
  })
  isCurrentUserReadonlyVaultMember.mockReturnValue(false)
  vaultObserver = undefined
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
})

const changeValue = (textarea: HTMLTextAreaElement, value: string) => {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    valueSetter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('FileViewWithoutProtection file description authorization', () => {
  it('renders the description and title readonly on the server-first paint', () => {
    isCurrentUserReadonlyVaultMember.mockReturnValue(true)

    const markup = renderToStaticMarkup(createElement(FileViewWithoutProtection, { application, file }))
    const rendered = document.createElement('div')
    rendered.innerHTML = markup

    expect((rendered.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true)
    expect((rendered.querySelector('#file-title-editor') as HTMLInputElement).disabled).toBe(true)
    expect(rendered.textContent).toContain('fileReadonly')
  })

  it('immediately disables a draft after matching vault authorization revocation and cancels autosave', async () => {
    act(() => root.render(createElement(FileViewWithoutProtection, { application, file })))
    let textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)

    changeValue(textarea, 'Must not upload after revocation')
    isCurrentUserReadonlyVaultMember.mockReturnValue(true)

    act(() => vaultObserver?.(VaultUserServiceEvent.InvalidatedUserCacheForVault, 'different-vault'))
    expect((container.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(false)

    act(() => vaultObserver?.(VaultUserServiceEvent.InvalidatedUserCacheForVault, 'vault-1'))
    textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(true)
    expect(container.textContent).toContain('fileReadonly')

    await act(async () => {
      jest.advanceTimersByTime(FileDescriptionSaveDebounceMs)
      await Promise.resolve()
    })

    expect(setFileDescription).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  })
})
