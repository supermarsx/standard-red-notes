import 'reflect-metadata'

import { DataSource, Repository } from 'typeorm'

import TYPES from '../../Bootstrap/Types'
import { CookieFactoryInterface } from '../../Domain/Auth/Cookies/CookieFactoryInterface'
import { InviteEventOutboxDispatcher } from '../../Domain/Invite/InviteEventOutboxDispatcher'
import { InviteEventOutboxRepositoryInterface } from '../../Domain/Invite/InviteEventOutboxRepositoryInterface'
import { TypeORMInviteEventOutbox } from '../TypeORM/TypeORMInviteEventOutbox'
import {
  AuthDiagnosticsBindings,
  DIAGNOSTICS_CACHE_TTL_MS,
  clearAuthRuntimeDiagnosticsCache,
  readAuthRuntimeDiagnosticsSources,
  resolveAuthRuntimeDiagnosticsReport,
} from './AuthRuntimeDiagnosticsEndpoint'

/**
 * Standard Red Notes: the ONE composition of the `/healthcheck/diagnostics`
 * answer, shared by auth's annotated controller and by the bundled
 * home-server's loopback-only internal listener.
 *
 * WHAT THESE TESTS ARE FOR. Everything the route decides lives here now, so
 * these are the tests that hold the decisions a second copy would get subtly
 * wrong: that an absent outbox OMITS the census rather than reporting zero dead
 * rows (zero is the healthy reading an operator stops looking at), that the
 * answer window is SHARED rather than one per entry point, and that a container
 * with no auth bindings yields NO sources — so the caller mounts no route
 * instead of mounting one that answers with a fabricated reading.
 */
