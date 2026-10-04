import {
  buildBackendSection,
  describeCacheRequirement,
  filesProbeTarget,
  KNOWN_SERVICES,
  type BackendSectionInput,
} from './backendSection'
import type { DeploymentTopology } from './diagnosticRemedies'
import {
  UNRECOGNISED,
  VERDICTS,
  type DiagnosticFinding,
  type DiagnosticRow,
  type SectionModel,
} from './diagnosticsSections'
import { errorKind } from './healthReport'

/**
 * Standard Red Notes: the Database & internal communications section's own tests.
 *
 * *** WHAT THIS FILE IS ACTUALLY GUARDING ***
 *
 * Four properties. Three of them are the properties every section in this
 * directory owes; the fourth is specific to this one and is the sharpest secrecy
 * surface in the pane.
 *
 *  1. An absent payload must not read as a failure. This section reads the admin
 *     status endpoint, and the recorded defect is `healthReport.ts`'s own: a 401
 *     once produced a report that read as the server having refused every
 *     capability. So the whole model is built with NO input and all 25 rows are
 *     checked individually — an assertion over a set is satisfied by any member
 *     of it — and the three-state read row is asserted apart from the rows that
 *     depend on it.
 *
 *  2. An absent counter is not zero. `0` means the server measured none and
 *     `undefined` means nobody asked. Both are asserted for the service counts,
 *     the migration count and the pool, because this is the one section whose
 *     counts come from a payload that may legitimately carry a zero.
 *
 *  3. A claim may not exceed its evidence, in BOTH directions. A positive reading
 *     on a constant (`api-gateway` adds itself to the services array with a
 *     hardcoded `reachable: true`) must not paint green. A failing probe must not
 *     claim an application-call outage it cannot see, because the probe resolves
 *     its own base address. And the two places this section DOES claim necessity
 *     are asserted to survive as `broken`, because asserting only the caps would
 *     pass against a section that never claims anything at all.
 *
 *  4. No address, no service name off the wire, no probe `detail` and no raw
 *     error message may reach a row, a note, a finding, a remedy or the copyable
 *     report. The planted-value scan serialises the WHOLE model rather than only
 *     the report, because `note`, `detail`, `summary` and `because` are plain
 *     strings and are the one type-valid path a server value can take to the
 *     screen. It asserts per candidate AND on a long fragment of each, because a
 *     partially scrubbed string is not safe and a partial scrub has actually
 *     happened in this directory before.
 *
 * `rowOf` THROWS on a missing label, so renaming a row turns its assertions red
 * instead of leaving them silently vacuous.
 */

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const topology = (overrides: Partial<DeploymentTopology> = {}): DeploymentTopology => ({
  recorded: true,
  mode: 'self-hosted',
  serviceProxySetting: 'unset',
  boundServiceProxy: 'http',
  cacheSetting: 'redis',
  syncSwitchSetting: 'unset',
  grpcSyncingProxyBound: false,
  grpcProxyBindableInThisMode: true,
  redisBound: true,
  presence: {},
  ...overrides,
})

type ServiceEntry = {
  name?: unknown
  reachable?: unknown
  status?: unknown
  detail?: unknown
  responseTimeMs?: unknown
}

/** Every known service answering, which is what a healthy deployment reports. */
const healthyServices = (overrides: readonly ServiceEntry[] = []): ServiceEntry[] => [
  { name: 'api-gateway', reachable: true, status: 'ok' },
  { name: 'auth', reachable: true, status: 'ok', responseTimeMs: 120 },
  { name: 'syncing-server', reachable: true, status: 'ok', responseTimeMs: 80 },
  { name: 'files', reachable: true, status: 'ok', responseTimeMs: 60 },
  { name: 'revisions', reachable: true, status: 'ok', responseTimeMs: 40 },
  { name: 'websocket-gateway', reachable: false, status: 'unknown', detail: 'not configured' },
  ...overrides,
]

const serverStatus = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  health: {
    gateway: { redis: true },
    auth: { reachable: true, status: 'ready', checks: { db: true, redis: true }, responseTimeMs: 120 },
  },
  services: healthyServices(),
  ...overrides,
})

const healthy = (overrides: Partial<BackendSectionInput> = {}): SectionModel =>
  buildBackendSection({ serverStatus: serverStatus(), topology: topology({ mode: 'home-server' }), ...overrides })

/* -------------------------------------------------------------------------- */
/* Lookups that fail loudly                                                   */
/* -------------------------------------------------------------------------- */

const allRows = (model: SectionModel): readonly DiagnosticRow[] => model.blocks.flatMap((block) => block.rows)

const allFindings = (model: SectionModel): readonly DiagnosticFinding[] =>
  model.blocks.flatMap((block) => block.findings)

const rowOf = (model: SectionModel, label: string): DiagnosticRow => {
  const found = allRows(model).find((row) => row.label === label)
  if (found === undefined) {
    throw new Error(
      `no row labelled "${label}" — the model has: ${allRows(model)
        .map((row) => row.label)
        .join(' | ')}`,
    )
  }

  return found
}

const findingOf = (model: SectionModel, code: string): DiagnosticFinding | undefined =>
  allFindings(model).find((finding) => finding.code === code)

const codesOf = (model: SectionModel): string[] => allFindings(model).map((finding) => String(finding.code))

const headingsOf = (model: SectionModel): string[] => model.blocks.map((block) => String(block.heading))

/* -------------------------------------------------------------------------- */
/* Absent is not false                                                        */
/* -------------------------------------------------------------------------- */

describe('buildBackendSection with nothing reported', () => {
  it('claims absent evidence and no verdict for every single row', () => {
    const model = buildBackendSection()
    const rows = allRows(model)

    expect(rows).toHaveLength(25)
    for (const row of rows) {
      expect({
        label: String(row.label),
        kind: row.evidence.kind,
        verdict: row.verdict,
        value: String(row.value),
      }).toEqual({ label: String(row.label), kind: 'absent', verdict: 'undetermined', value: 'not reported' })
    }
  })

  it('raises no finding and reports the section as undetermined rather than healthy', () => {
    const model = buildBackendSection()

    expect(codesOf(model)).toEqual([])
    expect(model.worstVerdict).toBe('undetermined')
    expect(model.worst).toBe('neutral')
    expect(model.headline).toBeUndefined()
  })

  it('builds the five always-present blocks, in order, under the section title', () => {
    const model = buildBackendSection()

    expect(model.id).toBe('backend')
    expect(model.title).toBe('Database & internal comms')
    expect(headingsOf(model)).toEqual([
      'Status endpoint read',
      'Durable storage',
      'Shared cache',
      'Internal service communication',
      'Event delivery and queues',
    ])
  })

  /**
   * The read row is the one row that must distinguish THREE states, because the
   * other 24 all read "not reported" in two completely different situations and
   * this is the row that says which. "Nobody has tried" is absent evidence, not
   * a failure — a section that reported a failed read before anything was
   * fetched would be the panel asserting it looked.
   */
  it('separates "nobody asked" from "the read failed" from "the read answered"', () => {
    const untried = buildBackendSection()
    const failed = buildBackendSection({ statusError: 'could not reach the server' })
    const answered = buildBackendSection({ serverStatus: {} })

    expect(untried.blocks[0].rows[0].value).toBe('not reported')
    expect(untried.blocks[0].rows[0].evidence.kind).toBe('absent')
    expect(untried.blocks[0].rows[0].verdict).toBe('undetermined')

    expect(failed.blocks[0].rows[0].value).toBe('did not answer')
    expect(failed.blocks[0].rows[0].evidence.kind).toBe('direct')
    expect(failed.blocks[0].rows[0].verdict).toBe('broken')

    expect(answered.blocks[0].rows[0].value).toBe('answered')
    expect(answered.blocks[0].rows[0].verdict).toBe('healthy')
  })

  /**
   * A payload that ARRIVED and carried nothing is a different fact from no
   * payload, and must not fill the rest of the section in with negatives. This
   * is the state an older gateway build produces.
   */
  it('does not turn an empty payload into negative verdicts for the services', () => {
    const model = buildBackendSection({ serverStatus: {} })

    expect(rowOf(model, 'Auth database round trip').value).toBe('not reported')
    expect(rowOf(model, 'Auth database round trip').evidence.kind).toBe('absent')
    expect(rowOf(model, 'Gateway cache ping').value).toBe('not reported')
    expect(rowOf(model, 'Syncing server probe').value).toBe('not reported')
    expect(rowOf(model, 'Services reported').value).toBe('not reported')
    expect(codesOf(model)).toEqual([])
  })

  /** A non-object payload is silence too, not a shape to read fields off. */
  it.each([null, 'a string', 42, [], true])('treats a non-object payload (%p) as no payload', (payload) => {
    const model = buildBackendSection({ serverStatus: payload })

    expect(rowOf(model, 'Admin status endpoint').value).toBe('not reported')
    expect(rowOf(model, 'Auth database round trip').evidence.kind).toBe('absent')
  })
})

