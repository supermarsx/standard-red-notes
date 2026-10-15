jest.mock('@standardnotes/toast', () => ({ addToast: jest.fn(), ToastType: { Regular: 0 } }))
import { addToast } from '@standardnotes/toast'
import { showAppUpdateToast, watchServedBuild } from './ServedBuildWatcher'

const current = 'a'.repeat(40),
  newer = 'b'.repeat(40)
const response = (revision: unknown, ok = true) => ({ ok, json: async () => ({ revision }) }) as Response
describe('automatic running-build update notice', () => {
  const stops: Array<() => void> = []
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    stops.splice(0).forEach((stop) => stop())
    jest.restoreAllMocks()
    jest.useRealTimers()
  })
  it('detects deployment changes automatically and offers refresh without reloading', async () => {
    const fetcher = jest.fn().mockResolvedValueOnce(response(current)).mockResolvedValue(response(newer))
    const notify = jest.fn(),
      refresh = jest.fn()
    stops.push(watchServedBuild(current, fetcher, notify, refresh))
    await jest.advanceTimersByTimeAsync(0)
    expect(notify).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(60_000)
    expect(notify).toHaveBeenCalledWith(refresh)
    expect(refresh).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenLastCalledWith(
      '/.well-known/srn-deployment.json',
      expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }),
    )
    await jest.advanceTimersByTimeAsync(180_000)
    expect(notify).toHaveBeenCalledTimes(1)
  })
  it('does not treat HTTP failures, malformed markers, or an unstamped bundle as an update', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(response(newer, false))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(response('unstamped'))
      .mockResolvedValue(response(newer))
    const notify = jest.fn()
    stops.push(watchServedBuild('', fetcher, notify))
    expect(fetcher).not.toHaveBeenCalled()
    stops.push(watchServedBuild(current, fetcher, notify))
    await jest.advanceTimersByTimeAsync(120_000)
    expect(notify).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(60_000)
    expect(notify).toHaveBeenCalledTimes(1)
  })
  it('checks when a tab returns to the foreground and removes its listeners on cleanup', async () => {
    const visibility = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const fetcher = jest.fn().mockResolvedValue(response(newer)),
      notify = jest.fn()
    const stop = watchServedBuild(current, fetcher, notify)
    expect(fetcher).not.toHaveBeenCalled()
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await jest.advanceTimersByTimeAsync(0)
    expect(notify).toHaveBeenCalledTimes(1)
    stop()
    window.dispatchEvent(new Event('focus'))
    await jest.advanceTimersByTimeAsync(120_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('shows a persistent actionable toast and deduplicates service-worker notices', () => {
    const refresh = jest.fn()
    showAppUpdateToast(refresh)
    showAppUpdateToast(refresh)
    expect(addToast).toHaveBeenCalledTimes(1)
    const toast = jest.mocked(addToast).mock.calls[0][0]
    expect(toast.autoClose).toBe(false)
    expect(toast.actions?.[0].label).toBe('Refresh app')
    toast.actions?.[0].handler?.('update-toast')
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
