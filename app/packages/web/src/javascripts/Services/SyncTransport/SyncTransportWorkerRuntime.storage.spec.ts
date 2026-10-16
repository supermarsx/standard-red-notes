import { SyncTransportWorkerRuntime } from './SyncTransportWorkerRuntime'

it('surfaces a default outbox IndexedDB quota failure as bounded worker metadata', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      open: () => {
        const request: { error: DOMException; onerror?: () => void } = {
          error: new DOMException('Sensitive OS error details', 'QuotaExceededError'),
        }
        queueMicrotask(() => request.onerror?.())
        return request
      },
    },
  })
  const postMessage = jest.fn()
  const runtime = new SyncTransportWorkerRuntime({
    postMessage,
    uuid: () => 'storage-worker',
    subtle: {} as SubtleCrypto,
  })
  try {
    await runtime.handle({
      type: 'RECOVER',
      clientRequestId: 'recover',
      sessionScope: `sync-session-v1:${'a'.repeat(64)}`,
    })
    expect(postMessage).toHaveBeenCalledWith({ type: 'LOCAL_STORAGE_HEALTH', code: 'quota-exceeded' })
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain('Sensitive OS')
    await runtime.handle({ type: 'SHUTDOWN' })
  } finally {
    if (previous) Object.defineProperty(globalThis, 'indexedDB', previous)
    else delete (globalThis as { indexedDB?: IDBFactory }).indexedDB
  }
})