/* -------------------------------------------------------------------------- */
/* Absent is not zero                                                         */
/* -------------------------------------------------------------------------- */

describe('a zero counter means measured none, an absent one means did not ask', () => {
  it('prints a reported zero and withholds an absent one', () => {
    const measured = buildBackendSection({ serverStatus: { services: [] } })
    const silent = buildBackendSection({ serverStatus: {} })

    expect(rowOf(measured, 'Services reported').value).toBe('0')
    expect(rowOf(measured, 'Services reported').evidence.kind).toBe('direct')
    expect(rowOf(measured, 'Unrecognised services reported').value).toBe('0')

    expect(rowOf(silent, 'Services reported').value).toBe('not reported')
    expect(rowOf(silent, 'Services reported').evidence.kind).toBe('absent')
    expect(rowOf(silent, 'Unrecognised services reported').value).toBe('not reported')
  })

  it('prints a reported zero pending-migration count without claiming the schema is behind', () => {
    const behind = buildBackendSection({ datastore: { migrationsApplied: false, pendingMigrations: 3 } })
    const unknownCount = buildBackendSection({ datastore: { migrationsApplied: false } })
    const upToDate = buildBackendSection({ datastore: { migrationsApplied: true, pendingMigrations: 0 } })

    expect(rowOf(behind, 'Schema migrations').value).toBe('no 3 pending')
    expect(rowOf(behind, 'Schema migrations').verdict).toBe('degraded')
    // Absent count, reported state: the row must not invent a number and must
    // not drop the fact that migrations are outstanding.
    expect(rowOf(unknownCount, 'Schema migrations').value).toBe('no (count not reported) pending')
    expect(rowOf(unknownCount, 'Schema migrations').verdict).toBe('degraded')
    expect(rowOf(upToDate, 'Schema migrations').value).toBe('yes')
    expect(rowOf(upToDate, 'Schema migrations').verdict).toBe('healthy')
  })

  it('reads a malformed number as not reported rather than rounding it into a reassuring zero', () => {
    const model = buildBackendSection({
      datastore: { readRoundTripMs: Number.NaN, writeRoundTripMs: -5, poolInUse: 1.5, poolSize: 10 },
    })

    expect(rowOf(model, 'Database read round trip').value).toBe('not reported')
    expect(rowOf(model, 'Database read round trip').evidence.kind).toBe('absent')
    expect(rowOf(model, 'Database write round trip').value).toBe('not reported')
    // A fractional pool count is still a finite non-negative number and is
    // reported; `safeCount` refuses the non-integer, so the row says so rather
    // than printing a connection count of 1.5.
    expect(rowOf(model, 'Connection pool in use').value).toBe('not reported of 10')
  })

  it('reports the pool only when both halves arrive, and warns at saturation', () => {
    const neither = buildBackendSection({ datastore: {} })
    const half = buildBackendSection({ datastore: { poolInUse: 4 } })
    const quiet = buildBackendSection({ datastore: { poolInUse: 4, poolSize: 10 } })
    const saturated = buildBackendSection({ datastore: { poolInUse: 19, poolSize: 20 } })

    expect(rowOf(neither, 'Connection pool in use').value).toBe('not reported')
    expect(rowOf(half, 'Connection pool in use').value).toBe('not reported')
    expect(rowOf(half, 'Connection pool in use').evidence.kind).toBe('absent')
    expect(rowOf(quiet, 'Connection pool in use').value).toBe('4 of 10')
    expect(rowOf(quiet, 'Connection pool in use').verdict).toBe('informational')
    expect(rowOf(saturated, 'Connection pool in use').value).toBe('19 of 20')
    expect(rowOf(saturated, 'Connection pool in use').verdict).toBe('degraded')
  })
})

/* -------------------------------------------------------------------------- */
/* The database rows                                                          */
/* -------------------------------------------------------------------------- */

describe('the durable store', () => {
  it('reports the auth database round trip as direct evidence, both ways', () => {
    const up = healthy()
    const down = buildBackendSection({
      serverStatus: serverStatus({
        health: { gateway: { redis: true }, auth: { reachable: true, checks: { db: false, redis: true } } },
      }),
    })

    expect(rowOf(up, 'Auth database round trip').value).toBe('answering')
    expect(rowOf(up, 'Auth database round trip').verdict).toBe('healthy')
    expect(rowOf(up, 'Auth database round trip').evidence.kind).toBe('direct')

    expect(rowOf(down, 'Auth database round trip').value).toBe('not answering')
    expect(rowOf(down, 'Auth database round trip').verdict).toBe('broken')
  })

  /**
   * A check key MISSING from the map is a server that said nothing about that
   * dependency; collapsing it to `false` would turn silence into a confident
   * database outage with a remedy attached. This is the same defect
   * `environmentSection.ts` caught in its own presence read.
   */
  it('treats a check missing from the map as silence, not as a failing dependency', () => {
    const model = buildBackendSection({
      serverStatus: serverStatus({ health: { gateway: { redis: true }, auth: { reachable: true, checks: {} } } }),
    })

    expect(rowOf(model, 'Auth database round trip').value).toBe('not reported')
    expect(rowOf(model, 'Auth database round trip').evidence.kind).toBe('absent')
    expect(rowOf(model, 'Auth cache ping').value).toBe('not reported')
    expect(codesOf(model)).not.toContain('AUTH_DATABASE_NOT_ANSWERING')
  })

  /**
   * The one necessary condition this section claims about the database, asserted
   * to SURVIVE. Asserting only that the proxies cap would pass against a section
   * that claims nothing at all.
   */
  it('keeps the auth database finding conclusive, because sign-in cannot work without it', () => {
    const model = buildBackendSection({
      serverStatus: serverStatus({
        health: { gateway: { redis: true }, auth: { reachable: true, checks: { db: false, redis: true } } },
      }),
    })
    const finding = findingOf(model, 'AUTH_DATABASE_NOT_ANSWERING')

    expect(finding?.claimed).toBe('broken')
    expect(finding?.verdict).toBe('broken')
    expect(finding?.evidence.kind).toBe('proxy')
    expect(finding?.caveat).toContain('Its failure is conclusive')
    expect(finding?.remedy?.effort).toBe('peer-service')
    expect(finding?.remedy?.steps.length).toBeGreaterThan(0)
  })

  it('distinguishes a connected data source from a handle that was never connected', () => {
    const connected = buildBackendSection({ datastore: { connectionState: 'connected' } })
    const handle = buildBackendSection({ datastore: { connectionState: 'handle-only' } })
    const unreported = buildBackendSection()

    expect(rowOf(connected, 'Database connection state').value).toBe('connected')
    expect(rowOf(connected, 'Database connection state').verdict).toBe('healthy')
    expect(codesOf(connected)).not.toContain('DATABASE_HANDLE_NOT_CONNECTED')

    expect(rowOf(handle, 'Database connection state').value).toBe('handle-only')
    expect(rowOf(handle, 'Database connection state').verdict).toBe('broken')
    expect(findingOf(handle, 'DATABASE_HANDLE_NOT_CONNECTED')?.remedy?.effort).toBe('rebuild')

    expect(rowOf(unreported, 'Database connection state').value).toBe('not reported')
    expect(rowOf(unreported, 'Database connection state').evidence.kind).toBe('absent')
  })

  it('refuses a connection state this build does not recognise rather than printing it', () => {
    const model = buildBackendSection({ datastore: { connectionState: 'reconnecting-soon' } })

    expect(rowOf(model, 'Database connection state').value).toBe(UNRECOGNISED)
    // Unrecognised is not a claim either way: the state was reported and this
    // build cannot read it, so no verdict is derived from it.
    expect(rowOf(model, 'Database connection state').evidence.kind).toBe('absent')
    expect(codesOf(model)).not.toContain('DATABASE_HANDLE_NOT_CONNECTED')
  })

  it('bucket the auth readiness duration without claiming it measures the database', () => {
    const fast = healthy()
    const slow = buildBackendSection({
      serverStatus: serverStatus({ services: healthyServices().map((entry) => ({ ...entry, responseTimeMs: 2600 })) }),
    })

    expect(rowOf(fast, 'Auth readiness round trip').value).toBe('under 1s')
    expect(rowOf(fast, 'Auth readiness round trip').verdict).toBe('informational')
    expect(rowOf(slow, 'Auth readiness round trip').value).toBe('2s')
  })

  /**
   * The outbox count has no producer, so there is deliberately NO row for it: a
   * row reading "not reported" for a number nobody reports invites the reading
   * that it is zero. The withholding is stated instead.
   */
  it('shows no dead-outbox row and says so in the report instead', () => {
    const model = buildBackendSection()

    expect(allRows(model).map((row) => String(row.label))).not.toContain('Dead outbox rows')
    expect(model.reportLines.join('\n')).toContain('- Dead outbox rows: no endpoint this pane can read reports a count')
  })
})

