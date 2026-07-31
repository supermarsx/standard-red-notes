import { htmlToText, WebFetchLike, WebService, WebServiceConfig, WebValidationError } from './WebService'

type Recorded = { url: string; init: Parameters<WebFetchLike>[1] }

/** A fetchFn that always answers with `body` and records every call it received. */
const recordingFetch = (
  body: string,
  options: { status?: number; contentType?: string } = {},
): { fn: WebFetchLike; calls: Recorded[] } => {
  const calls: Recorded[] = []
  const status = options.status ?? 200

  const fn: WebFetchLike = async (url, init) => {
    calls.push({ url, init })
    const bytes = Buffer.from(body)
    let consumed = false

    return {
      status,
      ok: status >= 200 && status < 300,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? (options.contentType ?? null) : null),
      },
      body: {
        getReader: () => ({
          read: async () => {
            if (consumed) {
              return { done: true, value: undefined }
            }
            consumed = true
            return { done: false, value: bytes }
          },
          cancel: () => {
            consumed = true
          },
        }),
        cancel: () => {
          consumed = true
        },
      },
      text: async () => body,
    }
  }

  return { fn, calls }
}

const makeService = (config: WebServiceConfig, fn: WebFetchLike, searchFn: WebFetchLike = fn) =>
  new WebService(fn, config, async () => ['93.184.216.34'], searchFn)

const streamingFetch = (
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
  cancelResult: Promise<void> = Promise.resolve(),
) => {
  let index = 0
  const read = jest.fn(async () => {
    return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true, value: undefined }
  })
  const cancel = jest.fn(() => cancelResult)
  const releaseLock = jest.fn()
  const fn: WebFetchLike = async () =>
    ({
      status: 200,
      ok: true,
      headers: {
        get: (name: string) => headers[name.toLowerCase()] ?? null,
      },
      body: {
        getReader: () => ({ read, cancel, releaseLock }),
      },
      text: async () => {
        throw new Error('The streaming response must not use text().')
      },
    }) as Awaited<ReturnType<WebFetchLike>>

  return { fn, read, cancel, releaseLock }
}

