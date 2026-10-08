import 'reflect-metadata'

import TYPES from '../../Bootstrap/Types'
import {
  AuthReadinessBindings,
  AuthReadinessSources,
  READINESS_PROBE_TIMEOUT_MS,
  authReadinessStatusCode,
  authReadinessUnavailableReport,
  readAuthReadinessSources,
  resolveAuthReadinessReport,
} from './AuthReadinessEndpoint'

/**
 * Standard Red Notes: the ONE composition of the `/healthcheck/readiness`
 * answer, shared by auth's annotated controller and by the bundled home-server's
 * loopback-only internal listener.
 *
 * WHAT THESE TESTS ARE FOR. Everything the route decides lives here now, so
 * these are the tests that hold the decisions a second copy would get subtly
 * wrong:
 *
 *   - an ABSENT cache reads `redis: true`. `CACHE_TYPE=memory` is the
 *     self-hosted default and binds no `Auth_Redis` at all; a copy that read
 *     `false` for "nothing to ping" would hold every such deployment
 *     permanently un-ready and out of the orchestrator's rotation;
 *   - the probe is a METHOD call on the manager, so TypeORM keeps its receiver;
 *   - the key order of `checks`, which is what a multi-container /
 *     single-container body diff is read on;
 *   - one failing dependency still reports the other's state rather than
 *     collapsing the route;
 *   - and a container with no auth bindings yields NO sources, so the caller
 *     mounts no route rather than publishing `db: false` — "the auth database is
 *     down" — over a container that simply has no auth in it.
 */