describe('resolveAuthRuntimeDiagnosticsReport', () => {
  let queryMock: jest.Mock

  beforeEach(() => {
    clearAuthRuntimeDiagnosticsCache()
  })

  /** A data source whose read and write both succeed, with a mysql-shaped pool. */
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

  const cookieFactory = (header: string): CookieFactoryInterface =>
    ({ createCookieHeaderValue: (): string[] => [header] }) as unknown as CookieFactoryInterface

  const outboxEntityRepository = (count: number): Repository<TypeORMInviteEventOutbox> =>
    ({ countBy: jest.fn(async () => count) }) as unknown as Repository<TypeORMInviteEventOutbox>

  it('reads the effective cookie attributes off the real factory header', async () => {
    const report = await resolveAuthRuntimeDiagnosticsReport({
      dataSource: dataSourceWith(),
      cookieFactory: cookieFactory('session=abc; HttpOnly; Secure; Partitioned'),
      forceLegacySessions: true,
    })

    expect(report.session).toEqual({ cookieSecure: true, cookiePartitioned: true, e2eTesting: true })
  })

  it('reports both cookie attributes off and no legacy-session mode when neither binding is present', async () => {
    const report = await resolveAuthRuntimeDiagnosticsReport({ dataSource: dataSourceWith() })

    expect(report.session).toEqual({ cookieSecure: false, cookiePartitioned: false, e2eTesting: false })
  })

  it('reports legacy sessions OFF when the binding says false, not merely when it is absent', async () => {
    // `E2E_TESTING` forces header sessions for every user on the deployment, so
    // "bound to false" and "not bound" are the same answer and both must read
    // false — a presence test would report a deployment as legacy-session mode.
    const report = await resolveAuthRuntimeDiagnosticsReport({
      dataSource: dataSourceWith(),
      forceLegacySessions: false,
    })

    expect(report.session.e2eTesting).toBe(false)
  })

  it('probes the datastore through the supplied data source', async () => {
    const report = await resolveAuthRuntimeDiagnosticsReport({ dataSource: dataSourceWith() })

    expect(report.datastore.connectionState).toBe('connected')
    expect(report.datastore.writeProbe).toBe('accepted')
    expect(report.datastore.poolSize).toBe(20)
    expect(queryMock.mock.calls.map(([sql]) => sql)).toEqual(['SELECT 1', 'UPDATE roles SET name = name WHERE 1 = 0'])
  })

  it('OMITS the queue block when no outbox entity repository is bound', async () => {
    const report = await resolveAuthRuntimeDiagnosticsReport({ dataSource: dataSourceWith() })

    // ABSENT IS NOT ZERO. Zero dead rows is the healthy reading an operator
    // stops looking at, so a store this process cannot count must report no
    // block at all rather than an empty one.
    expect(report.queue).toBeUndefined()
    expect(Object.keys(report)).not.toContain('queue')
  })

  it('OMITS the queue block when only the two auxiliary outbox bindings are present', async () => {
    const report = await resolveAuthRuntimeDiagnosticsReport({
      dataSource: dataSourceWith(),
      outboxRepository: { requeueFailed: jest.fn() } as unknown as InviteEventOutboxRepositoryInterface,
      outboxDispatcher: { isDrainArmed: (): boolean => true } as unknown as InviteEventOutboxDispatcher,
    })

    expect(report.queue).toBeUndefined()
  })

  it('takes the dead-row census when the outbox entity repository is bound', async () => {
    const report = await resolveAuthRuntimeDiagnosticsReport({
      dataSource: dataSourceWith(),
      outboxEntityRepository: outboxEntityRepository(2),
      outboxRepository: { requeueFailed: jest.fn() } as unknown as InviteEventOutboxRepositoryInterface,
      outboxDispatcher: { isDrainArmed: (): boolean => true } as unknown as InviteEventOutboxDispatcher,
    })

    expect(report.queue).toEqual({ deadLetterRows: 2, deadLetterRequeueable: true })
  })

  it('reports counted rows as not requeueable when no drain loop is armed', async () => {
    const report = await resolveAuthRuntimeDiagnosticsReport({
      dataSource: dataSourceWith(),
      outboxEntityRepository: outboxEntityRepository(3),
      outboxRepository: { requeueFailed: jest.fn() } as unknown as InviteEventOutboxRepositoryInterface,
      outboxDispatcher: { isDrainArmed: (): boolean => false } as unknown as InviteEventOutboxDispatcher,
    })

    expect(report.queue).toEqual({ deadLetterRows: 3, deadLetterRequeueable: false })
  })

  it('re-serves ONE shared answer inside the window, however many entry points ask', async () => {
    const first = dataSourceWith()
    const report = await resolveAuthRuntimeDiagnosticsReport({ dataSource: first }, 1_000)
    const firstProbeCount = queryMock.mock.calls.length

    // A DIFFERENT sources object, standing in for the other entry point: the
    // window belongs to the module, not to a controller instance.
    const second = dataSourceWith()
    const reserved = await resolveAuthRuntimeDiagnosticsReport(
      { dataSource: second },
      1_000 + DIAGNOSTICS_CACHE_TTL_MS - 1,
    )

    expect(reserved).toBe(report)
    expect(firstProbeCount).toBeGreaterThan(0)
    // `queryMock` is now the SECOND data source's: it was never probed.
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('probes again once the window has elapsed', async () => {
    await resolveAuthRuntimeDiagnosticsReport({ dataSource: dataSourceWith() }, 1_000)

    const next = dataSourceWith()
    await resolveAuthRuntimeDiagnosticsReport({ dataSource: next }, 1_000 + DIAGNOSTICS_CACHE_TTL_MS)

    expect(queryMock).toHaveBeenCalled()
  })

  it('reports a handle with no live connection rather than a healthy store', async () => {
    const report = await resolveAuthRuntimeDiagnosticsReport({
      dataSource: dataSourceWith({
        query: jest.fn(async () => {
          throw new Error('connect ECONNREFUSED 10.1.2.3:3306')
        }),
      }),
    })

    expect(report.datastore.connectionState).toBe('handle-only')
    expect(report.datastore.writeProbe).toBe('not-attempted')
    expect(JSON.stringify(report)).not.toContain('10.1.2.3')
  })
})

describe('readAuthRuntimeDiagnosticsSources', () => {
  const dataSource = { isInitialized: true } as unknown as DataSource

  /**
   * `get` THROWS on an unbound identifier, exactly as inversify does. A fake
   * that returned `undefined` instead would let a reader that skipped `isBound`
   * pass here and crash a real boot.
   */
  const bindings = (bound: Map<symbol, unknown>): AuthDiagnosticsBindings =>
    ({
      isBound: (identifier: symbol): boolean => bound.has(identifier),
      get: (identifier: symbol): unknown => {
        if (!bound.has(identifier)) {
          throw new Error(`No bindings found for service: ${String(identifier)}`)
        }

        return bound.get(identifier)
      },
    }) as unknown as AuthDiagnosticsBindings

  it('yields NO sources when the container holds no auth role repository', () => {
    expect(readAuthRuntimeDiagnosticsSources(bindings(new Map()))).toBeUndefined()
  })

  it('yields NO sources when the bound repository exposes no connection', () => {
    const bound = new Map<symbol, unknown>([[TYPES.Auth_ORMRoleRepository, { manager: {} }]])

    expect(readAuthRuntimeDiagnosticsSources(bindings(bound))).toBeUndefined()
  })

  it('reads the data source and every optional binding the container holds', () => {
    const cookieFactory = { createCookieHeaderValue: (): string[] => [] }
    const outboxEntityRepository = { countBy: jest.fn() }
    const outboxRepository = { requeueFailed: jest.fn() }
    const outboxDispatcher = { isDrainArmed: (): boolean => true }
    const bound = new Map<symbol, unknown>([
      [TYPES.Auth_ORMRoleRepository, { manager: { connection: dataSource } }],
      [TYPES.Auth_CookieFactory, cookieFactory],
      [TYPES.Auth_FORCE_LEGACY_SESSIONS, true],
      [TYPES.Auth_ORMInviteEventOutboxRepository, outboxEntityRepository],
      [TYPES.Auth_InviteEventOutboxRepository, outboxRepository],
      [TYPES.Auth_InviteEventOutboxDispatcher, outboxDispatcher],
    ])

    expect(readAuthRuntimeDiagnosticsSources(bindings(bound))).toEqual({
      dataSource,
      cookieFactory,
      forceLegacySessions: true,
      outboxEntityRepository,
      outboxRepository,
      outboxDispatcher,
    })
  })

  it('leaves every optional binding absent on a container that predates them', () => {
    const bound = new Map<symbol, unknown>([[TYPES.Auth_ORMRoleRepository, { manager: { connection: dataSource } }]])

    expect(readAuthRuntimeDiagnosticsSources(bindings(bound))).toEqual({
      dataSource,
      cookieFactory: undefined,
      forceLegacySessions: undefined,
      outboxEntityRepository: undefined,
      outboxRepository: undefined,
      outboxDispatcher: undefined,
    })
  })
})
