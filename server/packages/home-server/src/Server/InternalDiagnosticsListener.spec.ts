import * as http from 'http'
import { EventEmitter } from 'events'

import {
  DEFAULT_AUTH_PROBE_PORT,
  INTERNAL_DIAGNOSTICS_BIND_ADDRESS,
  INTERNAL_DIAGNOSTICS_PATH,
  InternalDiagnosticsRequest,
  handleInternalDiagnosticsRequest,
  parseInternalDiagnosticsPort,
  readRequestPath,
  startInternalDiagnosticsListener,
} from './InternalDiagnosticsListener'

/**
 * Standard Red Notes: the loopback-only listener that makes the three
 * auth-owned Diagnostics blocks reachable on the single-container topology.
 *
 * THE TESTS THAT MATTER HERE ARE THE TWO DIRECTIONS OF THE EXPOSURE BOUNDARY.
 * The route is internal on every other topology — it answers on auth's internal
 * port and 404s at the public front door — and that must stay true where one
 * process serves everything. So: the gateway's own in-process probe is served,
 * and a request that arrived through the front-door proxy is refused with the
 * SAME answer an unmatched path gets. The refusal is decided on the TCP peer and
 * the presence of a forwarding header, never on a header that could GRANT
 * access: `DirectCallServiceProxy` hands Express requests through untouched on
 * this topology, so a header-derived decision here would be caller-controlled.
 */
describe('parseInternalDiagnosticsPort', () => {
  it('defaults to the port the gateway probe map defaults to for auth', () => {
    expect(parseInternalDiagnosticsPort(undefined)).toBe(DEFAULT_AUTH_PROBE_PORT)
  })

  it('honours a configured sibling port', () => {
    expect(parseInternalDiagnosticsPort('3203')).toBe(3203)
    expect(parseInternalDiagnosticsPort(' 3203 ')).toBe(3203)
  })

  it.each([['' as string], ['nonsense'], ['0'], ['70000'], ['3103.5'], ['-1']])(
    'falls back to the default rather than binding a random port for %p',
    (value) => {
      // `listen(NaN)` binds an ARBITRARY free port: a listener the probe could
      // never find, reported in the log as a success.
      expect(parseInternalDiagnosticsPort(value)).toBe(DEFAULT_AUTH_PROBE_PORT)
    },
  )
})

describe('readRequestPath', () => {
  it('ignores a query string and a fragment', () => {
    expect(readRequestPath('/healthcheck/diagnostics?x=1')).toBe(INTERNAL_DIAGNOSTICS_PATH)
    expect(readRequestPath('/healthcheck/diagnostics#x')).toBe(INTERNAL_DIAGNOSTICS_PATH)
  })

  it('ignores one trailing slash', () => {
    expect(readRequestPath('/healthcheck/diagnostics/')).toBe(INTERNAL_DIAGNOSTICS_PATH)
  })

  it('leaves the root path alone', () => {
    expect(readRequestPath('/')).toBe('/')
  })

  it('treats a request with no URL as the empty path', () => {
    expect(readRequestPath(undefined)).toBe('')
  })
})

describe('handleInternalDiagnosticsRequest', () => {
  const NOT_FOUND = JSON.stringify({ error: { message: 'Not Found' } })

  const request = (overrides: Partial<InternalDiagnosticsRequest> = {}): InternalDiagnosticsRequest =>
    ({
      method: 'GET',
      url: INTERNAL_DIAGNOSTICS_PATH,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      ...overrides,
    }) as unknown as InternalDiagnosticsRequest

  const responder = (): {
    writeHead: jest.Mock
    end: jest.Mock
    status: () => number
    body: () => string | undefined
  } => {
    const writeHead = jest.fn()
    const end = jest.fn()

    return {
      writeHead,
      end,
      status: (): number => writeHead.mock.calls[0][0] as number,
      body: (): string | undefined => end.mock.calls[0][0] as string | undefined,
    }
  }

  it('serves the report to the in-process probe over loopback', async () => {
    const response = responder()
    const report = { processUptimeSeconds: 7, datastore: { connectionState: 'connected' } }

    await handleInternalDiagnosticsRequest(request(), response, async () => report)

    expect(response.status()).toBe(200)
    expect(response.writeHead.mock.calls[0][1]).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(response.body() as string)).toEqual(report)
  })

  it.each([['::1'], ['::ffff:127.0.0.1']])('serves a loopback probe that dialled over %p', async (peer) => {
    const response = responder()

    await handleInternalDiagnosticsRequest(
      request({ socket: { remoteAddress: peer } as unknown as InternalDiagnosticsRequest['socket'] }),
      response,
      async () => ({ ok: true }),
    )

    expect(response.status()).toBe(200)
  })

  it('REFUSES a request forwarded by the front-door proxy, though its peer is loopback nginx', async () => {
    const response = responder()
    const report = jest.fn(async () => ({ processUptimeSeconds: 7 }))

    // Exactly what the single container's nginx sends: it runs on loopback and
    // sets X-Forwarded-For on every proxied request.
    await handleInternalDiagnosticsRequest(
      request({ headers: { 'x-forwarded-for': '203.0.113.55' } }),
      response,
      report,
    )

    expect(response.status()).toBe(404)
    expect(response.body()).toBe(NOT_FOUND)
    // Not merely hidden: the probes never ran.
    expect(report).not.toHaveBeenCalled()
  })

  it('REFUSES a request from off-box, whatever it claims about itself', async () => {
    const response = responder()

    await handleInternalDiagnosticsRequest(
      request({
        headers: { 'x-origin-ip': '127.0.0.1', 'x-real-ip': '127.0.0.1' },
        socket: { remoteAddress: '203.0.113.55' } as unknown as InternalDiagnosticsRequest['socket'],
      }),
      response,
      async () => ({ ok: true }),
    )

    expect(response.status()).toBe(404)
    expect(response.body()).toBe(NOT_FOUND)
  })

  it('answers a refused caller exactly as it answers an unmatched path', async () => {
    const refused = responder()
    await handleInternalDiagnosticsRequest(
      request({ headers: { 'x-forwarded-for': '203.0.113.55' } }),
      refused,
      async () => ({ ok: true }),
    )

    const unmatched = responder()
    await handleInternalDiagnosticsRequest(request({ url: '/healthcheck/readiness' }), unmatched, async () => ({
      ok: true,
    }))

    expect(refused.writeHead.mock.calls).toEqual(unmatched.writeHead.mock.calls)
    expect(refused.end.mock.calls).toEqual(unmatched.end.mock.calls)
  })

  it('serves nothing but this one path', async () => {
    const response = responder()

    await handleInternalDiagnosticsRequest(request({ url: '/healthcheck' }), response, async () => ({ ok: true }))

    expect(response.status()).toBe(404)
  })

  it('serves nothing but GET', async () => {
    const response = responder()
    const report = jest.fn(async () => ({ ok: true }))

    await handleInternalDiagnosticsRequest(request({ method: 'POST' }), response, report)

    expect(response.status()).toBe(404)
    expect(report).not.toHaveBeenCalled()
  })

  it('reduces a failed probe to a bounded refusal and echoes nothing from it', async () => {
    const response = responder()

    await handleInternalDiagnosticsRequest(request(), response, async () => {
      throw new Error('connect ECONNREFUSED 10.1.2.3:3306')
    })

    expect(response.status()).toBe(503)
    expect(response.body()).toBe(JSON.stringify({ error: { message: 'Diagnostics unavailable' } }))
    expect(response.body()).not.toContain('10.1.2.3')
  })
})

