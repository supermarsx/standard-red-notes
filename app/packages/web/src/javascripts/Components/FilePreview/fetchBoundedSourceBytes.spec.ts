import {
  BoundedSourceFetchError,
  decodeDataUrlBytes,
  fetchBoundedSourceBytes,
  isRenderableAttachmentSource,
} from './fetchBoundedSourceBytes'

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

  /**
   * `fetch('data:…')` is governed by CSP `connect-src`. The shipped policy
   * (`connect-src 'self' https: http://localhost:* http://127.0.0.1:* ws://… wss:`)
   * does not list `data:`, so such a fetch is BLOCKED and the violation report
   * prints the entire data URL — a whole base64 image — into the console, while
   * the inline preview and "save to Files" both fail. The only way to be immune
   * to that is to never issue the request.
   */
  describe('data: sources', () => {
    // "hello" — 5 bytes.
    const base64Source = 'data:application/octet-stream;base64,aGVsbG8='
    const expected = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f])

    it('decodes base64 without calling fetch at all', async () => {
      const fetchMock = jest.fn(() => {
        throw new Error('fetch must never be used for a data: URL')
      })
      globalThis.fetch = fetchMock as unknown as typeof fetch

      await expect(
        fetchBoundedSourceBytes(base64Source, { maximumBytes: 1_024, idleTimeoutMs: 1_000 }),
      ).resolves.toEqual(expected)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('decodes a percent-encoded data URL without calling fetch', async () => {
      const fetchMock = jest.fn(() => {
        throw new Error('fetch must never be used for a data: URL')
      })
      globalThis.fetch = fetchMock as unknown as typeof fetch

      await expect(
        fetchBoundedSourceBytes('data:text/plain,he%6Clo', { maximumBytes: 1_024, idleTimeoutMs: 1_000 }),
      ).resolves.toEqual(expected)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('still enforces the byte ceiling on a data URL', async () => {
      globalThis.fetch = jest.fn() as unknown as typeof fetch

      await expect(
        fetchBoundedSourceBytes(base64Source, { maximumBytes: 2, idleTimeoutMs: 1_000 }),
      ).rejects.toMatchObject<Partial<BoundedSourceFetchError>>({ code: 'size-limit' })
    })

    it('rejects a malformed data URL rather than handing back partial bytes', async () => {
      globalThis.fetch = jest.fn() as unknown as typeof fetch

      await expect(
        fetchBoundedSourceBytes('data:image/png;base64,!!!not base64!!!', {
          maximumBytes: 1_024,
          idleTimeoutMs: 1_000,
        }),
      ).rejects.toMatchObject<Partial<BoundedSourceFetchError>>({ code: 'invalid-source' })
    })
  })

  it('refuses a file:/// source before any request is made', async () => {
    const fetchMock = jest.fn()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    await expect(
      fetchBoundedSourceBytes('file:///C:/Users/me/clip_image001.png', {
        maximumBytes: 1_024,
        idleTimeoutMs: 1_000,
      }),
    ).rejects.toMatchObject<Partial<BoundedSourceFetchError>>({ code: 'invalid-source' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('decodeDataUrlBytes', () => {
  it('decodes a base64 data URL to its exact bytes', () => {
    expect(decodeDataUrlBytes('data:image/png;base64,aGVsbG8=', 1_024)).toEqual(
      new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]),
    )
  })

  it('enforces the ceiling', () => {
    expect(() => decodeDataUrlBytes('data:image/png;base64,aGVsbG8=', 2)).toThrow(BoundedSourceFetchError)
  })

  it('refuses anything that is not a data URL', () => {
    expect(() => decodeDataUrlBytes('https://example.test/a.png', 1_024)).toThrow(BoundedSourceFetchError)
    expect(() => decodeDataUrlBytes('file:///C:/a.png', 1_024)).toThrow(BoundedSourceFetchError)
  })
})

describe('isRenderableAttachmentSource', () => {
  it.each(['https://example.test/a.png', 'http://example.test/a.png', 'data:image/png;base64,iVBORw0KGgo=', 'blob:x'])(
    'accepts %s',
    (source) => {
      expect(isRenderableAttachmentSource(source)).toBe(true)
    },
  )

  it.each([
    'file:///C:/Users/me/AppData/Local/Temp/msohtmlclip1/01/clip_image001.png',
    'file://server/share/photo.png',
    'sn-file://3f2ae1#page=2',
    'javascript:alert(1)',
    'about:blank',
  ])('rejects %s', (source) => {
    expect(isRenderableAttachmentSource(source)).toBe(false)
  })
})