/* -------------------------------------------------------------------------- */
/* The cache rows                                                             */
/* -------------------------------------------------------------------------- */

describe('the shared cache', () => {
  const withGatewayRedis = (redis: unknown): SectionModel =>
    buildBackendSection({
      serverStatus: serverStatus({
        health: { gateway: { redis }, auth: { reachable: true, checks: { db: true, redis: true } } },
      }),
      topology: topology({ mode: 'home-server' }),
    })

  /**
   * FOUR states out of one tri-state field plus silence, and the two that get
   * confused are the expensive pair: a literal `null` means this gateway has no
   * client to ping — which is CORRECT on the single container — and `false`
   * means a client exists and did not answer.
   */
  it('keeps "no client bound" apart from "the ping failed" and from silence', () => {
    expect(rowOf(withGatewayRedis(true), 'Gateway cache ping').value).toBe('answering')
    expect(rowOf(withGatewayRedis(true), 'Gateway cache ping').verdict).toBe('healthy')

    expect(rowOf(withGatewayRedis(false), 'Gateway cache ping').value).toBe('not answering')
    expect(rowOf(withGatewayRedis(false), 'Gateway cache ping').verdict).toBe('broken')

    expect(rowOf(withGatewayRedis(null), 'Gateway cache ping').value).toBe('no client bound')
    expect(rowOf(withGatewayRedis(null), 'Gateway cache ping').verdict).toBe('informational')
    expect(rowOf(withGatewayRedis(null), 'Gateway cache ping').evidence.kind).toBe('direct')

    const silent = buildBackendSection({ serverStatus: serverStatus({ health: { gateway: {}, auth: {} } }) })
    expect(rowOf(silent, 'Gateway cache ping').value).toBe('not reported')
    expect(rowOf(silent, 'Gateway cache ping').evidence.kind).toBe('absent')
  })

  it('derives the requirement from the reported shape, and claims nothing without one', () => {
    expect(describeCacheRequirement(topology({ mode: 'home-server' }))).toBe('not-required')
    expect(describeCacheRequirement(topology({ mode: 'self-hosted' }))).toBe('required')
    expect(describeCacheRequirement(topology({ mode: 'unset' }))).toBeUndefined()
    expect(describeCacheRequirement(topology({ mode: 'other' }))).toBeUndefined()
    expect(describeCacheRequirement({ recorded: false, mode: 'self-hosted' })).toBeUndefined()
    expect(describeCacheRequirement(undefined)).toBeUndefined()
  })

  /**
   * The relation is DERIVED from the topology, not asserted. On the compose
   * stack the cache is a necessary condition of the realtime lane and the
   * `broken` claim survives; with no reported shape this panel has no evidence
   * for necessity and the same finding caps to `undetermined` rather than
   * borrowing one.
   */
  it('claims necessity for the cache only where the shape establishes it', () => {
    const required = buildBackendSection({
      serverStatus: serverStatus({ health: { gateway: { redis: false }, auth: {} } }),
      topology: topology({ mode: 'self-hosted' }),
    })
    const unknownShape = buildBackendSection({
      serverStatus: serverStatus({ health: { gateway: { redis: false }, auth: {} } }),
    })

    const survived = findingOf(required, 'SHARED_CACHE_NOT_ANSWERING')
    expect(survived?.claimed).toBe('broken')
    expect(survived?.verdict).toBe('broken')
    expect(survived?.caveat).toContain('Its failure is conclusive')
    expect(survived?.remedy?.because?.[1]).toContain('bundled compose stack')

    const capped = findingOf(unknownShape, 'SHARED_CACHE_NOT_ANSWERING')
    expect(capped?.claimed).toBe('broken')
    expect(capped?.verdict).toBe('undetermined')
    // The capped caveat says what was observed and what it does not establish,
    // and — crucially — does NOT say the failure is conclusive. That sentence
    // belongs to a necessary condition and reaching a correlated one is this
    // contract's own recorded defect, one level down.
    expect(capped?.caveat).toContain('does not establish')
    expect(capped?.caveat).toContain('Reported as undetermined rather than claiming it')
    expect(capped?.caveat).not.toContain('conclusive')
    expect(capped?.remedy?.because?.[1]).toContain('could not be established')
  })

  it('flags an absent cache only on a shape that needs one', () => {
    const compose = buildBackendSection({
      serverStatus: serverStatus({ health: { gateway: { redis: null }, auth: {} } }),
      topology: topology({ mode: 'self-hosted' }),
    })
    const single = buildBackendSection({
      serverStatus: serverStatus({ health: { gateway: { redis: null }, auth: {} } }),
      topology: topology({ mode: 'home-server' }),
    })

    expect(findingOf(compose, 'SHARED_CACHE_ABSENT')?.verdict).toBe('broken')
    expect(findingOf(compose, 'SHARED_CACHE_ABSENT')?.remedy?.effort).toBe('restart')
    expect(codesOf(single)).not.toContain('SHARED_CACHE_ABSENT')
    expect(rowOf(single, 'Shared cache needed here').value).toBe('not-required')
  })

  it('reports the two cache clients as independent facts', () => {
    const model = buildBackendSection({
      serverStatus: serverStatus({
        health: { gateway: { redis: true }, auth: { reachable: true, checks: { db: true, redis: false } } },
      }),
    })

    expect(rowOf(model, 'Gateway cache ping').value).toBe('answering')
    expect(rowOf(model, 'Auth cache ping').value).toBe('not answering')
    expect(rowOf(model, 'Auth cache ping').verdict).toBe('degraded')
  })
})

/* -------------------------------------------------------------------------- */
/* Internal communication                                                     */
/* -------------------------------------------------------------------------- */

