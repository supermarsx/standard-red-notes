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

  it('passes the realtime composition codes through, without their messages', () => {
    for (const code of ['INVITE_CURSOR_SECRET_TOO_SHORT', 'INVITE_REDIS_NAMESPACE_INVALID']) {
      const error = Object.assign(new Error('Invite cursor secret must contain at least 32 bytes.'), {
        name: 'InviteEventConfigurationError',
        code,
      })

      const result = safeErrorLogMetadata(error)

      // The class name is not in the known-type allowlist, so it collapses to
      // 'Error'; the code is the stable signal the boot log keeps.
      expect(result).toEqual({ errorType: 'Error', errorCode: code, status: undefined })
      expect(JSON.stringify(result)).not.toContain('32 bytes')
    }
  })

  it('passes the SNS publish timeout type through, without its message or cause', () => {
    // Same shape as domain-events-infra's SNSPublishTimeoutError (the class
    // itself lives above this package). A sync-command outbox row that dies
    // after twenty of these must be distinguishable from one rejected outright.
    const timedOut = Object.assign(new Error('SNS publish timed out after 2000 ms.'), {
      name: 'SNSPublishTimeoutError',
      cause: Object.assign(new Error('The operation was aborted https://sns.internal:4566/topic'), {
        name: 'AbortError',
      }),
    })
    const rejected = Object.assign(new Error('Message too long: 300000 bytes'), { name: 'Error' })

    const result = safeErrorLogMetadata(timedOut)

    expect(result).toEqual({ errorType: 'SNSPublishTimeoutError', errorCode: undefined, status: undefined })
    expect(JSON.stringify(result)).not.toContain('2000 ms')
    expect(JSON.stringify(result)).not.toContain('sns.internal')
    expect(safeErrorLogMetadata(rejected).errorType).toBe('Error')
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
    expect(safeErrorLogMetadata({ name: 'Error', code: 429 })).toEqual({
      errorType: 'Error',
      errorCode: 429,
      status: undefined,
    })
  })
})
