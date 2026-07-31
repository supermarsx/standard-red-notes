import { EventEmitter } from 'events'
import { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'http'
import { Readable } from 'stream'
import { brotliCompressSync, deflateSync, gzipSync } from 'zlib'

import { SsrfValidationError } from './SsrfFilter'
import { PinnedHttpTransport, PinnedRequestFactory } from './PinnedHttpTransport'

interface ScriptedResponse {
  status?: number
  headers?: IncomingHttpHeaders
  body?: Buffer | string
  neverRespond?: boolean
  neverEndBody?: boolean
  endThrows?: Error
  errorAfterResponse?: Error
  responseErrorAfterHeaders?: Error
  abortResponseAfterHeaders?: boolean
}

interface FakeClientRequest extends EventEmitter {
  destroyed: boolean
  write: jest.Mock
  end: jest.Mock
  destroy: jest.Mock
}

function scriptedRequests(steps: ScriptedResponse[]) {
  const calls: Array<{ protocol: string; options: Parameters<PinnedRequestFactory>[1] }> = []
  const requests: FakeClientRequest[] = []
  const responses: IncomingMessage[] = []
  let index = 0
  const factory: PinnedRequestFactory = (protocol, options, onResponse) => {
    const step = steps[Math.min(index++, steps.length - 1)]
    const request = new EventEmitter() as FakeClientRequest
    request.destroyed = false
    request.write = jest.fn()
    request.destroy = jest.fn((error?: Error) => {
      request.destroyed = true
      if (error) {
        queueMicrotask(() => request.emit('error', error))
      }
      return request
    })
    request.end = jest.fn(() => {
      if (step.endThrows) {
        throw step.endThrows
      }
      if (step.neverRespond) {
        return
      }
      queueMicrotask(() => {
        const chunks = step.body === undefined ? [] : [Buffer.from(step.body)]
        let chunkIndex = 0
        const readable = step.neverEndBody
          ? new Readable({
              read() {
                if (chunkIndex < chunks.length) {
                  this.push(chunks[chunkIndex++])
                }
              },
            })
          : Readable.from(chunks)
        const response = readable as unknown as IncomingMessage
        response.statusCode = step.status ?? 200
        response.headers = step.headers ?? {}
        responses.push(response)
        onResponse(response)
        if (step.errorAfterResponse) {
          queueMicrotask(() => request.emit('error', step.errorAfterResponse))
        }
        if (step.responseErrorAfterHeaders) {
          queueMicrotask(() => response.emit('error', step.responseErrorAfterHeaders))
        }
        if (step.abortResponseAfterHeaders) {
          queueMicrotask(() => response.emit('aborted'))
        }
      })
    })
    calls.push({ protocol, options })
    requests.push(request)
    return request as unknown as ClientRequest
  }

  return { factory, calls, requests, responses }
}

const headersOf = (call: { options: Parameters<PinnedRequestFactory>[1] }): Record<string, string> =>
  call.options.headers as Record<string, string>

describe('PinnedHttpTransport', () => {
  it('uses the validated address as the socket destination while preserving Host and TLS identity', async () => {
    const resolveHost = jest.fn().mockResolvedValue(['93.184.216.34'])
    const { factory, calls } = scriptedRequests([{ body: 'ok' }])
    const transport = new PinnedHttpTransport(resolveHost, factory)

    const response = await transport.request({ url: 'https://service.example:8443/path?q=1' })
    await response.discard()

    expect(resolveHost).toHaveBeenCalledTimes(1)
    expect(calls[0].protocol).toBe('https:')
    expect(calls[0].options).toMatchObject({
      hostname: '93.184.216.34',
      family: 4,
      port: '8443',
      path: '/path?q=1',
      servername: 'service.example',
      rejectUnauthorized: true,
      agent: false,
    })
    expect(headersOf(calls[0]).Host).toBe('service.example:8443')
  })

  it('overrides a caller-supplied Host header with the validated original authority', async () => {
    const { factory, calls } = scriptedRequests([{ body: 'ok' }])
    const response = await new PinnedHttpTransport(async () => ['93.184.216.34'], factory).request({
      url: new URL('http://safe.example/path'),
      headers: { host: 'attacker.invalid', 'X-Safe': 'kept' },
    })
    await response.discard()

    expect(headersOf(calls[0])).toMatchObject({ Host: 'safe.example', 'X-Safe': 'kept' })
    expect(headersOf(calls[0]).host).toBeUndefined()
  })

  it('pins an exact operator-allowed private origin without trusting any other origin', async () => {
    const resolveHost = jest.fn().mockResolvedValue(['10.20.30.40'])
    const { factory, calls } = scriptedRequests([{ body: 'ok' }])
    const transport = new PinnedHttpTransport(resolveHost, factory, {
      allowedPrivateOrigins: ['http://searxng.internal:8080/search'],
    })

    const response = await transport.request({ url: 'http://searxng.internal:8080/search?q=notes' })
    await response.discard()

    expect(calls).toHaveLength(1)
    expect(calls[0].options).toMatchObject({
      hostname: '10.20.30.40',
      family: 4,
      port: '8080',
      path: '/search?q=notes',
    })
    expect(headersOf(calls[0]).Host).toBe('searxng.internal:8080')

    await expect(transport.request({ url: 'http://other.internal:8080/search' })).rejects.toBeInstanceOf(
      SsrfValidationError,
    )
    expect(calls).toHaveLength(1)
  })

  it('does not extend an operator origin allowance across redirects', async () => {
    const resolveHost = jest.fn().mockResolvedValue(['10.20.30.40'])
    const { factory, calls } = scriptedRequests([
      { status: 302, headers: { location: 'http://other.internal/search' } },
    ])
    const transport = new PinnedHttpTransport(resolveHost, factory, {
      allowedPrivateOrigins: ['http://searxng.internal/search'],
    })

    await expect(
      transport.request({ url: 'http://searxng.internal/search', redirect: 'follow', maxRedirects: 1 }),
    ).rejects.toBeInstanceOf(SsrfValidationError)
    expect(calls).toHaveLength(1)
  })

  it('ignores malformed and non-HTTP origin allowances', async () => {
    const { factory, calls } = scriptedRequests([{ body: 'should not be reached' }])
    const transport = new PinnedHttpTransport(async () => ['127.0.0.1'], factory, {
      allowedPrivateOrigins: ['not a URL', 'file:///tmp/search'],
    })

    await expect(transport.request({ url: 'http://search.internal/' })).rejects.toBeInstanceOf(SsrfValidationError)
    expect(calls).toHaveLength(0)
  })

  it('cannot be redirected by a deterministic public-to-private DNS flip after validation', async () => {
    const resolveHost = jest.fn().mockResolvedValueOnce(['93.184.216.34']).mockResolvedValueOnce(['127.0.0.1'])
    const { factory, calls } = scriptedRequests([{ body: 'ok' }])

    const response = await new PinnedHttpTransport(resolveHost, factory).request({ url: 'https://flip.example/' })
    await response.discard()

    expect(resolveHost).toHaveBeenCalledTimes(1)
    expect(calls[0].options.hostname).toBe('93.184.216.34')
  })

  it('fails closed when any DNS answer is blocked and never opens a socket', async () => {
    const resolveHost = jest.fn().mockResolvedValue(['93.184.216.34', '10.0.0.8'])
    const { factory, calls } = scriptedRequests([{ body: 'unreachable' }])

    await expect(
      new PinnedHttpTransport(resolveHost, factory).request({ url: 'https://mixed.example/' }),
    ).rejects.toBeInstanceOf(SsrfValidationError)
    expect(calls).toHaveLength(0)
  })

  it('accepts multiple public answers and deterministically pins the first one', async () => {
    const resolveHost = jest.fn().mockResolvedValue(['1.1.1.1', '93.184.216.34'])
    const { factory, calls } = scriptedRequests([{ body: 'ok' }])

    const response = await new PinnedHttpTransport(resolveHost, factory).request({ url: 'http://multi.example/' })
    await response.discard()

    expect(calls[0].options).toMatchObject({ hostname: '1.1.1.1', family: 4 })
    expect(headersOf(calls[0]).Host).toBe('multi.example')
  })

  it('pins IPv6 destinations without weakening DNS-name SNI verification', async () => {
    const resolveHost = jest.fn().mockResolvedValue(['2606:4700:4700::1111'])
    const { factory, calls } = scriptedRequests([{ body: 'ok' }])

    const response = await new PinnedHttpTransport(resolveHost, factory).request({ url: 'https://ipv6.example/' })
    await response.discard()

    expect(calls[0].options).toMatchObject({
      hostname: '2606:4700:4700::1111',
      family: 6,
      servername: 'ipv6.example',
      rejectUnauthorized: true,
    })
    expect(headersOf(calls[0]).Host).toBe('ipv6.example')
  })

  it('verifies a literal IPv6 origin as an IP and does not send an IP-valued SNI name', async () => {
    const resolveHost = jest.fn()
    const { factory, calls } = scriptedRequests([{ body: 'ok' }])

    const response = await new PinnedHttpTransport(resolveHost, factory).request({
      url: 'https://[2606:4700:4700::1111]:9443/',
    })
    await response.discard()

    expect(resolveHost).not.toHaveBeenCalled()
    expect(calls[0].options.hostname).toBe('2606:4700:4700::1111')
    expect(calls[0].options.servername).toBeUndefined()
    expect(calls[0].options.rejectUnauthorized).toBe(true)
    expect(headersOf(calls[0]).Host).toBe('[2606:4700:4700::1111]:9443')
  })

  it('re-resolves and re-pins every followed redirect hop', async () => {
    const resolveHost = jest.fn(async (host: string) => (host === 'first.example' ? ['93.184.216.34'] : ['1.1.1.1']))
    const { factory, calls } = scriptedRequests([
      { status: 302, headers: { location: 'https://second.example/final' } },
      { status: 200, body: 'done' },
    ])
    const response = await new PinnedHttpTransport(resolveHost, factory).request({
      url: 'https://first.example/start',
      redirect: 'follow',
      maxRedirects: 2,
    })

    await expect(response.text()).resolves.toBe('done')
    expect(resolveHost).toHaveBeenCalledTimes(2)
    expect(calls.map((call) => call.options.hostname)).toEqual(['93.184.216.34', '1.1.1.1'])
    expect(headersOf(calls[0]).Host).toBe('first.example')
    expect(headersOf(calls[1]).Host).toBe('second.example')
    expect(calls[1].options.servername).toBe('second.example')
  })

  it('rejects redirects when redirect mode is error', async () => {
    const { factory } = scriptedRequests([{ status: 302, headers: { location: '/other' } }])
    const transport = new PinnedHttpTransport(async () => ['93.184.216.34'], factory)

    await expect(transport.request({ url: 'https://example.com/start', redirect: 'error' })).rejects.toMatchObject({
      tag: 'redirect-not-allowed',
    })
  })

  it('enforces the redirect limit and rejects a malformed redirect target', async () => {
    const tooMany = scriptedRequests([{ status: 302, headers: { location: '/again' } }])
    await expect(
      new PinnedHttpTransport(async () => ['93.184.216.34'], tooMany.factory).request({
        url: 'https://example.com/start',
        redirect: 'follow',
        maxRedirects: 0,
      }),
    ).rejects.toMatchObject({ tag: 'too-many-redirects' })

    const malformed = scriptedRequests([{ status: 302, headers: { location: 'http://[::bad' } }])
    await expect(
      new PinnedHttpTransport(async () => ['93.184.216.34'], malformed.factory).request({
        url: 'https://example.com/start',
        redirect: 'follow',
        maxRedirects: 1,
      }),
    ).rejects.toMatchObject({ tag: 'invalid-redirect' })
  })

  it('rewrites a POST on 302 to GET and removes entity headers and body', async () => {
    const { factory, calls, requests } = scriptedRequests([
      { status: 302, headers: { location: '/after' } },
      { status: 200, body: 'done' },
    ])
    const response = await new PinnedHttpTransport(async () => ['93.184.216.34'], factory).request({
      url: 'https://example.com/start',
      method: 'POST',
      body: 'payload',
      redirect: 'follow',
      maxRedirects: 1,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '7',
        'Content-Encoding': 'identity',
        'X-Safe': 'keep',
      },
    })
    await response.discard()

    expect(calls.map((call) => call.options.method)).toEqual(['POST', 'GET'])
    expect(requests[0].write).toHaveBeenCalledWith('payload')
    expect(requests[1].write).not.toHaveBeenCalled()
    expect(headersOf(calls[1])).toMatchObject({ Host: 'example.com', 'X-Safe': 'keep' })
    expect(headersOf(calls[1])['Content-Type']).toBeUndefined()
    expect(headersOf(calls[1])['Content-Length']).toBeUndefined()
    expect(headersOf(calls[1])['Content-Encoding']).toBeUndefined()
  })

  it('strips authorization, cookies, tokens, API keys, and signatures on a changed-origin redirect', async () => {
    const resolveHost = jest.fn(async (host: string) => (host === 'first.example' ? ['93.184.216.34'] : ['1.1.1.1']))
    const { factory, calls } = scriptedRequests([
      { status: 307, headers: { location: 'https://other.example/final' } },
      { status: 200, body: 'done' },
    ])

    const response = await new PinnedHttpTransport(resolveHost, factory).request({
      url: 'https://first.example/start',
      method: 'POST',
      body: 'payload',
      redirect: 'follow',
      maxRedirects: 1,
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'session=secret',
        'X-SRN-Signature': 'signature',
        'X-Api-Key': 'key',
        'X-Auth-Token': 'token',
        'X-Safe': 'keep',
      },
    })
    await response.discard()

    const redirectedHeaders = headersOf(calls[1])
    expect(JSON.stringify(redirectedHeaders)).not.toContain('secret')
    expect(redirectedHeaders['X-SRN-Signature']).toBeUndefined()
    expect(redirectedHeaders['X-Api-Key']).toBeUndefined()
    expect(redirectedHeaders['X-Auth-Token']).toBeUndefined()
    expect(redirectedHeaders['X-Safe']).toBe('keep')
  })

  it('enforces an absolute request timeout and destroys the in-flight socket', async () => {
    jest.useFakeTimers()
    try {
      const { factory, requests } = scriptedRequests([{ neverRespond: true }])
      const transport = new PinnedHttpTransport(async () => ['93.184.216.34'], factory)
      const pending = transport.request({ url: 'https://slow.example/', timeoutMs: 50 })
      const rejection = expect(pending).rejects.toMatchObject({ tag: 'request-timeout' })

      await jest.advanceTimersByTimeAsync(50)

      await rejection
      expect(requests[0].destroy).toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it('rejects malformed initial URLs before DNS or socket use', async () => {
    const resolveHost = jest.fn()
    const { factory, calls } = scriptedRequests([{ body: 'unreachable' }])

    await expect(new PinnedHttpTransport(resolveHost, factory).request({ url: 'not a URL' })).rejects.toMatchObject({
      tag: 'invalid-url',
    })
    expect(resolveHost).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('rejects a synchronously failing request factory and request end', async () => {
    const factoryError = new Error('factory failed')
    const throwingFactory: PinnedRequestFactory = () => {
      throw factoryError
    }
    await expect(
      new PinnedHttpTransport(async () => ['93.184.216.34'], throwingFactory).request({
        url: 'https://example.com/',
      }),
    ).rejects.toBe(factoryError)

    const endError = new Error('end failed')
    const scripted = scriptedRequests([{ endThrows: endError }])
    await expect(
      new PinnedHttpTransport(async () => ['93.184.216.34'], scripted.factory).request({
        url: 'https://example.com/',
      }),
    ).rejects.toBe(endError)
    expect(scripted.requests[0].destroy).toHaveBeenCalled()
  })

  it('propagates a socket failure that arrives after response headers', async () => {
    const socketError = new Error('socket failed')
    const { factory } = scriptedRequests([{ neverEndBody: true, errorAfterResponse: socketError }])
    const response = await new PinnedHttpTransport(async () => ['93.184.216.34'], factory).request({
      url: 'https://example.com/',
    })

    await expect(response.text()).rejects.toBe(socketError)
  })

  it('propagates AbortSignal cancellation and destroys the in-flight socket', async () => {
    const { factory, requests } = scriptedRequests([{ neverRespond: true }])
    const transport = new PinnedHttpTransport(async () => ['93.184.216.34'], factory)
    const controller = new AbortController()
    const pending = transport.request({ url: 'https://slow.example/', signal: controller.signal })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    for (let turn = 0; turn < 5 && requests.length === 0; turn++) {
      await Promise.resolve()
    }
    expect(requests).toHaveLength(1)
    controller.abort()

    await rejection
    expect(requests[0].destroy).toHaveBeenCalled()
  })

  it('rejects immediately when the external signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { factory, calls } = scriptedRequests([{ body: 'unreachable' }])

    await expect(
      new PinnedHttpTransport(() => Promise.reject(new Error('ignored resolver failure')), factory).request({
        url: 'https://example.com/',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    expect(calls).toHaveLength(0)
  })

  it('applies the same absolute timeout while DNS resolution is still pending', async () => {
    jest.useFakeTimers()
    try {
      const { factory, calls } = scriptedRequests([{ body: 'unreachable' }])
      const transport = new PinnedHttpTransport(() => new Promise<string[]>(() => undefined), factory)
      const pending = transport.request({ url: 'https://slow-dns.example/', timeoutMs: 50 })
      const rejection = expect(pending).rejects.toMatchObject({ tag: 'request-timeout' })

      await jest.advanceTimersByTimeAsync(50)

      await rejection
      expect(calls).toHaveLength(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it('safely ignores a late DNS success after the absolute deadline has fired', async () => {
    jest.useFakeTimers()
    try {
      let resolveDns: ((addresses: string[]) => void) | undefined
      const dns = new Promise<string[]>((resolve) => {
        resolveDns = resolve
      })
      const pending = new PinnedHttpTransport(() => dns, scriptedRequests([{ body: 'unused' }]).factory).request({
        url: 'https://late.example/',
        timeoutMs: 50,
      })
      const rejection = expect(pending).rejects.toMatchObject({ tag: 'request-timeout' })
      await jest.advanceTimersByTimeAsync(50)
      await rejection

      resolveDns?.(['93.184.216.34'])
      await Promise.resolve()
    } finally {
      jest.useRealTimers()
    }
  })

  it('safely ignores a late DNS failure after the absolute deadline has fired', async () => {
    jest.useFakeTimers()
    try {
      let rejectDns: ((error: Error) => void) | undefined
      const dns = new Promise<string[]>((_resolve, reject) => {
        rejectDns = reject
      })
      const pending = new PinnedHttpTransport(() => dns, scriptedRequests([{ body: 'unused' }]).factory).request({
        url: 'https://late.example/',
        timeoutMs: 50,
      })
      const rejection = expect(pending).rejects.toMatchObject({ tag: 'request-timeout' })
      await jest.advanceTimersByTimeAsync(50)
      await rejection

      rejectDns?.(new Error('late DNS failure'))
      await Promise.resolve()
    } finally {
      jest.useRealTimers()
    }
  })

  it('keeps the absolute timeout active through response-body consumption', async () => {
    const { factory, requests } = scriptedRequests([{ neverEndBody: true }])
    const transport = new PinnedHttpTransport(async () => ['93.184.216.34'], factory)
    const response = await transport.request({ url: 'https://slow-body.example/', timeoutMs: 20 })

    await expect(response.text()).rejects.toMatchObject({ tag: 'request-timeout' })
    expect(requests[0].destroy).toHaveBeenCalled()
  })

  it('decodes compressed fetch responses before exposing streamed bytes', async () => {
    const compressed = gzipSync(Buffer.from('decoded response'))
    const { factory } = scriptedRequests([
      {
        body: compressed,
        headers: { 'content-encoding': 'gzip', 'content-length': String(compressed.byteLength) },
      },
    ])
    const transport = new PinnedHttpTransport(async () => ['93.184.216.34'], factory)

    const response = await transport.fetch('https://compressed.example/', {
      method: 'GET',
      headers: {},
    })

    await expect(response.text()).resolves.toBe('decoded response')
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-length')).toBeNull()
  })

  it('cancels both the decoded stream and its underlying response and supports late cleanup hooks', async () => {
    const compressed = gzipSync(Buffer.from('decoded response'))
    const { factory, responses } = scriptedRequests([{ body: compressed, headers: { 'content-encoding': 'gzip' } }])
    const response = await new PinnedHttpTransport(async () => ['93.184.216.34'], factory).fetch(
      'https://compressed.example/',
      { method: 'GET', headers: {} },
    )

    response.cancel()
    const lateCleanup = jest.fn()
    ;(response as unknown as { onFinished(callback: () => void): void }).onFinished(lateCleanup)

    expect(responses[0].destroyed).toBe(true)
    expect(lateCleanup).toHaveBeenCalledTimes(1)
  })

  it('propagates encoded-source errors and premature aborts through the decoder', async () => {
    const sourceError = new Error('encoded source failed')
    const errored = scriptedRequests([
      {
        neverEndBody: true,
        headers: { 'content-encoding': 'gzip' },
        responseErrorAfterHeaders: sourceError,
      },
    ])
    const errorResponse = await new PinnedHttpTransport(async () => ['93.184.216.34'], errored.factory).fetch(
      'https://compressed.example/',
      { method: 'GET', headers: {} },
    )
    await expect(errorResponse.text()).rejects.toBe(sourceError)

    const aborted = scriptedRequests([
      { neverEndBody: true, headers: { 'content-encoding': 'gzip' }, abortResponseAfterHeaders: true },
    ])
    const abortedResponse = await new PinnedHttpTransport(async () => ['93.184.216.34'], aborted.factory).fetch(
      'https://compressed.example/',
      { method: 'GET', headers: {} },
    )
    await expect(abortedResponse.text()).rejects.toThrow('encoded response ended unexpectedly')
  })

  it('destroys the encoded response when corrupt compressed bytes make the decoder fail', async () => {
    const corrupt = scriptedRequests([
      {
        body: Buffer.from('not a gzip stream'),
        neverEndBody: true,
        headers: { 'content-encoding': 'gzip' },
      },
    ])
    const response = await new PinnedHttpTransport(async () => ['93.184.216.34'], corrupt.factory).fetch(
      'https://compressed.example/',
      { method: 'GET', headers: {} },
    )

    await expect(response.text()).rejects.toThrow()
    expect(corrupt.responses[0].destroyed).toBe(true)
  })

  it.each([
    ['deflate', (value: Buffer) => deflateSync(value)],
    ['br', (value: Buffer) => brotliCompressSync(value)],
  ])('decodes %s fetch responses', async (encoding, compress) => {
    const compressed = compress(Buffer.from('decoded response'))
    const { factory } = scriptedRequests([{ body: compressed, headers: { 'content-encoding': encoding } }])
    const response = await new PinnedHttpTransport(async () => ['93.184.216.34'], factory).fetch(
      'https://compressed.example/',
      { method: 'GET', headers: { 'Accept-Encoding': 'identity' } },
    )

    await expect(response.text()).resolves.toBe('decoded response')
  })

  it('passes through unknown encodings and exposes a stable WHATWG response body', async () => {
    const { factory } = scriptedRequests([{ body: 'plain', headers: { 'content-encoding': 'custom' } }])
    const response = await new PinnedHttpTransport(async () => ['93.184.216.34'], factory).fetch(
      'https://encoded.example/',
      { method: 'GET', headers: {} },
    )
    const body = response.body
    expect(response.body).toBe(body)
    const reader = body.getReader()

    await expect(reader.read()).resolves.toMatchObject({ done: false, value: Buffer.from('plain') })
    await expect(reader.read()).resolves.toMatchObject({ done: true })
    reader.releaseLock?.()
  })

  it('joins repeated response headers and reports missing headers as null', async () => {
    const { factory } = scriptedRequests([{ headers: { 'x-values': ['one', 'two'], 'x-undefined': undefined } }])
    const response = await new PinnedHttpTransport(async () => ['93.184.216.34'], factory).request({
      url: 'https://example.com/',
    })

    expect(response.headers.get('x-values')).toBe('one, two')
    expect(response.headers.get('x-undefined')).toBeNull()
    expect(response.headers.get('missing')).toBeNull()
    await response.discard()
  })
})
