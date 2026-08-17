import { LegacyApiService, resolveFilesServerUrl } from './ApiService'

describe('file server URL resolution', () => {
  const createService = (filesHost = 'https://files.example.test') => {
    const runHttp = jest.fn()
    const service = new LegacyApiService(
      { runHttp } as never,
      { setValue: jest.fn(), getValue: jest.fn() } as never,
      'https://notes.example.test',
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )
    const internals = service as unknown as { session: unknown; filesHost: string }
    internals.session = { accessToken: 'access-token' }
    internals.filesHost = filesHost

    return { service, runHttp }
  }

  it.each([
    ['/files', 'https://notes.example.test/files'],
    ['files/', 'https://notes.example.test/files'],
    ['https://files.example.test/storage/', 'https://files.example.test/storage'],
  ])('resolves supported file host %s', (advertised, expected) => {
    expect(resolveFilesServerUrl(advertised, 'https://notes.example.test')).toBe(expected)
  })

  it('repairs the Compose localhost default when the API is remote', () => {
    expect(resolveFilesServerUrl('http://localhost:3001/files', 'https://notes.example.test')).toBe(
      'https://notes.example.test/files',
    )
  })

  it.each([
    'file:///tmp/files',
    'data:text/plain,files',
    'javascript:alert(1)',
    'https://user:secret@files.example.test/files',
    'https://files.example.test/files?token=secret',
    'https://files.example.test/files#fragment',
    'https://files.example.test\\files',
    'https://files.example.test/files\u0000',
    'http://files.example.test/files',
  ])('rejects unsafe file host %s', (advertised) => {
    expect(resolveFilesServerUrl(advertised, 'https://notes.example.test')).toBeUndefined()
  })

  it.each([undefined, null, 42, {}, [], true])('rejects a non-string advertised file host %p', (advertised) => {
    expect(resolveFilesServerUrl(advertised, 'https://notes.example.test')).toBeUndefined()
  })

  it('rejects a non-string API host without throwing', () => {
    expect(resolveFilesServerUrl('/files', { origin: 'https://notes.example.test' })).toBeUndefined()
  })

  it('stores only a resolved safe URL from response metadata', () => {
    const service = new LegacyApiService(
      {} as never,
      {} as never,
      'https://notes.example.test',
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )

    service.processMetaObject({ server: { filesServerUrl: '/files' } })
    expect(service.getFilesHost()).toBe('https://notes.example.test/files')

    service.processMetaObject({ server: { filesServerUrl: 'file:///tmp/files' } })
    expect(() => service.getFilesHost()).toThrow('missing or unsafe')
  })

  it('clears a stale file host when switching API servers', async () => {
    const storage = { setValue: jest.fn(), getValue: jest.fn() }
    const service = new LegacyApiService(
      {} as never,
      storage as never,
      'https://one.example.test',
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )

    service.processMetaObject({ server: { filesServerUrl: '/files' } })
    expect(service.getFilesHost()).toBe('https://one.example.test/files')

    await service.setHost('https://two.example.test')

    expect(() => service.getFilesHost()).toThrow('missing or unsafe')
  })

  it('clears a previous file host when metadata explicitly advertises an empty value', () => {
    const service = new LegacyApiService(
      {} as never,
      {} as never,
      'https://notes.example.test',
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )

    service.processMetaObject({ server: { filesServerUrl: '/files' } })
    service.processMetaObject({ server: { filesServerUrl: '' } })

    expect(() => service.getFilesHost()).toThrow('missing or unsafe')
  })

  it('does not let malformed response metadata break API response processing', () => {
    const service = new LegacyApiService(
      {} as never,
      {} as never,
      'https://notes.example.test',
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    )

    expect(() => service.processMetaObject({ server: { filesServerUrl: 42 as never } })).not.toThrow()
    expect(() => service.getFilesHost()).toThrow('missing or unsafe')
  })

  it('marks every cross-origin file-server request as external', async () => {
    const { service, runHttp } = createService()
    const successResponse = { status: 200, data: { success: true }, headers: new Map() }
    const expectLastRequestIsExternal = () => {
      expect(runHttp).toHaveBeenLastCalledWith(expect.objectContaining({ external: true }))
    }

    runHttp.mockResolvedValue(successResponse)
    await service.startUploadSession('valet-token', 'user')
    expectLastRequestIsExternal()

    await service.deleteFile('valet-token', 'user')
    expectLastRequestIsExternal()

    await service.uploadFileBytes('valet-token', 'user', 1, new Uint8Array([1, 2]))
    expectLastRequestIsExternal()

    await service.closeUploadSession('valet-token', 'user')
    expectLastRequestIsExternal()

    await service.moveFile('valet-token')
    expectLastRequestIsExternal()

    runHttp.mockResolvedValue({
      status: 206,
      data: new Uint8Array([1, 2]).buffer,
      headers: new Map([['content-range', 'bytes 0-1/2']]),
    })
    await service.downloadFile({
      file: { encryptedChunkSizes: [2] },
      chunkIndex: 0,
      valetToken: 'valet-token',
      ownershipType: 'user',
      contentRangeStart: 0,
      onBytesReceived: jest.fn(),
    })
    expectLastRequestIsExternal()
  })

  it('keeps unrelated authenticated admin requests first-party when the files host is external', async () => {
    const { service, runHttp } = createService()
    runHttp.mockResolvedValue({ status: 200, data: { success: true }, headers: new Map() })

    await service.adminControlService('api-gateway', 'restart')

    const request = runHttp.mock.calls[0][0] as { authentication?: string; external?: boolean }
    expect(request.authentication).toBe('access-token')
    expect(request.external).not.toBe(true)
  })

  it('does not invalidate the account session for a rejected valet token', async () => {
    const { service, runHttp } = createService()
    const invalidSessionObserver = jest.fn()
    service.setInvalidSessionObserver(invalidSessionObserver)
    runHttp.mockResolvedValue({
      status: 401,
      data: { error: { message: 'Invalid valet token.', tag: 'invalid-auth' } },
      headers: new Map(),
    })

    await service.startUploadSession('expired-valet-token', 'user')
    expect(invalidSessionObserver).not.toHaveBeenCalled()

    await service.adminControlService('api-gateway', 'restart')
    expect(invalidSessionObserver).toHaveBeenCalledWith(false)
  })
})
