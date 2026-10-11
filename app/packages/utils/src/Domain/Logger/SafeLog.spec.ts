import {
  authoredLogMessage,
  redactLogValue,
  safeErrorLogMetadata,
  safeHttpLogMetadata,
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

  it('recursively redacts credentials, PII, content, and circular values', () => {
    const value: Record<string, unknown> = {
      authorization: 'Bearer access-token-sentinel',
      nested: {
        refreshToken: 'refresh-token-sentinel',
        offlineToken: 'offline-token-sentinel',
        featuresToken: 'features-token-sentinel',
        subscriptionToken: 'subscription-token-sentinel',
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

  it('sanitizes URL userinfo, credential path segments, query strings, and fragments', () => {
    expect(
      sanitizeUrlForSafeLog(
        'https://user:pass@app.test/subscription-tokens/path-token-sentinel/validate?token=query-token#fragment-token',
      ),
    ).toBe('https://app.test/subscription-tokens/[REDACTED]/validate [query-parameter-count=1]')
  })

  it('redacts opaque and route-bound secrets from every sensitive URL path shape', () => {
    const hexSecret = 'a'.repeat(64)
    const cases = [
      [`https://app.test/objects/${hexSecret}/metadata`, 'https://app.test/objects/[REDACTED]/metadata'],
      ['https://app.test/magic-link/magic-code/verify', 'https://app.test/magic-link/[REDACTED]/verify'],
      ['https://app.test/recovery/recovery-code/confirm', 'https://app.test/recovery/[REDACTED]/confirm'],
      ['https://app.test/share/share-code/open', 'https://app.test/share/[REDACTED]/open'],
      ['https://app.test/oauth/callback/oauth-state/complete', 'https://app.test/oauth/callback/[REDACTED]/complete'],
      ['https://app.test/items/collaboration-authorization', 'https://app.test/items/collaboration-authorization'],
    ]

    for (const [url, expected] of cases) {
      expect(sanitizeUrlForSafeLog(url)).toBe(expected)
    }
    expect(JSON.stringify(cases.map(([url]) => sanitizeUrlForSafeLog(url)))).not.toContain(hexSecret)
  })

  it('sanitizes credentials and URLs embedded in free-form strings', () => {
    const result = redactLogValue(
      'authorization=access-token-sentinel endpoint=https://app.test/items?token=query-token#fragment-token',
    ) as string

    expect(result).toContain('authorization=[REDACTED]')
    expect(result).toContain('https://app.test/items [query-parameter-count=1]')
    expect(result).not.toContain('access-token-sentinel')
    expect(result).not.toContain('query-token')
    expect(result).not.toContain('fragment-token')
  })

  it('creates bounded allowlisted HTTP and error metadata', () => {
    const error = {
      name: 'TypeError',
      code: 'ERR_NETWORK',
      message: 'Bearer access-token-sentinel',
      config: { headers: { Cookie: 'cookie-sentinel' } },
    }

    expect(safeErrorLogMetadata(error)).toEqual({
      errorType: 'TypeError',
      errorCode: 'ERR_NETWORK',
      status: undefined,
    })
    expect(
      safeHttpLogMetadata(
        {
          url: 'https://app.test/items?access_token=query-token#fragment-token',
          verb: 'post',
        },
        { status: 503 },
      ),
    ).toEqual({
      method: 'POST',
      url: 'https://app.test/items [query-parameter-count=1]',
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

  /**
   * The fixture is a REAL `TypeError`, which is the whole point: `name` is an own
   * property only on an object literal (what the test above is written from) and on our
   * own classes. On every native error it lives on the prototype, so the own-property
   * read behind this field reported `Error` for a TypeError, a RangeError and a plain
   * Error alike — and no test could see it.
   */
  it('names a native error subclass instead of calling everything an Error', () => {
    expect(safeErrorLogMetadata(new TypeError('opaque-upstream-secret'))).toEqual(
      expect.objectContaining({ errorType: 'TypeError' }),
    )
    expect(safeErrorLogMetadata(new Error('opaque-upstream-secret'))).toEqual(
      expect.objectContaining({ errorType: 'Error' }),
    )
    // A `name` that is not a class-name shape is still refused, marked or not.
    expect(safeErrorLogMetadata(Object.assign(new Error('x'), { name: 'person@example.test' }))).toEqual(
      expect.objectContaining({ errorType: 'Error' }),
    )
  })

  it('carries an AUTHORED message and refuses every other message', () => {
    const upstream = Object.assign(new Error('Bearer access-token-sentinel'), { code: 'ERR_NETWORK' })

    expect(safeErrorLogMetadata(upstream).message).toBeUndefined()
    expect(JSON.stringify(safeErrorLogMetadata(upstream))).not.toContain('access-token-sentinel')

    const authored = authoredLogMessage(
      new Error('Durable sync recovery must complete before a new command can execute.'),
    )

    expect(safeErrorLogMetadata(authored).message).toBe(
      'Durable sync recovery must complete before a new command can execute.',
    )
  })

  /**
   * The marker says "this message is a literal", so a call site that marks an
   * interpolated one is a mistake — and must not be a credential channel.
   */
  it('sanitizes an authored message that a call site marked by mistake', () => {
    const mistaken = authoredLogMessage(new Error('rejected for person@example.test with Bearer access-token-sentinel'))
    const message = safeErrorLogMetadata(mistaken).message as string

    expect(message).toContain('[REDACTED_EMAIL]')
    expect(message).toContain(`Bearer [REDACTED]`)
    for (const sentinel of ['access-token-sentinel', 'person@example.test']) {
      expect(message).not.toContain(sentinel)
    }
  })

  /**
   * A stack is the one field that says WHERE an unmarked error was thrown, and it is
   * also the field that reads `at fn (file:///C:/Users/<the account holder>/…)` on
   * desktop and in Node. Every frame is therefore rebuilt from matched pieces: an
   * identifier, a basename and digits.
   */
  it('logs stack frames rebuilt from allowlisted pieces, never the raw frame', () => {
    const thrown = new Error('opaque-upstream-secret')
    thrown.stack = [
      'Error: opaque-upstream-secret',
      '    at recoverPending (file:///C:/Users/person-sentinel/app/bundle.js:12:34)',
      '    at https://notes.example.test/app.js:2:1932041',
      '    at Object.<anonymous> (/srv/person-sentinel/app.js:7:8)',
      '    at eval (eval at <anonymous> (app.js:1:1), <anonymous>:1:1)',
      '    at onlyFour (https://notes.example.test/app.js?build=secret-sentinel:5:5)',
      '    at fifthFrameIsOverTheCap (app.js:6:6)',
    ].join('\n')

    const stack = safeErrorLogMetadata(thrown).stack as string

    expect(stack.split('\n')).toEqual([
      'at recoverPending (bundle.js:12:34)',
      'at (app.js:2:1932041)',
      'at Object.<anonymous> (app.js:7:8)',
      // A basename carrying anything but basename characters — a query string here —
      // is refused outright rather than trimmed down to the part that looks safe.
      'at onlyFour ([resource]:5:5)',
    ])
    for (const sentinel of ['opaque-upstream-secret', 'person-sentinel', 'secret-sentinel', 'notes.example.test']) {
      expect(stack).not.toContain(sentinel)
    }
  })

  it('reports no stack for a non-error and for an engine whose accessor throws', () => {
    expect(safeErrorLogMetadata({ name: 'TypeError', stack: 'at anything (app.js:1:1)' }).stack).toBeUndefined()

    const hostile = new Error('opaque-upstream-secret')
    Object.defineProperty(hostile, 'stack', {
      get: () => {
        throw new Error('stack-getter-sentinel')
      },
    })

    expect(safeErrorLogMetadata(hostile).stack).toBeUndefined()
    expect(safeErrorLogMetadata(hostile).errorType).toBe('Error')
  })

  it('redacts session-linked identifiers unless a call site explicitly allowlists a user or request id', () => {
    expect(redactLogValue({ sessionUuid: 'session-uuid-sentinel', userId: 'user-123' })).toEqual({
      sessionUuid: '[REDACTED]',
      userId: 'user-123',
    })
  })

  it('bounds oversized untrusted strings', () => {
    const result = redactLogValue('x'.repeat(2_000)) as string

    expect(result.length).toBeLessThan(300)
    expect(result).toContain('[Truncated]')
  })

  it('fails closed for unsupported URLs, accessors, deep objects, and oversized collections', () => {
    const accessor = Object.defineProperty({}, 'safeField', {
      enumerable: true,
      get: () => 'accessor-sentinel',
    })
    const descriptorProxy = new Proxy(
      { safeField: true },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error('descriptor-sentinel')
        },
      },
    )
    const oversized = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, index]))

    expect(sanitizeUrlForSafeLog(undefined)).toBe('[unavailable-url]')
    expect(sanitizeUrlForSafeLog('file:///credential-sentinel')).toBe('[unparseable-url]')
    expect(redactLogValue(accessor)).toEqual({ safeField: '[Accessor]' })
    expect(redactLogValue(descriptorProxy)).toEqual({ safeField: '[Uninspectable]' })
    expect(redactLogValue({ a: { b: { c: { d: { value: 'deep-sentinel' } } } } })).toEqual({
      a: { b: { c: { d: '[Truncated]' } } },
    })
    expect(redactLogValue(oversized)).toMatchObject({ field0: 0, field23: 23, truncated: true })
    expect(redactLogValue(Symbol('symbol-sentinel'))).toBe('[Symbol]')
    expect(redactLogValue(() => 'function-sentinel')).toBe('[Function]')
  })
})
