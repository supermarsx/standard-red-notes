import { SharedSyncWorkerClient } from './SharedSyncWorkerClient'

describe('shared sync worker page adapter', () => {
  let port: {
    postMessage: jest.Mock
    start: jest.Mock
    close: jest.Mock
    onmessage: ((event: MessageEvent) => void) | null
    onmessageerror: (() => void) | null
  }
  let adapter: SharedSyncWorkerClient
  beforeEach(() => {
    jest.useFakeTimers()
    port = { postMessage: jest.fn(), start: jest.fn(), close: jest.fn(), onmessage: null, onmessageerror: null }
    adapter = new SharedSyncWorkerClient({ port, onerror: null } as unknown as SharedWorker, 'opaque-session', 'build')
  })
  afterEach(() => {
    adapter.terminate()
    jest.useRealTimers()
  })

  it('attaches the account/build scope and forwards binary messages without owning the worker process', () => {
    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'BROKER_ATTACH',
      sessionScope: 'opaque-session',
      revision: 'build',
    })
    const message = {
      type: 'SEND_FILE_CHUNK' as const,
      clientRequestId: 'upload',
      index: 0,
      offset: 0,
      bytes: new Uint8Array([1, 2]),
    }
    adapter.postMessage(message)
    expect(port.postMessage).toHaveBeenLastCalledWith(message)
    const receive = jest.fn()
    adapter.onmessage = receive
    const output = { type: 'RPC_CHUNK', clientRequestId: 'request', bytes: 'ciphertext', byteLength: 10 }
    port.onmessage!({ data: output } as MessageEvent)
    expect(receive).toHaveBeenCalledWith({ data: output })
    adapter.terminate()
    expect(port.postMessage).toHaveBeenLastCalledWith({ type: 'BROKER_DETACH' })
    expect(port.close).toHaveBeenCalledTimes(1)
    const count = port.postMessage.mock.calls.length
    jest.advanceTimersByTime(60000)
    expect(port.postMessage).toHaveBeenCalledTimes(count)
  })

  it('preserves a cached page durability callback but detaches a genuinely closed page', () => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
    expect(port.close).not.toHaveBeenCalled()
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))
    expect(port.close).toHaveBeenCalledTimes(1)
  })

  it('reports inactivity expiration as local worker recovery, without asserting auth revocation', () => {
    const expired = jest.fn(),
      error = jest.fn(),
      receive = jest.fn()
    adapter.onexpired = expired
    adapter.onerror = error
    adapter.onmessage = receive
    port.onmessage!({ data: { type: 'SHUTDOWN_COMPLETE' } } as MessageEvent)
    expect(expired).toHaveBeenCalledTimes(1)
    expect(error).not.toHaveBeenCalled()
    expect(receive).not.toHaveBeenCalled()
  })

  it('passes its own graceful shutdown acknowledgement back to the existing barrier', () => {
    const receive = jest.fn(),
      expired = jest.fn()
    adapter.onmessage = receive
    adapter.onexpired = expired
    adapter.postMessage({ type: 'SHUTDOWN' })
    port.onmessage!({ data: { type: 'SHUTDOWN_COMPLETE' } } as MessageEvent)
    expect(receive).toHaveBeenCalledTimes(1)
    expect(expired).not.toHaveBeenCalled()
  })
})

describe('stable shared worker bundle URL', () => {
  // The worker loader compiles the entry; this final loader exports its emitted
  // URL instead of instantiating an inline/blob worker independently in each tab.
  const loader = require('../../../../shared-worker-url-loader.cjs') as (source: string) => string
  it('exports the content-hashed same-origin emission and rejects inline wrapper drift', () => {
    expect(
      loader(
        'export default function Worker_fn() {\n return new Worker(__webpack_public_path__ + "abc.sharedworker.js");\n}',
      ),
    ).toBe('export default __webpack_public_path__ + "abc.sharedworker.js";\n')
    expect(() => loader('return worker("inline-code")')).toThrow('stable emitted URL')
  })
})
