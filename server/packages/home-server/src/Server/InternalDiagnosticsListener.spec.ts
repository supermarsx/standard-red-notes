import * as http from 'http'
import { EventEmitter } from 'events'

import {
  DEFAULT_AUTH_PROBE_PORT,
  INTERNAL_DIAGNOSTICS_BIND_ADDRESS,
  INTERNAL_DIAGNOSTICS_PATH,
  INTERNAL_READINESS_PATH,
  InternalDiagnosticsRequest,
  InternalRoute,
  InternalRouteTable,
  handleInternalDiagnosticsRequest,
  parseInternalDiagnosticsPort,
  readRequestPath,
  startInternalDiagnosticsListener,
} from './InternalDiagnosticsListener'

/**
 * Standard Red Notes: the loopback-only listener that makes auth's internal
 * health routes reachable on the single-container topology — the three
 * auth-owned Diagnostics blocks, and auth's own readiness verdict.
 *
 * THE TESTS THAT MATTER HERE ARE THE TWO DIRECTIONS OF THE EXPOSURE BOUNDARY.
 * Both routes are internal on every other topology — they answer on auth's
 * internal port and 404 at the public front door — and that must stay true where
 * one process serves everything. So: the gateway's own in-process probe is
 * served, and a request that arrived through the front-door proxy is refused
 * with the SAME answer an unmatched path gets. The refusal is decided on the TCP
 * peer and the presence of a forwarding header, never on a header that could
 * GRANT access: `DirectCallServiceProxy` hands Express requests through
 * untouched on this topology, so a header-derived decision here would be
 * caller-controlled.
 *
 * THE SECOND THING THAT MATTERS is that a route's FAILURE answer is in that
 * route's own vocabulary. The gateway's readiness probe accepts a 503 and reads
 * `status` and `checks` out of the body; a generic `{ error: { message } }` body
 * leaves it with `status: undefined` and `checks: {}`, which it scores as a
 * healthy `'ok'` auth. A shared failure answer would therefore publish a crashed
 * readiness probe as a working auth service.
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
    expect(readRequestPath('/healthcheck/readiness/')).toBe(INTERNAL_READINESS_PATH)
  })

  it('leaves the root path alone', () => {
    expect(readRequestPath('/')).toBe('/')
  })

  it('treats a request with no URL as the empty path', () => {
    expect(readRequestPath(undefined)).toBe('')
  })
})

describe('the two paths the gateway dials', () => {
  it('are exactly what AdminController appends to the auth probe base', () => {
    // `probeAuthRuntime` fetches `${base}/healthcheck/diagnostics` and
    // `probeAuthReadiness` fetches `${base}/healthcheck/readiness`. A typo in
    // either constant is a listener that binds, logs success, and is never found.
    expect(INTERNAL_DIAGNOSTICS_PATH).toBe('/healthcheck/diagnostics')
    expect(INTERNAL_READINESS_PATH).toBe('/healthcheck/readiness')
  })
})

describe('handleInternalDiagnosticsRequest', () => {
  const NOT_FOUND = JSON.stringify({ error: { message: 'Not Found' } })
  const DIAGNOSTICS_REPORT = { processUptimeSeconds: 7, datastore: { connectionState: 'connected' } }
  const READY_REPORT = { status: 'ready', checks: { db: true, redis: true } }
  const DIAGNOSTICS_UNAVAILABLE = { error: { message: 'Diagnostics unavailable' } }
  const READINESS_UNAVAILABLE = { status: 'unavailable', checks: { db: false, redis: false } }

  type Answers = {
    diagnostics: jest.Mock<Promise<{ status: number; body: unknown }>, []>
    readiness: jest.Mock<Promise<{ status: number; body: unknown }>, []>
  }

  /**
   * Both routes wired exactly as `buildInternalAuthRoutes` wires them, so a test
   * here exercises the same shapes production serves.
   */
  const routeTable = (
    overrides: { diagnostics?: InternalRoute['answer']; readiness?: InternalRoute['answer'] } = {},
  ): { routes: InternalRouteTable; answers: Answers } => {
    const answers: Answers = {
      diagnostics: jest.fn(overrides.diagnostics ?? (async () => ({ status: 200, body: DIAGNOSTICS_REPORT }))),
      readiness: jest.fn(overrides.readiness ?? (async () => ({ status: 200, body: READY_REPORT }))),
    }

    return {
      answers,
      routes: new Map<string, InternalRoute>([
        [
          INTERNAL_DIAGNOSTICS_PATH,
          { answer: answers.diagnostics, onFailure: { status: 503, body: DIAGNOSTICS_UNAVAILABLE } },
        ],
        [
          INTERNAL_READINESS_PATH,
          { answer: answers.readiness, onFailure: { status: 503, body: READINESS_UNAVAILABLE } },
        ],
      ]),
    }
  }

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

  it('serves the diagnostics report to the in-process probe over loopback', async () => {
    const response = responder()
    const { routes } = routeTable()

    await handleInternalDiagnosticsRequest(request(), response, routes)

    expect(response.status()).toBe(200)
    expect(response.writeHead.mock.calls[0][1]).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(response.body() as string)).toEqual(DIAGNOSTICS_REPORT)
  })

  it('serves the readiness report to the in-process probe over loopback', async () => {
    const response = responder()
    const { routes, answers } = routeTable()

    await handleInternalDiagnosticsRequest(request({ url: INTERNAL_READINESS_PATH }), response, routes)

    expect(response.status()).toBe(200)
    expect(JSON.parse(response.body() as string)).toEqual(READY_REPORT)
    // The paths are not interchangeable: a readiness request must not be served
    // the diagnostics report, which carries no `checks` the pane could read.
    expect(answers.diagnostics).not.toHaveBeenCalled()
  })

  it('serves the status the ROUTE decided, so an unready auth still answers 503', async () => {
    const response = responder()
    const unavailable = { status: 'unavailable', checks: { db: false, redis: true } }
    const { routes } = routeTable({ readiness: async () => ({ status: 503, body: unavailable }) })

    await handleInternalDiagnosticsRequest(request({ url: INTERNAL_READINESS_PATH }), response, routes)

    // A hardcoded 200 here would keep a deployment whose database is gone in the
    // orchestrator's rotation, and would print "answering" in the pane over a
    // body that says it is not.
    expect(response.status()).toBe(503)
    expect(JSON.parse(response.body() as string)).toEqual(unavailable)
  })

  it.each([['::1'], ['::ffff:127.0.0.1']])('serves a loopback probe that dialled over %p', async (peer) => {
    const response = responder()
    const { routes } = routeTable()

    await handleInternalDiagnosticsRequest(
      request({ socket: { remoteAddress: peer } as unknown as InternalDiagnosticsRequest['socket'] }),
      response,
      routes,
    )

    expect(response.status()).toBe(200)
  })

  it.each([[INTERNAL_DIAGNOSTICS_PATH], [INTERNAL_READINESS_PATH]])(
    'REFUSES %s when forwarded by the front-door proxy, though its peer is loopback nginx',
    async (url) => {
      const response = responder()
      const { routes, answers } = routeTable()

      // Exactly what the single container's nginx sends: it runs on loopback and
      // sets X-Forwarded-For on every proxied request.
      await handleInternalDiagnosticsRequest(
        request({ url, headers: { 'x-forwarded-for': '203.0.113.55' } }),
        response,
        routes,
      )

      expect(response.status()).toBe(404)
      expect(response.body()).toBe(NOT_FOUND)
      // Not merely hidden: the probes never ran.
      expect(answers.diagnostics).not.toHaveBeenCalled()
      expect(answers.readiness).not.toHaveBeenCalled()
    },
  )

  it.each([[INTERNAL_DIAGNOSTICS_PATH], [INTERNAL_READINESS_PATH]])(
    'REFUSES %s from off-box, whatever it claims about itself',
    async (url) => {
      const response = responder()
      const { routes, answers } = routeTable()

      await handleInternalDiagnosticsRequest(
        request({
          url,
          headers: { 'x-origin-ip': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-forwarded-host': 'localhost' },
          socket: { remoteAddress: '203.0.113.55' } as unknown as InternalDiagnosticsRequest['socket'],
        }),
        response,
        routes,
      )

      expect(response.status()).toBe(404)
      expect(response.body()).toBe(NOT_FOUND)
      expect(answers.diagnostics).not.toHaveBeenCalled()
      expect(answers.readiness).not.toHaveBeenCalled()
    },
  )

  it.each([[INTERNAL_DIAGNOSTICS_PATH], [INTERNAL_READINESS_PATH]])(
    'answers a caller refused on %s exactly as it answers an unmatched path',
    async (url) => {
      const { routes } = routeTable()

      const refused = responder()
      await handleInternalDiagnosticsRequest(
        request({ url, headers: { 'x-forwarded-for': '203.0.113.55' } }),
        refused,
        routes,
      )

      const unmatched = responder()
      await handleInternalDiagnosticsRequest(request({ url: '/healthcheck/nothing-here' }), unmatched, routes)

      expect(refused.writeHead.mock.calls).toEqual(unmatched.writeHead.mock.calls)
      expect(refused.end.mock.calls).toEqual(unmatched.end.mock.calls)
    },
  )

  it.each([
    ['/healthcheck'],
    ['/'],
    ['/healthcheck/diagnostic'],
    ['/healthcheck/readinessx'],
    ['/internal'],
    ['/auth'],
  ])('serves nothing at the sibling path %p', async (url) => {
    const response = responder()
    const { routes } = routeTable()

    await handleInternalDiagnosticsRequest(request({ url }), response, routes)

    expect(response.status()).toBe(404)
  })

  it.each([['__proto__'], ['constructor'], ['toString'], ['hasOwnProperty']])(
    'treats the inherited object key %p as an unmatched path',
    async (key) => {
      const response = responder()
      const { routes } = routeTable()

      // A route table looked up as an OBJECT would hand back an inherited member
      // for these — `routes['constructor']` is `Object`, a callable whose result
      // has neither a status nor a body. The table is a Map, which has no
      // inherited keys.
      await handleInternalDiagnosticsRequest(request({ url: `/${key}` }), response, routes)

      expect(response.status()).toBe(404)
      expect(response.body()).toBe(NOT_FOUND)
    },
  )

  it.each([
    ['POST', INTERNAL_DIAGNOSTICS_PATH],
    ['POST', INTERNAL_READINESS_PATH],
    ['HEAD', INTERNAL_READINESS_PATH],
    ['DELETE', INTERNAL_DIAGNOSTICS_PATH],
  ])('serves nothing but GET (%s %s)', async (method, url) => {
    const response = responder()
    const { routes, answers } = routeTable()

    await handleInternalDiagnosticsRequest(request({ method, url }), response, routes)

    expect(response.status()).toBe(404)
    expect(answers.diagnostics).not.toHaveBeenCalled()
    expect(answers.readiness).not.toHaveBeenCalled()
  })

  it('reduces a failed diagnostics probe to a bounded refusal and echoes nothing from it', async () => {
    const response = responder()
    const { routes } = routeTable({
      diagnostics: async () => {
        throw new Error('connect ECONNREFUSED 10.1.2.3:3306')
      },
    })

    await handleInternalDiagnosticsRequest(request(), response, routes)

    expect(response.status()).toBe(503)
    expect(JSON.parse(response.body() as string)).toEqual(DIAGNOSTICS_UNAVAILABLE)
    expect(response.body()).not.toContain('10.1.2.3')
  })

  it('answers a failed readiness probe IN THE READINESS VOCABULARY, never as a healthy auth', async () => {
    const response = responder()
    const { routes } = routeTable({
      readiness: async () => {
        throw new Error('connect ECONNREFUSED 10.1.2.3:3306')
      },
    })

    await handleInternalDiagnosticsRequest(request({ url: INTERNAL_READINESS_PATH }), response, routes)

    expect(response.status()).toBe(503)
    expect(response.body()).not.toContain('10.1.2.3')

    const body = JSON.parse(response.body() as string) as { status?: string; checks?: Record<string, boolean> }
    // This is the whole point of a per-route failure answer. `AdminController`
    // accepts a 503 and then reads these two fields; `authServiceEntry` scores
    // `status === undefined` plus an empty `checks` as 'ok'. So the body has to
    // carry a status that is not "ready" and at least one check that is false,
    // or a crashed probe is published as a working auth service.
    expect(body.status).toBe('unavailable')
    expect(Object.values(body.checks ?? {})).toContain(false)
    expect(Object.values(body.checks ?? {}).every(Boolean)).toBe(false)
  })

  it('serves no route at all from an empty table', async () => {
    const response = responder()

    await handleInternalDiagnosticsRequest(request(), response, new Map())

    expect(response.status()).toBe(404)
    expect(response.body()).toBe(NOT_FOUND)
  })
})

