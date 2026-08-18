import { BoundedSourceFetchError, fetchBoundedSourceBytes } from './fetchBoundedSourceBytes'

type MockReader = {
  read: jest.Mock
  cancel: jest.Mock
  releaseLock: jest.Mock
}

function streamResponse(chunks: Uint8Array[], contentLength?: string): { response: Response; reader: MockReader } {
  let index = 0
  const reader: MockReader = {
    read: jest.fn(async () =>
      index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined },
    ),
    cancel: jest.fn(async () => undefined),
    releaseLock: jest.fn(),
  }
  const response = {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name === 'content-length' ? (contentLength ?? null) : null) },
    body: { getReader: () => reader },
  } as unknown as Response
  return { response, reader }
}

describe('fetchBoundedSourceBytes', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    jest.useRealTimers()
  })

  it('streams exactly once without credentials/referrer and wipes source chunks', async () => {
    const first = new Uint8Array([1, 2])
    const second = new Uint8Array([3, 4])
    const { response, reader } = streamResponse([first, second], '4')
    const fetchMock = jest.fn().mockResolvedValue(response)
    globalThis.fetch = fetchMock as typeof fetch

    await expect(
      fetchBoundedSourceBytes('https://example.invalid/file', { maximumBytes: 4, idleTimeoutMs: 1_000 }),
    ).resolves.toEqual(new Uint8Array([1, 2, 3, 4]))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.invalid/file',
      expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer' }),
    )
    expect(first).toEqual(new Uint8Array([0, 0]))
    expect(second).toEqual(new Uint8Array([0, 0]))
    expect(reader.releaseLock).toHaveBeenCalledTimes(1)
  })

  it('rejects an oversized declared length before reading a body', async () => {
    const { response, reader } = streamResponse([], '5')
    globalThis.fetch = jest.fn().mockResolvedValue(response) as typeof fetch

    await expect(
      fetchBoundedSourceBytes('blob:oversized', { maximumBytes: 4, idleTimeoutMs: 1_000 }),
    ).rejects.toMatchObject<Partial<BoundedSourceFetchError>>({ code: 'size-limit' })
    expect(reader.read).not.toHaveBeenCalled()
  })

  it('cancels an underreported stream as soon as its byte ceiling is crossed', async () => {
    const retained = new Uint8Array([1, 2, 3, 4])
    const overflow = new Uint8Array([5])
    const { response, reader } = streamResponse([retained, overflow], '1')
    globalThis.fetch = jest.fn().mockResolvedValue(response) as typeof fetch

    await expect(
      fetchBoundedSourceBytes('blob:underreported', { maximumBytes: 4, idleTimeoutMs: 1_000 }),
    ).rejects.toMatchObject<Partial<BoundedSourceFetchError>>({ code: 'size-limit' })
    expect(reader.cancel).toHaveBeenCalledTimes(1)
    expect(retained).toEqual(new Uint8Array([0, 0, 0, 0]))
    expect(overflow).toEqual(new Uint8Array([0]))
  })

  it('aborts a stalled source at the idle timeout', async () => {
    jest.useFakeTimers()
    globalThis.fetch = jest.fn((_source, options) => {
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    }) as typeof fetch
    const promise = fetchBoundedSourceBytes('https://example.invalid/stalled', {
      maximumBytes: 4,
      idleTimeoutMs: 100,
    })

    jest.advanceTimersByTime(100)

    await expect(promise).rejects.toMatchObject<Partial<BoundedSourceFetchError>>({ code: 'timeout' })
  })

  it('honors caller cancellation without converting it into a timeout', async () => {
    const controller = new AbortController()
    globalThis.fetch = jest.fn((_source, options) => {
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    }) as typeof fetch
    const promise = fetchBoundedSourceBytes('https://example.invalid/cancelled', {
      maximumBytes: 4,
      idleTimeoutMs: 1_000,
      signal: controller.signal,
    })

    controller.abort()

    await expect(promise).rejects.toMatchObject<Partial<BoundedSourceFetchError>>({ code: 'aborted' })
  })
})
