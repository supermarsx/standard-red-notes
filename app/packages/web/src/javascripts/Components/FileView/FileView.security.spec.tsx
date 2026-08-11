/**
 * @jest-environment jsdom
 */
import { WebApplication } from '@/Application/WebApplication'
import { ContentType, FileItem, VaultLockServiceEvent } from '@standardnotes/snjs'
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import FileView from './FileView'

jest.mock('@/Components/ProtectedItemOverlay/ProtectedItemOverlay', () => ({
  __esModule: true,
  default: () => {
    const React = jest.requireActual<typeof import('react')>('react')
    return React.createElement('div', { 'data-testid': 'protected-overlay' }, 'blocked')
  },
}))
jest.mock('./FileViewWithoutProtection', () => ({
  __esModule: true,
  default: () => {
    const React = jest.requireActual<typeof import('react')>('react')
    return React.createElement('div', { 'data-testid': 'file-contents' }, 'secret-file-title-and-actions')
  },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('FileView vault authorization', () => {
  let container: HTMLElement
  let root: Root
  let authorized: boolean
  let vaultLockObserver!: (event: VaultLockServiceEvent) => void
  let application: WebApplication
  let file: FileItem

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    authorized = true
    file = {
      uuid: 'vault-file',
      content_type: ContentType.TYPES.File,
      key_system_identifier: 'vault-key-system',
    } as FileItem

    application = {
      isAuthorizedToRenderItem: jest.fn(() => authorized),
      addEventObserver: jest.fn(() => jest.fn()),
      hasProtectionSources: jest.fn(() => false),
      showAccountMenu: jest.fn(),
      protections: { authorizeItemAccess: jest.fn() },
      filesController: {
        showProtectedOverlay: false,
        setShowProtectedOverlay: jest.fn(),
      },
      vaultLocks: {
        addEventObserver: jest.fn((observer) => {
          vaultLockObserver = observer
          return jest.fn()
        }),
      },
      items: {
        streamItems: jest.fn(() => jest.fn()),
      },
    } as unknown as WebApplication
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.clearAllMocks()
  })

  it('removes the full file title and action layout when its vault locks', () => {
    act(() => root.render(createElement(FileView, { application, file })))
    expect(container.querySelector('[data-testid="file-contents"]')).not.toBeNull()

    authorized = false
    act(() => vaultLockObserver(VaultLockServiceEvent.VaultLocked))

    expect(container.querySelector('[data-testid="file-contents"]')).toBeNull()
    expect(container.querySelector('[data-testid="protected-overlay"]')).not.toBeNull()
  })
})
