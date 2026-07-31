import { LegacyApiService } from './ApiService'

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
  const baseParams = {
    file: { encryptedChunkSizes: [2, 3] },
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
      file: { encryptedChunkSizes },
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

  it('requires a 206 response and a Content-Range header', async () => {
    const notPartial = createService()
    notPartial.runHttp.mockResolvedValue(partialResponse('bytes 0-1/5', 2, 200))
    const missingHeader = createService()
    missingHeader.runHttp.mockResolvedValue({
      status: 206,
      data: bytes(2),
      headers: new Map(),
    })

    const statusResult = await notPartial.service.downloadFile({
      ...baseParams,
      onBytesReceived: jest.fn(),
    })
    const headerResult = await missingHeader.service.downloadFile({
      ...baseParams,
      onBytesReceived: jest.fn(),
    })

    expect(statusResult?.text).toContain('partial-content')
    expect(headerResult?.text).toContain('Content-Range')
  })

  it.each(['bytes NaN-1/5', 'bytes 0-1/*', 'bytes 0-/5', 'bytes 0-1/5 trailing', 'items 0-1/5'])(
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
})
