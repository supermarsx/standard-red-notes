import 'reflect-metadata'

import { Response } from 'express'
import { DataSource, Repository } from 'typeorm'

import {
  AnnotatedHealthCheckController,
  DIAGNOSTICS_CACHE_TTL_MS,
  clearAuthRuntimeDiagnosticsCache,
} from './AnnotatedHealthCheckController'
import { Role } from '../../Domain/Role/Role'
import { CookieFactory } from '../../Domain/Auth/Cookies/CookieFactory'

/**
 * Standard Red Notes: the `/healthcheck/diagnostics` route the admin
 * Diagnostics pane reads through the gateway.
 *
 * THE TEST THAT MATTERS MOST HERE is the shape of the write probe. The route
 * runs a WRITE against a live deployment's database, so what it runs has to be
 * provably incapable of changing a row — and provable by the statement itself
 * rather than by a comment claiming so. The assertion below is on the SQL that
 * is emitted: an `UPDATE` that assigns a column to itself under an impossible
 * predicate. A statement that stopped being either of those fails this test.
 *
 * The second is that the cookie attributes come from the REAL `CookieFactory`
 * this container binds. Re-resolving `COOKIE_SECURE` here would be a second
 * place for a default-true setting to be got wrong, and "not set" and "off" are
 * opposite answers.
 */
describe('AnnotatedHealthCheckController /diagnostics', () => {
  let jsonMock: jest.Mock
  let statusMock: jest.Mock
  let queryMock: jest.Mock

  const response = (): Response => {
    jsonMock = jest.fn()
    statusMock = jest.fn(() => ({ json: jsonMock }))

    return { status: statusMock, json: jsonMock } as unknown as Response
  }

  const body = (): Record<string, never> => jsonMock.mock.calls[0][0]

  /**
   * A DataSource whose read and write both succeed. `MigrationExecutor` cannot
   * run against it, which is the realistic degradation: both migration fields
   * then stay ABSENT rather than defaulting to applied.
   */
  const dataSourceWith = (overrides: Record<string, unknown> = {}): DataSource => {
    queryMock = jest.fn(async () => [])

    return {
      isInitialized: true,
      query: queryMock,
      driver: {
        pool: { _allConnections: { length: 5 }, _freeConnections: { length: 2 }, config: { connectionLimit: 20 } },
      },
      ...overrides,
    } as unknown as DataSource
  }

  const controllerWith = (
    dataSource: DataSource,
    cookies = new CookieFactory('Lax', '', false, false),
    e2eTesting = false,
  ): AnnotatedHealthCheckController =>
    new AnnotatedHealthCheckController(
      { manager: { connection: dataSource } } as unknown as Repository<Role>,
      undefined,
      cookies,
      e2eTesting,
    )

  beforeEach(() => {
    clearAuthRuntimeDiagnosticsCache()
  })

  afterAll(() => {
    clearAuthRuntimeDiagnosticsCache()
  })

  it('probes the store with a read and a write that cannot change a row', async () => {
    await controllerWith(dataSourceWith()).diagnostics(response())

    const statements = queryMock.mock.calls.map((call) => String(call[0]))
    expect(statements[0]).toBe('SELECT 1')
    // Structural, not a denylist: a self-assignment under an impossible
    // predicate. It is still a WRITE — a read-only server, a read-only replica
    // and a revoked UPDATE grant all refuse it, which is the whole point — and
    // it matches no row, so it takes no row lock and writes no undo record.
    expect(statements[1]).toMatch(/^UPDATE [a-z_]+ SET ([a-z_]+) = \1 WHERE 1 = 0$/)
    expect(statements).toHaveLength(2)
  })

  it('answers 200 with the effective cookie attributes from the real factory', async () => {
    await controllerWith(dataSourceWith(), new CookieFactory('None', 'notes.example.com', true, true)).diagnostics(
      response(),
    )

    expect(statusMock).toHaveBeenCalledWith(200)
    expect(body()).toMatchObject({ session: { cookieSecure: true, cookiePartitioned: true, e2eTesting: false } })
    // The domain the factory was built with never reaches the body, even though
    // the header the attributes were read from carried it.
    expect(JSON.stringify(body())).not.toContain('notes.example.com')
  })

  it('reports the legacy-session switch and the pool census', async () => {
    await controllerWith(dataSourceWith(), new CookieFactory('Lax', '', false, false), true).diagnostics(response())

    expect(body()).toMatchObject({
      session: { e2eTesting: true },
      datastore: { connectionState: 'connected', writeProbe: 'accepted', poolInUse: 3, poolSize: 20 },
    })
  })

  it('reports an uptime that is a whole-second duration, never an instant', async () => {
    const uptime = jest.spyOn(process, 'uptime').mockReturnValue(4321.8)

    await controllerWith(dataSourceWith()).diagnostics(response())

    expect(body()).toMatchObject({ processUptimeSeconds: 4321 })
    expect(JSON.stringify(body())).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    uptime.mockRestore()
  })

  it('reports `disconnected` without touching the database when the handle is not initialized', async () => {
    await controllerWith(dataSourceWith({ isInitialized: false })).diagnostics(response())

    expect(body()).toMatchObject({ datastore: { connectionState: 'disconnected', writeProbe: 'not-attempted' } })
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('answers 200 even when the store is unreachable, so a sick database cannot fail the route', async () => {
    const dataSource = dataSourceWith()
    queryMock.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.3.14:3306'))

    await controllerWith(dataSource).diagnostics(response())

    expect(statusMock).toHaveBeenCalledWith(200)
    expect(body()).toMatchObject({ datastore: { connectionState: 'handle-only' } })
    // The driver error is never read, so there is no field for the host and port
    // it carries.
    expect(JSON.stringify(body())).not.toContain('10.0.3.14')
  })

  it('re-serves one answer inside the cache window, so the probes cannot be driven in a loop', async () => {
    // The route is reachable by anything that can reach this service on the
    // internal network and it does real database work. One probe set per window
    // bounds that, and costs the pane nothing: a schema's migration state does
    // not change between two clicks.
    const first = dataSourceWith()
    await controllerWith(first).diagnostics(response())
    const firstCalls = queryMock.mock.calls.length

    const second = dataSourceWith()
    await controllerWith(second).diagnostics(response())

    expect(firstCalls).toBe(2)
    expect(queryMock).not.toHaveBeenCalled()
    expect(DIAGNOSTICS_CACHE_TTL_MS).toBeGreaterThan(0)
  })

  it('probes again once the window has passed', async () => {
    const now = jest.spyOn(Date, 'now')
    now.mockReturnValue(1_000_000)
    await controllerWith(dataSourceWith()).diagnostics(response())

    now.mockReturnValue(1_000_000 + DIAGNOSTICS_CACHE_TTL_MS + 1)
    await controllerWith(dataSourceWith()).diagnostics(response())

    expect(queryMock.mock.calls.length).toBe(2)
    now.mockRestore()
  })
})
