import 'reflect-metadata'

import { Request, Response } from 'express'

import { AdminController } from './AdminController'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'
import { ServiceControlService } from '../../Service/ServiceControl/ServiceControlService'
import { deploymentDiagnostics, observeDeployment } from '../../Service/Diagnostics/DeploymentDiagnostics'
import { syncGateDiagnostics } from '../../Service/Sync/SyncGateDiagnostics'
import { syncWebSocketAccessService } from '../../Service/Sync/SyncWebSocketAccessService'
import {
  AUTH_RUNTIME_PROBE_OUTCOMES,
  DATABASE_CONNECTION_STATES,
  MAX_REPORTED_CONSUMERS,
  MAX_REPORTED_MIGRATIONS,
  MAX_REPORTED_POOL,
  MAX_ROUND_TRIP_MS,
  MAX_UPTIME_SECONDS,
  QUEUE_SEPARATIONS,
  WRITE_PROBE_OUTCOMES,
} from '../../Service/Diagnostics/RuntimeDiagnostics'

jest.mock('../../Service/Assistant/providers/factory', () => ({
  configuredProviders: jest.fn().mockReturnValue([]),
}))

/**
 * Standard Red Notes: the three blocks `/v1/admin/sync-diagnostics` grew so that
 * the admin Diagnostics pane stops reading "no endpoint publishes this" —
 * `runtime`, `datastore` and `queues`.
 *
 * WHAT THIS FILE HOLDS, end to end and through the real handler rather than
 * through the reader alone:
 *
 *   1. The endpoint stays ADMIN-ONLY. It now reports a database's state and a
 *      deployment's queue topology, so widening access would be worse than the
 *      blank rows it replaces.
 *   2. The uptime ADVANCES and is a duration, never an instant. A start
 *      timestamp would let a reader of the (deliberately pasteable) report line
 *      this deployment up against other logs and buys nothing.
 *   3. Nothing but contract-conformant values reaches the response, asserted on
 *      WHAT IS EMITTED rather than against a list of forbidden substrings — a
 *      denylist passes a structureless secret, passes a differently-shaped
 *      address, and passes a field nobody thought to poison.
 *   4. Every I/O failure degrades to a closed token. The endpoint must not 5xx
 *      because a sibling container is down: that is the deployment the pane is
 *      for.
 */
