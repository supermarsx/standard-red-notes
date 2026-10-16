jest.mock('@standardnotes/toast', () => ({ addToast: jest.fn(), ToastType: { Regular: 0 } }))
import { addToast } from '@standardnotes/toast'
import { showAppUpdateToast, watchServedBuild } from './ServedBuildWatcher'

const current = 'a'.repeat(40),
  newer = 'b'.repeat(40)
const response = (revision: unknown, ok = true) => ({ ok, json: async () => ({ revision }) }) as Response
const application = (
  rpc: jest.Mock,
  options: { host?: string; state?: string; operations?: string[]; signedIn?: boolean } = {},
) =>
  ({
    serverGetJsonRequest: rpc,
    syncTransportStatus: { state: options.state ?? 'READY', operations: options.operations ?? ['API_RPC'] },
    getHost: { execute: () => ({ getValue: () => options.host ?? window.location.origin }) },
    sessions: { getUser: () => (options.signedIn === false ? undefined : { uuid: 'self' }) },
  }) as never
describe('automatic running-build update notice', () => {
  const stops: Array<() => void> = []
  beforeEach(() => {
    jest.useFakeTimers()
    jest.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  })
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
  it('uses the healthy authenticated socket without fetching the public HTTP marker', async () => {
    const rpc = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, data: { revision: newer, version: 'web-release' } })
    const fetcher = jest.fn(),
      notify = jest.fn(),
      refresh = jest.fn()
    stops.push(watchServedBuild(current, fetcher, notify, refresh, () => application(rpc)))
    await jest.advanceTimersByTimeAsync(0)
    expect(rpc).toHaveBeenCalledWith('/v1/deployment/web', expect.any(AbortSignal))
    expect(fetcher).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(refresh)
  })
  it('resolves an application that becomes available after bootstrap lazily', async () => {
    const rpc = jest.fn().mockResolvedValue({ ok: true, status: 200, data: { revision: current } })
    let ready = false
    const fetcher = jest.fn().mockResolvedValue(response(current))
    stops.push(watchServedBuild(current, fetcher, jest.fn(), jest.fn(), () => (ready ? application(rpc) : undefined)))
    await jest.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
    ready = true
    await jest.advanceTimersByTimeAsync(60_000)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([
    { host: 'https://another-deployment.example' },
    { state: 'CONNECTING' },
    { operations: ['SYNC_ITEMS'] },
    { signedIn: false },
  ])('keeps same-origin HTTP compatibility when socket use is inappropriate: %p', async (options) => {
    const rpc = jest.fn(),
      fetcher = jest.fn().mockResolvedValue(response(current))
    stops.push(watchServedBuild(current, fetcher, jest.fn(), jest.fn(), () => application(rpc, options)))
    await jest.advanceTimersByTimeAsync(0)
    expect(rpc).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([404, 501, 503])(
    'falls back to the public frontend marker for unavailable route status %s',
    async (status) => {
      const rpc = jest.fn().mockResolvedValue({ ok: false, status, data: { revision: newer } })
      const fetcher = jest.fn().mockResolvedValue(response(current)),
        notify = jest.fn()
      stops.push(watchServedBuild(current, fetcher, notify, jest.fn(), () => application(rpc)))
      await jest.advanceTimersByTimeAsync(0)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(notify).not.toHaveBeenCalled()
    },
  )
  it('validates socket revisions and falls back after rejected or malformed reads', async () => {
    const rpc = jest
      .fn()
      .mockRejectedValueOnce(new Error('socket unavailable'))
      .mockResolvedValue({ ok: true, status: 200, data: { revision: 'not-a-revision' } })
    const fetcher = jest.fn().mockResolvedValue(response(current)),
      notify = jest.fn()
    stops.push(watchServedBuild(current, fetcher, notify, jest.fn(), () => application(rpc)))
    await jest.advanceTimersByTimeAsync(60_000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(notify).not.toHaveBeenCalled()
  })
  it('coalesces wake events and rate limits foreground probes', async () => {
    const rpc = jest.fn().mockResolvedValue({ ok: true, status: 200, data: { revision: current } })
    const fetcher = jest.fn()
    stops.push(watchServedBuild(current, fetcher, jest.fn(), jest.fn(), () => application(rpc)))
    await jest.advanceTimersByTimeAsync(0)
    for (let index = 0; index < 8; index++) {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('online'))
      document.dispatchEvent(new Event('visibilitychange'))
    }
    await jest.advanceTimersByTimeAsync(14_999)
    expect(rpc).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('does not probe offline or hidden tabs, then checks when online and visible', async () => {
    const online = jest.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const visibility = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const rpc = jest.fn().mockResolvedValue({ ok: true, status: 200, data: { revision: current } })
    const fetcher = jest.fn()
    stops.push(watchServedBuild(current, fetcher, jest.fn(), jest.fn(), () => application(rpc)))
    await jest.advanceTimersByTimeAsync(60_000)
    visibility.mockReturnValue('visible')
    window.dispatchEvent(new Event('focus'))
    await jest.advanceTimersByTimeAsync(0)
    expect(rpc).not.toHaveBeenCalled()
    online.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await jest.advanceTimersByTimeAsync(0)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('coalesces wakes during an in-flight probe and cancels deferred wakes on cleanup', async () => {
    let finish!: (value: { ok: boolean; status: number; data: { revision: string } }) => void
    const pending = new Promise<{ ok: boolean; status: number; data: { revision: string } }>((resolve) => {
      finish = resolve
    })
    const rpc = jest
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValue({ ok: true, status: 200, data: { revision: current } })
    const fetcher = jest.fn()
    const stop = watchServedBuild(current, fetcher, jest.fn(), jest.fn(), () => application(rpc))
    stops.push(stop)
    for (let index = 0; index < 8; index++) {
      window.dispatchEvent(new Event('focus'))
    }
    expect(rpc).toHaveBeenCalledTimes(1)
    finish({ ok: true, status: 200, data: { revision: current } })
    await jest.advanceTimersByTimeAsync(0)
    window.dispatchEvent(new Event('focus'))
    stop()
    await jest.advanceTimersByTimeAsync(120_000)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
