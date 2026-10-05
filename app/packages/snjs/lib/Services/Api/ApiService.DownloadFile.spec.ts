import { FILE_TRANSFER_REQUEST_TIMEOUT_MS, LegacyApiService } from './ApiService'

describe('LegacyApiService.downloadFile integrity contract', () => {
  let consoleError: jest.SpyInstance

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  const createService = () => {
    const runHttp = jest.fn()
    const service = new LegacyApiService(
      { runHttp } as never,
      {} as never,
      'https://sync.example.test',
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
    const internals = service as unknown as { session: unknown; filesHost: string }
    internals.session = { accessToken: 'access-token' }
    internals.filesHost = 'https://files.example.test'

    return { service, runHttp }
  }

  const bytes = (size: number): ArrayBuffer => new Uint8Array(size).buffer
  const partialResponse = (contentRange: string, size: number, status = 206) => ({
    status,
    data: bytes(size),
    headers: new Map([['content-range', contentRange]]),
  })
  /**
   * The full `DownloadFileParams['file']` shape. Spelled out rather than cast so
   * the specs keep typechecking against the real contract: `lib/tsconfig.json`
   * excludes every `.spec.ts`, so `linter.tsconfig.json` is the only thing that
   * ever compiles this file.
   */
  const fileMetadata = (encryptedChunkSizes: number[]) => ({
    uuid: '11111111-1111-4111-8111-111111111111',
    remoteIdentifier: 'remote-identifier',
    encryptedChunkSizes,
    shared_vault_uuid: undefined,
  })
  const baseParams = {
    file: fileMetadata([2, 3]),
    chunkIndex: 0,
    valetToken: 'valet-token',
    ownershipType: 'user' as const,
    contentRangeStart: 0,
  }

  it('downloads every declared encrypted chunk with exact bounded ranges', async () => {
    const { service, runHttp } = createService()
    runHttp
      .mockResolvedValueOnce(partialResponse('bytes 0-1/5', 2))
      .mockResolvedValueOnce(partialResponse('bytes 2-4/5', 3))
    const received: number[] = []

    const result = await service.downloadFile({
      ...baseParams,
      onBytesReceived: async (chunk) => {
        received.push(chunk.byteLength)
      },
    })

    expect(result).toBeUndefined()
    expect(received).toEqual([2, 3])
    expect(runHttp).toHaveBeenCalledTimes(2)
    expect(runHttp.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        responseType: 'arraybuffer',
        timeoutMs: FILE_TRANSFER_REQUEST_TIMEOUT_MS,
        external: true,
        customHeaders: expect.arrayContaining([
          { key: 'x-chunk-size', value: '2' },
          { key: 'range', value: 'bytes=0-1' },
        ]),
      }),
    )
    expect(runHttp.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        customHeaders: expect.arrayContaining([
          { key: 'x-chunk-size', value: '3' },
          { key: 'range', value: 'bytes=2-4' },
        ]),
      }),
    )
  })

  it('forwards caller cancellation to every active range request', async () => {
    const { service, runHttp } = createService()
    const controller = new AbortController()
    runHttp.mockResolvedValue(partialResponse('bytes 0-1/5', 2))

    await service.downloadFile({
      ...baseParams,
      abortSignal: controller.signal,
      onBytesReceived: jest.fn(),
    })

    expect(runHttp).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: controller.signal,
      }),
    )
  })

  it('preserves a server-provided missing-file reason for the caller', async () => {
    const { service, runHttp } = createService()
    runHttp.mockResolvedValue({
      status: 404,
      data: { error: { message: 'Encrypted file data was not found on this server.' } },
      headers: new Map(),
    })

    const result = await service.downloadFile({
      ...baseParams,
      onBytesReceived: jest.fn(),
    })

    expect(result?.text).toBe('Encrypted file data was not found on this server.')
  })

  it('returns an actionable error instead of throwing when the file host is missing', async () => {
    const { service, runHttp } = createService()
    ;(service as unknown as { filesHost?: string }).filesHost = undefined

    const result = await service.downloadFile({
      ...baseParams,
      onBytesReceived: jest.fn(),
    })

    expect(result?.text).toContain('PUBLIC_FILES_SERVER_URL')
    expect(runHttp).not.toHaveBeenCalled()
  })

  it('uses the bounded transfer timeout for encrypted upload chunks', async () => {
    const { service, runHttp } = createService()
    runHttp.mockResolvedValue({ status: 200, data: { success: true }, headers: new Map() })

    await expect(service.uploadFileBytes('valet-token', 'user', 1, new Uint8Array([1, 2]))).resolves.toBe(true)

    expect(runHttp).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: FILE_TRANSFER_REQUEST_TIMEOUT_MS,
        rawBytes: new Uint8Array([1, 2]),
        external: true,
      }),
    )
  })

  it.each([
    ['empty', []],
    ['zero', [0]],
    ['negative', [-1]],
    ['fractional', [1.5]],
    ['NaN', [Number.NaN]],
    ['unsafe aggregate', [Number.MAX_SAFE_INTEGER, 1]],
  ])('rejects %s encrypted chunk metadata before a request', async (_label, encryptedChunkSizes) => {
    const { service, runHttp } = createService()

    const result = await service.downloadFile({
      ...baseParams,
      file: fileMetadata(encryptedChunkSizes),
      onBytesReceived: jest.fn(),
    })

    expect(result?.text).toMatch(/metadata|authenticated encrypted chunk/)
    expect(runHttp).not.toHaveBeenCalled()
  })

  it.each([-1, 2, 1.5, Number.NaN])('rejects out-of-bounds chunk index %s before a request', async (chunkIndex) => {
    const { service, runHttp } = createService()

    const result = await service.downloadFile({
      ...baseParams,
      chunkIndex,
      onBytesReceived: jest.fn(),
    })

    expect(result?.text).toContain('outside its metadata')
    expect(runHttp).not.toHaveBeenCalled()
  })

  it.each([-1, 1, 1.5, Number.NaN])('rejects a resume offset %s that does not match metadata', async (start) => {
    const { service, runHttp } = createService()

    const result = await service.downloadFile({
      ...baseParams,
      chunkIndex: 1,
      contentRangeStart: start,
      onBytesReceived: jest.fn(),
    })

    expect(result?.text).toContain('does not match its encrypted metadata')
    expect(runHttp).not.toHaveBeenCalled()
  })

  it.each([204, 203, 205])('rejects an unusable 2xx status %s and names it', async (status) => {
    const { service, runHttp } = createService()
    runHttp.mockResolvedValue({ status, data: bytes(2), headers: new Map([['content-range', 'bytes 0-1/5']]) })
    const onBytesReceived = jest.fn()

    const result = await service.downloadFile({ ...baseParams, onBytesReceived })

    expect(result?.text).toContain('partial-content')
    expect(result?.text).toContain(`HTTP ${status}`)
    expect(onBytesReceived).not.toHaveBeenCalled()
  })

  /**
   * `Content-Range` is not CORS-safelisted, so on a split deployment it is
   * readable only while every hop preserves `Access-Control-Expose-Headers`.
   * A correct 206 whose header the browser will not surface must still work:
   * the body length is checked anyway, and the payload is AEAD-sealed, so a
   * wrong window fails its tag at decryption rather than being trusted.
   */
  it.each([
    ['no header at all', new Map<string, string>()],
    ['an empty header value', new Map([['content-range', '']])],
    ['an unknown complete length', new Map([['content-range', 'bytes 0-1/*']])],
  ])('accepts a 206 with %s', async (_label, headers) => {
    const { service, runHttp } = createService()
    runHttp
      .mockResolvedValueOnce({ status: 206, data: bytes(2), headers })
      .mockResolvedValueOnce(partialResponse('bytes 2-4/5', 3))
    const received: number[] = []

    const result = await service.downloadFile({
      ...baseParams,
      onBytesReceived: async (chunk) => {
        received.push(chunk.byteLength)
      },
    })

    expect(result).toBeUndefined()
    expect(received).toEqual([2, 3])
  })

  it.each(['bytes NaN-1/5', 'bytes 0-1/5x', 'bytes 0-/5', 'bytes 0-1/5 trailing', 'items 0-1/5'])(
    'rejects malformed or wildcard Content-Range %s',
    async (contentRange) => {
      const { service, runHttp } = createService()
      runHttp.mockResolvedValue(partialResponse(contentRange, 2))
      const onBytesReceived = jest.fn()

      const result = await service.downloadFile({
        ...baseParams,
        onBytesReceived,
      })

      expect(result?.text).toContain('malformed Content-Range')
      expect(onBytesReceived).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['start', 'bytes 1-2/5'],
    ['end', 'bytes 0-2/5'],
    ['total', 'bytes 0-1/6'],
  ])('rejects a Content-Range with a misaligned %s', async (_label, contentRange) => {
    const { service, runHttp } = createService()
    runHttp.mockResolvedValue(partialResponse(contentRange, 2))
    const onBytesReceived = jest.fn()

    const result = await service.downloadFile({
      ...baseParams,
      onBytesReceived,
    })

    expect(result?.text).toContain('does not match the requested encrypted chunk metadata')
    expect(onBytesReceived).not.toHaveBeenCalled()
  })

  it.each([
    ['truncated', 1],
    ['oversized', 3],
  ])('rejects a %s encrypted response body', async (_label, responseSize) => {
    const { service, runHttp } = createService()
    runHttp.mockResolvedValue(partialResponse('bytes 0-1/5', responseSize))
    const onBytesReceived = jest.fn()

    const result = await service.downloadFile({
      ...baseParams,
      onBytesReceived,
    })

    expect(result?.text).toContain(`had ${responseSize} bytes; expected 2`)
    expect(onBytesReceived).not.toHaveBeenCalled()
  })

  it('rejects a non-binary response body', async () => {
    const { service, runHttp } = createService()
    runHttp.mockResolvedValue({
      status: 206,
      data: 'not an array buffer',
      headers: new Map([['content-range', 'bytes 0-1/5']]),
    })

    const result = await service.downloadFile({
      ...baseParams,
      onBytesReceived: jest.fn(),
    })

    expect(result?.text).toContain('encrypted binary data')
  })

  it('stops before requesting the next chunk after the lower layer aborts', async () => {
    const { service, runHttp } = createService()
    runHttp.mockResolvedValue(partialResponse('bytes 0-1/5', 2))
    let aborted = false

    const result = await service.downloadFile({
      ...baseParams,
      shouldAbort: () => aborted,
      onBytesReceived: async () => {
        aborted = true
      },
    })

    expect(result).toBeUndefined()
    expect(runHttp).toHaveBeenCalledTimes(1)
  })

  it('propagates a rejected network request without invoking the byte callback', async () => {
    const { service, runHttp } = createService()
    const networkError = new Error('connection reset')
    runHttp.mockRejectedValue(networkError)
    const onBytesReceived = jest.fn()

    await expect(
      service.downloadFile({
        ...baseParams,
        onBytesReceived,
      }),
    ).rejects.toBe(networkError)
    expect(onBytesReceived).not.toHaveBeenCalled()
  })
  /**
   * RFC 9110 15.3.7: a server or intermediary MAY ignore `Range` and answer
   * `200` with the whole representation. Refusing that killed every preview
   * behind such a hop with no visible cause.
   */
  describe('a 200 that ignores the requested range', () => {
    const distinctBytes = (size: number): ArrayBuffer => Uint8Array.from({ length: size }, (_v, i) => i + 1).buffer
    const fullResponse = (size: number, headers = new Map<string, string>()) => ({
      status: 200,
      data: distinctBytes(size),
      headers,
    })

    it('slices every declared chunk out of one whole-body response', async () => {
      const { service, runHttp } = createService()
      runHttp.mockResolvedValue(fullResponse(5))
      const received: number[][] = []

      const result = await service.downloadFile({
        ...baseParams,
        onBytesReceived: async (chunk) => {
          received.push(Array.from(chunk))
        },
      })

      expect(result).toBeUndefined()
      expect(received).toEqual([
        [1, 2],
        [3, 4, 5],
      ])
    })

    it('never issues a second request, so a single-use read token is not burned twice', async () => {
      const { service, runHttp } = createService()
      runHttp.mockResolvedValueOnce(fullResponse(5)).mockResolvedValue({
        status: 401,
        data: { error: { message: 'Valet token already used.' } },
        headers: new Map(),
      })

      const result = await service.downloadFile({ ...baseParams, onBytesReceived: jest.fn() })

      expect(result).toBeUndefined()
      expect(runHttp).toHaveBeenCalledTimes(1)
    })

    it('resumes from a later chunk by slicing at the absolute offset', async () => {
      const { service, runHttp } = createService()
      runHttp.mockResolvedValue(fullResponse(5))
      const received: number[][] = []

      const result = await service.downloadFile({
        ...baseParams,
        chunkIndex: 1,
        contentRangeStart: 2,
        onBytesReceived: async (chunk) => {
          received.push(Array.from(chunk))
        },
      })

      expect(result).toBeUndefined()
      expect(received).toEqual([[3, 4, 5]])
      expect(runHttp).toHaveBeenCalledTimes(1)
    })

    it('still sends the Range request it would have sent', async () => {
      const { service, runHttp } = createService()
      runHttp.mockResolvedValue(fullResponse(5))

      await service.downloadFile({ ...baseParams, onBytesReceived: jest.fn() })

      expect(runHttp.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          customHeaders: expect.arrayContaining([{ key: 'range', value: 'bytes=0-1' }]),
        }),
      )
    })

    it('honours cancellation between sliced chunks', async () => {
      const { service, runHttp } = createService()
      runHttp.mockResolvedValue(fullResponse(5))
      let aborted = false
      const received: number[] = []

      const result = await service.downloadFile({
        ...baseParams,
        shouldAbort: () => aborted,
        onBytesReceived: async (chunk) => {
          received.push(chunk.byteLength)
          aborted = true
        },
      })

      expect(result).toBeUndefined()
      expect(received).toEqual([2])
    })

    it.each([
      ['shorter', 4],
      ['longer', 6],
    ])('refuses to hold a %s whole body than the authenticated encrypted total', async (_label, size) => {
      const { service, runHttp } = createService()
      runHttp.mockResolvedValue(fullResponse(size))
      const onBytesReceived = jest.fn()

      const result = await service.downloadFile({ ...baseParams, onBytesReceived })

      expect(result?.text).toContain(`full ${size}-byte body`)
      expect(result?.text).toContain('authenticated encrypted total is 5')
      expect(onBytesReceived).not.toHaveBeenCalled()
    })

    it('hands on copies, so a retained chunk does not pin the whole representation', async () => {
      const { service, runHttp } = createService()
      runHttp.mockResolvedValue(fullResponse(5))
      const retained: Uint8Array[] = []

      await service.downloadFile({
        ...baseParams,
        onBytesReceived: async (chunk) => {
          retained.push(chunk)
        },
      })

      expect(retained.map((chunk) => chunk.buffer.byteLength)).toEqual([2, 3])
    })
  })

  describe('multi-range downloads against a single-use read token', () => {
    it('completes when the token is consumed only by the final range', async () => {
      const { service, runHttp } = createService()
      const ranges = ['bytes=0-1', 'bytes=2-4']
      let consumed = false
      runHttp.mockImplementation(async (request: { customHeaders: { key: string; value: string }[] }) => {
        if (consumed) {
          return { status: 401, data: { error: { message: 'Valet token already used.' } }, headers: new Map() }
        }
        const range = request.customHeaders.find((header) => header.key === 'range')?.value
        const index = ranges.indexOf(range as string)
        if (index === ranges.length - 1) {
          consumed = true
        }
        return partialResponse(`bytes ${(range as string).slice('bytes='.length)}/5`, index === 0 ? 2 : 3)
      })
      const received: number[] = []

      const result = await service.downloadFile({
        ...baseParams,
        onBytesReceived: async (chunk) => {
          received.push(chunk.byteLength)
        },
      })

      expect(result).toBeUndefined()
      expect(received).toEqual([2, 3])
      expect(runHttp).toHaveBeenCalledTimes(2)
    })
  })

  describe('attributable rejections', () => {
    it('names the status, the requested range and the received Content-Range', async () => {
      const { service, runHttp } = createService()
      runHttp.mockResolvedValue(partialResponse('bytes 0-9/5', 2))

      const result = await service.downloadFile({ ...baseParams, onBytesReceived: jest.fn() })

      expect(result?.text).toContain('chunk 0')
      expect(result?.text).toContain('HTTP 206')
      expect(result?.text).toContain('requested bytes=0-1')
      expect(result?.text).toContain('Content-Range bytes 0-9/5')
      expect(consoleError).toHaveBeenCalledWith(
        'File download rejected a chunk response.',
        expect.objectContaining({
          chunkIndex: 0,
          status: 206,
          requestedRange: 'bytes=0-1',
          contentRange: 'bytes 0-9/5',
        }),
      )
    })

    it('says so explicitly when no Content-Range was received', async () => {
      const { service, runHttp } = createService()
      runHttp.mockResolvedValue({ status: 206, data: bytes(1), headers: new Map() })

      const result = await service.downloadFile({ ...baseParams, onBytesReceived: jest.fn() })

      expect(result?.text).toContain('Content-Range absent')
      expect(consoleError).toHaveBeenCalledWith(
        'File download rejected a chunk response.',
        expect.objectContaining({ contentRange: 'absent' }),
      )
    })

    it('never puts the valet token in the log or the message', async () => {
      const { service, runHttp } = createService()
      runHttp.mockResolvedValue(partialResponse('bytes 0-9/5', 2))

      const result = await service.downloadFile({ ...baseParams, onBytesReceived: jest.fn() })

      expect(result?.text).not.toContain('valet-token')
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('valet-token')
    })
  })
})