describe('internal service communication', () => {
  it('builds exactly one row per service this build knows, in a fixed order', () => {
    const model = healthy()
    const labels = allRows(model).map((row) => String(row.label))

    expect(labels).toEqual(
      expect.arrayContaining([
        'This gateway, self-reported',
        'Auth service probe',
        'Syncing server probe',
        'Files service probe',
        'Revisions service probe',
        'WebSocket gateway probe',
      ]),
    )
    expect(KNOWN_SERVICES).toHaveLength(6)
  })

  /**
   * *** THE CONTRACT APPLIED TO ITS MOST OBVIOUS INSTANCE. ***
   *
   * `api-gateway` is pushed onto the services array as a literal
   * `{ reachable: true, status: 'ok' }`. It is the process that answered the
   * request: it never probed itself. A green chip derived from a constant is the
   * pane painting a verdict out of nothing, so the positive reading is capped and
   * the caveat says why.
   */
  it('does not paint the gateway green from its own hardcoded self-report', () => {
    const row = rowOf(healthy(), 'This gateway, self-reported')

    expect(row.value).toBe('answering')
    expect(row.claimed).toBe('healthy')
    expect(row.verdict).toBe('undetermined')
    expect(row.tone).toBe('neutral')
    expect(row.evidence.kind).toBe('proxy')
    expect(row.caveat).toContain('does not establish')
  })

  it('reads a probe outcome from the closed status and reachable pair, not from the detail string', () => {
    const model = buildBackendSection({
      serverStatus: serverStatus({
        services: [
          { name: 'api-gateway', reachable: true, status: 'ok' },
          { name: 'auth', reachable: true, status: 'ok', responseTimeMs: 10 },
          { name: 'syncing-server', reachable: false, status: 'down', detail: 'unreachable', responseTimeMs: 2500 },
          { name: 'files', reachable: true, status: 'degraded', detail: 'readiness reported unavailable' },
          { name: 'revisions', reachable: true, status: 'down', detail: 'unexpected status 500' },
          { name: 'websocket-gateway', reachable: false, status: 'unknown', detail: 'not configured' },
        ],
      }),
    })

    expect(rowOf(model, 'Syncing server probe').value).toBe('did not connect')
    expect(rowOf(model, 'Syncing server probe').verdict).toBe('broken')
    expect(rowOf(model, 'Files service probe').value).toBe('answering, not ready')
    expect(rowOf(model, 'Files service probe').verdict).toBe('degraded')
    expect(rowOf(model, 'Revisions service probe').value).toBe('answering, refusing')
    expect(rowOf(model, 'Revisions service probe').verdict).toBe('broken')
    expect(rowOf(model, 'WebSocket gateway probe').value).toBe('not configured')
    expect(rowOf(model, 'WebSocket gateway probe').verdict).toBe('informational')
  })

  /**
   * The central honesty problem of this section, asserted. The probe resolves
   * its own base address, which can differ from the one the gateway makes
   * application calls on, so a failed probe does not establish a failing call
   * path. The ROW keeps its `broken` verdict on the measurement; the FINDING
   * that infers client impact caps to `undetermined`.
   */
  it('caps the inference from a failed probe while keeping the measurement conclusive', () => {
    const model = buildBackendSection({
      serverStatus: serverStatus({
        services: [
          { name: 'api-gateway', reachable: true, status: 'ok' },
          { name: 'syncing-server', reachable: false, status: 'down', detail: 'unreachable', responseTimeMs: 2500 },
        ],
      }),
    })

    expect(rowOf(model, 'Syncing server probe').verdict).toBe('broken')
    expect(rowOf(model, 'Syncing server probe').evidence.kind).toBe('direct')

    const finding = findingOf(model, 'INTERNAL_SERVICE_PROBE_FAILED')
    expect(finding?.claimed).toBe('broken')
    expect(finding?.verdict).toBe('undetermined')
    expect(finding?.caveat).toContain('does not establish')
    expect(finding?.remedy?.effort).toBe('peer-service')
    expect(finding?.remedy?.summary).toContain('syncing-server')
  })

  it('raises one finding for several failing probes rather than one each', () => {
    const model = buildBackendSection({
      serverStatus: serverStatus({
        services: [
          { name: 'api-gateway', reachable: true, status: 'ok' },
          { name: 'syncing-server', reachable: false, status: 'down' },
          { name: 'files', reachable: false, status: 'down' },
          { name: 'revisions', reachable: true, status: 'degraded' },
        ],
      }),
    })

    expect(codesOf(model).filter((code) => code === 'INTERNAL_SERVICE_PROBE_FAILED')).toHaveLength(1)
    const finding = findingOf(model, 'INTERNAL_SERVICE_PROBE_FAILED')
    expect(finding?.title).toBe('Several internal readiness probes are failing')
    expect(finding?.remedy?.summary).toContain('syncing-server, files, revisions')
    expect(finding?.remedy?.because?.[0]).toContain('unreachable')
  })

  it('never counts the gateway own self-report as a failing probe', () => {
    const model = buildBackendSection({
      serverStatus: serverStatus({ services: [{ name: 'api-gateway', reachable: false, status: 'down' }] }),
    })

    expect(codesOf(model)).not.toContain('INTERNAL_SERVICE_PROBE_FAILED')
  })

  /**
   * The one probe failure that is EXPECTED, and whose obvious action is the
   * wrong one. Setting a probe address for a service that does not run turns an
   * accurate "not configured" into an inaccurate "unreachable".
   */
  it('states the unprobed websocket gateway as expected, with nothing to fix', () => {
    const finding = findingOf(healthy(), 'WEBSOCKET_GATEWAY_NOT_PROBED')

    expect(finding?.verdict).toBe('informational')
    expect(finding?.remedy?.effort).toBe('none')
    expect(finding?.remedy?.steps).toEqual([])
    expect(finding?.remedy?.summary).toContain('Do not set WEB_SOCKET_SERVER_URL')
    expect(codesOf(healthy())).not.toContain('INTERNAL_SERVICE_PROBE_FAILED')
  })

  it('reports the slowest probe as a duration AND as a fraction of its own deadline', () => {
    const quiet = healthy()
    const near = buildBackendSection({
      serverStatus: serverStatus({
        services: [
          { name: 'api-gateway', reachable: true, status: 'ok' },
          { name: 'auth', reachable: true, status: 'ok', responseTimeMs: 300 },
          { name: 'files', reachable: true, status: 'ok', responseTimeMs: 2100 },
        ],
      }),
    })

    expect(rowOf(quiet, 'Slowest internal probe').value).toBe('under 1s 0-25% of its deadline')
    expect(rowOf(quiet, 'Slowest internal probe').verdict).toBe('informational')
    expect(rowOf(quiet, 'Service nearest its deadline').value).toBe('auth')
    expect(codesOf(quiet)).not.toContain('INTERNAL_PROBE_NEAR_DEADLINE')

    // 2100 of the 2500 ms a non-auth probe is allowed: nothing has failed, and
    // one slow response away from being reported unreachable.
    expect(rowOf(near, 'Slowest internal probe').value).toBe('2s 75-90% of its deadline')
    expect(rowOf(near, 'Slowest internal probe').verdict).toBe('degraded')
    expect(rowOf(near, 'Service nearest its deadline').value).toBe('files')
    expect(findingOf(near, 'INTERNAL_PROBE_NEAR_DEADLINE')?.verdict).toBe('degraded')
  })

  /**
   * The gateway's deadlines differ per service (3000 ms for auth, 2500 for the
   * rest), so one duration maps to two different fractions. A single shared
   * deadline would under-report the one probe that matters most.
   */
  it('uses each service own deadline for the fraction', () => {
    const authSlow = buildBackendSection({
      serverStatus: serverStatus({
        services: [{ name: 'auth', reachable: true, status: 'ok', responseTimeMs: 2100 }],
      }),
    })

    expect(rowOf(authSlow, 'Slowest internal probe').value).toBe('2s 50-75% of its deadline')
    expect(codesOf(authSlow)).not.toContain('INTERNAL_PROBE_NEAR_DEADLINE')
  })

  it('skips the unprobed gateway and unreported timings when finding the slowest', () => {
    const model = buildBackendSection({
      serverStatus: serverStatus({
        services: [
          { name: 'api-gateway', reachable: true, status: 'ok', responseTimeMs: 9999 },
          { name: 'files', reachable: true, status: 'ok' },
          { name: 'revisions', reachable: true, status: 'ok', responseTimeMs: 50 },
        ],
      }),
    })

    expect(rowOf(model, 'Service nearest its deadline').value).toBe('revisions')
    expect(rowOf(model, 'Slowest internal probe').value).toBe('under 1s 0-25% of its deadline')
  })

  /**
   * A name off the wire never becomes a row label. The rows iterate this build's
   * own closed tuple; an unrecognised entry is counted, which is evidence, and
   * never named, which is the one field in this payload with an address-shaped
   * future.
   */
  it('counts a service this build does not know and never names it', () => {
    const model = buildBackendSection({
      serverStatus: serverStatus({
        services: [
          ...healthyServices(),
          { name: 'search-indexer.internal:9200', reachable: true, status: 'ok', responseTimeMs: 10 },
          { name: 'another-unknown', reachable: false, status: 'down' },
        ],
      }),
    })

    expect(rowOf(model, 'Services reported').value).toBe('8')
    expect(rowOf(model, 'Unrecognised services reported').value).toBe('2')
    expect(JSON.stringify(model)).not.toContain('search-indexer')
    expect(JSON.stringify(model)).not.toContain('another-unknown')
    // And the unknown entries are not allowed to produce a finding either.
    expect(codesOf(model)).not.toContain('INTERNAL_SERVICE_PROBE_FAILED')
  })

  /* ------------------------------------------------------------------------ */
  /* A green probe is not a working lane                                      */
  /* ------------------------------------------------------------------------ */

  /**
   * *** THE MEASURED FAILURE THIS GROUP EXISTS FOR. ***
   *
   * On a deployment where file listing aborted, downloads hung forever, previews
   * failed and the account's usage read zero permanently, this pane showed: files
   * probe "answering", FILES_V1 advertised, no unmet files condition, and all three
   * files variables set. Every row defensible, the screen as a whole wrong.
   *
   * The probe is an UNAUTHENTICATED `GET /healthcheck/readiness`. It cannot see a
   * credential the far end refuses, which is the exact failure the user had — so a
   * positive reading keeps its fact and loses its claim.
   */
  it('caps a probe that answered, because an unauthenticated readiness route is not an authorized call', () => {
    const row = rowOf(healthy(), 'Files service probe')

    expect(row.value).toBe('answering')
    expect(row.claimed).toBe('healthy')
    expect(row.verdict).toBe('undetermined')
    expect(row.evidence.kind).toBe('proxy')
    expect(row.caveat).toContain('AUTHORIZED request')

    // Every probed service, not only files: the mechanism is the same route and the
    // same self-resolved address for all of them.
    for (const label of ['Auth service probe', 'Syncing server probe', 'Revisions service probe']) {
      expect(rowOf(healthy(), label).claimed).toBe('healthy')
      expect(rowOf(healthy(), label).verdict).toBe('undetermined')
    }
  })

  it('still reports a probe that FAILED as broken, on direct evidence', () => {
    // *** THE CONTROL. *** Capping the positive reading must not cost the negative
    // one: a probe that failed, failed, and that is conclusive.
    const model = buildBackendSection({
      topology: topology(),
      serverStatus: serverStatus({
        services: [
          { name: 'api-gateway', reachable: true, status: 'ok' },
          { name: 'files', reachable: false, status: 'down', detail: 'unreachable', responseTimeMs: 2500 },
        ],
      }),
    })
    const row = rowOf(model, 'Files service probe')

    expect(row.value).toBe('did not connect')
    expect(row.verdict).toBe('broken')
    expect(row.evidence.kind).toBe('direct')
    expect(codesOf(model)).toContain('INTERNAL_SERVICE_PROBE_FAILED')
    expect(model.worstVerdict).toBe('broken')
  })

  it('states that nothing on this screen establishes a file transfer, especially when the probe is green', () => {
    const finding = findingOf(healthy(), 'FILE_TRANSFER_UNVERIFIED')

    // Precondition: the probe really did read green, so this is the "everything
    // looks fine" case rather than one where something else already failed.
    expect(rowOf(healthy(), 'Files service probe').value).toBe('answering')
    expect(finding?.verdict).toBe('undetermined')
    expect(finding?.detail).toContain('DISAGREE satisfy every row on this screen and refuse every transfer')
    expect(finding?.detail).toContain('never as "file transfers work"')
  })

  it('does not raise the unverified-transfer finding when no files probe was reported at all', () => {
    // Absent is not a green probe either: with nothing reported there is no claim
    // to qualify, and the row already reads "not reported" on absent evidence.
    const model = buildBackendSection({
      topology: topology(),
      serverStatus: serverStatus({ services: [{ name: 'api-gateway', reachable: true, status: 'ok' }] }),
    })

    expect(rowOf(model, 'Files service probe').value).toBe('not reported')
    expect(codesOf(model)).not.toContain('FILE_TRANSFER_UNVERIFIED')
  })

  /* ------------------------------------------------------------------------ */
  /* What the files probe was pointed at                                      */
  /* ------------------------------------------------------------------------ */

  /**
   * `FILES_SERVER_PROBE_URL` unset does not disable the probe — it falls back to
   * `http://localhost:<FILES_SERVER_PORT>`, loopback RELATIVE TO THE API-GATEWAY.
   * On the single container that is the files service; on anything else it is not,
   * and "answering" then describes something that is not the files service.
   */
  it('derives what the probe dialled from a presence boolean and the mode', () => {
    expect(filesProbeTarget(topology({ presence: { FILES_SERVER_PROBE_URL: true } }))).toBe('configured')
    expect(filesProbeTarget(topology({ mode: 'home-server', presence: { FILES_SERVER_PROBE_URL: false } }))).toBe(
      'colocated-sibling',
    )
    for (const mode of ['self-hosted', 'unset', 'other'] as const) {
      expect(filesProbeTarget(topology({ mode, presence: { FILES_SERVER_PROBE_URL: false } }))).toBe('gateway-loopback')
    }
    // Absent is not false: a key missing from the presence map is silence.
    expect(filesProbeTarget(topology({ presence: {} }))).toBe('unknown')
    expect(filesProbeTarget(undefined)).toBe('unknown')
    expect(filesProbeTarget(topology({ mode: undefined, presence: { FILES_SERVER_PROBE_URL: false } }))).toBe('unknown')
  })

  it('withholds the probe result entirely when it dialled the gateway’s own loopback', () => {
    const model = buildBackendSection({
      topology: topology({ mode: 'self-hosted', presence: { FILES_SERVER_PROBE_URL: false } }),
      serverStatus: serverStatus(),
    })
    const row = rowOf(model, 'Files service probe')

    // The word an operator skims must not say the opposite of the sentence under it.
    expect(row.value).toBe('did not probe the files service')
    expect(row.verdict).toBe('undetermined')
    expect(row.note).toContain('IS NOT SET AND THIS IS NOT A SINGLE CONTAINER')
    expect(findingOf(model, 'FILES_PROBE_TARGET_WRONG')?.verdict).toBe('degraded')
    expect(findingOf(model, 'FILES_PROBE_TARGET_WRONG')?.remedy?.summary).toContain('FILES_SERVER_PROBE_URL')
    expect(findingOf(model, 'FILES_PROBE_TARGET_WRONG')?.remedy?.steps?.[1]).toContain('Do NOT use FILES_SERVER_URL')
  })

  it('leaves the probe result standing where the target IS the files service', () => {
    for (const reported of [
      topology({ presence: { FILES_SERVER_PROBE_URL: true } }),
      topology({ mode: 'home-server', presence: { FILES_SERVER_PROBE_URL: false } }),
    ]) {
      const model = buildBackendSection({ topology: reported, serverStatus: serverStatus() })

      expect(rowOf(model, 'Files service probe').value).toBe('answering')
      expect(codesOf(model)).not.toContain('FILES_PROBE_TARGET_WRONG')
      // ...and the claim is STILL capped, because the address being right says
      // nothing about the credential.
      expect(rowOf(model, 'Files service probe').verdict).toBe('undetermined')
      expect(codesOf(model)).toContain('FILE_TRANSFER_UNVERIFIED')
    }
  })

  it('ignores a duplicate entry for a known service rather than letting the last one win', () => {
    const model = buildBackendSection({
      serverStatus: serverStatus({
        services: [
          { name: 'files', reachable: true, status: 'ok', responseTimeMs: 10 },
          { name: 'files', reachable: false, status: 'down' },
        ],
      }),
    })

    expect(rowOf(model, 'Files service probe').value).toBe('answering')
    expect(rowOf(model, 'Services reported').value).toBe('2')
    expect(rowOf(model, 'Unrecognised services reported').value).toBe('0')
  })
})

