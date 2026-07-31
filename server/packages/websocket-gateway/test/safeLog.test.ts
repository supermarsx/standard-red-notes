import { describe, expect, it } from 'vitest'

import { redactLogValue, safeErrorLogMetadata, safeLogArguments } from '../src/safeLog.js'

describe('safe websocket logging', () => {
  it('recursively redacts credentials, content, PII, and session identifiers', () => {
    const value: Record<string, unknown> = {
      userId: 'user-1',
      connectionId: 'connection-1',
      authorization: 'Bearer access-token-sentinel',
      nested: {
        sessionUuid: 'session-uuid-sentinel',
        originatingSessionUuid: 'origin-session-sentinel',
        cookie: 'cookie-sentinel',
        password: 'password-sentinel',
        apiKey: 'api-key-sentinel',
        body: 'encrypted-content-sentinel',
        email: 'person@example.test',
      },
    }
    value.circular = value

    const result = redactLogValue(value)
    const serialized = JSON.stringify(result)

    expect(result).toMatchObject({
      userId: 'user-1',
      connectionId: 'connection-1',
      authorization: '[REDACTED]',
    })
    for (const sentinel of [
      'access-token-sentinel',
      'session-uuid-sentinel',
      'origin-session-sentinel',
      'cookie-sentinel',
      'password-sentinel',
      'api-key-sentinel',
      'encrypted-content-sentinel',
      'person@example.test',
    ]) {
      expect(serialized).not.toContain(sentinel)
    }
    expect(serialized).toContain('[Circular]')
  })

  it('scrubs credentials embedded in strings and URLs and bounds their length', () => {
    const result = String(
      redactLogValue(
        'Bearer bearer-sentinel email=person@example.test ' +
          'https://user:pass@example.test/tokens/path-token-sentinel/validate?token=query-sentinel#fragment-sentinel ' +
          'x'.repeat(300),
      ),
    )

    expect(result).toContain('Bearer [REDACTED]')
    expect(result).toContain('email=[REDACTED]')
    expect(result).toContain('https://example.test/tokens/[REDACTED]/validate [query-parameter-count=1]')
    expect(result).toContain('[Truncated]')
    expect(result).not.toContain('bearer-sentinel')
    expect(result).not.toContain('person@example.test')
    expect(result).not.toContain('path-token-sentinel')
    expect(result).not.toContain('query-sentinel')
    expect(result).not.toContain('fragment-sentinel')
  })

  it('redacts opaque and route-bound secrets from every sensitive URL path shape', () => {
    const hexSecret = 'a'.repeat(64)
    const cases = [
      [`https://push.test/objects/${hexSecret}/metadata`, 'https://push.test/objects/[REDACTED]/metadata'],
      ['https://push.test/magic-link/magic-code/verify', 'https://push.test/magic-link/[REDACTED]/verify'],
      ['https://push.test/recovery/recovery-code/confirm', 'https://push.test/recovery/[REDACTED]/confirm'],
      ['https://push.test/share/share-code/open', 'https://push.test/share/[REDACTED]/open'],
      ['https://push.test/oauth/callback/oauth-state/complete', 'https://push.test/oauth/callback/[REDACTED]/complete'],
      ['https://push.test/items/collaboration-authorization', 'https://push.test/items/collaboration-authorization'],
    ]

    for (const [url, expected] of cases) {
      expect(redactLogValue(url)).toBe(expected)
    }
    expect(JSON.stringify(cases.map(([url]) => redactLogValue(url)))).not.toContain(hexSecret)
  })

  it('emits only allowlisted error type and code metadata', () => {
    const failure = Object.assign(new TypeError('credential-sentinel'), { name: 'TypeError', code: 'ECONNRESET' })

    expect(safeErrorLogMetadata(failure)).toEqual({
      errorType: 'TypeError',
      errorCode: 'ECONNRESET',
    })
    expect(safeErrorLogMetadata({ name: 'CustomSecretError', code: 'SECRET_CODE' })).toEqual({
      errorType: 'Error',
      errorCode: undefined,
    })
    expect(safeErrorLogMetadata({ code: 503 })).toEqual({
      errorType: 'Error',
      errorCode: 503,
    })
  })

  it('never invokes accessors and fails closed for hostile proxies', () => {
    let getterInvoked = false
    const withAccessor = Object.defineProperty({}, 'accessToken', {
      enumerable: true,
      get: () => {
        getterInvoked = true
        throw new Error('getter-token-sentinel')
      },
    })
    const descriptorProxy = new Proxy(
      { safe: true },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('descriptor-token-sentinel')
        },
      },
    )
    const ownKeysProxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('proxy-token-sentinel')
        },
        getPrototypeOf: () => {
          throw new Error('prototype-token-sentinel')
        },
      },
    )

    expect(redactLogValue(withAccessor)).toEqual({ accessToken: '[REDACTED]' })
    expect(getterInvoked).toBe(false)
    expect(redactLogValue(descriptorProxy)).toEqual({ safe: '[Uninspectable]' })
    expect(redactLogValue(ownKeysProxy)).toBe('[Uninspectable]')
    expect(safeErrorLogMetadata(ownKeysProxy)).toEqual({
      errorType: 'Error',
      errorCode: undefined,
    })
  })

  it('bounds depth and collection size and handles non-JSON primitive types', () => {
    const oversized = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, index]))

    expect(redactLogValue({ a: { b: { c: { d: 'too-deep' } } } })).toEqual({
      a: { b: { c: { d: '[Truncated]' } } },
    })
    expect(redactLogValue(oversized)).toMatchObject({ field0: 0, field23: 23, truncated: true })
    expect(redactLogValue(42n)).toBe('42')
    expect(redactLogValue(Symbol('sentinel'))).toBe('[Symbol]')
    expect(redactLogValue(() => 'sentinel')).toBe('[Function]')
    expect(redactLogValue(null)).toBeNull()
    expect(redactLogValue(undefined)).toBeUndefined()
  })

  it('sanitizes every variadic argument and never emits an Error message', () => {
    const args = safeLogArguments([
      '[shutdown] failed',
      new Error('exception-credential-sentinel'),
      { sessionUuid: 'session-uuid-sentinel', userId: 'user-1' },
    ])
    const serialized = JSON.stringify(args)

    expect(args[0]).toBe('[shutdown] failed')
    expect(args[1]).toEqual({ errorType: 'Error', errorCode: undefined })
    expect(args[2]).toEqual({ sessionUuid: '[REDACTED]', userId: 'user-1' })
    expect(serialized).not.toContain('exception-credential-sentinel')
    expect(serialized).not.toContain('session-uuid-sentinel')
  })

  it('fails closed when a string contains an invalid URL', () => {
    expect(redactLogValue('endpoint=https://[invalid')).toBe('endpoint=[unparseable-url]')
  })
})
