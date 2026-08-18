/**
 * @jest-environment jsdom
 */
import { WebApplication } from '@/Application/WebApplication'
import { ContentType, FileItem, VaultLockServiceEvent } from '@standardnotes/snjs'
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import FilePreview, { PREVIEW_DOWNLOAD_IDLE_TIMEOUT_MS } from './FilePreview'
import { MAX_TEXT_PREVIEW_BYTES } from './textPreviewContent'

let mockPreviewBytes: Uint8Array | undefined
let mockPreviewFile: FileItem | undefined

jest.mock('react-i18next', () => {
  const t = (key: string) => key
  return { useTranslation: () => ({ t }) }
})
jest.mock('./PreviewComponent', () => ({
  __esModule: true,
  default: ({ bytes, file }: { bytes: Uint8Array; file: FileItem }) => {
    const React = jest.requireActual<typeof import('react')>('react')
    mockPreviewBytes = bytes
    mockPreviewFile = file
    return React.createElement(
      'div',
      { 'data-preview-mime': file.mimeType },
      `decrypted-preview:${[...bytes].join(',')}`,
    )
  },
}))
jest.mock('@/Components/Spinner/Spinner', () => ({
  __esModule: true,
  default: () => 'spinner',
}))
jest.mock('./FilePreviewError', () => ({
  __esModule: true,
  default: ({ tryAgainCallback, errorMessage }: { tryAgainCallback: () => void; errorMessage?: string }) => {
    const React = jest.requireActual<typeof import('react')>('react')
    return React.createElement(
      'div',
      null,
      React.createElement('span', null, errorMessage ?? 'preview-error'),
      React.createElement('button', { onClick: tryAgainCallback }, 'retry-preview'),
    )
  },
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
    mockPreviewFile = undefined
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.clearAllMocks()
  })

  it('discards late decrypted chunks after lock and requires a fresh authorized download', async () => {
    let authorized = true
    let vaultLockObserver!: (event: VaultLockServiceEvent) => void
    const file = {
      uuid: 'vault-file',
      remoteIdentifier: 'vault-file-remote',
      content_type: ContentType.TYPES.File,
      key_system_identifier: 'vault-key-system',
      mimeType: 'text/plain',
      name: 'secret.txt',
      decryptedSize: 6,
      protected: false,
    } as FileItem
    const currentFile = file
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
        findItem: jest.fn(() => currentFile),
        streamItems: jest.fn(() => jest.fn()),
      },
      files: { downloadFile },
      hasProtectionSources: jest.fn().mockReturnValue(true),
      protections: { authorizeItemAccess: jest.fn() },
    } as unknown as WebApplication
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
    let currentFile: FileItem | undefined
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
      items: {
        findItem: jest.fn(() => currentFile),
        streamItems: jest.fn(() => jest.fn()),
      },
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
      decryptedSize: 3,
    } as FileItem
    const secondFile = {
      ...firstFile,
      uuid: 'file-b',
      remoteIdentifier: 'remote-b',
      name: 'b.txt',
    } as FileItem
    currentFile = firstFile

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
      currentFile = secondFile
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

  it('restarts from a live same-UUID replacement and fails closed when the authoritative item is removed', async () => {
    const originalFile = {
      uuid: 'live-file',
      remoteIdentifier: 'remote-original',
      content_type: ContentType.TYPES.File,
      mimeType: 'image/png',
      name: 'original.png',
      decryptedSize: 3,
    } as FileItem
    const replacementFile = {
      ...originalFile,
      remoteIdentifier: 'remote-replacement',
      name: 'replacement.png',
    } as FileItem
    let currentFile: FileItem | undefined = originalFile
    const fileObservers: ((event: {
      changed: FileItem[]
      inserted: FileItem[]
      removed: { uuid: string }[]
    }) => void)[] = []
    const downloads: {
      emit: (chunk: Uint8Array) => Promise<void>
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
      items: {
        findItem: jest.fn(() => currentFile),
        streamItems: jest.fn(
          (
            contentType: string | string[],
            observer: (event: { changed: FileItem[]; inserted: FileItem[]; removed: { uuid: string }[] }) => void,
          ) => {
            if (contentType === ContentType.TYPES.File) {
              fileObservers.push(observer)
            }
            return jest.fn()
          },
        ),
      },
      files: { downloadFile },
      hasProtectionSources: jest.fn().mockReturnValue(true),
      protections: { authorizeItemAccess: jest.fn() },
    } as unknown as WebApplication

    await act(async () => {
      root.render(createElement(FilePreview, { application, file: originalFile }))
      await Promise.resolve()
    })
    await act(async () => {
      await downloads[0].emit(new Uint8Array([1, 2, 3]))
      downloads[0].resolve(undefined)
      await Promise.resolve()
    })
    const originalBytes = mockPreviewBytes
    expect(mockPreviewFile).toBe(originalFile)

    currentFile = replacementFile
    await act(async () => {
      fileObservers.forEach((observer) => observer({ changed: [replacementFile], inserted: [], removed: [] }))
      await Promise.resolve()
    })

    expect(originalBytes && [...originalBytes]).toEqual([0, 0, 0])
    expect(downloadFile).toHaveBeenCalledTimes(2)
    expect(downloadFile).toHaveBeenLastCalledWith(replacementFile, expect.any(Function), expect.any(Object))

    await act(async () => {
      await downloads[1].emit(new Uint8Array([4, 5, 6]))
      downloads[1].resolve(undefined)
      await Promise.resolve()
    })
    const replacementBytes = mockPreviewBytes
    expect(mockPreviewFile).toBe(replacementFile)

    currentFile = undefined
    await act(async () => {
      fileObservers.forEach((observer) => observer({ changed: [], inserted: [], removed: [replacementFile] }))
      await Promise.resolve()
    })

    expect(replacementBytes && [...replacementBytes]).toEqual([0, 0, 0])
    expect(container.textContent).toContain('fileProtected')
    expect(container.textContent).not.toContain('decrypted-preview')
  })

  it.each([
    ['image', 'image/png'],
    ['PDF', 'application/pdf'],
  ])(
    'authorizes and downloads the authoritative %s item instead of a stale linked snapshot',
    async (_kind, mimeType) => {
      let authorized = false
      const staleFile = {
        uuid: `stale-${mimeType}`,
        remoteIdentifier: 'old-remote',
        content_type: ContentType.TYPES.File,
        mimeType,
        name: `stale.${mimeType === 'application/pdf' ? 'pdf' : 'png'}`,
        decryptedSize: 3,
        protected: false,
      } as FileItem
      const authoritativeFile = {
        ...staleFile,
        remoteIdentifier: 'current-remote',
        protected: true,
      } as FileItem
      let emitChunk!: (chunk: Uint8Array) => Promise<void>
      let finishDownload!: (error: undefined) => void
      const downloadFile = jest.fn(
        (_file: FileItem, emit: (chunk: Uint8Array) => Promise<void>) =>
          new Promise<undefined>((resolve) => {
            emitChunk = emit
            finishDownload = resolve
          }),
      )
      const authorizeItemAccess = jest.fn(async (item: FileItem) => {
        expect(item).toBe(authoritativeFile)
        authorized = true
        return true
      })
      const application = {
        isAuthorizedToRenderItem: jest.fn(() => authorized),
        addEventObserver: jest.fn(() => jest.fn()),
        vaultLocks: { addEventObserver: jest.fn(() => jest.fn()) },
        items: {
          findItem: jest.fn(() => authoritativeFile),
          streamItems: jest.fn(() => jest.fn()),
        },
        files: { downloadFile },
        filesController: {},
        hasProtectionSources: jest.fn(() => true),
        protections: { authorizeItemAccess },
      } as unknown as WebApplication

      await act(async () => {
        root.render(createElement(FilePreview, { application, file: staleFile }))
        await Promise.resolve()
      })
      expect(container.textContent).toContain('fileProtected')

      await act(async () => {
        container.querySelector('button')?.click()
        await Promise.resolve()
      })

      expect(authorizeItemAccess).toHaveBeenCalledWith(authoritativeFile)
      expect(downloadFile).toHaveBeenCalledWith(authoritativeFile, expect.any(Function), expect.any(Object))

      await act(async () => {
        await emitChunk(new Uint8Array([1, 2, 3]))
        finishDownload(undefined)
        await Promise.resolve()
      })

      expect(container.querySelector(`[data-preview-mime="${mimeType}"]`)).not.toBeNull()
      expect(mockPreviewFile).toBe(authoritativeFile)
    },
  )

  it.each([
    ['image', 'image/png'],
    ['PDF', 'application/pdf'],
  ])('retries a failed %s download even while preview state is already empty', async (_kind, mimeType) => {
    const file = {
      uuid: `retry-${mimeType}`,
      remoteIdentifier: 'retry-remote',
      content_type: ContentType.TYPES.File,
      mimeType,
      name: `retry.${mimeType === 'application/pdf' ? 'pdf' : 'png'}`,
      decryptedSize: 3,
    } as FileItem
    let emitChunk!: (chunk: Uint8Array) => Promise<void>
    let finishDownload!: (error: undefined) => void
    const downloadFile = jest
      .fn()
      .mockResolvedValueOnce({ text: 'File metadata was not found.' })
      .mockImplementationOnce(
        (_file: FileItem, emit: (chunk: Uint8Array) => Promise<void>) =>
          new Promise<undefined>((resolve) => {
            emitChunk = emit
            finishDownload = resolve
          }),
      )
    const application = {
      isAuthorizedToRenderItem: jest.fn(() => true),
      addEventObserver: jest.fn(() => jest.fn()),
      vaultLocks: { addEventObserver: jest.fn(() => jest.fn()) },
      items: {
        findItem: jest.fn(() => file),
        streamItems: jest.fn(() => jest.fn()),
      },
      files: { downloadFile },
      filesController: {},
      hasProtectionSources: jest.fn(() => true),
      protections: { authorizeItemAccess: jest.fn() },
    } as unknown as WebApplication

    await act(async () => {
      root.render(createElement(FilePreview, { application, file }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.textContent).toContain('File metadata was not found.')

    await act(async () => {
      container.querySelector('button')?.click()
      await Promise.resolve()
    })
    expect(downloadFile).toHaveBeenCalledTimes(2)

    await act(async () => {
      await emitChunk(new Uint8Array([4, 5, 6]))
      finishDownload(undefined)
      await Promise.resolve()
    })

    expect(container.querySelector(`[data-preview-mime="${mimeType}"]`)).not.toBeNull()
  })

  it('rejects a declared text size above the preview limit without starting a download', async () => {
    const file = {
      uuid: 'declared-too-large',
      remoteIdentifier: 'declared-too-large-remote',
      content_type: ContentType.TYPES.File,
      mimeType: 'text/plain',
      name: 'large.txt',
      decryptedSize: MAX_TEXT_PREVIEW_BYTES + 1,
    } as FileItem
    const downloadFile = jest.fn()
    const application = {
      isAuthorizedToRenderItem: jest.fn(() => true),
      addEventObserver: jest.fn(() => jest.fn()),
      vaultLocks: { addEventObserver: jest.fn(() => jest.fn()) },
      items: {
        findItem: jest.fn(() => file),
        streamItems: jest.fn(() => jest.fn()),
      },
      files: { downloadFile },
      filesController: {},
      hasProtectionSources: jest.fn(() => true),
      protections: { authorizeItemAccess: jest.fn() },
    } as unknown as WebApplication

    await act(async () => {
      root.render(createElement(FilePreview, { application, file }))
      await Promise.resolve()
    })

    expect(downloadFile).not.toHaveBeenCalled()
    expect(container.textContent).toContain('filePreviewTooLarge')
    expect(container.textContent).not.toContain('decrypted-preview')
  })

  it('aborts and wipes streamed plaintext when received bytes exceed the preview limit', async () => {
    const file = {
      uuid: 'streamed-too-large',
      remoteIdentifier: 'streamed-too-large-remote',
      content_type: ContentType.TYPES.File,
      mimeType: 'text/plain',
      name: 'underreported.txt',
      decryptedSize: 1,
    } as FileItem
    const retainedChunk = new Uint8Array(MAX_TEXT_PREVIEW_BYTES)
    retainedChunk.fill(7)
    const overflowChunk = new Uint8Array([9])
    let downloadSignal: AbortSignal | undefined
    const downloadFile = jest.fn(
      async (_file: FileItem, emit: (chunk: Uint8Array) => Promise<void>, options: { signal: AbortSignal }) => {
        downloadSignal = options.signal
        await emit(retainedChunk)
        await emit(overflowChunk)
        if (options.signal.aborted) {
          const error = new Error('Preview download was aborted')
          error.name = 'AbortError'
          throw error
        }
        return undefined
      },
    )
    const application = {
      isAuthorizedToRenderItem: jest.fn(() => true),
      addEventObserver: jest.fn(() => jest.fn()),
      vaultLocks: { addEventObserver: jest.fn(() => jest.fn()) },
      items: {
        findItem: jest.fn(() => file),
        streamItems: jest.fn(() => jest.fn()),
      },
      files: { downloadFile },
      filesController: {},
      hasProtectionSources: jest.fn(() => true),
      protections: { authorizeItemAccess: jest.fn() },
    } as unknown as WebApplication

    await act(async () => {
      root.render(createElement(FilePreview, { application, file }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(downloadFile).toHaveBeenCalledTimes(1)
    expect(downloadSignal?.aborted).toBe(true)
    expect(retainedChunk[0]).toBe(0)
    expect(retainedChunk.at(-1)).toBe(0)
    expect(overflowChunk[0]).toBe(0)
    expect(container.textContent).toContain('filePreviewTooLarge')
    expect(container.textContent).not.toContain('decrypted-preview')
  })

  it('terminates a stalled download, wipes buffered plaintext, and exposes retry instead of spinning forever', async () => {
    jest.useFakeTimers()
    try {
      const file = {
        uuid: 'stalled-preview',
        remoteIdentifier: 'stalled-preview-remote',
        content_type: ContentType.TYPES.File,
        mimeType: 'text/plain',
        name: 'stalled.txt',
        decryptedSize: 3,
      } as FileItem
      const retainedChunk = new Uint8Array([1, 2])
      const signals: AbortSignal[] = []
      const downloadFile = jest.fn(
        async (_file: FileItem, emit: (chunk: Uint8Array) => Promise<void>, options: { signal: AbortSignal }) => {
          signals.push(options.signal)
          await emit(retainedChunk)
          return await new Promise<undefined>(() => undefined)
        },
      )
      const application = {
        isAuthorizedToRenderItem: jest.fn(() => true),
        addEventObserver: jest.fn(() => jest.fn()),
        vaultLocks: { addEventObserver: jest.fn(() => jest.fn()) },
        items: {
          findItem: jest.fn(() => file),
          streamItems: jest.fn(() => jest.fn()),
        },
        files: { downloadFile },
        filesController: {},
        hasProtectionSources: jest.fn(() => true),
        protections: { authorizeItemAccess: jest.fn() },
      } as unknown as WebApplication

      await act(async () => {
        root.render(createElement(FilePreview, { application, file }))
        await Promise.resolve()
      })
      expect(container.textContent).toContain('loading')

      await act(async () => {
        jest.advanceTimersByTime(PREVIEW_DOWNLOAD_IDLE_TIMEOUT_MS)
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(downloadFile).toHaveBeenCalledTimes(2)
      expect(signals[0]?.aborted).toBe(true)
      expect(container.textContent).toContain('loading')

      await act(async () => {
        jest.advanceTimersByTime(PREVIEW_DOWNLOAD_IDLE_TIMEOUT_MS)
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(signals[1]?.aborted).toBe(true)
      expect([...retainedChunk]).toEqual([0, 0])
      expect(container.textContent).toContain('errorLoadingFile')
      expect(container.textContent).toContain('retry-preview')
      expect(container.textContent).not.toContain('loading')
    } finally {
      jest.useRealTimers()
    }
  })

  it('opens a freshly uploaded PDF from complete provisional metadata before the file list publishes it', async () => {
    const file = {
      uuid: 'fresh-pdf',
      remoteIdentifier: 'fresh-pdf-remote',
      content_type: ContentType.TYPES.File,
      mimeType: 'application/pdf',
      name: 'fresh.pdf',
      decryptedSize: 4,
      encryptedChunkSizes: [20],
      dirty: true,
    } as FileItem
    const downloadFile = jest.fn(async (_file: FileItem, emit: (chunk: Uint8Array) => Promise<void>) => {
      await emit(new Uint8Array([37, 80, 68, 70]))
      return undefined
    })
    const application = {
      isAuthorizedToRenderItem: jest.fn(() => true),
      addEventObserver: jest.fn(() => jest.fn()),
      vaultLocks: { addEventObserver: jest.fn(() => jest.fn()) },
      items: {
        findItem: jest.fn(() => undefined),
        streamItems: jest.fn(() => jest.fn()),
      },
      files: { downloadFile },
      filesController: {},
      hasProtectionSources: jest.fn(() => true),
      protections: { authorizeItemAccess: jest.fn() },
    } as unknown as WebApplication

    await act(async () => {
      root.render(createElement(FilePreview, { application, file }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(downloadFile).toHaveBeenCalledTimes(1)
    expect(downloadFile).toHaveBeenCalledWith(file, expect.any(Function), expect.any(Object))
    expect(container.querySelector('[data-preview-mime="application/pdf"]')).not.toBeNull()
  })

  it('gets one fresh-token retry for NS_BINDING_ABORTED and never duplicates a successful download', async () => {
    const file = {
      uuid: 'binding-aborted-pdf',
      remoteIdentifier: 'binding-aborted-pdf-remote',
      content_type: ContentType.TYPES.File,
      mimeType: 'application/pdf',
      name: 'binding-aborted.pdf',
      decryptedSize: 3,
    } as FileItem
    const downloadFile = jest
      .fn()
      .mockRejectedValueOnce(new DOMException('NS_BINDING_ABORTED', 'AbortError'))
      .mockImplementationOnce(async (_file: FileItem, emit: (chunk: Uint8Array) => Promise<void>) => {
        await emit(new Uint8Array([1, 2, 3]))
        return undefined
      })
    const application = {
      isAuthorizedToRenderItem: jest.fn(() => true),
      addEventObserver: jest.fn(() => jest.fn()),
      vaultLocks: { addEventObserver: jest.fn(() => jest.fn()) },
      items: { findItem: jest.fn(() => file), streamItems: jest.fn(() => jest.fn()) },
      files: { downloadFile },
      filesController: {},
      hasProtectionSources: jest.fn(() => true),
      protections: { authorizeItemAccess: jest.fn() },
    } as unknown as WebApplication

    await act(async () => {
      root.render(createElement(FilePreview, { application, file }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(downloadFile).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[data-preview-mime="application/pdf"]')).not.toBeNull()
    expect(container.textContent).not.toContain('loading')
  })

  it('stops after one automatic abort retry and exposes the manual retry action', async () => {
    const file = {
      uuid: 'bounded-abort-pdf',
      remoteIdentifier: 'bounded-abort-pdf-remote',
      content_type: ContentType.TYPES.File,
      mimeType: 'application/pdf',
      name: 'bounded-abort.pdf',
      decryptedSize: 3,
    } as FileItem
    const downloadFile = jest.fn().mockRejectedValue(new DOMException('NS_BINDING_ABORTED', 'AbortError'))
    const application = {
      isAuthorizedToRenderItem: jest.fn(() => true),
      addEventObserver: jest.fn(() => jest.fn()),
      vaultLocks: { addEventObserver: jest.fn(() => jest.fn()) },
      items: { findItem: jest.fn(() => file), streamItems: jest.fn(() => jest.fn()) },
      files: { downloadFile },
      filesController: {},
      hasProtectionSources: jest.fn(() => true),
      protections: { authorizeItemAccess: jest.fn() },
    } as unknown as WebApplication

    await act(async () => {
      root.render(createElement(FilePreview, { application, file }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(downloadFile).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('retry-preview')
    expect(container.textContent).not.toContain('loading')
  })
})