describe('WebService.search', () => {
  it('uses a separate exact-origin operator path for a private configured SearXNG backend', async () => {
    const publicFetch = recordingFetch('{}')
    const privateSearch = recordingFetch(
      JSON.stringify({ results: [{ title: 'Private', url: 'https://result.test', content: 'Found' }] }),
    )
    const service = makeService(
      { searchProvider: 'searxng', searchApiUrl: 'http://searxng.internal:8080/search' },
      publicFetch.fn,
      privateSearch.fn,
    )

    await expect(service.search('notes')).resolves.toEqual({
      results: [{ title: 'Private', url: 'https://result.test', snippet: 'Found' }],
    })
    expect(privateSearch.calls[0]).toMatchObject({
      url: 'http://searxng.internal:8080/search?q=notes&format=json',
      init: { redirect: 'error' },
    })
    expect(publicFetch.calls).toHaveLength(0)

    await expect(service.fetch('http://searxng.internal:8080/search')).rejects.toMatchObject({
      tag: 'blocked-host',
    })
    expect(publicFetch.calls).toHaveLength(0)
  })

  it('reports an empty query rather than calling the upstream', async () => {
    const { fn, calls } = recordingFetch('{}')
    const service = makeService({ searchProvider: 'searxng', searchApiUrl: 'https://s.test/search' }, fn)

    await expect(service.search('   ')).resolves.toEqual({ results: [], error: 'empty query' })
    expect(calls).toHaveLength(0)
  })

  it('reports a non-string query as empty', async () => {
    const { fn } = recordingFetch('{}')
    const service = makeService({ searchProvider: 'searxng', searchApiUrl: 'https://s.test/search' }, fn)

    await expect(service.search(undefined as never)).resolves.toEqual({ results: [], error: 'empty query' })
  })

  it('reports "not configured" when no provider or no API URL is set', async () => {
    const { fn, calls } = recordingFetch('{}')

    await expect(makeService({}, fn).search('cats')).resolves.toEqual({
      results: [],
      error: 'web search not configured',
    })
    await expect(makeService({ searchProvider: 'searxng' }, fn).search('cats')).resolves.toEqual({
      results: [],
      error: 'web search not configured',
    })
    await expect(makeService({ searchApiUrl: 'https://s.test' }, fn).search('cats')).resolves.toEqual({
      results: [],
      error: 'web search not configured',
    })
    expect(calls).toHaveLength(0)
  })

  it('names an unsupported provider in the error instead of throwing', async () => {
    const { fn, calls } = recordingFetch('{}')
    const service = makeService({ searchProvider: 'AltaVista', searchApiUrl: 'https://s.test' }, fn)

    await expect(service.search('cats')).resolves.toEqual({
      results: [],
      error: "unsupported search provider 'altavista'",
    })
    expect(calls).toHaveLength(0)
  })

  describe('searxng', () => {
    const config = { searchProvider: 'searxng', searchApiUrl: 'https://s.test/search' }

    it('requests JSON with the query appended and maps the results', async () => {
      const { fn, calls } = recordingFetch(
        JSON.stringify({ results: [{ title: 'T', url: 'https://a.test', content: 'C' }] }),
      )

      const result = await makeService(config, fn).search('cats')

      expect(calls[0].url).toBe('https://s.test/search?q=cats&format=json')
      expect(calls[0].init.method).toBe('GET')
      expect(result).toEqual({ results: [{ title: 'T', url: 'https://a.test', snippet: 'C' }] })
    })

    it('falls back to `snippet` when the result has no `content`', async () => {
      const { fn } = recordingFetch(JSON.stringify({ results: [{ url: 'https://a.test', snippet: 'S' }] }))

      const result = await makeService(config, fn).search('cats')

      expect(result.results[0]).toEqual({ title: '', url: 'https://a.test', snippet: 'S' })
    })

    it('sends the API key as a bearer token only when one is configured', async () => {
      const withKey = recordingFetch('{}')
      await makeService({ ...config, searchApiKey: 'k' }, withKey.fn).search('cats')
      expect(withKey.calls[0].init.headers['Authorization']).toBe('Bearer k')

      const withoutKey = recordingFetch('{}')
      await makeService(config, withoutKey.fn).search('cats')
      expect(withoutKey.calls[0].init.headers['Authorization']).toBeUndefined()
    })

    it('drops results that carry no URL', async () => {
      const { fn } = recordingFetch(
        JSON.stringify({ results: [{ title: 'no url' }, { title: 'ok', url: 'https://a.test' }] }),
      )

      const result = await makeService(config, fn).search('cats')

      expect(result.results).toHaveLength(1)
      expect(result.results[0].url).toBe('https://a.test')
    })

    it('reports the upstream status rather than throwing on an error response', async () => {
      const { fn } = recordingFetch('nope', { status: 503 })

      await expect(makeService(config, fn).search('cats')).resolves.toEqual({
        results: [],
        error: 'search upstream error (status 503)',
      })
    })

    it('returns an empty result set when the upstream body is not JSON', async () => {
      const { fn } = recordingFetch('<html>not json</html>')

      await expect(makeService(config, fn).search('cats')).resolves.toEqual({ results: [] })
    })

    it('returns an empty result set when the JSON has no results array', async () => {
      const { fn } = recordingFetch(JSON.stringify({ something: 'else' }))

      await expect(makeService(config, fn).search('cats')).resolves.toEqual({ results: [] })
    })
  })

  describe('brave', () => {
    const config = { searchProvider: 'brave', searchApiUrl: 'https://brave.test/search' }

    it('reads results from the nested web.results and maps description to snippet', async () => {
      const { fn, calls } = recordingFetch(
        JSON.stringify({ web: { results: [{ title: 'T', url: 'https://a.test', description: 'D' }] } }),
      )

      const result = await makeService(config, fn).search('cats')

      expect(calls[0].url).toBe('https://brave.test/search?q=cats')
      expect(result).toEqual({ results: [{ title: 'T', url: 'https://a.test', snippet: 'D' }] })
    })

    it('sends the key in the X-Subscription-Token header only when configured', async () => {
      const withKey = recordingFetch('{}')
      await makeService({ ...config, searchApiKey: 'k' }, withKey.fn).search('cats')
      expect(withKey.calls[0].init.headers['X-Subscription-Token']).toBe('k')

      const withoutKey = recordingFetch('{}')
      await makeService(config, withoutKey.fn).search('cats')
      expect(withoutKey.calls[0].init.headers['X-Subscription-Token']).toBeUndefined()
    })

    it('returns an empty result set when the response has no web block', async () => {
      const { fn } = recordingFetch(JSON.stringify({ query: 'cats' }))

      await expect(makeService(config, fn).search('cats')).resolves.toEqual({ results: [] })
    })

    it('reports the upstream status rather than throwing', async () => {
      const { fn } = recordingFetch('nope', { status: 401 })

      await expect(makeService(config, fn).search('cats')).resolves.toEqual({
        results: [],
        error: 'search upstream error (status 401)',
      })
    })
  })

  describe('serper', () => {
    const config = { searchProvider: 'serper', searchApiUrl: 'https://serper.test/search' }

    it('POSTs the query as a JSON body and maps `link` to url', async () => {
      const { fn, calls } = recordingFetch(
        JSON.stringify({ organic: [{ title: 'T', link: 'https://a.test', snippet: 'S' }] }),
      )

      const result = await makeService(config, fn).search('cats')

      expect(calls[0].url).toBe('https://serper.test/search')
      expect(calls[0].init.method).toBe('POST')
      expect((calls[0].init as unknown as { body: string }).body).toBe(JSON.stringify({ q: 'cats' }))
      expect(calls[0].init.headers['Content-Type']).toBe('application/json')
      expect(result).toEqual({ results: [{ title: 'T', url: 'https://a.test', snippet: 'S' }] })
    })

    it('falls back to `url` when the result has no `link`', async () => {
      const { fn } = recordingFetch(JSON.stringify({ organic: [{ url: 'https://a.test' }] }))

      const result = await makeService(config, fn).search('cats')

      expect(result.results[0].url).toBe('https://a.test')
    })

    it('sends the key in the X-API-KEY header only when configured', async () => {
      const withKey = recordingFetch('{}')
      await makeService({ ...config, searchApiKey: 'k' }, withKey.fn).search('cats')
      expect(withKey.calls[0].init.headers['X-API-KEY']).toBe('k')

      const withoutKey = recordingFetch('{}')
      await makeService(config, withoutKey.fn).search('cats')
      expect(withoutKey.calls[0].init.headers['X-API-KEY']).toBeUndefined()
    })

    it('reports the upstream status rather than throwing', async () => {
      const { fn } = recordingFetch('nope', { status: 429 })

      await expect(makeService(config, fn).search('cats')).resolves.toEqual({
        results: [],
        error: 'search upstream error (status 429)',
      })
    })
  })

  it('reports a timeout as an error result rather than rejecting', async () => {
    const fn: WebFetchLike = async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }

    await expect(
      makeService({ searchProvider: 'brave', searchApiUrl: 'https://b.test' }, fn).search('cats'),
    ).resolves.toEqual({ results: [], error: 'web search timed out' })
  })

  it('reports any other upstream failure as an error result rather than rejecting', async () => {
    const fn: WebFetchLike = async () => {
      throw new Error('ECONNREFUSED')
    }

    await expect(
      makeService({ searchProvider: 'brave', searchApiUrl: 'https://b.test' }, fn).search('cats'),
    ).resolves.toEqual({ results: [], error: 'web search failed' })
  })

  it('bounds the decoded search response stream without calling response.text()', async () => {
    const publicFetch = recordingFetch('{}')
    const oversized = streamingFetch([Buffer.from('{"results":['), Buffer.alloc(32, 0x61)])
    const service = makeService(
      { searchProvider: 'searxng', searchApiUrl: 'http://searxng.internal/search', maxSearchBytes: 12 },
      publicFetch.fn,
      oversized.fn,
    )

    await expect(service.search('notes')).resolves.toEqual({ results: [], error: 'search response too large' })
    expect(oversized.cancel).toHaveBeenCalledTimes(1)
    expect(publicFetch.calls).toHaveLength(0)
  })

  it('fails closed instead of buffering a non-streaming search response', async () => {
    const text = jest.fn(async () => JSON.stringify({ results: [] }))
    const searchFn: WebFetchLike = async () => ({
      status: 200,
      ok: true,
      headers: { get: () => 'application/json' },
      text,
    })

    await expect(
      makeService(
        { searchProvider: 'searxng', searchApiUrl: 'https://search.test' },
        recordingFetch('{}').fn,
        searchFn,
      ).search('notes'),
    ).resolves.toEqual({ results: [], error: 'web search failed' })
    expect(text).not.toHaveBeenCalled()
  })
})

