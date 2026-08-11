/**
 * @jest-environment jsdom
 */
import { WebApplication } from '@/Application/WebApplication'
import { ContentType, FileItem, VaultLockServiceEvent } from '@standardnotes/snjs'
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import FilePreview from './FilePreview'

let mockPreviewBytes: Uint8Array | undefined

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
jest.mock('./PreviewComponent', () => ({
  __esModule: true,
  default: ({ bytes }: { bytes: Uint8Array }) => {
    mockPreviewBytes = bytes
    return `decrypted-preview:${[...bytes].join(',')}`
  },
}))
jest.mock('@/Components/Spinner/Spinner', () => ({
  __esModule: true,
  default: () => 'spinner',
}))
jest.mock('./FilePreviewError', () => ({
  __esModule: true,
  default: () => 'preview-error',
}))
jest.mock('@standardnotes/icons', () => ({
  ProtectedIllustration: () => 'protected',
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('FilePreview vault authorization', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mockPreviewBytes = undefined
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.clearAllMocks()
  })

  it('discards late decrypted chunks after lock and requires a fresh authorized download', async () => {
    let authorized = true
    let vaultLockObserver!: (event: VaultLockServiceEvent) => void
    const downloads: {
      emit: (chunk: Uint8Array, progress?: undefined) => Promise<void>
      resolve: (error: undefined) => void
      signal: AbortSignal
    }[] = []
    const downloadFile = jest.fn(
      (
        _file: FileItem,
        emit: (chunk: Uint8Array, progress?: undefined) => Promise<void>,
        options: { signal: AbortSignal },
      ) => new Promise<undefined>((resolve) => downloads.push({ emit, resolve, signal: options.signal })),
    )
    const application = {
      isAuthorizedToRenderItem: jest.fn(() => authorized),
      addEventObserver: jest.fn(() => jest.fn()),
      vaultLocks: {
        addEventObserver: jest.fn((observer) => {
          vaultLockObserver = observer
          return jest.fn()
        }),
      },
      items: {
        streamItems: jest.fn(() => jest.fn()),
      },
      files: { downloadFile },
      hasProtectionSources: jest.fn().mockReturnValue(true),
      protections: { authorizeItemAccess: jest.fn() },
    } as unknown as WebApplication
    const file = {
      uuid: 'vault-file',
      remoteIdentifier: 'vault-file-remote',
      content_type: ContentType.TYPES.File,
      key_system_identifier: 'vault-key-system',
      mimeType: 'text/plain',
      name: 'secret.txt',
      protected: false,
    } as FileItem

    await act(async () => {
      root.render(createElement(FilePreview, { application, file }))
      await Promise.resolve()
    })
    expect(downloadFile).toHaveBeenCalledTimes(1)

    authorized = false
    await act(async () => {
      vaultLockObserver(VaultLockServiceEvent.VaultLocked)
      await Promise.resolve()
    })
    expect(container.textContent).toContain('fileProtected')
    expect(container.textContent).not.toContain('decrypted-preview')
    expect(downloads[0].signal.aborted).toBe(true)

    const lateChunk = new Uint8Array([115, 101, 99, 114, 101, 116])
    await act(async () => {
      await downloads[0].emit(lateChunk)
      downloads[0].resolve(undefined)
      await Promise.resolve()
    })
    expect([...lateChunk]).toEqual([0, 0, 0, 0, 0, 0])
    expect(container.textContent).not.toContain('decrypted-preview')

    authorized = true
    await act(async () => {
      vaultLockObserver(VaultLockServiceEvent.VaultUnlocked)
      await Promise.resolve()
    })
    expect(downloadFile).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('decrypted-preview')

    const freshChunk = new Uint8Array([110, 101, 119])
    await act(async () => {
      await downloads[1].emit(freshChunk)
      downloads[1].resolve(undefined)
      await Promise.resolve()
    })
    expect(container.textContent).toContain('decrypted-preview')
    const renderedBytes = mockPreviewBytes
    expect(renderedBytes && [...renderedBytes]).toEqual([110, 101, 119])

    authorized = false
    await act(async () => {
      vaultLockObserver(VaultLockServiceEvent.VaultLocked)
      await Promise.resolve()
    })
    expect(renderedBytes && [...renderedBytes]).toEqual([0, 0, 0])
    expect(container.textContent).not.toContain('decrypted-preview')
  })

  it('never renders file A bytes when the same mounted component switches to file B', async () => {
    const downloads: {
      emit: (chunk: Uint8Array, progress?: undefined) => Promise<void>
      resolve: (error: undefined) => void
    }[] = []
    const downloadFile = jest.fn(
      (_file: FileItem, emit: (chunk: Uint8Array) => Promise<void>) =>
        new Promise<undefined>((resolve) => downloads.push({ emit, resolve })),
    )
    const application = {
      isAuthorizedToRenderItem: jest.fn(() => true),
      addEventObserver: jest.fn(() => jest.fn()),
      vaultLocks: { addEventObserver: jest.fn(() => jest.fn()) },
      items: { streamItems: jest.fn(() => jest.fn()) },
      files: { downloadFile },
      hasProtectionSources: jest.fn().mockReturnValue(true),
      protections: { authorizeItemAccess: jest.fn() },
    } as unknown as WebApplication
    const firstFile = {
      uuid: 'file-a',
      remoteIdentifier: 'remote-a',
      content_type: ContentType.TYPES.File,
      mimeType: 'text/plain',
      name: 'a.txt',
    } as FileItem
    const secondFile = {
      ...firstFile,
      uuid: 'file-b',
      remoteIdentifier: 'remote-b',
      name: 'b.txt',
    } as FileItem

    await act(async () => {
      root.render(createElement(FilePreview, { application, file: firstFile }))
      await Promise.resolve()
    })
    const firstChunk = new Uint8Array([1, 2, 3])
    await act(async () => {
      await downloads[0].emit(firstChunk)
      downloads[0].resolve(undefined)
      await Promise.resolve()
    })
    expect(container.textContent).toContain('decrypted-preview:1,2,3')
    const firstRenderedBytes = mockPreviewBytes

    await act(async () => {
      root.render(createElement(FilePreview, { application, file: secondFile }))
      await Promise.resolve()
    })

    expect(firstRenderedBytes && [...firstRenderedBytes]).toEqual([0, 0, 0])
    expect(container.textContent).not.toContain('decrypted-preview:1,2,3')
    expect(downloadFile).toHaveBeenCalledTimes(2)

    await act(async () => {
      await downloads[1].emit(new Uint8Array([4, 5, 6]))
      downloads[1].resolve(undefined)
      await Promise.resolve()
    })
    expect(container.textContent).toContain('decrypted-preview:4,5,6')
  })
})
