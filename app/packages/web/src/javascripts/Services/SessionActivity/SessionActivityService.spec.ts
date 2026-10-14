/** @jest-environment jsdom */
import { ApplicationEvent } from '@standardnotes/snjs'
import { SessionActivityService } from './SessionActivityService'
import type { WebApplication } from '@/Application/WebApplication'

jest.mock('@/Components/SuperEditor/Collaboration/CollaborationDeviceIdentity', () => ({
  collaborationDeviceId: () => 'opaque-profile-id',
}))

describe('authenticated session activity lifecycle', () => {
  let service: SessionActivityService
  beforeEach(() => {
    jest.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })
  afterEach(() => {
    service?.deinit()
    jest.useRealTimers()
  })
  const setup = (signedOut = false) => {
    const recordSessionActivity = jest.fn().mockResolvedValue({ data: {} })
    const isSignedOut = jest.fn().mockReturnValue(signedOut)
    let observer!: (event: ApplicationEvent) => void
    const disposer = jest.fn()
    service = new SessionActivityService({
      sessions: { isSignedOut },
      legacyApi: { recordSessionActivity },
      addEventObserver: (callback: typeof observer) => {
        observer = callback
        return disposer
      },
    } as unknown as WebApplication)
    return { recordSessionActivity, isSignedOut, disposer, observer }
  }
  it('records authenticated visible profile activity and stops on disposal', async () => {
    const { recordSessionActivity, disposer } = setup()
    await Promise.resolve()
    expect(recordSessionActivity).toHaveBeenCalledWith('opaque-profile-id')
    await jest.advanceTimersByTimeAsync(30_000)
    expect(recordSessionActivity).toHaveBeenCalledTimes(2)
    service.deinit()
    await jest.advanceTimersByTimeAsync(60_000)
    expect(recordSessionActivity).toHaveBeenCalledTimes(2)
    expect(disposer).toHaveBeenCalled()
  })
  it('does not manufacture activity while signed out or hidden and resumes after sign-in/visibility', async () => {
    const { recordSessionActivity, isSignedOut, observer } = setup(true)
    expect(recordSessionActivity).not.toHaveBeenCalled()
    isSignedOut.mockReturnValue(false)
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    observer(ApplicationEvent.SignedIn)
    expect(recordSessionActivity).not.toHaveBeenCalled()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(recordSessionActivity).toHaveBeenCalledTimes(1)
  })
  it('keeps slow or failed heartbeat requests out of the editing/sync path', async () => {
    const { recordSessionActivity } = setup()
    await Promise.resolve()
    let settle!: () => void
    recordSessionActivity.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        }),
    )
    await jest.advanceTimersByTimeAsync(30_000)
    await jest.advanceTimersByTimeAsync(60_000)
    expect(recordSessionActivity).toHaveBeenCalledTimes(2)
    settle()
    await Promise.resolve()
    recordSessionActivity.mockRejectedValue(new Error('offline'))
    await expect(service.record()).resolves.toBeUndefined()
  })
})
