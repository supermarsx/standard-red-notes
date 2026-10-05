import {
  DatastoreProbe,
  MAX_REPORTED_POOL,
  observeAuthRuntime,
  observeDatastore,
  readCookieAttributes,
} from './AuthRuntimeDiagnostics'
import { CookieFactory } from '../Auth/Cookies/CookieFactory'

/**
 * Standard Red Notes: the auth process's runtime diagnostics.
 *
 * THE PROPERTY THIS FILE EXISTS FOR is that the two cookie attributes are read
 * off the REAL factory rather than re-resolved from the environment. Both
 * default to TRUE when their variable is unset, so a second resolution anywhere
 * is a second place for the default to be got wrong — and "not set" and "off"
 * are OPPOSITE answers here, so getting it wrong inverts the diagnosis rather
 * than blurring it. The tests below therefore drive the actual `CookieFactory`
 * this container binds, not a stand-in.
 *
 * The second property is that nothing is invented on absent evidence. A store
 * that fails its read reports `handle-only` and NO figures; an unreadable
 * migration state leaves both migration fields absent rather than defaulting to
 * applied, because `migrationsApplied: true` over an unread schema is the
 * flattering reading the whole module refuses.
 */
describe('readCookieAttributes — measured off the real header', () => {
  it('reads both attributes OFF a plain-HTTP local trial’s real factory', () => {
    // The shipped compose default: COOKIE_SECURE=false, COOKIE_PARTITIONED=false
    // for an http://localhost self-host.
    expect(readCookieAttributes(new CookieFactory('Lax', '', false, false))).toEqual({
      cookieSecure: false,
      cookiePartitioned: false,
    })
  })

  it('reads both attributes ON from the factory an HTTPS deployment binds', () => {
    expect(readCookieAttributes(new CookieFactory('None', 'notes.example.com', true, true))).toEqual({
      cookieSecure: true,
      cookiePartitioned: true,
    })
  })

  it('reports the broken pair the panel raises a finding for', () => {
    // Partitioning without Secure: no browser will store the cookie, and both
    // flags default to true, so an explicit COOKIE_SECURE=false is what produces
    // it. The pane can only name it if these two are reported independently.
    expect(readCookieAttributes(new CookieFactory('None', '', false, true))).toEqual({
      cookieSecure: false,
      cookiePartitioned: true,
    })
  })

  it('cannot be fooled by an attribute name appearing INSIDE a cookie value', () => {
    // A token is opaque bytes. A bare `includes('Secure')` would be satisfied by
    // a token that happened to contain those six characters, and the row would
    // then assert an attribute the server never set — on a deployment whose
    // sessions are silently dropped by every browser.
    const liar = {
      createCookieHeaderValue: (): string[] => [
        'access_token_x=aSecurePartitionedToken; HttpOnly; Path=/; SameSite=Lax;',
      ],
    }

    expect(readCookieAttributes(liar)).toEqual({ cookieSecure: false, cookiePartitioned: false })
  })
})