describe('WebService.fetch limits and error handling', () => {
  it('reports a timeout with the fetch-timeout tag', async () => {
    const fn: WebFetchLike = async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }

    await expect(makeService({}, fn).fetch('https://example.com/')).rejects.toMatchObject({
      tag: 'fetch-timeout',
      message: 'The request timed out.',
    })
  })

  it('reports any other network failure with the fetch-failed tag', async () => {
    const fn: WebFetchLike = async () => {
      throw new Error('ECONNRESET')
    }

    await expect(makeService({}, fn).fetch('https://example.com/')).rejects.toMatchObject({
      tag: 'fetch-failed',
      message: 'Failed to fetch the URL.',
    })
  })

  it('preserves the SSRF validation error instead of masking it as a fetch failure', async () => {
    const { fn } = recordingFetch('')

    const error = await makeService({}, fn)
      .fetch('http://127.0.0.1/')
      .catch((thrown) => thrown as WebValidationError)

    expect(error).toBeInstanceOf(WebValidationError)
    expect(error.tag).toBe('blocked-host')
  })

  it('rejects an empty URL before any network call', async () => {
    const { fn, calls } = recordingFetch('')

    await expect(makeService({}, fn).fetch('   ')).rejects.toMatchObject({ tag: 'missing-url' })
    expect(calls).toHaveLength(0)
  })

  it('rejects a malformed URL', async () => {
    const { fn } = recordingFetch('')

    await expect(makeService({}, fn).fetch('http://[::bad')).rejects.toMatchObject({ tag: 'invalid-url' })
  })

  it('rejects a malformed redirect target', async () => {
    const fn: WebFetchLike = async () => ({
      status: 302,
      ok: false,
      headers: { get: (name: string) => (name.toLowerCase() === 'location' ? 'http://[::bad' : null) },
      text: async () => '',
    })

    await expect(makeService({}, fn).fetch('https://example.com/')).rejects.toMatchObject({ tag: 'invalid-redirect' })
  })

  it('rejects a fallback body that exceeds maxFetchBytes instead of silently truncating it', async () => {
    const { fn } = recordingFetch('x'.repeat(500), { contentType: 'text/plain' })

    await expect(makeService({ maxFetchBytes: 10 }, fn).fetch('https://example.com/')).rejects.toMatchObject({
      tag: 'response-too-large',
      message: 'The fetched response exceeds the allowed size.',
    })
  })

  it('counts UTF-8 bytes rather than JavaScript characters in the fallback path', async () => {
    const { fn } = recordingFetch('😀😀', { contentType: 'text/plain' })

    await expect(makeService({ maxFetchBytes: 7 }, fn).fetch('https://example.com/')).rejects.toMatchObject({
      tag: 'response-too-large',
    })
  })

  it('reassembles a multibyte character split across streamed chunks', async () => {
    const encoded = Buffer.from('A😀B')
    const { fn } = streamingFetch([encoded.subarray(0, 3), encoded.subarray(3)])

    await expect(
      makeService({ maxFetchBytes: encoded.byteLength }, fn).fetch('https://example.com/'),
    ).resolves.toMatchObject({
      text: 'A😀B',
    })
  })

  it('ignores a misleading low Content-Length and enforces the streamed-byte ceiling', async () => {
    const { fn, read, cancel } = streamingFetch(
      [Buffer.from('1234'), Buffer.from('5678'), Buffer.from('unread')],
      { 'content-length': '2', 'content-type': 'text/plain' },
      new Promise<void>(() => undefined),
    )

    await expect(makeService({ maxFetchBytes: 6 }, fn).fetch('https://example.com/')).rejects.toMatchObject({
      tag: 'response-too-large',
      message: 'The fetched response exceeds the allowed size.',
    })
    expect(read).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('accepts a bounded stream even when Content-Length misleadingly claims it is larger', async () => {
    const { fn } = streamingFetch([Buffer.from('safe')], {
      'content-length': '999999999',
      'content-type': 'text/plain',
    })

    await expect(makeService({ maxFetchBytes: 4 }, fn).fetch('https://example.com/')).resolves.toMatchObject({
      text: 'safe',
    })
  })

  it('bounds chunked responses without relying on Content-Length', async () => {
    const { fn, cancel } = streamingFetch([Buffer.from('abc'), Buffer.from('def')])

    await expect(makeService({ maxFetchBytes: 5 }, fn).fetch('https://example.com/')).rejects.toMatchObject({
      tag: 'response-too-large',
    })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('bounds decoded compressed expansion rather than the encoded Content-Length', async () => {
    const { fn, cancel } = streamingFetch([Buffer.from('decoded-'), Buffer.from('expansion')], {
      'content-encoding': 'gzip',
      'content-length': '4',
    })

    await expect(makeService({ maxFetchBytes: 10 }, fn).fetch('https://example.com/')).rejects.toMatchObject({
      tag: 'response-too-large',
    })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('keeps the deadline active while a slow body is being consumed and cancels it', async () => {
    jest.useFakeTimers()
    try {
      let markReadStarted: (() => void) | undefined
      const readStarted = new Promise<void>((resolve) => {
        markReadStarted = resolve
      })
      const read = jest.fn(() => {
        markReadStarted?.()
        return new Promise<{ done: boolean; value?: Uint8Array }>(() => undefined)
      })
      const cancel = jest.fn().mockResolvedValue(undefined)
      const fn: WebFetchLike = async () =>
        ({
          status: 200,
          ok: true,
          headers: { get: () => 'text/plain' },
          body: { getReader: () => ({ read, cancel, releaseLock: jest.fn() }) },
          text: async () => '',
        }) as Awaited<ReturnType<WebFetchLike>>
      const request = makeService({ fetchTimeoutMs: 50 }, fn).fetch('https://example.com/')

      await readStarted
      const rejection = expect(request).rejects.toMatchObject({
        tag: 'fetch-timeout',
        message: 'The request timed out.',
      })
      await jest.advanceTimersByTimeAsync(50)

      await rejection
      expect(cancel).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('keeps the same deadline active while validating a redirect target', async () => {
    jest.useFakeTimers()
    try {
      let markRedirectResolutionStarted: (() => void) | undefined
      const redirectResolutionStarted = new Promise<void>((resolve) => {
        markRedirectResolutionStarted = resolve
      })
      const calls: string[] = []
      const fn: WebFetchLike = async (url) => {
        calls.push(url)
        return {
          status: 302,
          ok: false,
          headers: { get: (name: string) => (name.toLowerCase() === 'location' ? 'https://next.test/' : null) },
          text: async () => '',
        }
      }
      const resolveHost = async (host: string): Promise<string[]> => {
        if (host === 'next.test') {
          markRedirectResolutionStarted?.()
          return new Promise<string[]>(() => undefined)
        }
        return ['93.184.216.34']
      }
      const request = new WebService(fn, { fetchTimeoutMs: 50 }, resolveHost).fetch('https://example.com/')

      await redirectResolutionStarted
      const rejection = expect(request).rejects.toMatchObject({ tag: 'fetch-timeout' })
      await jest.advanceTimersByTimeAsync(50)

      await rejection
      expect(calls).toEqual(['https://example.com/'])
    } finally {
      jest.useRealTimers()
    }
  })

  it('turns a body read failure into a fixed safe error', async () => {
    const read = jest.fn().mockRejectedValue(new Error('upstream socket leaked-a-secret'))
    const cancel = jest.fn().mockResolvedValue(undefined)
    const fn: WebFetchLike = async () =>
      ({
        status: 200,
        ok: true,
        headers: { get: () => 'text/plain' },
        body: { getReader: () => ({ read, cancel, releaseLock: jest.fn() }) },
        text: async () => '',
      }) as Awaited<ReturnType<WebFetchLike>>

    await expect(makeService({}, fn).fetch('https://example.com/')).rejects.toMatchObject({
      tag: 'fetch-failed',
      message: 'Failed to fetch the URL.',
    })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('caps the extracted text at maxContentChars', async () => {
    const { fn } = recordingFetch('y'.repeat(500), { contentType: 'text/plain' })

    const result = await makeService({ maxContentChars: 20 }, fn).fetch('https://example.com/')

    expect(result.text).toHaveLength(20)
  })

  it('ignores non-positive cap overrides and keeps the safe defaults', async () => {
    const { fn } = recordingFetch('z'.repeat(300), { contentType: 'text/plain' })

    const result = await makeService({ maxContentChars: 0, maxFetchBytes: -1 }, fn).fetch('https://example.com/')

    expect(result.text).toHaveLength(300)
  })

  it('treats a body that merely starts with < as HTML even without a content type', async () => {
    const { fn } = recordingFetch('<title>T</title><p>body text</p>')

    const result = await makeService({}, fn).fetch('https://example.com/')

    expect(result.title).toBe('T')
    expect(result.text).toContain('body text')
  })

  it('passes a non-HTML body through untouched', async () => {
    const { fn } = recordingFetch('plain <not html', { contentType: 'text/plain' })

    const result = await makeService({}, fn).fetch('https://example.com/')

    expect(result.title).toBe('')
    expect(result.text).toBe('plain <not html')
  })

  it('reports the upstream content type and status verbatim', async () => {
    const { fn } = recordingFetch('{}', { status: 404, contentType: 'application/json' })

    const result = await makeService({}, fn).fetch('https://example.com/')

    expect(result.status).toBe(404)
    expect(result.contentType).toBe('application/json')
  })

  it('reports an empty content type when the response omits the header', async () => {
    const { fn } = recordingFetch('body')

    const result = await makeService({}, fn).fetch('https://example.com/')

    expect(result.contentType).toBe('')
  })
})

describe('htmlToText', () => {
  it('removes script, style, noscript, template and svg contents entirely', () => {
    const text = htmlToText(
      '<p>keep</p><script>secret()</script><style>.a{}</style><noscript>ns</noscript>' +
        '<template>tpl</template><svg><path/></svg><!-- comment -->',
    )

    expect(text).toContain('keep')
    for (const removed of ['secret', '.a{}', 'ns', 'tpl', 'path', 'comment']) {
      expect(text).not.toContain(removed)
    }
  })

  it('turns block boundaries and line breaks into newlines', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\ntwo')
    expect(htmlToText('a<br>b')).toBe('a\nb')
    expect(htmlToText('a<br />b')).toBe('a\nb')
    expect(htmlToText('<li>x</li><li>y</li>')).toBe('x\ny')
  })

  it('strips remaining tags without concatenating adjacent words', () => {
    expect(htmlToText('<span>one</span><span>two</span>')).toBe('one two')
  })

  it('decodes the common named entities', () => {
    expect(htmlToText('a&nbsp;b &amp; &lt;c&gt; &quot;d&quot; &#39;e&apos;')).toBe('a b & <c> "d" \'e\'')
  })

  it('decodes decimal and hexadecimal numeric entities', () => {
    expect(htmlToText('&#65;&#x42;&#x1F600;')).toBe('AB\u{1F600}')
  })

  it('drops an out-of-range numeric entity instead of throwing', () => {
    expect(htmlToText('a&#1114112;b')).toBe('ab')
    expect(htmlToText('a&#x999999;b')).toBe('ab')
  })

  it('collapses whitespace runs and caps consecutive blank lines', () => {
    expect(htmlToText('a  \t  b')).toBe('a b')
    expect(htmlToText('<p>a</p><p></p><p></p><p></p><p>b</p>')).toBe('a\n\nb')
  })

  it('trims leading and trailing whitespace', () => {
    expect(htmlToText('   <p>  a  </p>   ')).toBe('a')
  })
})

// Title extraction is internal to the module, so it is exercised through the
// public fetch() path rather than by exporting the helper for the test's sake.
describe('title extraction via fetch', () => {
  const titleOf = async (html: string) => {
    const { fn } = recordingFetch(html, { contentType: 'text/html' })

    return (await makeService({}, fn).fetch('https://example.com/')).title
  }

  it('reads the title element and collapses its whitespace', async () => {
    await expect(titleOf('<html><head><title>  Hello \n  World  </title></head></html>')).resolves.toBe('Hello World')
  })

  it('decodes entities inside the title', async () => {
    await expect(titleOf('<title>a &amp; b</title>')).resolves.toBe('a & b')
  })

  it('returns an empty string when there is no title', async () => {
    await expect(titleOf('<html><body>no title</body></html>')).resolves.toBe('')
  })

  it('caps a very long title at 500 characters', async () => {
    await expect(titleOf(`<title>${'t'.repeat(900)}</title>`)).resolves.toHaveLength(500)
  })
})