describe('AdminController runtime diagnostics', () => {
  let jsonMock: jest.Mock
  let statusMock: jest.Mock
  let realFetch: typeof globalThis.fetch

  const AUTH_PROBE_BASE = 'http://localhost:3103'

  /** A well-formed auth answer: the shape the real route serves. */
  const HEALTHY_AUTH_BODY = {
    processUptimeSeconds: 931.77,
    session: { cookieSecure: false, cookiePartitioned: false, e2eTesting: false },
    datastore: {
      connectionState: 'connected',
      writeProbe: 'accepted',
      migrationsApplied: true,
      pendingMigrations: 0,
      poolInUse: 2,
      poolSize: 20,
      readRoundTripMs: 3,
      writeRoundTripMs: 5,
    },
  }

  type FetchStub = { status: number; body?: unknown; reject?: boolean }

  const stubAuthFetch = (stub: FetchStub): jest.Mock => {
    const fetchMock = jest.fn(async (url: string) => {
      if (!url.endsWith('/healthcheck/diagnostics')) {
        // Every other probe this endpoint's siblings make stays unreachable, so
        // the only network behaviour under test is the runtime route.
        throw new Error('not under test')
      }
      if (stub.reject === true) {
        throw new Error('ECONNREFUSED')
      }

      return { status: stub.status, json: async () => stub.body }
    })
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

    return fetchMock
  }

  /**
   * The probe map defaults to a resolvable auth base, because that is what a
   * real container binds (`SERVICE_PROBE_URLS` always resolves, falling back to
   * the supervisord sibling port). `noAuthProbeUrl` is the deliberate opposite,
   * for the one test that needs no target at all.
   */
  const makeController = (
    options: {
      serviceProbeUrls?: Record<string, string>
      serviceControlService?: ServiceControlService
      noAuthProbeUrl?: boolean
    } = {},
  ): AdminController =>
    new AdminController(
      {} as ServiceProxyInterface,
      {} as EndpointResolverInterface,
      undefined,
      undefined,
      undefined,
      undefined,
      // No AUTH_SERVER_URL fallback: the probe map below is the only resolution
      // under test, exactly as on a real container.
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      options.noAuthProbeUrl === true ? {} : (options.serviceProbeUrls ?? { auth: AUTH_PROBE_BASE }),
      undefined,
      undefined,
      options.serviceControlService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    )

  const responseWith = (roles: Array<{ name: string }>): Response => {
    jsonMock = jest.fn()
    statusMock = jest.fn(() => ({ json: jsonMock }))

    return {
      locals: { user: { uuid: 'admin-1' }, roles },
      setHeader: jest.fn(),
      status: statusMock,
      json: jsonMock,
    } as unknown as Response
  }

  const adminResponse = (): Response => responseWith([{ name: 'ADMIN_USER' }])

  type Payload = {
    runtime: Record<string, unknown>
    datastore?: Record<string, unknown>
    queues: Record<string, unknown>
  }

  const payload = (): Payload => jsonMock.mock.calls[0][0] as Payload

  const supervisordWith = (statuses: Record<string, string>): ServiceControlService =>
    ({
      getProgramStatuses: async () => ({ available: Object.keys(statuses).length > 0, statuses }),
    }) as unknown as ServiceControlService

  beforeEach(() => {
    realFetch = globalThis.fetch
    syncGateDiagnostics.clear()
    deploymentDiagnostics.clear()
    syncWebSocketAccessService.clearProvider()
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    syncGateDiagnostics.clear()
    deploymentDiagnostics.clear()
    syncWebSocketAccessService.clearProvider()
  })

  /* ------------------------------------------------------------------------ */
  /* The emitted contract                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * Every key the three new blocks may carry, and what its value may be.
   *
   * A key emitted that is not named here FAILS. That is the arm a denylist
   * cannot have: it catches a field added later with no sentinel planted in it,
   * and it catches a value whose shape nobody anticipated.
   */
  const CONTRACT: Record<
    string,
    { kind: 'boolean' } | { kind: 'closed'; allowed: readonly string[] } | { kind: 'bound'; max: number }
  > = {
    // runtime
    processUptimeSeconds: { kind: 'bound', max: MAX_UPTIME_SECONDS },
    authRuntimeProbe: { kind: 'closed', allowed: AUTH_RUNTIME_PROBE_OUTCOMES },
    authProcessUptimeSeconds: { kind: 'bound', max: MAX_UPTIME_SECONDS },
    cookieSecure: { kind: 'boolean' },
    cookiePartitioned: { kind: 'boolean' },
    e2eTesting: { kind: 'boolean' },
    // datastore
    connectionState: { kind: 'closed', allowed: [...DATABASE_CONNECTION_STATES, 'other'] },
    writeProbe: { kind: 'closed', allowed: [...WRITE_PROBE_OUTCOMES, 'other'] },
    migrationsApplied: { kind: 'boolean' },
    pendingMigrations: { kind: 'bound', max: MAX_REPORTED_MIGRATIONS },
    poolInUse: { kind: 'bound', max: MAX_REPORTED_POOL },
    poolSize: { kind: 'bound', max: MAX_REPORTED_POOL },
    readRoundTripMs: { kind: 'bound', max: MAX_ROUND_TRIP_MS },
    writeRoundTripMs: { kind: 'bound', max: MAX_ROUND_TRIP_MS },
    // queues
    separation: { kind: 'closed', allowed: QUEUE_SEPARATIONS },
    consumerCount: { kind: 'bound', max: MAX_REPORTED_CONSUMERS },
  }

  /** Assert a block against the contract and return the leaves it inspected. */
  const assertBlock = (block: Record<string, unknown> | undefined, name: string): string[] => {
    if (block === undefined) {
      return []
    }

    const checked: string[] = []
    for (const [key, value] of Object.entries(block)) {
      // `JSON.stringify` drops an `undefined` property, so a field this handler
      // deliberately omitted never reaches a client; in-process it is still a
      // key with an undefined value, and omitting is what the panel reads as
      // "not reported".
      if (value === undefined) {
        continue
      }
      const rule = CONTRACT[key]
      if (rule === undefined) {
        throw new Error(`${name}.${key} is emitted but not named in the contract`)
      }
      if (rule.kind === 'boolean') {
        expect(typeof value).toBe('boolean')
      } else if (rule.kind === 'closed') {
        expect(rule.allowed).toContain(value)
      } else {
        expect(typeof value).toBe('number')
        expect(Number.isInteger(value)).toBe(true)
        expect(value as number).toBeGreaterThanOrEqual(0)
        expect(value as number).toBeLessThanOrEqual(rule.max)
      }
      checked.push(`${name}.${key}`)
    }

    return checked
  }

  /* ------------------------------------------------------------------------ */

  it('refuses a non-admin with 403 and answers nothing', async () => {
    const response = responseWith([{ name: 'CORE_USER' }])

    await makeController().getSyncDiagnostics({} as Request, response)

    expect(statusMock).toHaveBeenCalledWith(403)
    expect(jsonMock).toHaveBeenCalledWith({ error: { message: 'Admin role required.' } })
  })

  it('publishes this process’s uptime as a duration that advances', async () => {
    // The answer to "I changed the setting and restarted — did it take?", which
    // is the most-asked question in this area and had no producer at all: neither
    // admin endpoint carried a process start in any field, and the readiness
    // probes they relay carry only a status and per-check booleans.
    const uptime = jest.spyOn(process, 'uptime')
    uptime.mockReturnValueOnce(12.9)
    stubAuthFetch({ status: 404 })

    await makeController().getSyncDiagnostics({} as Request, adminResponse())
    const first = payload().runtime.processUptimeSeconds as number

    uptime.mockReturnValueOnce(75.4)
    jsonMock.mockClear()
    await makeController().getSyncDiagnostics({} as Request, adminResponse())
    const second = payload().runtime.processUptimeSeconds as number

    expect(first).toBe(12)
    expect(second).toBe(75)
    expect(second).toBeGreaterThan(first)
    uptime.mockRestore()
  })

  it('carries no absolute instant for the process start anywhere in the runtime block', async () => {
    // A duration answers the question; an instant additionally lets a reader of
    // the public report correlate this deployment against other logs. The only
    // timestamp this payload has ever carried is `capturedAt`, which is the
    // reading's own age and not a property of the deployment.
    stubAuthFetch({ status: 200, body: HEALTHY_AUTH_BODY })

    await makeController().getSyncDiagnostics({} as Request, adminResponse())

    const runtimeJson = JSON.stringify(payload().runtime)
    expect(runtimeJson).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('serves the auth-owned facts a browser structurally cannot observe', async () => {
    // The session cookie is HttpOnly, so it is not script-readable, and a
    // cookie's attributes are never exposed to a page even when the cookie is.
    // Presence of the variables would not substitute either: both attributes
    // default to ON when unset, so "unset" and "off" are opposite answers.
    stubAuthFetch({ status: 200, body: HEALTHY_AUTH_BODY })

    await makeController().getSyncDiagnostics({} as Request, adminResponse())

    expect(payload().runtime).toMatchObject({
      authRuntimeProbe: 'answered',
      authProcessUptimeSeconds: 931,
      cookieSecure: false,
      cookiePartitioned: false,
      e2eTesting: false,
    })
  })

  it('publishes the durable store as the service that owns the handle reports it', async () => {
    stubAuthFetch({ status: 200, body: HEALTHY_AUTH_BODY })

    await makeController().getSyncDiagnostics({} as Request, adminResponse())

    expect(payload().datastore).toEqual({
      connectionState: 'connected',
      writeProbe: 'accepted',
      migrationsApplied: true,
      pendingMigrations: 0,
      poolInUse: 2,
      poolSize: 20,
      readRoundTripMs: 3,
      writeRoundTripMs: 5,
    })
  })

  it('reports the handle-only store no readiness probe can see', async () => {
    // An initialized DataSource whose queries do not complete. The service
    // answers HTTP perfectly, and every route that touches the database fails.
    stubAuthFetch({
      status: 200,
      body: { ...HEALTHY_AUTH_BODY, datastore: { connectionState: 'handle-only', writeProbe: 'not-attempted' } },
    })

    await makeController().getSyncDiagnostics({} as Request, adminResponse())

    expect(payload().datastore).toEqual({ connectionState: 'handle-only', writeProbe: 'not-attempted' })
  })

  it('does not put a datastore block on the wire when auth did not answer', async () => {
    // ABSENT IS NOT HEALTHY. A fabricated `connected` here would be the panel
    // inventing the one reading it exists to make observable.
    stubAuthFetch({ reject: true, status: 0 })

    await makeController().getSyncDiagnostics({} as Request, adminResponse())

    expect(payload().runtime.authRuntimeProbe).toBe('unreachable')
    expect(payload().datastore).toBeUndefined()
    expect(payload().runtime.cookieSecure).toBeUndefined()
  })

  it('separates an auth older than the route from an auth that could not be reached', async () => {
    stubAuthFetch({ status: 404 })
    await makeController().getSyncDiagnostics({} as Request, adminResponse())
    expect(payload().runtime.authRuntimeProbe).toBe('unreadable')

    jsonMock.mockClear()
    stubAuthFetch({ status: 200, body: 'ECONNREFUSED 10.0.3.14:3306' })
    await makeController().getSyncDiagnostics({} as Request, adminResponse())
    expect(payload().runtime.authRuntimeProbe).toBe('unreadable')
  })

  it('refuses a body carried by a NON-200 answer, however well-formed it looks', async () => {
    // The status is read before the body, and this is the arm that needs saying:
    // a 503 carrying a perfectly shaped diagnostics object is a service that
    // declared itself unavailable, and publishing its figures as a live reading
    // would put `connected` on the screen for a store that just said otherwise.
    // The route this build serves always answers 200; a proxy, a load balancer
    // or an older image in front of it need not.
    stubAuthFetch({ status: 503, body: HEALTHY_AUTH_BODY })

    await makeController().getSyncDiagnostics({} as Request, adminResponse())

    expect(payload().runtime.authRuntimeProbe).toBe('unreadable')
    expect(payload().runtime.cookieSecure).toBeUndefined()
    expect(payload().datastore).toBeUndefined()
  })

  it('reports no probe target as such rather than as a dial failure', async () => {
    await makeController({ noAuthProbeUrl: true }).getSyncDiagnostics({} as Request, adminResponse())

    expect(payload().runtime.authRuntimeProbe).toBe('not-configured')
  })

  /* ------------------------------------------------------------------------ */
  /* The queue verdict                                                        */
  /* ------------------------------------------------------------------------ */

  const recordDeployment = (presence: Record<string, string | undefined>, mode = 'self-hosted'): void => {
    deploymentDiagnostics.record(
      observeDeployment((key) => (key === 'MODE' ? mode : presence[key]), {
        boundServiceProxy: 'http',
        grpcSyncingProxyBound: false,
        redisBound: true,
      }),
    )
  }

  it('names the queue collision that presence alone provably cannot express', async () => {
    // The measured defect: the compose stack's workers inherited the gateway's
    // bare SQS_QUEUE_URL, a queue delivers each message once, and roughly four in
    // five realtime pushes plus revision and e-mail events went to whichever
    // consumer won the race and were then deleted. Nothing logged an error.
    recordDeployment({ SQS_QUEUE_URL: 'queue' })
    stubAuthFetch({ status: 404 })

    await makeController({
      serviceControlService: supervisordWith({ 'api-gateway': 'RUNNING', 'auth-worker': 'RUNNING' }),
    }).getSyncDiagnostics({} as Request, adminResponse())

    expect(payload().queues).toEqual({ separation: 'inherited-shared-queue', consumerCount: 2 })
  })

  it('reports the prefix fix as in place when the gateway owns its queue', async () => {
    recordDeployment({ SQS_QUEUE_URL: 'queue', API_GATEWAY_SQS_QUEUE_URL: 'queue' })
    stubAuthFetch({ status: 404 })

    await makeController({
      serviceControlService: supervisordWith({ 'auth-worker': 'RUNNING' }),
    }).getSyncDiagnostics({} as Request, adminResponse())

    expect(payload().queues.separation).toBe('own-prefixed-queue')
  })

  it('withholds the verdict when the other consumers are invisible from this process', async () => {
    // Identical presence booleans to the collision above. Without a co-resident
    // consumer to compare against, a second consumer could be in another
    // container, and a row reading "not reported" beats one that says the fix is
    // in place over a live collision.
    recordDeployment({ SQS_QUEUE_URL: 'queue' })
    stubAuthFetch({ status: 404 })

    await makeController().getSyncDiagnostics({} as Request, adminResponse())

    expect(payload().queues.separation).toBeUndefined()
    expect(payload().queues.consumerCount).toBeUndefined()
  })

  it('makes no queue claim at all before the deployment report is recorded', async () => {
    stubAuthFetch({ status: 404 })

    await makeController({
      serviceControlService: supervisordWith({ 'auth-worker': 'RUNNING' }),
    }).getSyncDiagnostics({} as Request, adminResponse())

    // `recorded: false` means the container had not finished configuring, so
    // presence is empty — and an empty presence map must not read as "no queue".
    expect(payload().queues.separation).toBeUndefined()
    // The census IS taken — the control channel answered — but with no recorded
    // presence there is nothing for it to resolve, and the gateway does not
    // count itself as a consumer of a queue it cannot see configured.
    expect(payload().queues.consumerCount).toBe(1)
  })

  /* ------------------------------------------------------------------------ */
  /* The structural secrecy sweep                                             */
  /* ------------------------------------------------------------------------ */

  it('emits nothing but contract-conformant values, with every readable field populated', async () => {
    // The positive half of the sweep: a fully-reporting deployment, so the
    // structural assertion below is exercising real leaves rather than passing
    // over an empty payload. A flattering denominator is one of the ways one of
    // these tests comes to prove nothing.
    recordDeployment({ SQS_QUEUE_URL: 'queue', SRN_SERVICE_PROXY_TYPE_DECISION: 'grpc-default' })
    stubAuthFetch({ status: 200, body: HEALTHY_AUTH_BODY })

    await makeController({
      serviceProbeUrls: { auth: AUTH_PROBE_BASE },
      serviceControlService: supervisordWith({ 'auth-worker': 'RUNNING' }),
    }).getSyncDiagnostics({} as Request, adminResponse())

    const body = payload()
    const checked = [
      ...assertBlock(body.runtime, 'runtime'),
      ...assertBlock(body.datastore, 'datastore'),
      ...assertBlock(body.queues, 'queues'),
    ]

    // 6 runtime + 8 datastore + 2 queues. If a block silently stopped reporting,
    // this count falls and the test fails rather than passing on absence.
    expect(checked).toHaveLength(16)
  })

  it('emits nothing but contract-conformant values from an auth answer whose every leaf is a disclosure', async () => {
    // The hostile half. Each leaf is a different SHAPE of leak — a queue URL
    // with an embedded credential, a bare host and port, a connection string, a
    // structureless 64-hex secret, a free-form driver error (which is where a
    // probe failure puts an address), an unbounded figure — plus keys this build
    // has never heard of. The assertion is on what is EMITTED: unnamed keys
    // fail, so a field nobody thought to poison is caught too.
    recordDeployment({ SQS_QUEUE_URL: 'queue' })
    stubAuthFetch({
      status: 200,
      body: {
        processUptimeSeconds: 'https://admin:hunter2@sqs.eu-west-1.amazonaws.com/123456789012/srn-events',
        session: {
          cookieSecure: 'true',
          cookiePartitioned: 'db.internal.example:3306',
          e2eTesting: 1,
          cookieDomain: 'notes.example.com',
        },
        datastore: {
          connectionState: 'mysql://std_notes_user:changeme123@db:3306/standard_notes_db',
          writeProbe: 'ER_OPTION_PREVENTS_STATEMENT: --read-only on db.internal.example:3306',
          migrationsApplied: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          pendingMigrations: 10 ** 12,
          poolInUse: -7,
          readRoundTripMs: Number.NaN,
          writeRoundTripMs: 99_999_999,
          lastError: 'connect ECONNREFUSED 10.0.3.14:3306',
          schemaName: 'standard_notes_db',
          migrationNames: ['1700000000000-AddSharedVaultUsers'],
        },
        queueUrl: 'https://sqs.eu-west-1.amazonaws.com/123456789012/srn-events',
      },
    })

    await makeController({
      serviceProbeUrls: { auth: AUTH_PROBE_BASE },
      serviceControlService: supervisordWith({ 'auth-worker': 'RUNNING' }),
    }).getSyncDiagnostics({} as Request, adminResponse())

    const body = payload()
    const checked = [
      ...assertBlock(body.runtime, 'runtime'),
      ...assertBlock(body.datastore, 'datastore'),
      ...assertBlock(body.queues, 'queues'),
    ]

    // Something WAS inspected, so the sweep is not passing on an empty payload.
    expect(checked.length).toBeGreaterThan(0)
    // The two leaves whose declared type the hostile body satisfied collapse to
    // the closed fallback rather than echoing a word of it.
    expect(body.datastore).toEqual({ connectionState: 'other', writeProbe: 'other' })
    // Every numeric leaf of the hostile body was outside its declared bound or
    // not a number at all, and each is ABSENT rather than clamped into a
    // plausible reading no process measured.
    expect(Object.keys(body.datastore as object).sort()).toEqual(['connectionState', 'writeProbe'])
    // Corroborating only, and deliberately second: this is the denylist arm, and
    // it is here to document the shapes, not to be the boundary.
    const serialized = JSON.stringify(body)
    for (const planted of [
      'hunter2',
      'sqs.eu-west-1.amazonaws.com',
      'db.internal.example',
      'std_notes_user',
      'changeme123',
      'standard_notes_db',
      '10.0.3.14',
      'ECONNREFUSED',
      'deadbeef',
      'AddSharedVaultUsers',
      'notes.example.com',
      '3306',
    ]) {
      expect(serialized).not.toContain(planted)
    }
  })

  it('never lets a sibling service failure take the endpoint down', async () => {
    // The deployment this pane exists for is the broken one, so every I/O arm
    // has to degrade to a field value rather than a status code.
    recordDeployment({ SQS_QUEUE_URL: 'queue' })
    globalThis.fetch = (() => {
      throw new Error('boom')
    }) as unknown as typeof globalThis.fetch

    const throwingControl = {
      getProgramStatuses: async () => {
        throw new Error('supervisorctl is not installed')
      },
    } as unknown as ServiceControlService

    await makeController({
      serviceProbeUrls: { auth: AUTH_PROBE_BASE },
      serviceControlService: throwingControl,
    }).getSyncDiagnostics({} as Request, adminResponse())

    expect(statusMock).not.toHaveBeenCalled()
    expect(payload().runtime.authRuntimeProbe).toBe('unreachable')
    expect(payload().queues).toEqual({ separation: undefined, consumerCount: undefined })
  })
})
