import { WebDeploymentMarkerReader, webDeploymentOrigin } from './WebDeploymentMarker'

const marker = { revision: 'a'.repeat(40), version: 'src-aaaaaaaaaaaa' }
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

describe('web deployment marker', () => {
  it('uses only a configured canonical origin, prioritizes the stable internal facade and fails closed on invalid overrides', () => {
    expect(webDeploymentOrigin('http://app:8080', 'https://public.test')).toBe('http://app:8080')
    expect(webDeploymentOrigin(undefined, 'https://public.test')).toBe('https://public.test')
    for (const value of [
      'file:///secret',
      'http://user:password@app:8080',
      'http://app:8080/path',
      'http://app:8080/?x=1',
      'http://app:8080/#x',
      'invalid',
    ]) {
      expect(webDeploymentOrigin(value, 'https://public.test')).toBeUndefined()
    }
    expect(webDeploymentOrigin()).toBeUndefined()
  })

  it('coalesces concurrent reads, fetches the live frontend after cache expiry, and sends no session credentials', async () => {
    let now = 100
    const fetcher = jest.fn(async () => json(marker))
    const reader = new WebDeploymentMarkerReader({
      internalOrigin: 'http://app:8080',
      fetch: fetcher as typeof fetch,
      now: () => now,
    })
    expect(await Promise.all([reader.read(), reader.read()])).toEqual([marker, marker])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith(
      'http://app:8080/.well-known/srn-deployment.json',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      }),
    )
    expect(await reader.read()).toEqual(marker)
    now += 5_001
    const next = { revision: 'b'.repeat(40), version: 'src-bbbbbbbbbbbb' }
    fetcher.mockImplementation(async () => json(next))
    expect(await reader.read()).toEqual(next)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([
    { revision: 'unstamped', version: 'unstamped' },
    { revision: 'A'.repeat(40), version: 'v1' },
    { revision: marker.revision, version: 'invalid version' },
    { revision: marker.revision },
    { ...marker, internalSecret: 'must-never-be-returned' },
    ['not-a-marker'],
    null,
  ])('rejects invalid or unexpected marker data %p', async (body) => {
    const reader = new WebDeploymentMarkerReader({
      internalOrigin: 'http://app:8080',
      fetch: jest.fn(async () => json(body)) as typeof fetch,
    })
    expect(await reader.read()).toBeUndefined()
  })

  it('bounds streamed bytes without trusting content-length and cancels the remainder', async () => {
    const cancel = jest.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(513))
      },
      cancel,
    })
    const reader = new WebDeploymentMarkerReader({
      internalOrigin: 'http://app:8080',
      fetch: jest.fn(
        async () => new Response(stream, { headers: { 'content-type': 'application/json' } }),
      ) as typeof fetch,
    })
    expect(await reader.read()).toBeUndefined()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('rejects redirects, bad status, declared oversize, malformed JSON and non-JSON responses', async () => {
    for (const response of [
      new Response('', { status: 302 }),
      new Response('', { status: 500 }),
      new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '513' } }),
      new Response('{', { headers: { 'content-type': 'application/json' } }),
      new Response('not-json'),
    ]) {
      const reader = new WebDeploymentMarkerReader({
        internalOrigin: 'http://app:8080',
        fetch: jest.fn(async () => response) as typeof fetch,
      })
      expect(await reader.read()).toBeUndefined()
    }
  })

  it('aborts slow reads and caches failure briefly without substituting backend provenance', async () => {
    jest.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      const fetcher = jest.fn(
        (_url: unknown, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            signal = init.signal as AbortSignal
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          }),
      )
      const reader = new WebDeploymentMarkerReader({
        internalOrigin: 'http://app:8080',
        fetch: fetcher as typeof fetch,
      })
      const pending = reader.read()
      await jest.advanceTimersByTimeAsync(2_501)
      expect(await pending).toBeUndefined()
      expect(signal?.aborted).toBe(true)
      expect(await reader.read()).toBeUndefined()
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not fetch when no frontend origin is configured', async () => {
    const fetcher = jest.fn()
    expect(await new WebDeploymentMarkerReader({ fetch: fetcher }).read()).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
