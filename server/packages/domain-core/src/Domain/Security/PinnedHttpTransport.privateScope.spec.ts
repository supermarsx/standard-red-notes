import { EventEmitter } from 'events'
import { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'http'
import { Readable } from 'stream'

import { SsrfValidationError } from './SsrfFilter'
import { PinnedHttpTransport, PinnedRequestFactory } from './PinnedHttpTransport'

interface ScriptedResponse {
  status?: number
  headers?: IncomingHttpHeaders
  body?: string
}

/**
 * Records every socket the transport tries to open. A refused target must leave
 * this list EMPTY: "the request failed" would also be true of a transport that
 * connected and then gave up, which is the thing these tests exist to rule out.
 */
function recordingRequests(steps: ScriptedResponse[]) {
  const connections: Array<{ hostname: unknown; port: unknown; path: unknown }> = []
  let index = 0
  const factory: PinnedRequestFactory = (_protocol, options, onResponse) => {
    const step = steps[Math.min(index++, steps.length - 1)]
    const request = new EventEmitter() as EventEmitter & { destroyed: boolean; write(): void; end(): void }
    request.destroyed = false
    request.write = (): void => undefined
    request.end = (): void => {
      queueMicrotask(() => {
        const response = Readable.from(
          step.body === undefined ? [] : [Buffer.from(step.body)],
        ) as unknown as IncomingMessage
        response.statusCode = step.status ?? 200
        response.headers = step.headers ?? {}
        onResponse(response)
      })
    }
    connections.push({ hostname: options.hostname, port: options.port, path: options.path })
    return request as unknown as ClientRequest
  }

  return { factory, connections }
}

describe("PinnedHttpTransport with the 'private-ranges' scope", () => {
  const origin = 'http://nextcloud.lan'

  it('connects to the LAN address it validated, keeping the name in Host', async () => {
    const { factory, connections } = recordingRequests([{ body: 'ok' }])
    const transport = new PinnedHttpTransport(async () => ['192.168.1.20'], factory, {
      allowedPrivateOrigins: [origin],
      allowedPrivateOriginScope: 'private-ranges',
    })

    const response = await transport.request({ url: `${origin}/remote.php/dav/` })
    await response.discard()

    expect(connections).toEqual([{ hostname: '192.168.1.20', port: undefined, path: '/remote.php/dav/' }])
  })

  it.each([['127.0.0.1'], ['169.254.169.254'], ['::1'], ['::ffff:10.0.0.5'], ['0.0.0.0']])(
    'opens no socket when a listed origin resolves to %s',
    async (address) => {
      const { factory, connections } = recordingRequests([{ body: 'must not be reached' }])
      const transport = new PinnedHttpTransport(async () => [address], factory, {
        allowedPrivateOrigins: [origin],
        allowedPrivateOriginScope: 'private-ranges',
      })

      await expect(transport.request({ url: `${origin}/` })).rejects.toBeInstanceOf(SsrfValidationError)
      expect(connections).toHaveLength(0)
    },
  )

  it('opens no socket for a listed origin that is itself a loopback literal', async () => {
    const { factory, connections } = recordingRequests([{ body: 'must not be reached' }])
    const transport = new PinnedHttpTransport(undefined, factory, {
      allowedPrivateOrigins: ['http://127.0.0.1:3000'],
      allowedPrivateOriginScope: 'private-ranges',
    })

    await expect(transport.request({ url: 'http://127.0.0.1:3000/healthcheck' })).rejects.toBeInstanceOf(
      SsrfValidationError,
    )
    expect(connections).toHaveLength(0)
  })

  it('re-checks the address on a redirect hop: a rebind to loopback after the first answer is refused', async () => {
    const resolveHost = jest.fn().mockResolvedValueOnce(['192.168.1.20']).mockResolvedValueOnce(['127.0.0.1'])
    const { factory, connections } = recordingRequests([
      { status: 302, headers: { location: `${origin}/next` } },
      { body: 'must not be reached' },
    ])
    const transport = new PinnedHttpTransport(resolveHost, factory, {
      allowedPrivateOrigins: [origin],
      allowedPrivateOriginScope: 'private-ranges',
    })

    await expect(transport.request({ url: `${origin}/`, redirect: 'follow', maxRedirects: 3 })).rejects.toBeInstanceOf(
      SsrfValidationError,
    )
    expect(resolveHost).toHaveBeenCalledTimes(2)
    expect(connections).toEqual([{ hostname: '192.168.1.20', port: undefined, path: '/' }])
  })

  it('opens no socket to an address the deployment denies, on the first hop or a later one', async () => {
    const isAddressDenied = (address: string): boolean => address === '172.18.0.4'
    const first = recordingRequests([{ body: 'must not be reached' }])
    await expect(
      new PinnedHttpTransport(async () => ['172.18.0.4'], first.factory, {
        allowedPrivateOrigins: [origin],
        allowedPrivateOriginScope: 'private-ranges',
        isAddressDenied,
      }).request({ url: `${origin}/` }),
    ).rejects.toBeInstanceOf(SsrfValidationError)
    expect(first.connections).toHaveLength(0)

    const resolveHost = jest.fn().mockResolvedValueOnce(['172.18.0.9']).mockResolvedValueOnce(['172.18.0.4'])
    const later = recordingRequests([
      { status: 307, headers: { location: `${origin}/next` } },
      { body: 'must not be reached' },
    ])
    await expect(
      new PinnedHttpTransport(resolveHost, later.factory, {
        allowedPrivateOrigins: [origin],
        allowedPrivateOriginScope: 'private-ranges',
        isAddressDenied,
      }).request({ url: `${origin}/`, redirect: 'follow', maxRedirects: 3 }),
    ).rejects.toBeInstanceOf(SsrfValidationError)
    expect(later.connections).toEqual([{ hostname: '172.18.0.9', port: undefined, path: '/' }])
  })

  it('leaves the default scope alone: a listed origin may still resolve to loopback', async () => {
    const { factory, connections } = recordingRequests([{ body: 'ok' }])
    const transport = new PinnedHttpTransport(async () => ['127.0.0.1'], factory, {
      allowedPrivateOrigins: ['http://search.internal:8080'],
    })

    const response = await transport.request({ url: 'http://search.internal:8080/search' })
    await response.discard()

    expect(connections).toEqual([{ hostname: '127.0.0.1', port: '8080', path: '/search' }])
  })
})
