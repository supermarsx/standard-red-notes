import { createLogger, format, transports } from 'winston'
import { Writable } from 'stream'

import { createSafeLogFormat, redactLogValue, safeErrorLogMetadata, sanitizeUrlForSafeLog } from './SafeLog'

describe('SafeLog', () => {
  const sentinels = [
    'access-token-sentinel',
    'refresh-token-sentinel',
    'offline-token-sentinel',
    'features-token-sentinel',
    'subscription-token-sentinel',
    'cookie-sentinel',
    'password-sentinel',
    'pkce-sentinel',
    'api-key-sentinel',
    'encrypted-content-sentinel',
    'person@example.test',
  ]

  it('recursively redacts credential, session, PII, and content fields without following circular references', () => {
    const value: Record<string, unknown> = {
      authorization: 'Bearer access-token-sentinel',
      nested: {
        refreshToken: 'refresh-token-sentinel',
        offlineToken: 'offline-token-sentinel',
        featuresToken: 'features-token-sentinel',
        subscription_token: 'subscription-token-sentinel',
        cookie: 'cookie-sentinel',
        password: 'password-sentinel',
        codeVerifier: 'pkce-sentinel',
        apiKey: 'api-key-sentinel',
        content: 'encrypted-content-sentinel',
        email: 'person@example.test',
      },
    }
    value.circular = value

    const serialized = JSON.stringify(redactLogValue(value))

    for (const sentinel of sentinels) {
      expect(serialized).not.toContain(sentinel)
    }
    expect(serialized).toContain('[Circular]')
  })

  it('keeps only a sanitized origin and path and scrubs path, query, fragment, and userinfo credentials', () => {
    const result = sanitizeUrlForSafeLog(
      'https://user:pass@auth.test/subscription-tokens/path-token-sentinel/validate?token=query-token#fragment-token',
    )

    expect(result).toBe('https://auth.test/subscription-tokens/[REDACTED]/validate [query-parameter-count=1]')
    expect(result).not.toContain('user')
    expect(result).not.toContain('query-token')
    expect(result).not.toContain('fragment-token')
    expect(result).not.toContain('path-token-sentinel')
  })

  it('redacts opaque and route-bound secrets from every sensitive URL path shape', () => {
    const hexSecret = 'a'.repeat(64)
    const cases = [
      [`https://auth.test/objects/${hexSecret}/metadata`, 'https://auth.test/objects/[REDACTED]/metadata'],
      ['https://auth.test/magic-link/magic-code/verify', 'https://auth.test/magic-link/[REDACTED]/verify'],
      ['https://auth.test/recovery/recovery-code/confirm', 'https://auth.test/recovery/[REDACTED]/confirm'],
      ['https://auth.test/share/share-code/open', 'https://auth.test/share/[REDACTED]/open'],
      ['https://auth.test/oauth/callback/oauth-state/complete', 'https://auth.test/oauth/callback/[REDACTED]/complete'],
      ['https://auth.test/items/collaboration-authorization', 'https://auth.test/items/collaboration-authorization'],
    ]

    for (const [url, expected] of cases) {
      expect(sanitizeUrlForSafeLog(url)).toBe(expected)
    }
    expect(JSON.stringify(cases.map(([url]) => sanitizeUrlForSafeLog(url)))).not.toContain(hexSecret)
  })

  it('sanitizes credential assignments and URLs embedded in free-form strings', () => {
    const result = redactLogValue(
      'authorization=access-token-sentinel endpoint=https://auth.test/sessions?token=query-token#fragment-token',
    ) as string

    expect(result).toContain('authorization=[REDACTED]')
    expect(result).toContain('https://auth.test/sessions [query-parameter-count=1]')
    expect(result).not.toContain('access-token-sentinel')
    expect(result).not.toContain('query-token')
    expect(result).not.toContain('fragment-token')
  })

  it('returns an allowlisted error summary without messages or axios bodies', () => {
    const error = {
      name: 'AxiosError',
      code: 'ECONNREFUSED',
      message: 'Bearer access-token-sentinel',
      response: {
        status: 503,
        data: { password: 'password-sentinel' },
      },
      config: { headers: { Cookie: 'cookie-sentinel' } },
    }

    expect(safeErrorLogMetadata(error)).toEqual({
      errorType: 'AxiosError',
      errorCode: 'ECONNREFUSED',
      status: 503,
    })
  })

  it('never invokes accessors and fails closed for hostile proxies', () => {
    let getterInvoked = false
    const value = Object.defineProperty({}, 'accessToken', {
      enumerable: true,
      get: () => {
        getterInvoked = true
        throw new Error('getter-token-sentinel')
      },
    })
    const hostileProxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('proxy-token-sentinel')
        },
        getOwnPropertyDescriptor: () => {
          throw new Error('proxy-token-sentinel')
        },
      },
    )

    expect(redactLogValue(value)).toEqual({ accessToken: '[REDACTED]' })
    expect(getterInvoked).toBe(false)
    expect(redactLogValue(hostileProxy)).toBe('[Uninspectable]')
    expect(safeErrorLogMetadata(hostileProxy)).toEqual({
      errorType: 'Error',
      errorCode: undefined,
      status: undefined,
    })
  })

  it('redacts session-linked identifiers unless a call site explicitly allowlists a user or request id', () => {
    expect(redactLogValue({ sessionUuid: 'session-uuid-sentinel', userId: 'user-123' })).toEqual({
      sessionUuid: '[REDACTED]',
      userId: 'user-123',
    })
  })

  it('redacts variadic Winston metadata after splat expansion', () => {
    const logged: string[] = []
    const logger = createLogger({
      format: format.combine(format.splat(), createSafeLogFormat(), format.json()),
      transports: [
        new transports.Stream({
          stream: new Writable({
            write: (chunk, _encoding, callback) => {
              logged.push(chunk.toString())
              callback()
            },
          }),
        }),
      ],
    })

    logger.info('created session', {
      session: { accessToken: 'access-token-sentinel' },
      userId: 'user-123',
    })

    const serialized = logged.join('')
    expect(logged).toHaveLength(1)
    expect(serialized).not.toContain('access-token-sentinel')
    expect(serialized).toContain('user-123')
  })

  it('preserves Winston level metadata when more than the collection limit is logged with a simple formatter', () => {
    const logged: string[] = []
    const logger = createLogger({
      format: format.combine(format.splat(), createSafeLogFormat(), format.simple()),
      transports: [
        new transports.Stream({
          stream: new Writable({
            write: (chunk, _encoding, callback) => {
              logged.push(chunk.toString())
              callback()
            },
          }),
        }),
      ],
    })
    const oversizedMetadata = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, index]))

    logger.warn('bounded event', {
      ...oversizedMetadata,
      refreshToken: 'refresh-token-sentinel',
    })

    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('warn: bounded event')
    expect(logged[0]).not.toContain('refresh-token-sentinel')
  })
})