/* -------------------------------------------------------------------------- */
/* Queues                                                                     */
/* -------------------------------------------------------------------------- */

describe('event delivery and queues', () => {
  it('derives the fan-out mode from presence, and reads a missing key as silence', () => {
    const queued = buildBackendSection({ topology: topology({ presence: { SQS_QUEUE_URL: true } }) })
    const inProcess = buildBackendSection({ topology: topology({ presence: { SQS_QUEUE_URL: false } }) })
    const silent = buildBackendSection({ topology: topology({ presence: { SNS_TOPIC_ARN: true } }) })

    expect(rowOf(queued, 'Event fan-out').value).toBe('queue-backed')
    expect(rowOf(queued, 'Event fan-out').verdict).toBe('informational')
    expect(rowOf(inProcess, 'Event fan-out').value).toBe('in-process')
    expect(rowOf(silent, 'Event fan-out').value).toBe('not reported')
    expect(rowOf(silent, 'Event fan-out').evidence.kind).toBe('absent')
    expect(rowOf(silent, 'Event topic configured').value).toBe('set')
  })

  it('does not treat recorded:false as a set of falses', () => {
    const model = buildBackendSection({ topology: { recorded: false, presence: { SQS_QUEUE_URL: true } } })

    expect(rowOf(model, 'Event fan-out').value).toBe('not reported')
    expect(rowOf(model, 'Event topic configured').value).toBe('not reported')
  })

  /**
   * The measured defect: two consumers on one queue cost roughly four in five
   * realtime pushes on the compose stack, and presence cannot express it — a
   * queue being configured says a queue exists and nothing about how many
   * consumers are pointed at it.
   */
  it('reports the queue as a separation state, with no address in it', () => {
    const shared = buildBackendSection({ queues: { separation: 'inherited-shared-queue' } })
    const own = buildBackendSection({ queues: { separation: 'own-prefixed-queue' } })
    const unreported = buildBackendSection()

    expect(rowOf(shared, 'Queue separation').value).toBe('inherited-shared-queue')
    expect(rowOf(shared, 'Queue separation').verdict).toBe('broken')
    const finding = findingOf(shared, 'EVENT_QUEUE_SHARED')
    expect(finding?.verdict).toBe('broken')
    expect(finding?.remedy?.effort).toBe('restart')
    expect(finding?.remedy?.summary).toContain('API_GATEWAY_SQS_')

    expect(rowOf(own, 'Queue separation').value).toBe('own-prefixed-queue')
    expect(rowOf(own, 'Queue separation').verdict).toBe('informational')
    expect(codesOf(own)).not.toContain('EVENT_QUEUE_SHARED')

    expect(rowOf(unreported, 'Queue separation').value).toBe('not reported')
    expect(rowOf(unreported, 'Queue separation').evidence.kind).toBe('absent')
    expect(codesOf(unreported)).not.toContain('EVENT_QUEUE_SHARED')
  })

  it('refuses a separation state this build does not recognise', () => {
    const model = buildBackendSection({ queues: { separation: 'queue://planted/address' } })

    expect(rowOf(model, 'Queue separation').value).toBe(UNRECOGNISED)
    expect(codesOf(model)).not.toContain('EVENT_QUEUE_SHARED')
  })
})

