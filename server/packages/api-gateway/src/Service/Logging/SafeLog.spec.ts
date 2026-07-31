import { createLogger, format, transports } from 'winston'
import { Writable } from 'stream'
import { safeErrorLogMetadata } from '@standardnotes/domain-core'

import {
  createSafeLogFormat,
  PublicInvalidAuthFailure,
  PublicServiceFailure,
  redactLogValue,
  safeHttpErrorLogMetadata,
  safePublicErrorData,
  sanitizeUrlForSafeLog,
} from './SafeLog'

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

  it('loads the shared error classifier through the published domain-core entry point', () => {
    expect(typeof safeErrorLogMetadata).toBe('function')
    expect(safeErrorLogMetadata(Object.assign(new TypeError('secret-sentinel'), { code: 'ECONNRESET' }))).toEqual({
      errorType: 'TypeError',
      errorCode: 'ECONNRESET',
      status: undefined,
    })
  })

  it('recursively redacts credential, session, PII, and body fields without following circular references', () => {
    const value: Record<string, unknown> = {
      authorization: 'Bearer access-token-sentinel',
      nested: {
        refreshToken: 'refresh-token-sentinel',
        offlineToken: 'offline-token-sentinel',
        featuresToken: 'features-token-sentinel',
        subscriptionToken: 'subscription-token-sentinel',
        cookie: 'cookie-sentinel',
        password: 'password-sentinel',
        codeChallenge: 'pkce-sentinel',
        apiKey: 'api-key-sentinel',
        body: 'encrypted-content-sentinel',
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

  it('summarizes circular axios failures without request config, bodies, headers, or messages', () => {
    const error: Record<string, unknown> = {
      name: 'AxiosError',
      code: 'ECONNREFUSED',
      message: 'Bearer access-token-sentinel',
      response: {
        status: 503,
        data: { password: 'password-sentinel' },
      },
      config: { headers: { Cookie: 'cookie-sentinel' } },
    }
    error.circular = error

    const summary = safeHttpErrorLogMetadata(error, {
      endpoint: 'https://auth.test/sessions/validate?access_token=query-token#fragment-token',
      method: 'post',
      userId: 'user-123',
      action: 'session.validate',
    })
    const serialized = JSON.stringify(summary)

    expect(summary).toEqual({
      action: 'session.validate',
      endpoint: 'https://auth.test/sessions/validate [query-parameter-count=1]',
      method: 'POST',
      userId: 'user-123',
      errorType: 'AxiosError',
      errorCode: 'ECONNREFUSED',
      status: 503,
    })
    expect(serialized).not.toContain('access-token-sentinel')
    expect(serialized).not.toContain('password-sentinel')
    expect(serialized).not.toContain('query-token')
    expect(serialized).not.toContain('fragment-token')
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
    expect(
      safeHttpErrorLogMetadata(hostileProxy, {
        endpoint: '/sessions/validate',
      }),
    ).toEqual({
      action: undefined,
      endpoint: '/sessions/validate',
      method: undefined,
      userId: undefined,
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

  it('uses explicit legacy tag contracts with fixed local messages', () => {
    const contracts = [
      ['invalid-auth', 'Invalid login credentials.'],
      ['expired-access-token', 'The provided access token has expired.'],
      ['revoked-session', 'Your session has been revoked.'],
      ['invalid-request', 'Invalid request parameters.'],
      ['no-subscription', undefined],
      ['read-only-access', 'Session has read-only access.'],
      ['unsupported-account-version', 'Account version not supported.'],
      ['service-unavailable', 'The requested service is temporarily unavailable.'],
    ] as const

    for (const [tag, message] of contracts) {
      expect(
        safePublicErrorData({
          error: {
            tag,
            message: 'innocent looking multiword opaque secret value',
            payload: { accessToken: 'access-token-sentinel' },
          },
        }),
      ).toEqual({
        error: {
          tag,
          ...(message === undefined ? {} : { message }),
        },
      })
    }
  })

  it('rejects secret-shaped tags and never reflects plausible multiword upstream secrets', () => {
    const secretTag = 'a3'.repeat(32)
    const upstreamSecret = 'innocent looking multiword opaque secret value'

    expect(safePublicErrorData({ error: { tag: secretTag, message: upstreamSecret } })).toEqual(PublicServiceFailure)
    expect(safePublicErrorData({ error: { tag: 'invalid-auth', message: upstreamSecret } })).toEqual(
      PublicInvalidAuthFailure,
    )

    const serialized = JSON.stringify([
      safePublicErrorData({ error: { tag: secretTag, message: upstreamSecret } }),
      safePublicErrorData({ error: { tag: 'invalid-auth', message: upstreamSecret } }),
    ])
    expect(serialized).not.toContain(secretTag)
    expect(serialized).not.toContain(upstreamSecret)
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

    logger.info('upstream failure', {
      response: { data: { accessToken: 'access-token-sentinel' } },
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
