import { safeErrorLogMetadata } from './SafeErrorLogMetadata'

describe('safeErrorLogMetadata', () => {
  it('keeps only stable error classification and status', () => {
    const error = Object.assign(new TypeError('credential-sentinel'), {
      code: 'ECONNREFUSED',
      errno: 'errno-sentinel',
      url: 'https://user:password@example.test/?token=token-sentinel',
      sql: 'SELECT secret-sentinel',
      response: {
        status: 503,
        data: { providerBody: 'provider-body-sentinel' },
      },
    })

    const result = safeErrorLogMetadata(error)

    expect(result).toEqual({
      errorType: 'TypeError',
      errorCode: 'ECONNREFUSED',
      status: 503,
    })
    const serialized = JSON.stringify(result)
    for (const sentinel of [
      'credential-sentinel',
      'errno-sentinel',
      'password',
      'token-sentinel',
      'secret-sentinel',
      'provider-body-sentinel',
    ]) {
      expect(serialized).not.toContain(sentinel)
    }
  })

  it('does not invoke accessors or trust unknown classes and codes', () => {
    const error: Record<string, unknown> = {}
    for (const key of ['name', 'code', 'message', 'stack', 'errno', 'response']) {
      Object.defineProperty(error, key, {
        get: () => {
          throw new Error(`getter-sentinel-${key}`)
        },
      })
    }

    expect(safeErrorLogMetadata(error)).toEqual({
      errorType: 'Error',
      errorCode: undefined,
      status: undefined,
    })
  })

  it('survives hostile proxies and bounds numeric codes', () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('proxy-sentinel')
        },
      },
    )

    expect(safeErrorLogMetadata(hostile)).toEqual({
      errorType: 'Error',
      errorCode: undefined,
      status: undefined,
    })
    expect(safeErrorLogMetadata({ name: 'ProviderSecret', code: -111 })).toEqual({
      errorType: 'Error',
      errorCode: undefined,
      status: undefined,
    })
  })
})