/* -------------------------------------------------------------------------- */
/* The failed read, classified by the health report's own rule                */
/* -------------------------------------------------------------------------- */

describe('why the status read failed', () => {
  /**
   * The classifier is reused from `healthReport.ts` rather than re-written, so
   * the Server pane's report and this section cannot disagree about why a read
   * failed. This asserts the reuse is real on every code, which is the only way
   * a shared rule stays shared.
   */
  it.each<[string, string]>([
    ['Could not load: 401', 'unauthorized'],
    ['Could not load: 403', 'forbidden'],
    ['Could not load: 404', 'not-found'],
    ['could not reach the server', 'unreachable'],
    ['something else entirely', 'other'],
  ])('classifies %p as %p, exactly as the health report does', (message, expected) => {
    const model = buildBackendSection({ statusError: message })

    expect(errorKind(message)).toBe(expected)
    expect(rowOf(model, 'Why the read failed').value).toBe(expected)
  })

  /**
   * A permission answer does not implicate the services. Reporting a 403 as a
   * fault is how a pane comes to say "your database is down" when the real
   * answer is "this account is not an admin".
   */
  it('reports a permission answer as informational and a transport failure as degraded', () => {
    const forbidden = buildBackendSection({ statusError: 'Could not load: 403' })
    const unreachable = buildBackendSection({ statusError: 'could not reach the server' })

    expect(rowOf(forbidden, 'Why the read failed').verdict).toBe('informational')
    expect(findingOf(forbidden, 'BACKEND_STATUS_UNREADABLE')?.verdict).toBe('informational')
    expect(findingOf(forbidden, 'BACKEND_STATUS_UNREADABLE')?.remedy?.effort).toBe('none')

    expect(rowOf(unreachable, 'Why the read failed').verdict).toBe('degraded')
    expect(findingOf(unreachable, 'BACKEND_STATUS_UNREADABLE')?.verdict).toBe('degraded')
    expect(findingOf(unreachable, 'BACKEND_STATUS_UNREADABLE')?.remedy?.effort).toBe('peer-service')
  })

  it('sends an older server image to a rebuild rather than to a setting', () => {
    const model = buildBackendSection({ statusError: 'Could not load: 404' })

    expect(findingOf(model, 'BACKEND_STATUS_UNREADABLE')?.remedy?.effort).toBe('rebuild')
  })

  it('treats an empty or null error as no error at all', () => {
    for (const statusError of [null, undefined, '']) {
      const model = buildBackendSection({ statusError })

      expect(rowOf(model, 'Why the read failed').value).toBe('not reported')
      expect(rowOf(model, 'Admin status endpoint').value).toBe('not reported')
      expect(codesOf(model)).toEqual([])
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Probe results                                                              */
/* -------------------------------------------------------------------------- */

describe('operator-triggered checks', () => {
  it('shows only the probe results tagged for this section, and only when there are some', () => {
    const none = buildBackendSection({
      outcomes: [{ name: 'Ticket mint', passed: true, detail: 'd', reportDetail: 'r', section: 'websocket' }],
    })
    const some = buildBackendSection({
      outcomes: [
        { name: 'Ticket mint', passed: true, detail: 'd', reportDetail: 'r', section: 'websocket' },
        { name: 'Round trip', passed: false, detail: 'd', reportDetail: 'r', section: 'backend' },
      ],
    })

    expect(headingsOf(none)).not.toContain('Operator-triggered checks')
    expect(headingsOf(some)).toContain('Operator-triggered checks')
    const block = some.blocks.find((candidate) => String(candidate.heading) === 'Operator-triggered checks')
    expect(block?.outcomes).toHaveLength(1)
    expect(block?.outcomes?.[0].name).toBe('Round trip')
  })
})

/* -------------------------------------------------------------------------- */
/* A healthy deployment still says what it does not know                      */
/* -------------------------------------------------------------------------- */

describe('a healthy deployment', () => {
  /**
   * The intended output, stated so it is not "fixed" later. A deployment where
   * every probe answers still reports `undetermined` overall, because the
   * database connection state, the schema, the pool and the queue separation are
   * not reported by any endpoint this section can read — and the gateway's own
   * self-report is capped. A green section here would be the panel claiming more
   * than it has.
   *
   * Every PROBE row is capped too, and that is the point of the change this
   * assertion was rewritten for: the probes are unauthenticated readiness routes,
   * and a screen of green probe rows is what this pane showed over a files
   * subsystem that was entirely broken. The cache ping is NOT capped — that is a
   * real round trip over the client the gateway actually holds — so the two are
   * asserted apart rather than swept together.
   */
  it('reports undetermined overall, because several facts are not reported', () => {
    const model = healthy()

    expect(model.worstVerdict).toBe('undetermined')
    expect(rowOf(model, 'Auth service probe').claimed).toBe('healthy')
    expect(rowOf(model, 'Auth service probe').verdict).toBe('undetermined')
    expect(rowOf(model, 'Gateway cache ping').verdict).toBe('healthy')
    expect(codesOf(model).sort()).toEqual(['FILE_TRANSFER_UNVERIFIED', 'WEBSOCKET_GATEWAY_NOT_PROBED'])
  })

  it('emits only verdicts the contract declares', () => {
    const model = healthy()

    for (const row of allRows(model)) {
      expect(VERDICTS).toContain(row.verdict)
      expect(VERDICTS).toContain(row.claimed)
    }
    for (const finding of allFindings(model)) {
      expect(VERDICTS).toContain(finding.verdict)
      expect(VERDICTS).toContain(finding.claimed)
    }
  })

  it('writes a report with every block in it', () => {
    const report = healthy().reportLines.join('\n')

    expect(report).toContain('## Database & internal comms')
    expect(report).toContain('### Durable storage')
    expect(report).toContain('### Shared cache')
    expect(report).toContain('### Internal service communication')
    expect(report).toContain('### Event delivery and queues')
    expect(report).toContain('- Auth database round trip: answering')
    expect(report).toContain('- Addresses: never collected')
    expect(report).toContain('- Per-service failure detail: read by nothing here')
  })
})

/* -------------------------------------------------------------------------- */
/* Nothing an address could travel in                                         */
/* -------------------------------------------------------------------------- */

describe('no address, name, detail or error text reaches a row, a finding, a remedy or the report', () => {
  /**
   * Planted into every field this section reads that is typed as a string off
   * the wire, plus the two that are typed `unknown`.
   *
   * The leak path that MATTERS here is not a row value — `safeConstant` refuses
   * a value of type `string`, so a value cannot reach one without the banned
   * brand cast, which `diagnosticsSections.spec.ts` greps this module for. It is
   * `note`, `detail`, `summary` and `because`, which are plain strings and are
   * exactly where an interpolated server value would sit on the operator's
   * screen. So the scan serialises the whole model, not only the report.
   */
  /**
   * The most address-shaped input this section receives. The message is built by
   * this build and interpolates whatever the fetch threw, so it is the one place
   * an address arrives without a field declaring it.
   *
   * It is planted in its OWN model rather than beside a payload, because a
   * payload that arrived means the error is stale and the module stops reading
   * it — which would make a scan over this string vacuous in the model below.
   *
   * Every candidate here is deliberately built out of MARKERS rather than
   * ordinary English, including around the one word the classifier matches on
   * (`unreachable`). That is what makes the derived-fragment scan below sound: a
   * fragment drawn from a plausible English sentence would collide with the
   * prose this build writes itself and fail on a clean module.
   */
  const PLANTED_ERROR =
    'PLANTED-READ-FAILURE-MARKER unreachable https://db-PLANTED-HOST.internal:3306 redis://u:PLANTED-PASSWORD@cache.internal:6379'

  /**
   * *** AN OPAQUE SENTINEL, BECAUSE AN ADDRESS-SHAPED ONE CANNOT DISCRIMINATE. ***
   *
   * Almost every candidate below carries a scheme, a dot or a colon, so a denylist
   * and a correct allowlist both refuse it and the scan cannot tell the two apart.
   * This one has none of those: nothing in `sanitizeServerCopy` can match any part
   * of it, so only an allowlist stops it. It is planted in the three topology fields
   * this section now reads for the files-probe target — the presence KEY, the MODE
   * and the proxy setting — which is the surface that change made reachable.
   *
   * Built from markers rather than plausible prose, and long enough that the derived
   * middle and tail windows sit past the 30th and 45th characters, where a
   * truncating leak leaves its surviving bytes.
   */
  const PLANTED_OPAQUE = 'qzv4m-PLANTEDOPAQUEHEAD-wwwwwwww-PLANTEDOPAQUEMID-wwwwwwww-PLANTEDOPAQUETAIL'

  const SECRETS = [
    PLANTED_ERROR,
    PLANTED_OPAQUE,
    'redis://user:PLANTED-PASSWORD@cache.internal:6379',
    'mysql://root:PLANTED-DB-PASSWORD@db.internal:3306/standardnotes',
    'https://syncing-server.planted.internal:3000/healthcheck/readiness',
    'syncing-server.planted.internal',
    'sk-live-PLANTED-SECRET-0123456789abcdef',
    'PLANTED-PASSWORD',
    'PLANTED-DB-PASSWORD',
    'PLANTED-DETAIL-FROM-PROBE 10.44.12.9:3104',
    'PLANTED-SERVICE-NAME',
    'PLANTED-SEPARATION-STATE',
    'PLANTED-CONNECTION-STATE',
  ]

  /**
   * *** THIS DERIVATION EXISTS BECAUSE A HAND-WRITTEN LIST MISSED A REAL LEAK. ***
   *
   * A partially scrubbed string is not safe, and a partial scrub has actually
   * happened in this directory: a version reading `v1.2.3-build@ci.internal`
   * once printed as `v1.2.3-build@[address withheld]` — the host removed and the
   * rest intact. Refusing is safe; repairing is not.
   *
   * The first version of this file hand-picked fragments and a type-valid
   * mutation interpolating `message.slice(0, 60)` into a remedy SURVIVED it:
   * every hand-picked fragment happened to sit past the 60th character, so the
   * leak was of a part of the string nobody had thought to assert on. A leak
   * that truncates is the normal shape of a leak — a log line, a `slice`, a
   * `substring`, a UI that elides — so the fragments are now DERIVED from each
   * candidate at its start, its middle and its end, which is where a truncation
   * leaves the surviving bytes.
   */
  const fragmentsOf = (value: string): string[] => {
    const window = 20
    if (value.length <= window) {
      return [value]
    }
    const middle = Math.floor((value.length - window) / 2)

    return [value.slice(0, window), value.slice(middle, middle + window), value.slice(-window)]
  }

  const FRAGMENTS = [...new Set(SECRETS.flatMap(fragmentsOf))]

  const plantedUnreadable = (): SectionModel => buildBackendSection({ statusError: PLANTED_ERROR })

  const planted = (): SectionModel =>
    buildBackendSection({
      serverStatus: {
        health: {
          gateway: { redis: 'mysql://root:PLANTED-DB-PASSWORD@db.internal:3306/standardnotes' },
          auth: {
            reachable: true,
            // Free-form on the wire, reported as a PRESENCE by the health report
            // and read by nothing at all here.
            status: 'https://syncing-server.planted.internal:3000/healthcheck/readiness',
            checks: { db: false, redis: false, 'sk-live-PLANTED-SECRET-0123456789abcdef': true },
            responseTimeMs: 2900,
          },
        },
        services: [
          { name: 'api-gateway', reachable: true, status: 'ok' },
          // A known service whose DETAIL carries the address a probe failure put
          // there. This module reads `status` and `reachable` and never `detail`.
          {
            name: 'syncing-server',
            reachable: false,
            status: 'down',
            detail: 'PLANTED-DETAIL-FROM-PROBE 10.44.12.9:3104',
            responseTimeMs: 2400,
          },
          {
            name: 'files',
            reachable: true,
            status: 'degraded',
            detail: 'redis://user:PLANTED-PASSWORD@cache.internal:6379',
          },
          { name: 'websocket-gateway', reachable: false, status: 'unknown', detail: 'not configured' },
          // A name off the wire, which must be counted and never printed.
          { name: 'PLANTED-SERVICE-NAME', reachable: true, status: 'ok', responseTimeMs: 1 },
        ],
        // Fields this section does not read at all. Planted anyway: a future
        // reader of this payload must not be able to add one without this scan
        // noticing.
        network: { trustProxy: '10.0.0.0/8', clientIpHeader: 'X-Planted-Header' },
        masterSwitches: { currentVersion: 'v9.9.9-PLANTED-VERSION' },
      },
      topology: topology({
        // The three topology fields the files-probe target is derived from, each
        // poisoned. `mode` and `serviceProxySetting` are the server's enums and go
        // through `safeEnum`; the presence KEY is server-chosen text that this
        // section only ever tests membership of.
        mode: PLANTED_OPAQUE as 'other',
        serviceProxySetting: PLANTED_OPAQUE as 'other',
        presence: {
          SQS_QUEUE_URL: true,
          SNS_TOPIC_ARN: true,
          'redis://user:PLANTED-PASSWORD@cache.internal:6379': true,
          [PLANTED_OPAQUE]: true,
        },
      }),
      datastore: {
        connectionState: 'PLANTED-CONNECTION-STATE',
        migrationsApplied: false,
        pendingMigrations: 2,
        poolInUse: 19,
        poolSize: 20,
        readRoundTripMs: 40,
        writeRoundTripMs: 90,
        deadOutboxRows: 7,
      },
      queues: { separation: 'PLANTED-SEPARATION-STATE' },
    })

  /** Both planted models, so neither leak path can be left unscanned. */
  const plantedModels = (): readonly SectionModel[] => [planted(), plantedUnreadable()]

  it.each([...SECRETS])('keeps the planted value %p out of the serialised model', (secret) => {
    for (const model of plantedModels()) {
      expect(JSON.stringify(model)).not.toContain(secret)
    }
  })

  it.each([...FRAGMENTS])('keeps even the long fragment %p out of the serialised model', (fragment) => {
    for (const model of plantedModels()) {
      expect(JSON.stringify(model)).not.toContain(fragment)
    }
  })

  it.each([...SECRETS, ...FRAGMENTS])('keeps %p out of the copyable report', (candidate) => {
    for (const model of plantedModels()) {
      expect(model.reportLines.join('\n')).not.toContain(candidate)
    }
  })

  it('writes a real and full report in both planted models, so the scan is not vacuous', () => {
    const report = planted().reportLines.join('\n')
    const unreadable = plantedUnreadable().reportLines.join('\n')

    expect(report).toContain('## Database & internal comms')
    expect(report).toContain('- Worst verdict: broken')
    expect(report).toContain('- Queue separation: other (unrecognised)')
    expect(unreadable).toContain('- Why the read failed: unreachable')
    expect(unreadable).toContain('- Status-read error text: never stored or printed')
  })

  /**
   * The scan passing on an empty model would prove nothing, so the facts BESIDE
   * the refusals are asserted: every planted field was read, refused, and still
   * produced a diagnosis.
   */
  it('still reports the facts beside the refusals', () => {
    const model = planted()

    expect(rowOf(model, 'Admin status endpoint').value).toBe('answered')
    expect(rowOf(model, 'Database connection state').value).toBe(UNRECOGNISED)
    expect(rowOf(model, 'Queue separation').value).toBe(UNRECOGNISED)
    expect(rowOf(model, 'Schema migrations').value).toBe('no 2 pending')
    expect(rowOf(model, 'Connection pool in use').value).toBe('19 of 20')
    expect(rowOf(model, 'Syncing server probe').value).toBe('did not connect')
    expect(rowOf(model, 'Services reported').value).toBe('5')
    expect(rowOf(model, 'Unrecognised services reported').value).toBe('1')
    // A non-boolean gateway cache field is not a cache state at all.
    expect(rowOf(model, 'Gateway cache ping').value).toBe('not reported')
    expect(codesOf(model).sort()).toEqual(
      [
        'AUTH_DATABASE_NOT_ANSWERING',
        'DATABASE_MIGRATIONS_PENDING',
        'FILE_TRANSFER_UNVERIFIED',
        'INTERNAL_PROBE_NEAR_DEADLINE',
        'INTERNAL_SERVICE_PROBE_FAILED',
        'WEBSOCKET_GATEWAY_NOT_PROBED',
      ].sort(),
    )

    const unreadable = plantedUnreadable()
    expect(rowOf(unreadable, 'Admin status endpoint').value).toBe('did not answer')
    expect(rowOf(unreadable, 'Why the read failed').value).toBe('unreachable')
    expect(codesOf(unreadable)).toEqual(['BACKEND_STATUS_UNREADABLE'])
  })

  /**
   * The remedies are the longest prose in the model and the easiest place for an
   * interpolated value to hide, so they are scanned as their own corpus rather
   * than only through the serialised model.
   */
  it('keeps every planted value out of every remedy', () => {
    const remedies = plantedModels()
      .flatMap((model) => allFindings(model))
      .map((finding) => finding.remedy)
      .filter((remedy) => remedy !== undefined)
    const prose = remedies
      .map((remedy) => [remedy.code, remedy.summary, ...remedy.steps, ...remedy.because].join('\n'))
      .join('\n')

    expect(remedies.length).toBeGreaterThanOrEqual(6)
    for (const candidate of [...SECRETS, ...FRAGMENTS]) {
      expect(prose).not.toContain(candidate)
    }
  })

  /** The notes are what the operator actually reads. Same corpus, same rule. */
  it('keeps every planted value out of every note, title and detail', () => {
    const prose = plantedModels()
      .flatMap((model) => [
        ...allRows(model).map((row) => `${row.note} ${row.caveat ?? ''}`),
        ...allFindings(model).map((finding) => `${finding.title} ${finding.detail} ${finding.caveat ?? ''}`),
        ...model.blocks.map((block) => block.description),
      ])
      .join('\n')

    for (const candidate of [...SECRETS, ...FRAGMENTS]) {
      expect(prose).not.toContain(candidate)
    }
  })

  /**
   * The gating itself, asserted: a caller holding a stale error alongside a
   * payload that DID arrive must not produce a model that says "answered" and
   * raises an unreadable-status finding in the same breath.
   */
  it('stops reading a stale error once a payload arrives', () => {
    const model = buildBackendSection({ serverStatus: { services: [] }, statusError: PLANTED_ERROR })

    expect(rowOf(model, 'Admin status endpoint').value).toBe('answered')
    expect(rowOf(model, 'Why the read failed').value).toBe('not reported')
    expect(rowOf(model, 'Why the read failed').evidence.kind).toBe('absent')
    expect(codesOf(model)).not.toContain('BACKEND_STATUS_UNREADABLE')
    expect(JSON.stringify(model)).not.toContain('planted.internal')
  })
})
