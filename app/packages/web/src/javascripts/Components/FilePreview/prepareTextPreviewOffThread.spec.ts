import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util'

jest.mock('./textPreview.worker', () => {
  class MockTextPreviewWorker {
    public onmessage: ((event: { data: unknown }) => void) | null = null
    public onerror: (() => void) | null = null
    public terminated = false

    postMessage(message: { requestId: number; bytes: Uint8Array }): void {
      const marker = message.bytes[0]
      if (marker === 1) {
        setTimeout(
          () =>
            this.onmessage?.({
              data: {
                type: 'prepared',
                requestId: message.requestId,
                result: { decoded: { status: 'ready', text: 'worker result', hadBidiControls: false } },
              },
            }),
          0,
        )
      } else if (marker === 2) {
        setTimeout(() => this.onerror?.(), 0)
      }
      // marker 3 deliberately hangs so the client timeout/fallback is exercised.
    }

    terminate(): void {
      this.terminated = true
    }
  }

  return { __esModule: true, default: MockTextPreviewWorker }
})

import { prepareTextPreviewOffThread, TEXT_PREVIEW_WORKER_TIMEOUT_MS } from './prepareTextPreviewOffThread'

const codecGlobal = globalThis as unknown as { TextEncoder?: unknown; TextDecoder?: unknown }
if (!codecGlobal.TextEncoder) {
  codecGlobal.TextEncoder = NodeTextEncoder
}
if (!codecGlobal.TextDecoder) {
  codecGlobal.TextDecoder = NodeTextDecoder
}

describe('prepareTextPreviewOffThread', () => {
  const originalWorker = (globalThis as { Worker?: unknown }).Worker

  afterEach(() => {
    jest.useRealTimers()
    if (originalWorker === undefined) {
      delete (globalThis as { Worker?: unknown }).Worker
    } else {
      ;(globalThis as { Worker?: unknown }).Worker = originalWorker
    }
  })

  it('uses the bounded main-thread fallback when workers are unavailable and still rejects binary', async () => {
    delete (globalThis as { Worker?: unknown }).Worker

    await expect(prepareTextPreviewOffThread(new TextEncoder().encode('safe text'), 'plain')).resolves.toEqual({
      decoded: { status: 'ready', text: 'safe text', hadBidiControls: false },
    })
    await expect(prepareTextPreviewOffThread(new Uint8Array([0x61, 0, 0x62]), 'plain')).resolves.toEqual({
      decoded: { status: 'binary-or-invalid-utf8' },
    })
  })

  it('uses the dedicated worker when available', async () => {
    ;(globalThis as { Worker?: unknown }).Worker = function WorkerGate() {}

    await expect(prepareTextPreviewOffThread(new Uint8Array([1]), 'plain')).resolves.toEqual({
      decoded: { status: 'ready', text: 'worker result', hadBidiControls: false },
    })
  })

  it('falls back safely after a worker error', async () => {
    ;(globalThis as { Worker?: unknown }).Worker = function WorkerGate() {}

    await expect(prepareTextPreviewOffThread(new Uint8Array([2, 0]), 'plain')).resolves.toEqual({
      decoded: { status: 'binary-or-invalid-utf8' },
    })
  })

  it('times out a hung worker and reaches the bounded fallback', async () => {
    jest.useFakeTimers()
    ;(globalThis as { Worker?: unknown }).Worker = function WorkerGate() {}
    const promise = prepareTextPreviewOffThread(new Uint8Array([3, 0]), 'plain')

    jest.advanceTimersByTime(TEXT_PREVIEW_WORKER_TIMEOUT_MS)

    await expect(promise).resolves.toEqual({ decoded: { status: 'binary-or-invalid-utf8' } })
  })

  it('terminates without fallback when cancellation wins', async () => {
    ;(globalThis as { Worker?: unknown }).Worker = function WorkerGate() {}
    const controller = new AbortController()
    const promise = prepareTextPreviewOffThread(new Uint8Array([3]), 'plain', controller.signal)

    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })
})