describe('observeDatastore', () => {
  const probeWith = (overrides: Partial<DatastoreProbe> = {}): DatastoreProbe => ({
    initialized: true,
    read: async (): Promise<void> => undefined,
    write: async (): Promise<void> => undefined,
    pendingMigrations: async (): Promise<number> => 0,
    pool: (): { inUse: number; size: number } | undefined => ({ inUse: 3, size: 20 }),
    ...overrides,
  })

  it('reports a healthy store with every census figure', async () => {
    const report = await observeDatastore(probeWith())

    expect(report).toMatchObject({
      connectionState: 'connected',
      writeProbe: 'accepted',
      migrationsApplied: true,
      pendingMigrations: 0,
      poolInUse: 3,
      poolSize: 20,
    })
    expect(typeof report.readRoundTripMs).toBe('number')
    expect(typeof report.writeRoundTripMs).toBe('number')
  })

  it('reports `disconnected` without probing when there is no live handle', async () => {
    const read = jest.fn(async (): Promise<void> => undefined)

    const report = await observeDatastore(probeWith({ initialized: false, read }))

    expect(report).toEqual({ connectionState: 'disconnected', writeProbe: 'not-attempted' })
    // A probe through an uninitialized DataSource is a DIFFERENT failure from a
    // sick connection; running it anyway is how `handle-only` loses its meaning.
    expect(read).not.toHaveBeenCalled()
  })

  it('reports `handle-only` — the defect no readiness probe can see', async () => {
    // The service answers HTTP perfectly and every route that touches the
    // database fails. Nothing further is probed: a write and a migration read
    // against a store that just failed `SELECT 1` add no information and two
    // more timeouts to the admin request.
    const write = jest.fn(async (): Promise<void> => undefined)

    const report = await observeDatastore(
      probeWith({
        read: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.3.14:3306')),
        write,
      }),
    )

    expect(report).toEqual({ connectionState: 'handle-only', writeProbe: 'not-attempted' })
    expect(write).not.toHaveBeenCalled()
  })

  it('separates a refused write from a healthy read', async () => {
    // A read-only replica, a revoked UPDATE grant and a missing table all pass
    // `SELECT 1` and fail every real write. This is the only field on the screen
    // that can see them.
    const report = await observeDatastore(
      probeWith({ write: () => Promise.reject(new Error('ER_OPTION_PREVENTS_STATEMENT')) }),
    )

    expect(report.connectionState).toBe('connected')
    expect(report.writeProbe).toBe('refused')
    // No write figure for a write that never completed.
    expect(report.writeRoundTripMs).toBeUndefined()
    // The read figure survives: the read DID complete.
    expect(typeof report.readRoundTripMs).toBe('number')
  })

  it('leaves BOTH migration fields absent when the schema state is unreadable', async () => {
    const report = await observeDatastore(
      probeWith({ pendingMigrations: () => Promise.reject(new Error('Table "migrations" does not exist')) }),
    )

    expect(report.connectionState).toBe('connected')
    // `migrationsApplied: true` over an unread schema is the flattering reading
    // this module refuses. Absent is the honest answer and the panel renders it
    // as "not reported".
    expect(report.migrationsApplied).toBeUndefined()
    expect(report.pendingMigrations).toBeUndefined()
  })

  it('reports a schema that is behind as a count, never as a name', async () => {
    const report = await observeDatastore(probeWith({ pendingMigrations: async (): Promise<number> => 3 }))

    expect(report.pendingMigrations).toBe(3)
    expect(report.migrationsApplied).toBe(false)
    // A migration name is a schema disclosure the pane has no use for, and there
    // is no field here that could carry one.
    expect(JSON.stringify(report)).not.toMatch(/[A-Za-z]{6,}-[A-Z]/)
  })

  it('omits the pool census where the driver keeps no pool', async () => {
    // SQLite in the bundled home server. A zeroed census would read as a
    // healthy, empty pool rather than as "this driver has none".
    const report = await observeDatastore(probeWith({ pool: () => undefined }))

    expect(report.poolInUse).toBeUndefined()
    expect(report.poolSize).toBeUndefined()
  })

  it('survives a pool reader that throws on a driver shape it does not know', async () => {
    const report = await observeDatastore(
      probeWith({
        pool: () => {
          throw new Error('poolCluster has no _allConnections')
        },
      }),
    )

    expect(report.connectionState).toBe('connected')
    expect(report.poolInUse).toBeUndefined()
  })

  it('bounds a census figure rather than reporting an unbounded number', async () => {
    const report = await observeDatastore(probeWith({ pool: () => ({ inUse: 10 ** 9, size: 10 ** 9 }) }))

    expect(report.poolInUse).toBe(MAX_REPORTED_POOL)
    expect(report.poolSize).toBe(MAX_REPORTED_POOL)
  })

  it('calls a probe that outlives the deadline timed-out, not refused', async () => {
    // Two different fixes: a refused write is a permission or a read-only
    // server, a timed-out one is a store that is not answering.
    const report = await observeDatastore(probeWith({ write: () => new Promise<void>(() => undefined) }), {
      timeoutMs: 10,
    })

    expect(report.writeProbe).toBe('timed-out')
    expect(report.writeRoundTripMs).toBeUndefined()
  })

  it('reports a whole-millisecond duration, never a float off a clock', async () => {
    let clock = 1_000
    const report = await observeDatastore(probeWith(), {
      now: () => {
        clock += 7.6

        return clock
      },
    })

    expect(Number.isInteger(report.readRoundTripMs)).toBe(true)
    expect(Number.isInteger(report.writeRoundTripMs)).toBe(true)
  })
})