describe('startInternalDiagnosticsListener', () => {
  const logger = (): { info: jest.Mock; warn: jest.Mock } => ({ info: jest.fn(), warn: jest.fn() })

  const routesOf = (answer: () => Promise<{ status: number; body: unknown }>): InternalRouteTable =>
    new Map<string, InternalRoute>([
      [INTERNAL_DIAGNOSTICS_PATH, { answer, onFailure: { status: 503, body: { error: { message: 'no' } } } }],
    ])

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
      routes: routesOf(async () => ({ status: 200, body: { ok: true } })),
      logger: log,
      createServer: () => fake as unknown as http.Server,
    })

    expect(server).toBe(fake as unknown as http.Server)
    expect(fake.listenArgs?.slice(0, 2)).toEqual([3640, INTERNAL_DIAGNOSTICS_BIND_ADDRESS])
    expect(log.info).toHaveBeenCalledTimes(1)
  })

  it('names the paths it actually serves, so a missing route is visible in the log', async () => {
    const fake = new FakeServer('listen')
    const log = logger()

    await startInternalDiagnosticsListener({
      port: 3640,
      routes: new Map<string, InternalRoute>([
        [
          INTERNAL_DIAGNOSTICS_PATH,
          { answer: async () => ({ status: 200, body: {} }), onFailure: { status: 503, body: {} } },
        ],
        [
          INTERNAL_READINESS_PATH,
          { answer: async () => ({ status: 200, body: {} }), onFailure: { status: 503, body: {} } },
        ],
      ]),
      logger: log,
      createServer: () => fake as unknown as http.Server,
    })

    const message = log.info.mock.calls[0][0] as string
    expect(message).toContain(`${INTERNAL_DIAGNOSTICS_BIND_ADDRESS}:3640`)
    expect(message).toContain(INTERNAL_DIAGNOSTICS_PATH)
    expect(message).toContain(INTERNAL_READINESS_PATH)
  })

  it('degrades to no listener when the port cannot be bound, and never fails the boot', async () => {
    const log = logger()

    const server = await startInternalDiagnosticsListener({
      port: 3641,
      routes: routesOf(async () => ({ status: 200, body: { ok: true } })),
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
      routes: routesOf(async () => ({ status: 200, body: { ok: true } })),
      logger: log,
      createServer: () => fake as unknown as http.Server,
    })
    fake.emit('error', Object.assign(new Error('late'), { code: 'ECONNRESET' }))

    expect(server).toBe(fake as unknown as http.Server)
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('serves both real loopback requests end to end and refuses the forwarded ones', async () => {
    const log = logger()
    const readyBody = { status: 'ready', checks: { db: true, redis: true } }
    const server = await startInternalDiagnosticsListener({
      port: 3643,
      routes: new Map<string, InternalRoute>([
        [
          INTERNAL_DIAGNOSTICS_PATH,
          {
            answer: async () => ({ status: 200, body: { processUptimeSeconds: 11 } }),
            onFailure: { status: 503, body: { error: { message: 'no' } } },
          },
        ],
        [
          INTERNAL_READINESS_PATH,
          {
            answer: async () => ({ status: 200, body: readyBody }),
            onFailure: { status: 503, body: { status: 'unavailable', checks: { db: false, redis: false } } },
          },
        ],
      ]),
      logger: log,
    })
    expect(server).toBeDefined()

    try {
      const base = `http://${INTERNAL_DIAGNOSTICS_BIND_ADDRESS}:3643`

      const diagnostics = await fetch(`${base}${INTERNAL_DIAGNOSTICS_PATH}`)
      expect(diagnostics.status).toBe(200)
      expect(await diagnostics.json()).toEqual({ processUptimeSeconds: 11 })

      const readiness = await fetch(`${base}${INTERNAL_READINESS_PATH}`)
      expect(readiness.status).toBe(200)
      expect(await readiness.json()).toEqual(readyBody)

      for (const path of [INTERNAL_DIAGNOSTICS_PATH, INTERNAL_READINESS_PATH]) {
        const forwarded = await fetch(`${base}${path}`, { headers: { 'x-forwarded-for': '203.0.113.55' } })
        expect(forwarded.status).toBe(404)
        expect(await forwarded.json()).toEqual({ error: { message: 'Not Found' } })

        // The three headers a caller would forge to claim a loopback origin.
        // None of them can GRANT anything: the decision is the TCP peer.
        const spoofed = await fetch(`${base}${path}`, {
          headers: { 'x-real-ip': '127.0.0.1', 'x-origin-ip': '127.0.0.1' },
        })
        expect(spoofed.status).toBe(200)
      }
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()))
    }
  })
})
