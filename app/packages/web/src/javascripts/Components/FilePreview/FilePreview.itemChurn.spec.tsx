/**
 * @jest-environment jsdom
 */
import { WebApplication } from '@/Application/WebApplication'
import { ContentType, FileItem } from '@standardnotes/snjs'
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import FilePreview, { PREVIEW_TOTAL_DEADLINE_MS } from './FilePreview'

jest.mock('react-i18next', () => {
  const t = (key: string) => key
  return { useTranslation: () => ({ t }) }
})
jest.mock('./PreviewComponent', () => ({
  __esModule: true,
  default: ({ bytes, file }: { bytes: Uint8Array; file: FileItem }) => {
    const React = jest.requireActual<typeof import('react')>('react')
    return React.createElement('div', { 'data-preview-name': file.name }, `decrypted-preview:${[...bytes].join(',')}`)
  },
}))
jest.mock('@/Components/Spinner/Spinner', () => ({ __esModule: true, default: () => 'spinner' }))
jest.mock('./FilePreviewError', () => ({
  __esModule: true,
  default: ({ errorMessage }: { errorMessage?: string }) => {
    const React = jest.requireActual<typeof import('react')>('react')
    return React.createElement('div', null, errorMessage ?? 'preview-error')
  },
}))
jest.mock('@standardnotes/icons', () => ({ ProtectedIllustration: () => 'protected' }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type FileStreamEvent = { changed: FileItem[]; inserted: FileItem[]; removed: { uuid: string }[] }

const baseFile = {
  uuid: 'churn-file',
  remoteIdentifier: 'churn-remote',
  key: 'file-key',
  encryptionHeader: 'file-header',
  encryptedChunkSizes: [16],
  content_type: ContentType.TYPES.File,
  mimeType: 'text/plain',
  name: 'notes.txt',
  decryptedSize: 3,
} as unknown as FileItem

describe('FilePreview under local item churn', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.clearAllMocks()
  })

  const mountPreview = () => {
    let currentFile: FileItem | undefined = baseFile
    const fileObservers: ((event: FileStreamEvent) => void)[] = []
    const downloads: {
      emit: (chunk: Uint8Array) => Promise<void>
      resolve: (error: undefined) => void
      signal: AbortSignal
    }[] = []
    const downloadFile = jest.fn(
      (_file: FileItem, emit: (chunk: Uint8Array) => Promise<void>, options: { signal: AbortSignal }) =>
        new Promise<undefined>((resolve) => downloads.push({ emit, resolve, signal: options.signal })),
    )
    const application = {
      isAuthorizedToRenderItem: jest.fn(() => true),
      addEventObserver: jest.fn(() => jest.fn()),
      vaultLocks: { addEventObserver: jest.fn(() => jest.fn()) },
      items: {
        findItem: jest.fn(() => currentFile),
        streamItems: jest.fn((contentType: string | string[], observer: (event: FileStreamEvent) => void) => {
          if (contentType === ContentType.TYPES.File) {
            fileObservers.push(observer)
          }
          return jest.fn()
        }),
      },
      files: { downloadFile },
      filesController: {},
      hasProtectionSources: jest.fn(() => true),
      protections: { authorizeItemAccess: jest.fn() },
    } as unknown as WebApplication

    const publish = async (next: FileItem) => {
      currentFile = next
      await act(async () => {
        fileObservers.forEach((observer) => observer({ changed: [next], inserted: [], removed: [] }))
        await Promise.resolve()
      })
    }

    return { application, downloadFile, downloads, publish }
  }

  it('keeps a download alive when sync re-applies the same stored file', async () => {
    const { application, downloadFile, downloads, publish } = mountPreview()

    await act(async () => {
      root.render(createElement(FilePreview, { application, file: baseFile }))
      await Promise.resolve()
    })
    expect(downloadFile).toHaveBeenCalledTimes(1)

    // Half the payload has arrived when sync republishes the item unchanged.
    const firstChunk = new Uint8Array([1, 2])
    await act(async () => {
      await downloads[0].emit(firstChunk)
      await Promise.resolve()
    })

    for (let reapply = 0; reapply < 5; reapply++) {
      await publish({ ...baseFile } as FileItem)
    }

    expect(downloadFile).toHaveBeenCalledTimes(1)
    expect(downloads[0].signal.aborted).toBe(false)
    expect([...firstChunk]).toEqual([1, 2])

    // The original transfer finishes and renders, having never restarted.
    await act(async () => {
      await downloads[0].emit(new Uint8Array([3]))
      downloads[0].resolve(undefined)
      await Promise.resolve()
    })
    expect(container.textContent).toContain('decrypted-preview:1,2,3')
  })

  it('applies a rename mid-download without refetching the bytes', async () => {
    const { application, downloadFile, downloads, publish } = mountPreview()

    await act(async () => {
      root.render(createElement(FilePreview, { application, file: baseFile }))
      await Promise.resolve()
    })

    await publish({ ...baseFile, name: 'renamed.txt' } as FileItem)
    expect(downloadFile).toHaveBeenCalledTimes(1)

    await act(async () => {
      await downloads[0].emit(new Uint8Array([7, 8, 9]))
      downloads[0].resolve(undefined)
      await Promise.resolve()
    })

    expect(container.querySelector('[data-preview-name="renamed.txt"]')).not.toBeNull()
    expect(container.textContent).toContain('decrypted-preview:7,8,9')
  })

  it('still restarts when the stored payload really is replaced', async () => {
    const { application, downloadFile, downloads, publish } = mountPreview()

    await act(async () => {
      root.render(createElement(FilePreview, { application, file: baseFile }))
      await Promise.resolve()
    })

    await publish({ ...baseFile, remoteIdentifier: 'churn-remote-v2' } as FileItem)

    expect(downloadFile).toHaveBeenCalledTimes(2)
    expect(downloads[0].signal.aborted).toBe(true)
  })

  it('names the failure instead of spinning when re-keying outlives the deadline', async () => {
    jest.useFakeTimers({ doNotFake: ['performance'] })
    try {
      const { application, downloadFile, publish } = mountPreview()

      await act(async () => {
        root.render(createElement(FilePreview, { application, file: baseFile }))
        await Promise.resolve()
      })
      expect(container.textContent).toContain('spinner')

      // Payload genuinely re-keyed each time, so each restart is legitimate --
      // but collectively they must not spin past the ceiling.
      await publish({ ...baseFile, remoteIdentifier: 'churn-remote-v2' } as FileItem)
      jest.setSystemTime(Date.now() + PREVIEW_TOTAL_DEADLINE_MS + 1)
      const callsBeforeDeadline = downloadFile.mock.calls.length
      await publish({ ...baseFile, remoteIdentifier: 'churn-remote-v3' } as FileItem)

      expect(downloadFile).toHaveBeenCalledTimes(callsBeforeDeadline)
      expect(container.textContent).toContain('filePreviewKeptRestarting')
      expect(container.textContent).not.toContain('spinner')
    } finally {
      jest.useRealTimers()
    }
  })
})