describe('observeAuthRuntime', () => {
  it('reports the uptime as whole seconds and carries no instant', async () => {
    const report = await observeAuthRuntime({
      uptimeSeconds: 931.77,
      cookies: new CookieFactory('Lax', '', false, false),
      e2eTesting: false,
      datastore: {
        initialized: true,
        read: async (): Promise<void> => undefined,
        write: async (): Promise<void> => undefined,
        pendingMigrations: async (): Promise<number> => 0,
        pool: () => ({ inUse: 1, size: 20 }),
      },
    })

    expect(report.processUptimeSeconds).toBe(931)
    expect(report.session).toEqual({ cookieSecure: false, cookiePartitioned: false, e2eTesting: false })
    // A duration answers "did my restart take?"; an instant additionally lets a
    // reader of the pasteable report line this deployment up against other logs.
    expect(JSON.stringify(report)).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('reports the legacy-session switch, which makes cookie faults unobservable', async () => {
    // A real deployment running with E2E_TESTING on is in a mode where
    // cookie-session faults CANNOT occur — worth knowing twice over, because it
    // also means a green end-to-end suite proves nothing about cookie sessions.
    const report = await observeAuthRuntime({
      uptimeSeconds: 1,
      cookies: new CookieFactory('Lax', '', true, true),
      e2eTesting: true,
      datastore: {
        initialized: false,
        read: async (): Promise<void> => undefined,
        write: async (): Promise<void> => undefined,
        pendingMigrations: async (): Promise<number> => 0,
        pool: () => undefined,
      },
    })

    expect(report.session.e2eTesting).toBe(true)
  })

  it('emits no string-valued field anywhere outside its closed unions', async () => {
    // The structural half: walk the whole report and assert that every leaf is a
    // boolean, a bounded number, or a member of one of the two closed unions.
    // A `string` field added to this module later fails here, which is what a
    // denylist of forbidden substrings could never do.
    const report = await observeAuthRuntime({
      uptimeSeconds: 5,
      cookies: new CookieFactory('None', 'notes.example.com', true, true),
      e2eTesting: false,
      datastore: {
        initialized: true,
        read: async (): Promise<void> => undefined,
        write: async (): Promise<void> => undefined,
        pendingMigrations: async (): Promise<number> => 2,
        pool: () => ({ inUse: 4, size: 20 }),
      },
    })

    const CLOSED = ['connected', 'handle-only', 'disconnected', 'accepted', 'refused', 'timed-out', 'not-attempted']
    const leaves: unknown[] = []
    const walk = (value: unknown): void => {
      if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value as Record<string, unknown>)) {
          walk(child)
        }

        return
      }
      leaves.push(value)
    }
    walk(report)

    expect(leaves.length).toBeGreaterThan(8)
    for (const leaf of leaves) {
      if (typeof leaf === 'string') {
        expect(CLOSED).toContain(leaf)
      } else if (typeof leaf === 'number') {
        expect(Number.isInteger(leaf)).toBe(true)
      } else {
        expect(typeof leaf).toBe('boolean')
      }
    }
    // The domain this factory was built with never reaches the report, even
    // though the header the attributes were read from carried it.
    expect(JSON.stringify(report)).not.toContain('notes.example.com')
  })
})
