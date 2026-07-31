import { EventEmitter } from 'events'
import { ClientRequest, IncomingMessage } from 'http'
import { Readable } from 'stream'
import { gzipSync } from 'zlib'

import { PinnedHttpTransport, PinnedRequestFactory } from '@standardnotes/domain-core'

import { WebFetchLike, WebService } from './WebService'

describe('WebService with PinnedHttpTransport', () => {
  it('applies the decoded-byte ceiling after the pinned transport expands compression', async () => {
    const compressed = gzipSync(Buffer.from('decoded response larger than the configured ceiling'))
    const requestFactory: PinnedRequestFactory = (_protocol, _options, onResponse) => {
      const request = new EventEmitter() as EventEmitter & {
        destroyed: boolean
        write: jest.Mock
        end: jest.Mock
        destroy: jest.Mock
      }
      request.destroyed = false
      request.write = jest.fn()
      request.destroy = jest.fn(() => {
        request.destroyed = true
        return request
      })
      request.end = jest.fn(() => {
        queueMicrotask(() => {
          const response = Readable.from([compressed]) as unknown as IncomingMessage
          response.statusCode = 200
          response.headers = {
            'content-type': 'text/plain',
            'content-encoding': 'gzip',
            'content-length': String(compressed.byteLength),
          }
          onResponse(response)
        })
      })
      return request as unknown as ClientRequest
    }
    const transport = new PinnedHttpTransport(async () => ['93.184.216.34'], requestFactory)
    const service = new WebService(transport.fetch.bind(transport) as WebFetchLike, { maxFetchBytes: 10 }, async () => [
      '93.184.216.34',
    ])

    await expect(service.fetch('https://compressed.example/')).rejects.toMatchObject({
      tag: 'response-too-large',
      message: 'The fetched response exceeds the allowed size.',
    })
  })

  it('pins a private operator-configured search origin without opening arbitrary fetch to it', async () => {
    const calls: Array<{ hostname?: string; headers?: unknown }> = []
    const requestFactory: PinnedRequestFactory = (_protocol, options, onResponse) => {
      calls.push({ hostname: options.hostname, headers: options.headers })
      const request = new EventEmitter() as EventEmitter & {
        destroyed: boolean
        write: jest.Mock
        end: jest.Mock
        destroy: jest.Mock
      }
      request.destroyed = false
      request.write = jest.fn()
      request.destroy = jest.fn(() => {
        request.destroyed = true
        return request
      })
      request.end = jest.fn(() => {
        queueMicrotask(() => {
          const response = Readable.from([
            Buffer.from(JSON.stringify({ results: [{ title: 'T', url: 'https://result.test', content: 'C' }] })),
          ]) as unknown as IncomingMessage
          response.statusCode = 200
          response.headers = { 'content-type': 'application/json' }
          onResponse(response)
        })
      })
      return request as unknown as ClientRequest
    }
    const publicTransport = new PinnedHttpTransport(async () => ['10.20.30.40'], requestFactory)
    const searchTransport = new PinnedHttpTransport(async () => ['10.20.30.40'], requestFactory, {
      allowedPrivateOrigins: ['http://searxng.internal:8080/search'],
    })
    const service = new WebService(
      publicTransport.fetch.bind(publicTransport) as WebFetchLike,
      { searchProvider: 'searxng', searchApiUrl: 'http://searxng.internal:8080/search' },
      async () => ['10.20.30.40'],
      searchTransport.fetch.bind(searchTransport) as WebFetchLike,
    )

    await expect(service.search('notes')).resolves.toEqual({
      results: [{ title: 'T', url: 'https://result.test', snippet: 'C' }],
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      hostname: '10.20.30.40',
      headers: { Host: 'searxng.internal:8080' },
    })

    await expect(service.fetch('http://searxng.internal:8080/search')).rejects.toMatchObject({ tag: 'blocked-host' })
    expect(calls).toHaveLength(1)
  })
})
