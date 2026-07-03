/**
 * @jest-environment jsdom
 *
 * MomentsService.takePhoto acquires a live camera stream via PhotoRecorder and
 * MUST always release it (PhotoRecorder.finish stops the MediaStream tracks /
 * turns off the OS camera indicator). A prior version only called finish() on the
 * single happy path, so a failed capture or a throwing upload left the camera
 * streaming until the next hourly Moment. These tests pin the try/finally cleanup.
 */
import { MomentsService } from './MomentsService'
import { PhotoRecorder } from './PhotoRecorder'

jest.mock('./PhotoRecorder')

jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(() => 'toast-id'),
  dismissToast: jest.fn(),
  ToastType: { Regular: 'regular', Error: 'error', Success: 'success' },
}))

const installPhotoRecorder = (overrides: { takePhoto?: jest.Mock } = {}) => {
  const finish = jest.fn()
  const takePhoto =
    overrides.takePhoto ?? jest.fn().mockResolvedValue(new File(['x'], 'moment.png', { type: 'image/png' }))
  ;(PhotoRecorder as unknown as jest.Mock).mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    takePhoto,
    finish,
  }))
  return { finish, takePhoto }
}

const makeService = () => {
  const filesController = { uploadNewFile: jest.fn().mockResolvedValue(undefined) }
  const linkingController = { linkItemToSelectedItem: jest.fn(), linkItems: jest.fn() }
  const storage = { getValue: jest.fn(), setValue: jest.fn() }
  const preferences = { getValue: jest.fn() }
  const items = { findItem: jest.fn() }
  const protections = { isLocked: jest.fn().mockResolvedValue(false) }
  const isMobileDevice = { execute: () => ({ getValue: () => false }) }
  const eventBus = { addEventHandler: jest.fn(), publishSync: jest.fn() }

  const service = new MomentsService(
    filesController as never,
    linkingController as never,
    storage as never,
    preferences as never,
    items as never,
    protections as never,
    undefined,
    isMobileDevice as never,
    eventBus as never,
  )
  return { service, filesController }
}

describe('MomentsService.takePhoto camera-stream cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('releases the camera stream when the upload throws', async () => {
    const { finish } = installPhotoRecorder()
    const { service, filesController } = makeService()
    filesController.uploadNewFile.mockRejectedValue(new Error('upload failed'))

    await expect(service.takePhoto()).rejects.toThrow('upload failed')

    // The finally block must have released the camera despite the upload error.
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('releases the camera stream when both capture attempts fail', async () => {
    jest.useFakeTimers()
    // takePhoto returns undefined every time -> the service retries once (after a
    // 1s sleep) then returns undefined. Cleanup must still run.
    const { finish, takePhoto } = installPhotoRecorder({ takePhoto: jest.fn().mockResolvedValue(undefined) })
    const { service } = makeService()

    const promise = service.takePhoto()
    // Flush the retry sleep (setTimeout(1000)) and let microtasks settle.
    await jest.advanceTimersByTimeAsync(1500)
    const result = await promise

    expect(result).toBeUndefined()
    expect(takePhoto).toHaveBeenCalledTimes(2)
    expect(finish).toHaveBeenCalledTimes(1)
    jest.useRealTimers()
  })

  it('still releases the camera on the normal success path', async () => {
    const { finish } = installPhotoRecorder()
    const { service } = makeService()

    await service.takePhoto()

    expect(finish).toHaveBeenCalledTimes(1)
  })
})
