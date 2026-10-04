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
import { FILE_DOWNLOAD_IDLE_TIMEOUT_MS, FILE_DOWNLOAD_STALLED_MESSAGE, FilesController } from './FilesController'

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
    archiveService: { downloadData: jest.fn() },
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
    expect(mockedAddToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ToastType.Error,
        message: 'Unable to download the file: Encrypted file metadata was not found.',
      }),
    )
    expect(mockedDismissToast).toHaveBeenCalledTimes(1)
    expect(mockedDismissToast).toHaveBeenCalledWith('download-progress')
  })

  it('offers a retry affordance on the failure toast that re-runs the download', async () => {
    const file = fileFixture()
    const downloadFile = jest.fn().mockResolvedValue(new ClientDisplayableError('Encrypted file metadata not found.'))
    const controller = controllerFixture(file, downloadFile)

    await invokeExplicitDownload(controller, file)

    const errorToast = mockedAddToast.mock.calls
      .map(([options]) => options)
      .find((options) => options.type === ToastType.Error)
    // Precondition: there IS a failure toast to carry the affordance.
    expect(errorToast).toBeDefined()
    expect(errorToast?.actions).toHaveLength(1)
    expect(errorToast?.actions?.[0].label).toBe('Retry')

    // Pressing it dismisses its own toast and starts a fresh transfer, so a
    // one-off stall is recoverable without reopening the file.
    expect(downloadFile).toHaveBeenCalledTimes(1)
    errorToast?.actions?.[0].handler('error-toast-id')
    expect(mockedDismissToast).toHaveBeenCalledWith('error-toast-id')
    await Promise.resolve()
    expect(downloadFile).toHaveBeenCalledTimes(2)
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

/**
 * Standard Red Notes: a `/files/v1/files` range request that stalls used to hold
 * this method open for the full one-hour fetch deadline (and nginx's matching
 * one-hour `proxy_read_timeout`) with a "Downloading file … (0%)" toast and no
 * error — the "files get stuck loading forever" report. These prove the three
 * outcomes are now DISTINCT: a stall ends in a named failure, an empty-but-real
 * download still reports success, and the stall does not fire early.
 */
describe('FilesController explicit download stalls', () => {
  let consoleError: jest.SpyInstance

  /**
   * Resolves only when the controller aborts the transfer, which is what
   * `FileService.downloadFile` does with an abort signal. When NO signal is
   * handed in, resolve with a loud sentinel instead of hanging, so a regression
   * that drops the signal fails on an assertion rather than on a test timeout.
   */
  const stallingDownload = () => {
    const signals: (AbortSignal | undefined)[] = []
    const mock = jest.fn((_file: FileItem, _onBytes: unknown, options?: { signal?: AbortSignal }): Promise<unknown> => {
      signals.push(options?.signal)

      const signal = options?.signal
      if (!signal) {
        return Promise.resolve(new ClientDisplayableError('NO_ABORT_SIGNAL_WAS_PASSED'))
      }

      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(undefined), { once: true })
      })
    })

    return { mock, signals }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    mockedAddToast.mockReturnValue('download-progress')
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.useRealTimers()
    consoleError.mockRestore()
  })

  it('ends a transfer that delivers nothing with a stated failure and a retry', async () => {
    const file = fileFixture()
    const { mock: downloadFile, signals } = stallingDownload()
    const controller = controllerFixture(file, downloadFile)

    const pending = invokeExplicitDownload(controller, file)

    // Preconditions: the transfer really started, really received a live signal,
    // and really had not failed yet when the clock was advanced.
    expect(downloadFile).toHaveBeenCalledTimes(1)
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(signals[0]?.aborted).toBe(false)
    expect(mockedAddToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: ToastType.Error }))

    jest.advanceTimersByTime(FILE_DOWNLOAD_IDLE_TIMEOUT_MS)
    await pending

    expect(signals[0]?.aborted).toBe(true)
    expect(mockedAddToast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: ToastType.Error,
        message: formatFileDownloadError(new Error(FILE_DOWNLOAD_STALLED_MESSAGE)),
        actions: [expect.objectContaining({ label: 'Retry' })],
      }),
    )
    // A stall must never be reported as a completed download.
    expect(mockedAddToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: ToastType.Success }))
    expect(mockedDismissToast).toHaveBeenCalledWith('download-progress')
  })

  it('does not declare a stall before the idle window elapses', async () => {
    const file = fileFixture()
    const { mock: downloadFile, signals } = stallingDownload()
    const controller = controllerFixture(file, downloadFile)

    const pending = invokeExplicitDownload(controller, file)
    expect(downloadFile).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(FILE_DOWNLOAD_IDLE_TIMEOUT_MS - 1)
    await Promise.resolve()

    expect(signals[0]?.aborted).toBe(false)
    expect(mockedAddToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: ToastType.Error }))

    // Let the pending transfer settle so the test does not leak a live timer.
    jest.advanceTimersByTime(1)
    await pending
    expect(signals[0]?.aborted).toBe(true)
  })

  it('reports success for a download that genuinely carried no bytes', async () => {
    const file = fileFixture()
    // Distinguishable from the stall above: it RESOLVES on its own, without the
    // transfer ever being aborted. An empty result and a dead request must not
    // land on the same screen.
    const downloadFile = jest.fn().mockResolvedValue(undefined)
    const controller = controllerFixture(file, downloadFile)

    await invokeExplicitDownload(controller, file)

    expect(mockedAddToast).toHaveBeenCalledWith(expect.objectContaining({ type: ToastType.Success }))
    expect(mockedAddToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: ToastType.Error }))
  })
})