describe('startInternalDiagnosticsListener', () => {
  const logger = (): { info: jest.Mock; warn: jest.Mock } => ({ info: jest.fn(), warn: jest.fn() })

  class FakeServer extends EventEmitter {
    public listenArgs: unknown[] | undefined
    constructor(private readonly behaviour: 'listen' | 'fail') {
      super()
    }
    listen(...args: unknown[]): this {
      this.listenArgs = args
      const callback = args[args.length - 1] as () => void
      if (this.behaviour === 'listen') {
        setImmediate(callback)
      } else {
        setImmediate(() => this.emit('error', Object.assign(new Error('in use'), { code: 'EADDRINUSE' })))
      }

      return this
    }
  }

  it('binds LOOPBACK ONLY, never an operator-supplied address', async () => {
    const fake = new FakeServer('listen')
    const log = logger()

    const server = await startInternalDiagnosticsListener({
      port: 3640,
      report: async () => ({ ok: true }),
      logger: log,
      createServer: () => fake as unknown as http.Server,
    })

    expect(server).toBe(fake as unknown as http.Server)
    expect(fake.listenArgs?.slice(0, 2)).toEqual([3640, INTERNAL_DIAGNOSTICS_BIND_ADDRESS])
    expect(log.info).toHaveBeenCalledTimes(1)
  })

  it('degrades to no listener when the port cannot be bound, and never fails the boot', async () => {
    const log = logger()

    const server = await startInternalDiagnosticsListener({
      port: 3641,
      report: async () => ({ ok: true }),
      logger: log,
      createServer: () => new FakeServer('fail') as unknown as http.Server,
    })

    expect(server).toBeUndefined()
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn.mock.calls[0][1]).toEqual({ port: 3641, code: 'EADDRINUSE' })
  })

  it('settles once even when a listening server later errors', async () => {
    const fake = new FakeServer('listen')
    const log = logger()

    const server = await startInternalDiagnosticsListener({
      port: 3642,
      report: async () => ({ ok: true }),
      logger: log,
      createServer: () => fake as unknown as http.Server,
    })
    fake.emit('error', Object.assign(new Error('late'), { code: 'ECONNRESET' }))

    expect(server).toBe(fake as unknown as http.Server)
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('serves a real loopback request end to end and refuses a forwarded one', async () => {
    const log = logger()
    const server = await startInternalDiagnosticsListener({
      port: 3643,
      report: async () => ({ processUptimeSeconds: 11 }),
      logger: log,
    })
    expect(server).toBeDefined()

    try {
      const served = await fetch(`http://${INTERNAL_DIAGNOSTICS_BIND_ADDRESS}:3643${INTERNAL_DIAGNOSTICS_PATH}`)
      expect(served.status).toBe(200)
      expect(await served.json()).toEqual({ processUptimeSeconds: 11 })

      const forwarded = await fetch(`http://${INTERNAL_DIAGNOSTICS_BIND_ADDRESS}:3643${INTERNAL_DIAGNOSTICS_PATH}`, {
        headers: { 'x-forwarded-for': '203.0.113.55' },
      })
      expect(forwarded.status).toBe(404)
      expect(await forwarded.json()).toEqual({ error: { message: 'Not Found' } })
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()))
    }
  })
})
