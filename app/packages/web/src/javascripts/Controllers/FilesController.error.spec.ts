jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  dismissToast: jest.fn(),
  ToastType: {
    Error: 'error',
    Progress: 'progress',
    Success: 'success',
  },
  updateToast: jest.fn(),
}))

import { formatFileDownloadError } from '@/Utils/FileErrorMessage'
import { ClientDisplayableError, ContentType, FileItem, Platform } from '@standardnotes/snjs'
import { addToast, dismissToast, ToastType } from '@standardnotes/toast'
import { FilesController } from './FilesController'

const mockedAddToast = jest.mocked(addToast)
const mockedDismissToast = jest.mocked(dismissToast)

function fileFixture(): FileItem {
  return {
    content_type: ContentType.TYPES.File,
    mimeType: 'application/octet-stream',
    name: 'archive.bin',
    protected: false,
    uuid: 'file-uuid',
  } as FileItem
}

function controllerFixture(file: FileItem, downloadFile: jest.Mock): FilesController {
  const controller = Object.create(FilesController.prototype) as FilesController

  Object.assign(controller, {
    _isNativeMobileWeb: {
      execute: () => ({ getValue: () => false }),
    },
    archiveService: {},
    files: { downloadFile },
    isAuthorizedToRenderItem: () => true,
    items: { findItem: () => file },
    mobileDevice: undefined,
    platform: Platform.LinuxWeb,
    shouldUseStreamingAPI: false,
  })

  return controller
}

function invokeExplicitDownload(controller: FilesController, file: FileItem): Promise<void> {
  const downloadFile = (
    FilesController.prototype as unknown as {
      downloadFile: (this: FilesController, file: FileItem) => Promise<void>
    }
  ).downloadFile

  return downloadFile.call(controller, file)
}

describe('formatFileDownloadError', () => {
  it('surfaces a bounded actionable server reason', () => {
    expect(formatFileDownloadError(new Error('Encrypted file metadata was not found.'))).toBe(
      'Unable to download the file: Encrypted file metadata was not found.',
    )
  })

  it('removes control characters and bounds reflected details', () => {
    const message = formatFileDownloadError(new Error(`bad\u0000response ${'x'.repeat(500)}`))

    expect(message).not.toContain('\u0000')
    expect(message.length).toBeLessThanOrEqual('Unable to download the file: '.length + 300)
  })

  it('uses a stable fallback for unknown thrown values', () => {
    expect(formatFileDownloadError({ reason: 'unknown' })).toBe('There was an error while downloading the file.')
  })
})

describe('FilesController explicit download errors', () => {
  let consoleError: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    mockedAddToast.mockReturnValue('download-progress')
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  it('surfaces a ClientDisplayableError reason and dismisses the progress toast', async () => {
    const file = fileFixture()
    const downloadFile = jest
      .fn()
      .mockResolvedValue(new ClientDisplayableError('Encrypted file metadata was not found.'))
    const controller = controllerFixture(file, downloadFile)

    await expect(invokeExplicitDownload(controller, file)).resolves.toBeUndefined()

    expect(mockedAddToast).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: ToastType.Progress,
      }),
    )
    expect(mockedAddToast).toHaveBeenCalledWith({
      type: ToastType.Error,
      message: 'Unable to download the file: Encrypted file metadata was not found.',
    })
    expect(mockedDismissToast).toHaveBeenCalledTimes(1)
    expect(mockedDismissToast).toHaveBeenCalledWith('download-progress')
  })

  it('dismisses the progress toast when the file download is cancelled', async () => {
    const file = fileFixture()
    const downloadFile = jest.fn().mockRejectedValue(new DOMException('Cancelled by the user.', 'AbortError'))
    const controller = controllerFixture(file, downloadFile)

    await expect(invokeExplicitDownload(controller, file)).resolves.toBeUndefined()

    expect(mockedAddToast).toHaveBeenCalledTimes(1)
    expect(mockedAddToast).toHaveBeenCalledWith(expect.objectContaining({ type: ToastType.Progress }))
    expect(mockedAddToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: ToastType.Error }))
    expect(mockedDismissToast).toHaveBeenCalledTimes(1)
    expect(mockedDismissToast).toHaveBeenCalledWith('download-progress')
  })
})