describe('resolveAuthReadinessReport', () => {
  const database = (
    query: (sql: string) => Promise<unknown> = async () => [],
  ): AuthReadinessSources['database'] & { calls: string[] } => {
    const calls: string[] = []

    return {
      calls,
      query: async (sql: string): Promise<unknown> => {
        calls.push(sql)

        return query(sql)
      },
    }
  }

  it('reports both dependencies healthy when both answer', async () => {
    const report = await resolveAuthReadinessReport({
      database: database(),
      redis: { ping: async () => 'PONG' },
    })

    expect(report).toEqual({ status: 'ready', checks: { db: true, redis: true } })
  })

  it('serializes the verdict before the checks, and db before redis', async () => {
    const report = await resolveAuthReadinessReport({ database: database() })

    // The single container's body is diffed against the multi-container one row
    // for row, and a reordered body is a diff that has to be explained away.
    expect(Object.keys(report)).toEqual(['status', 'checks'])
    expect(Object.keys(report.checks)).toEqual(['db', 'redis'])
  })

  it('probes the database with SELECT 1 and nothing else', async () => {
    const db = database()

    await resolveAuthReadinessReport({ database: db })

    // Readiness is polled by the orchestrator every few seconds, so the probe
    // has to stay one bounded read. A statement that grew a write or a schema
    // read belongs on the diagnostics route instead.
    expect(db.calls).toEqual(['SELECT 1'])
  })

  it('probes through the manager as a METHOD call, keeping its receiver', async () => {
    // TypeORM's `EntityManager.query` uses `this`. An extracted-and-called
    // `query` reference throws, and this probe would then report a perfectly
    // healthy database as not answering.
    const manager = {
      marker: 'the real manager',
      async query(this: { marker: string }): Promise<unknown> {
        if (this?.marker !== 'the real manager') {
          throw new Error('called without a receiver')
        }

        return []
      },
    }

    const report = await resolveAuthReadinessReport({ database: manager })

    expect(report.checks.db).toBe(true)
  })

  it('reports an ABSENT cache as healthy, because there is nothing to be unhealthy', async () => {
    const report = await resolveAuthReadinessReport({ database: database() })

    // CACHE_TYPE=memory binds no Auth_Redis. Reading `false` here would hold
    // every self-hosted deployment permanently un-ready.
    expect(report).toEqual({ status: 'ready', checks: { db: true, redis: true } })
  })

  it('reports the database down while still reporting the cache up', async () => {
    const report = await resolveAuthReadinessReport({
      database: database(async () => {
        throw new Error('connect ECONNREFUSED 10.1.2.3:3306')
      }),
      redis: { ping: async () => 'PONG' },
    })

    expect(report).toEqual({ status: 'unavailable', checks: { db: false, redis: true } })
    // A driver rejection is exactly where a host, a port and a database name
    // live, and this body has no field that could carry one.
    expect(JSON.stringify(report)).not.toContain('10.1.2.3')
  })

  it('reports the cache down while still reporting the database up', async () => {
    const report = await resolveAuthReadinessReport({
      database: database(),
      redis: {
        ping: async () => {
          throw new Error('NOAUTH Authentication required')
        },
      },
    })

    expect(report).toEqual({ status: 'unavailable', checks: { db: true, redis: false } })
    expect(JSON.stringify(report)).not.toContain('NOAUTH')
  })

  it('reports a dependency that never answers as down, rather than hanging the route', async () => {
    const report = await resolveAuthReadinessReport(
      {
        database: database(() => new Promise(() => undefined)),
        redis: { ping: () => new Promise(() => undefined) },
      },
      5,
    )

    expect(report).toEqual({ status: 'unavailable', checks: { db: false, redis: false } })
  })

  it('leaves no pending timer behind when a probe answers inside the budget', async () => {
    // An uncleared deadline timer per probe keeps the event loop alive and, on a
    // route polled every few seconds, accumulates one handle per poll.
    jest.useFakeTimers()
    try {
      await resolveAuthReadinessReport({ database: database(), redis: { ping: async () => 'PONG' } })

      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it('keeps the probe budget short enough to answer inside an orchestrator poll', () => {
    expect(READINESS_PROBE_TIMEOUT_MS).toBe(2_000)
  })

  it('is NOT cached: a second call re-probes rather than re-serving the first answer', async () => {
    // Unlike the diagnostics report, which shares a 5s answer window. Readiness
    // is the deployment acceptance signal: a re-served answer reports a
    // dependency that has just gone as still up, and one that has just come back
    // as still down.
    const db = database()

    await resolveAuthReadinessReport({ database: db })
    await resolveAuthReadinessReport({ database: db })

    expect(db.calls).toEqual(['SELECT 1', 'SELECT 1'])
  })

  it('never rejects, even when the sources themselves are broken', async () => {
    const report = await resolveAuthReadinessReport({
      database: undefined as unknown as AuthReadinessSources['database'],
    })

    expect(report).toEqual({ status: 'unavailable', checks: { db: false, redis: true } })
  })
})

describe('authReadinessStatusCode', () => {
  it('answers 200 for a ready report', () => {
    expect(authReadinessStatusCode({ status: 'ready', checks: { db: true, redis: true } })).toBe(200)
  })

  it('answers 503 for an unavailable report, so the orchestrator stops routing here', () => {
    expect(authReadinessStatusCode({ status: 'unavailable', checks: { db: false, redis: true } })).toBe(503)
  })

  it('reads the verdict, not the checks', () => {
    // The verdict is the single place the two checks are combined. A status code
    // derived from the checks again would be a second copy of that rule.
    expect(authReadinessStatusCode({ status: 'unavailable', checks: { db: true, redis: true } })).toBe(503)
  })
})

describe('authReadinessUnavailableReport', () => {
  it('reports every check FALSE rather than reporting nothing', () => {
    // THIS IS THE FALSE-GREEN GUARD. The gateway's probe accepts a 503 and then
    // reads `status` and `checks` out of the body; `authServiceEntry` scores an
    // absent status plus an empty `checks` as a healthy `'ok'`. A failure answer
    // carrying neither field would publish a crashed probe as a working auth.
    const report = authReadinessUnavailableReport()

    expect(report).toEqual({ status: 'unavailable', checks: { db: false, redis: false } })
    expect(authReadinessStatusCode(report)).toBe(503)
    expect(Object.values(report.checks).every(Boolean)).toBe(false)
  })

  it('hands out a fresh report each time, so one caller cannot mutate the next answer', () => {
    const first = authReadinessUnavailableReport()
    first.checks.db = true

    expect(authReadinessUnavailableReport()).toEqual({ status: 'unavailable', checks: { db: false, redis: false } })
  })
})

describe('readAuthReadinessSources', () => {
  /**
   * `get` THROWS on an unbound identifier, exactly as inversify does. A fake
   * that returned `undefined` instead would let a reader that skipped `isBound`
   * pass here and crash a real boot.
   */
  const bindings = (bound: Map<symbol, unknown>): AuthReadinessBindings =>
    ({
      isBound: (identifier: symbol): boolean => bound.has(identifier),
      get: (identifier: symbol): unknown => {
        if (!bound.has(identifier)) {
          throw new Error(`No bindings found for service: ${String(identifier)}`)
        }

        return bound.get(identifier)
      },
    }) as unknown as AuthReadinessBindings

  it('yields NO sources when the container holds no auth role repository', () => {
    expect(readAuthReadinessSources(bindings(new Map()))).toBeUndefined()
  })

  it('yields NO sources when the bound repository exposes no manager', () => {
    const bound = new Map<symbol, unknown>([[TYPES.Auth_ORMRoleRepository, {}]])

    expect(readAuthReadinessSources(bindings(bound))).toBeUndefined()
  })

  it('yields NO sources when the manager cannot be queried', () => {
    // Answering the route over this would report `db: false` — "the auth
    // database is not answering" — which is a fabrication, and a far more
    // alarming one than no route at all.
    const bound = new Map<symbol, unknown>([[TYPES.Auth_ORMRoleRepository, { manager: { query: 'not a function' } }]])

    expect(readAuthReadinessSources(bindings(bound))).toBeUndefined()
  })

  it('reads the manager the annotated controller probes, and the cache when one is bound', () => {
    const manager = { query: async (): Promise<unknown> => [] }
    const redis = { ping: async (): Promise<string> => 'PONG' }
    const bound = new Map<symbol, unknown>([
      [TYPES.Auth_ORMRoleRepository, { manager }],
      [TYPES.Auth_Redis, redis],
    ])

    expect(readAuthReadinessSources(bindings(bound))).toEqual({ database: manager, redis })
  })

  it('leaves the cache absent on a CACHE_TYPE=memory container, and still reads ready', async () => {
    const manager = { query: async (): Promise<unknown> => [] }
    const bound = new Map<symbol, unknown>([[TYPES.Auth_ORMRoleRepository, { manager }]])

    const sources = readAuthReadinessSources(bindings(bound))

    expect(sources).toEqual({ database: manager, redis: undefined })
    // End to end over the pair: the self-hosted default binds no cache, and the
    // deployment has to come up ready anyway.
    await expect(resolveAuthReadinessReport(sources as AuthReadinessSources)).resolves.toEqual({
      status: 'ready',
      checks: { db: true, redis: true },
    })
  })
})
