import {
  buildBackendSection,
  describeCacheRequirement,
  FILES_PROBE_TARGETS,
  filesProbeTarget,
  KNOWN_SERVICES,
  type BackendSectionInput,
} from './backendSection'
import type { DeploymentTopology } from './diagnosticRemedies'
import {
  NOT_PUBLISHED,
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

    // Six unproduced durable-store rows collapsed into one, so the count fell by
    // five; the derived queue-prefix row and the consumer census added two back.
    expect(rows).toHaveLength(23)
    for (const row of rows) {
      expect({ label: String(row.label), kind: row.evidence.kind, verdict: row.verdict }).toEqual({
        label: String(row.label),
        kind: 'absent',
        verdict: 'undetermined',
      })
    }

    /**
     * *** THE STRUCTURAL WORDING IS NOW WRONG FOR EVERY ROW IN THIS SECTION,
     * AND THAT IS ASSERTED RATHER THAN ASSUMED. ***
     *
     * Two rows wore "no endpoint publishes this": the collapsed durable-store row
     * and the queue separation verdict. Both have producers now — the service
     * that owns the handle reports the first, and the gateway derives the second
     * from its own consumer census — so every absence here is "a field that could
     * have been reported and was not", which is what "not reported" means.
     *
     * The emptied list cannot be iterated into an assertion, so the property is
     * stated directly, with the constant asserted DISTINCT from "not reported"
     * first: without that, a build that made the two strings equal would pass the
     * scan trivially.
     */
    expect(NOT_PUBLISHED).not.toBe('not reported')
    for (const row of rows) {
      expect({ label: String(row.label), value: String(row.value) }).toEqual({
        label: String(row.label),
        value: 'not reported',
      })
    }
    expect(rows.map((row) => String(row.value))).not.toContain(String(NOT_PUBLISHED))
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
    // A fractional connection count is refused and the half that DID arrive is
    // still printed, so the row says which half it could not read rather than
    // printing a connection count of 1.5. It is also not read as "this driver
    // keeps no pool": the server just reported a maximum, so a pool exists.
    expect(rowOf(model, 'Connection pool in use').value).toBe('not reported of 10')
    expect(rowOf(model, 'Connection pool in use').value).not.toBe('no pool kept by this driver')
    // And the row does not claim it looked and got an answer while printing a
    // refusal — the value and the evidence have to agree.
    expect(rowOf(model, 'Connection pool in use').evidence.kind).toBe('absent')
  })

  /* ------------------------------------------------------------------------ */
  /* The write probe: the one row a read cannot stand in for                  */
  /* ------------------------------------------------------------------------ */

  /**
   * *** THREE DEPLOYMENTS PASS EVERY READ ON THIS SCREEN AND REFUSE EVERY
   * WRITE. ***
   *
   * A server opened read-only, a read-only replica being written to, and a
   * revoked UPDATE grant. The probe is a self-assignment under an impossible
   * predicate, so it matches no row and takes no lock, and all three refuse it —
   * which makes `refused` conclusive about writes while `accepted` establishes
   * only a NECESSARY condition: a statement that changes nothing being accepted
   * does not mean a real write would be, because a full volume, a constraint or
   * a trigger still refuses that one.
   *
   * So the two arms are asserted to behave DIFFERENTLY under the same proxy —
   * the positive capped, the negative surviving. Asserting only one would pass
   * against a row with no evidence discipline at all.
   */
  it('caps an accepted write probe and lets a refusal survive as broken', () => {
    const accepted = buildBackendSection({ datastore: { writeProbe: 'accepted' } })
    const refused = buildBackendSection({ datastore: { writeProbe: 'refused' } })

    expect(rowOf(accepted, 'Database write probe').value).toBe('accepted')
    expect(rowOf(accepted, 'Database write probe').claimed).toBe('healthy')
    expect(rowOf(accepted, 'Database write probe').verdict).toBe('undetermined')
    expect(rowOf(accepted, 'Database write probe').caveat).toContain('does not establish')
    expect(codesOf(accepted)).not.toContain('DATABASE_WRITES_REFUSED')

    expect(rowOf(refused, 'Database write probe').value).toBe('refused')
    expect(rowOf(refused, 'Database write probe').claimed).toBe('broken')
    expect(rowOf(refused, 'Database write probe').verdict).toBe('broken')
    expect(refused.worstVerdict).toBe('broken')
    const finding = findingOf(refused, 'DATABASE_WRITES_REFUSED')
    expect(finding?.verdict).toBe('broken')
    expect(finding?.remedy?.effort).toBe('peer-service')
    expect(finding?.remedy?.steps?.[0]).toContain('READ REPLICA')
  })

  it('separates a timed-out probe from one that was never attempted', () => {
    const timedOut = buildBackendSection({ datastore: { writeProbe: 'timed-out' } })
    const notAttempted = buildBackendSection({ datastore: { writeProbe: 'not-attempted' } })

    expect(rowOf(timedOut, 'Database write probe').verdict).toBe('degraded')
    expect(rowOf(timedOut, 'Database write probe').evidence.kind).toBe('direct')
    // Not a failure: a deployment where the probe did not run is not one that
    // failed it, and a verdict here would invent an outage out of an omission.
    expect(rowOf(notAttempted, 'Database write probe').verdict).toBe('informational')
    for (const model of [timedOut, notAttempted]) {
      expect(codesOf(model)).not.toContain('DATABASE_WRITES_REFUSED')
    }
  })

  it('refuses a write-probe outcome this build does not recognise', () => {
    const model = buildBackendSection({ datastore: { writeProbe: 'PLANTED-WRITE-PROBE-MARKER' } })

    expect(rowOf(model, 'Database write probe').value).toBe(UNRECOGNISED)
    expect(rowOf(model, 'Database write probe').verdict).toBe('informational')
    expect(JSON.stringify(model)).not.toContain('PLANTED-WRITE-PROBE-MARKER')
    expect(codesOf(model)).not.toContain('DATABASE_WRITES_REFUSED')
  })

  /**
   * The server's own `other` is a token ITS build could not name, so it says
   * nothing about the handle and must not read as a fault — while `handle-only`
   * and `disconnected`, which do say something, keep their verdict.
   */
  it('does not read the server own collapse of a connection state as a fault', () => {
    const collapsed = buildBackendSection({ datastore: { connectionState: 'other' } })

    expect(rowOf(collapsed, 'Database connection state').value).toBe('other')
    expect(rowOf(collapsed, 'Database connection state').value).not.toBe(UNRECOGNISED)
    expect(rowOf(collapsed, 'Database connection state').verdict).toBe('informational')
    expect(codesOf(collapsed)).not.toContain('DATABASE_HANDLE_NOT_CONNECTED')

    for (const [state, verdict] of [
      ['connected', 'healthy'],
      ['handle-only', 'broken'],
      ['disconnected', 'broken'],
    ] as const) {
      const model = buildBackendSection({ datastore: { connectionState: state } })
      expect(rowOf(model, 'Database connection state').value).toBe(state)
      expect(rowOf(model, 'Database connection state').verdict).toBe(verdict)
    }
    expect(codesOf(buildBackendSection({ datastore: { connectionState: 'handle-only' } }))).toContain(
      'DATABASE_HANDLE_NOT_CONNECTED',
    )
  })

  /**
   * *** AN UNREADABLE SCHEMA IS NOT A SCHEMA WITH NOTHING PENDING. *** Inside a
   * block that otherwise reported, an absent `migrationsApplied` means the
   * migration table could not be read, and reporting that as "up to date" would
   * be the panel choosing the most reassuring reading available.
   */
  it('says the schema was unreadable rather than implying nothing is pending', () => {
    const row = rowOf(buildBackendSection({ datastore: { connectionState: 'connected' } }), 'Schema migrations')

    expect(row.value).toBe('schema not readable')
    expect(row.value).not.toBe('yes')
    expect(row.value).not.toContain('0')
    expect(row.verdict).toBe('undetermined')
    expect(row.evidence.kind).toBe('absent')
    expect(row.note).toContain('AN ABSENT COUNT IS NOT ZERO')
  })

  it('reports the pool only when both halves arrive, and warns at saturation', () => {
    const neither = buildBackendSection({ datastore: {} })
    const half = buildBackendSection({ datastore: { poolInUse: 4 } })
    const quiet = buildBackendSection({ datastore: { poolInUse: 4, poolSize: 10 } })
    const saturated = buildBackendSection({ datastore: { poolInUse: 19, poolSize: 20 } })

    // Nothing reported at all: the six rows collapse into one line rather than a
    // column of "not reported", so the pool row is not rendered. The collapsed
    // row no longer claims nobody publishes the fields — the service that owns
    // the handle does — so it reads as the ordinary absence it is.
    expect(allRows(neither).map((row) => String(row.label))).not.toContain('Connection pool in use')
    expect(rowOf(neither, 'Connection, schema, pool and round trips').value).toBe('not reported')
    expect(rowOf(neither, 'Connection, schema, pool and round trips').value).not.toBe(String(NOT_PUBLISHED))
    expect(rowOf(neither, 'Connection, schema, pool and round trips').note).toContain('auth runtime route')
    /**
     * *** ONE HALF REPORTED IS STILL REPORTED, AND NO POOL IS NOT AN EMPTY POOL.
     * ***
     *
     * The collapse must not swallow a row whose field DID arrive and could not be
     * read on its own — gating this on the parsed `poolReported` rather than on
     * the raw fields would have. And inside a block that reported, absent pool
     * figures mean the DRIVER KEEPS NO POOL (SQLite, which the single container
     * runs), which is a complete answer rather than a missing measurement: a
     * reader told "not reported" goes looking for a pool that does not exist, and
     * `0 of 0` would be a saturation reading nobody took.
     */
    expect(rowOf(half, 'Connection pool in use').value).toBe('4 of not reported')
    expect(rowOf(half, 'Connection pool in use').evidence.kind).toBe('absent')
    // NEITHER figure, inside a block that otherwise reported, is the driver
    // keeping no pool at all — SQLite, which the single container runs. That is a
    // complete answer, and it is neither "not reported" (which sends a reader
    // looking for a pool that does not exist) nor `0 of 0` (a saturation reading
    // nobody took).
    const noPool = buildBackendSection({ datastore: { connectionState: 'connected' } })
    expect(rowOf(noPool, 'Connection pool in use').value).toBe('no pool kept by this driver')
    expect(rowOf(noPool, 'Connection pool in use').value).not.toBe('not reported')
    expect(rowOf(noPool, 'Connection pool in use').value).not.toContain('0')
    expect(rowOf(noPool, 'Connection pool in use').evidence.kind).toBe('absent')
    expect(rowOf(noPool, 'Connection pool in use').note).toContain('NO FIGURES IS NOT AN EMPTY POOL')
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
    const unreported = buildBackendSection({ datastore: { readRoundTripMs: 12 } })

    expect(rowOf(connected, 'Database connection state').value).toBe('connected')
    expect(rowOf(connected, 'Database connection state').verdict).toBe('healthy')
    expect(codesOf(connected)).not.toContain('DATABASE_HANDLE_NOT_CONNECTED')

    expect(rowOf(handle, 'Database connection state').value).toBe('handle-only')
    expect(rowOf(handle, 'Database connection state').verdict).toBe('broken')
    expect(findingOf(handle, 'DATABASE_HANDLE_NOT_CONNECTED')?.remedy?.effort).toBe('rebuild')

    // Reported ALONGSIDE another datastore field, so the row is rendered and the
    // "absent is not a state" reading is the thing under test rather than the
    // collapse. With nothing reported at all the five rows become one line, which
    // the pool test above pins.
    expect(rowOf(unreported, 'Database connection state').value).toBe('not reported')
    expect(rowOf(unreported, 'Database connection state').evidence.kind).toBe('absent')
    expect(allRows(buildBackendSection()).map((row) => String(row.label))).not.toContain('Database connection state')
  })

  /**
   * *** REFUSED IS NOT UNREPORTED, AND THE ROW MUST NOT SAY BOTH. ***
   *
   * An unrecognised state WAS reported; this build simply cannot name it. So the
   * value is the refusal constant and the EVIDENCE IS DIRECT — the panel did
   * look, and it did get an answer. This assertion used to read `absent`, which
   * is the row claiming nothing was reported while printing a refusal of
   * something that was: the same disagreement between a value and its evidence
   * that the pool row carried for a fractional count.
   *
   * No verdict is derived either way, which is the part that was right.
   */
  it('refuses a connection state this build does not recognise rather than printing it', () => {
    const model = buildBackendSection({ datastore: { connectionState: 'reconnecting-soon' } })
    const silent = buildBackendSection({ datastore: { writeProbe: 'accepted' } })

    expect(rowOf(model, 'Database connection state').value).toBe(UNRECOGNISED)
    expect(rowOf(model, 'Database connection state').evidence.kind).toBe('direct')
    expect(rowOf(model, 'Database connection state').verdict).toBe('informational')
    expect(codesOf(model)).not.toContain('DATABASE_HANDLE_NOT_CONNECTED')
    // The control: a state that genuinely was NOT reported still reads absent,
    // so the two are kept apart rather than merged in the other direction.
    expect(rowOf(silent, 'Database connection state').value).toBe('not reported')
    expect(rowOf(silent, 'Database connection state').evidence.kind).toBe('absent')
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
    expect(finding?.detail).toContain('never as "file transfers work"')
    // It credits the probe with what the readiness route really proves, rather than
    // understating it and sending an operator to re-check cleared ground.
    expect(finding?.detail).toContain('storage check passed')
    // *** AND IT SCOPES THE MECHANISM IT NAMES. *** Secret disagreement cannot hold
    // on the images this repo ships — the entrypoint exports both keys once,
    // unprefixed, and supervisord gives no program an environment of its own — so
    // the finding must not imply it for the deployment reading the report.
    expect(finding?.detail).toContain('on the images this repo ships that cannot happen')
    expect(finding?.detail).toContain('only where the services are configured separately')
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
   * *** A FINDING THAT WOULD HAVE FIRED ON EVERY SHIPPED TOPOLOGY. ***
   *
   * `FILES_SERVER_PROBE_URL` unset falls back to `http://localhost:<FILES_SERVER_PORT>`,
   * loopback relative to the api-gateway PROCESS — and the first version of this
   * derivation called that wrong for every mode but `home-server`, raising a
   * `degraded` finding and withholding a correct probe result. It is wrong about the
   * repo: `docker-compose.yml` declares NO files service, its one `server` container
   * runs `[program:files]` and `[program:api-gateway]` as supervisord siblings, the
   * entrypoint exports `FILES_SERVER_PORT=3104` and points the gateway's own
   * internal files URL at that same loopback, and `files/bin/server.ts` listens with
   * no host. So the bundled compose stack — the commonest deployment this repo
   * produces, and the one that produced the report this change came from — would
   * have been told its correct configuration was a misconfiguration.
   *
   * The axis is co-residency, not compose-versus-single, and BOTH shipped shapes are
   * co-resident. A hand-rolled split is indistinguishable from the presence rows, so
   * it is named in the note rather than guessed at, and the finding is gone.
   */
  it('derives what the probe dialled from the presence boolean alone, and never from the mode', () => {
    expect(filesProbeTarget(topology({ presence: { FILES_SERVER_PROBE_URL: true } }))).toBe('configured')

    // EVERY mode, including the two shipped ones, answers the same: an unset probe
    // URL reaches the co-resident files process on every topology this repo ships.
    for (const mode of ['home-server', 'self-hosted', 'unset', 'other', undefined] as const) {
      expect(filesProbeTarget(topology({ mode, presence: { FILES_SERVER_PROBE_URL: false } }))).toBe(
        'colocated-by-default',
      )
      expect(filesProbeTarget(topology({ mode, presence: { FILES_SERVER_PROBE_URL: true } }))).toBe('configured')
    }

    // Absent is not false: a key missing from the presence map is silence.
    expect(filesProbeTarget(topology({ presence: {} }))).toBe('unknown')
    expect(filesProbeTarget(undefined)).toBe('unknown')
    expect(FILES_PROBE_TARGETS).toHaveLength(3)
  })

  it('never raises a target finding, and never withholds the probe result, on any shape', () => {
    for (const mode of ['home-server', 'self-hosted', 'unset', 'other'] as const) {
      for (const probeUrlSet of [true, false]) {
        const model = buildBackendSection({
          topology: topology({ mode, presence: { FILES_SERVER_PROBE_URL: probeUrlSet } }),
          serverStatus: serverStatus(),
        })
        const row = rowOf(model, 'Files service probe')

        // The result stands — no shape makes this pane unable to report the probe.
        expect(row.value).toBe('answering')
        expect(codesOf(model)).not.toContain('FILES_PROBE_TARGET_WRONG')
        // ...and the claim is STILL capped, because the address being right says
        // nothing about the credential. That is the part that must survive.
        expect(row.claimed).toBe('healthy')
        expect(row.verdict).toBe('undetermined')
        expect(codesOf(model)).toContain('FILE_TRANSFER_UNVERIFIED')
        expect(model.worstVerdict).not.toBe('degraded')
      }
    }
  })

  it('names the one arrangement the fallback would miss, without claiming it', () => {
    const row = rowOf(
      buildBackendSection({
        topology: topology({ mode: 'self-hosted', presence: { FILES_SERVER_PROBE_URL: false } }),
        serverStatus: serverStatus(),
      }),
      'Files service probe',
    )

    expect(row.note).toContain('on every topology this repo ships that IS the files process')
    expect(row.note).toContain('cannot be told apart from here')
    expect(row.note).not.toContain('IS NOT SET AND THIS IS NOT A SINGLE CONTAINER')
  })

  /* ------------------------------------------------------------------------ */
  /* An unverifiable probe depth on an unidentifiable build                    */
  /* ------------------------------------------------------------------------ */

  /**
   * Two unknowns that only matter together. A readiness route that 404s is re-probed
   * for liveness and reported as `ok`, with the distinction in a `detail` string this
   * module refuses to read — and for `files` that cannot happen on a CURRENT image,
   * whose readiness route has no middleware and answers only 200 or 503. Whether the
   * image IS current is unanswerable on a build that recorded no revision, which is
   * this user's. Neither row can say that alone.
   */
  it('ties an unverifiable probe depth to an unstamped build, and only when both hold', () => {
    const unstamped = buildBackendSection({
      topology: topology(),
      serverStatus: serverStatus(),
      buildIdentified: false,
    })
    const finding = findingOf(unstamped, 'PROBE_DEPTH_UNVERIFIABLE')

    expect(finding?.verdict).toBe('undetermined')
    expect(finding?.detail).toContain('recorded no revision')
    expect(finding?.detail).toContain('readiness route has no middleware')
    expect(unstamped.worstVerdict).not.toBe('degraded')

    // *** THE TWO CONTROLS. *** A stamped build resolves it, and a payload with no
    // services at all has no probe depth to be unsure about.
    expect(
      codesOf(buildBackendSection({ topology: topology(), serverStatus: serverStatus(), buildIdentified: true })),
    ).not.toContain('PROBE_DEPTH_UNVERIFIABLE')
    expect(codesOf(buildBackendSection({ topology: topology(), serverStatus: serverStatus() }))).not.toContain(
      'PROBE_DEPTH_UNVERIFIABLE',
    )
    expect(codesOf(buildBackendSection({ buildIdentified: false }))).not.toContain('PROBE_DEPTH_UNVERIFIABLE')
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

    // A server older than the whole block: the ordinary absence, and no longer
    // the structural wording, because the field has a producer now.
    expect(rowOf(unreported, 'Queue separation').value).toBe('not reported')
    expect(rowOf(unreported, 'Queue separation').value).not.toBe(String(NOT_PUBLISHED))
    expect(rowOf(unreported, 'Queue separation').evidence.kind).toBe('absent')
    expect(rowOf(unreported, 'Queue separation').note).toContain('a server older than this block')
    expect(codesOf(unreported)).not.toContain('EVENT_QUEUE_SHARED')
  })

  /**
   * *** THE SERVER LOOKING AND WITHHOLDING IS NOT THE SERVER NOT LOOKING. ***
   *
   * `queues.separation` is OMITTED when the gateway could not classify the
   * deployment — a bare queue with no second co-resident consumer, or no census
   * at all, where a second consumer may still live in another container. That
   * omission is the only form this fact has for saying "I cannot tell", so the
   * row has to tell it apart from a server too old to send the block, and from a
   * verdict this build cannot name. Three absences, three sentences.
   */
  it('separates a withheld verdict from a server that never sent one', () => {
    const olderServer = buildBackendSection({ topology: topology({ presence: { SQS_QUEUE_URL: true } }) })
    const withheld = buildBackendSection({
      topology: topology({ presence: { SQS_QUEUE_URL: true } }),
      queues: { consumerCount: 1 },
    })

    expect(rowOf(olderServer, 'Queue separation').value).toBe('not reported')
    expect(rowOf(olderServer, 'Queue separation').note).toContain('a server older than this block')

    expect(rowOf(withheld, 'Queue separation').value).toBe('not classifiable from here')
    expect(rowOf(withheld, 'Queue separation').value).not.toBe('not reported')
    expect(rowOf(withheld, 'Queue separation').note).toContain('THE SERVER LOOKED AND WITHHELD A VERDICT')
    // Neither is a verdict, and neither invents the reassuring answer.
    for (const model of [olderServer, withheld]) {
      expect(rowOf(model, 'Queue separation').verdict).toBe('undetermined')
      expect(rowOf(model, 'Queue separation').evidence.kind).toBe('absent')
      expect(codesOf(model)).not.toContain('EVENT_QUEUE_SHARED')
    }
  })

  /* ------------------------------------------------------------------------ */
  /* The census: supporting evidence, and three readings of a small number    */
  /* ------------------------------------------------------------------------ */

  /**
   * *** A COUNT OF `1` IS NOT "NO COLLISION", AND ABSENT IS NEITHER `0` NOR
   * `1`. ***
   *
   * The census counts CO-RESIDENT consumers — this gateway plus each supervisord
   * worker — so `1` means "the only consumer I can see", which is exactly what a
   * deployment whose workers run in another container reports. The verdict comes
   * from `separation`, which the server derives from this count AND the presence
   * pair once, so the two cannot drift. This row therefore carries no verdict at
   * any value, which is asserted across the whole range rather than at one point.
   */
  it('prints the consumer census as evidence and never as a verdict', () => {
    for (const consumerCount of [0, 1, 2, 5, 64]) {
      const model = buildBackendSection({
        topology: topology({ presence: { SQS_QUEUE_URL: true } }),
        queues: { consumerCount },
      })
      const row = rowOf(model, 'Co-resident queue consumers')

      expect(row.value).toBe(String(consumerCount))
      expect(row.verdict).toBe('informational')
      expect(row.tone).toBe('neutral')
      expect(row.evidence.kind).toBe('direct')
      // The count alone never raises the shared-queue finding, at any value.
      expect(codesOf(model)).not.toContain('EVENT_QUEUE_SHARED')
    }
  })

  it('reads an absent census as a census that was never taken, not as one or zero', () => {
    const row = rowOf(
      buildBackendSection({
        topology: topology({ presence: { SQS_QUEUE_URL: true } }),
        queues: { separation: 'own-prefixed-queue' },
      }),
      'Co-resident queue consumers',
    )

    expect(row.value).toBe('not reported')
    expect(row.value).not.toBe('0')
    expect(row.value).not.toBe('1')
    expect(row.evidence.kind).toBe('absent')
    expect(row.note).toContain('ABSENT DOES NOT MEAN ZERO OR ONE')
  })

  it('refuses a census that is not a bounded count', () => {
    for (const consumerCount of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const row = rowOf(
        buildBackendSection({ topology: topology(), queues: { consumerCount } }),
        'Co-resident queue consumers',
      )

      expect(row.value).toBe('not reported')
      expect(row.evidence.kind).toBe('absent')
    }
  })

  /**
   * The verdict and the census arrive together on a collided deployment, and the
   * verdict is what carries the finding. Asserting the pair is what proves the
   * row is rendering the SERVER's derivation rather than re-deriving it here from
   * the count — which is the thing that could drift.
   */
  it('renders the collided verdict the server derived, with the census beside it', () => {
    const model = buildBackendSection({
      topology: topology({ presence: { SQS_QUEUE_URL: true, API_GATEWAY_SQS_QUEUE_URL: false } }),
      queues: { separation: 'inherited-shared-queue', consumerCount: 5 },
    })

    expect(rowOf(model, 'Queue separation').value).toBe('inherited-shared-queue')
    expect(rowOf(model, 'Queue separation').verdict).toBe('broken')
    expect(rowOf(model, 'Co-resident queue consumers').value).toBe('5')
    expect(rowOf(model, 'Gateway event queue prefix').value).toBe('not-own-prefixed')
    expect(codesOf(model)).toContain('EVENT_QUEUE_SHARED')
  })

  it('carries no verdict for the two separations that are not a fault', () => {
    for (const separation of ['own-prefixed-queue', 'in-process-fan-out', 'none']) {
      const model = buildBackendSection({ topology: topology(), queues: { separation, consumerCount: 1 } })

      expect(rowOf(model, 'Queue separation').value).toBe(separation)
      expect(rowOf(model, 'Queue separation').verdict).toBe('informational')
      expect(codesOf(model)).not.toContain('EVENT_QUEUE_SHARED')
    }
    // `none` is deliberately NOT a degradation: the server reaches it from the
    // MODE alone, and a compose deployment running no workers fans events out
    // in-process perfectly well. A tone there would be a judgement about which
    // services are running, taken from a field that does not say.
    expect(rowOf(buildBackendSection({ queues: { separation: 'none' } }), 'Queue separation').note).toContain(
      'a field that does not say',
    )
  })

  /* ------------------------------------------------------------------------ */
  /* The half of the question presence can now answer — and only that half    */
  /* ------------------------------------------------------------------------ */

  /**
   * *** THE PREFIX IS DERIVABLE. `COLLIDED` IS NOT, AND MUST NOT BE CLAIMED. ***
   *
   * The presence map gained `API_GATEWAY_SQS_QUEUE_URL`, so a gateway that
   * configured its own queue can be told from one reading the bare name. What
   * those two booleans CANNOT show is a second consumer: a standalone gateway
   * with no workers produces exactly the same pair as a gateway splitting a queue
   * with four of them.
   *
   * So each state is asserted individually — an assertion over a set is satisfied
   * by any member of it — and every one of them is asserted NOT to produce the
   * shared-queue finding. A row that read "inherited-shared-queue" off this pair
   * would be the pane asserting an outage it cannot see, which is the same defect
   * as a green chip over a withheld operation, pointed the other way.
   */
  const prefixRow = (presence: Record<string, boolean>): DiagnosticRow =>
    rowOf(buildBackendSection({ topology: topology({ presence }) }), 'Gateway event queue prefix')

  it('derives own-prefixed from the prefixed key, with no verdict and no address', () => {
    const row = prefixRow({ API_GATEWAY_SQS_QUEUE_URL: true, SQS_QUEUE_URL: true })

    expect(row.value).toBe('own-prefixed')
    expect(row.verdict).toBe('informational')
    expect(row.evidence.kind).toBe('direct')
    expect(row.note).toContain('not proof of separation')
  })

  it('derives not-own-prefixed, and still refuses to call it a collision', () => {
    const model = buildBackendSection({
      topology: topology({ presence: { API_GATEWAY_SQS_QUEUE_URL: false, SQS_QUEUE_URL: true } }),
    })
    const row = rowOf(model, 'Gateway event queue prefix')

    expect(row.value).toBe('not-own-prefixed')
    // NO VERDICT. This is the configuration in which the measured defect is
    // possible, and it is also exactly what a correct single-consumer deployment
    // looks like. Claiming a degradation here would be guessing.
    expect(row.verdict).toBe('informational')
    expect(row.evidence.kind).toBe('direct')
    expect(row.note).toContain('CORRECT on a deployment with no other consumer')
    expect(codesOf(model)).not.toContain('EVENT_QUEUE_SHARED')
    expect(model.worstVerdict).not.toBe('broken')
    expect(model.worstVerdict).not.toBe('degraded')
    // And the separation row beside it claims nothing on its own: the verdict is
    // the SERVER's to derive from this pair plus its own consumer census, and
    // this fixture carries no queues block at all.
    expect(rowOf(model, 'Queue separation').value).toBe('not reported')
    expect(rowOf(model, 'Queue separation').verdict).toBe('undetermined')
  })

  it('derives no-queue-configured when neither name is set', () => {
    const row = prefixRow({ API_GATEWAY_SQS_QUEUE_URL: false, SQS_QUEUE_URL: false })

    expect(row.value).toBe('no-queue-configured')
    expect(row.note).toContain('fan out in-process')
  })

  /**
   * *** THE ONE COMBINATION THAT IS NOT DERIVABLE, AND IS NOT GUESSED. ***
   *
   * The prefixed name absent with the bare name NOT REPORTED is consistent both
   * with an inherited queue and with no queue at all, and those are opposite
   * answers. The row reports nothing rather than picking one.
   */
  it('reports nothing when the pair cannot be told apart, rather than choosing', () => {
    const halfReported = prefixRow({ API_GATEWAY_SQS_QUEUE_URL: false })
    const neitherReported = prefixRow({ SNS_TOPIC_ARN: true })
    const prefixSilent = prefixRow({ SQS_QUEUE_URL: true })

    for (const row of [halfReported, neitherReported, prefixSilent]) {
      expect(row.value).toBe('not reported')
      expect(row.evidence.kind).toBe('absent')
      expect(row.verdict).toBe('undetermined')
    }
    // The positive control: the SAME pair of keys, one boolean different, IS
    // derivable — so the four assertions above are not passing on a builder that
    // never derives anything.
    expect(prefixRow({ API_GATEWAY_SQS_QUEUE_URL: false, SQS_QUEUE_URL: false }).value).toBe('no-queue-configured')
  })

  it('does not treat recorded:false as a prefix reading either', () => {
    const row = rowOf(
      buildBackendSection({ topology: { recorded: false, presence: { API_GATEWAY_SQS_QUEUE_URL: true } } }),
      'Gateway event queue prefix',
    )

    expect(row.value).toBe('not reported')
    expect(row.evidence.kind).toBe('absent')
  })

  /**
   * A server that DOES report a separation state keeps the verdict, and the
   * derived row keeps reporting the configuration beside it. The two are not
   * alternatives: one is what was configured, the other is what is happening.
   */
  it('lets a reported separation state carry the verdict the prefix row cannot', () => {
    const model = buildBackendSection({
      topology: topology({ presence: { API_GATEWAY_SQS_QUEUE_URL: false, SQS_QUEUE_URL: true } }),
      queues: { separation: 'inherited-shared-queue' },
    })

    expect(rowOf(model, 'Gateway event queue prefix').value).toBe('not-own-prefixed')
    expect(rowOf(model, 'Queue separation').verdict).toBe('broken')
    expect(codesOf(model)).toContain('EVENT_QUEUE_SHARED')
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
    'PLANTED-WRITE-PROBE-STATE',
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

  const plantedUnreadableInput = (): BackendSectionInput => ({ statusError: PLANTED_ERROR })

  const plantedUnreadable = (): SectionModel => buildBackendSection(plantedUnreadableInput())

  /**
   * The INPUT, returned so the sweep can prove it is not passing on a fixture
   * that stopped carrying one of its plants.
   *
   * *** A PLANT THAT IS NOT IN THE INPUT PROVES NOTHING. *** Every string-typed
   * field this module reads off the wire is poisoned here, and the test below
   * asserts each marker is PRESENT in the serialised input before asserting it is
   * absent from the output. Two fields arrived with the runtime block — the write
   * probe and the queue census — and a hand-maintained list is exactly the thing
   * that silently fails to grow with them.
   */
  const plantedInput = (): BackendSectionInput => ({
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
        // Both halves of the queue pair, so the derived prefix row is exercised
        // by the scan rather than sitting at "not reported" inside it.
        API_GATEWAY_SQS_QUEUE_URL: true,
        SNS_TOPIC_ARN: true,
        'redis://user:PLANTED-PASSWORD@cache.internal:6379': true,
        [PLANTED_OPAQUE]: true,
      },
    }),
    datastore: {
      connectionState: 'PLANTED-CONNECTION-STATE',
      writeProbe: 'PLANTED-WRITE-PROBE-STATE',
      migrationsApplied: false,
      pendingMigrations: 2,
      poolInUse: 19,
      poolSize: 20,
      readRoundTripMs: 40,
      writeRoundTripMs: 90,
      deadOutboxRows: 7,
    },
    // Both queue fields: the string one poisoned, and the census at a value
    // that would be a collision if anything here derived one from the count.
    queues: { separation: 'PLANTED-SEPARATION-STATE', consumerCount: 5 },
  })

  const planted = (): SectionModel => buildBackendSection(plantedInput())

  /** Both planted models, so neither leak path can be left unscanned. */
  const plantedModels = (): readonly SectionModel[] => [planted(), plantedUnreadable()]

  /**
   * *** THE SWEEP'S OWN NON-VACUITY, FIELD BY FIELD. ***
   *
   * Asserted before the refusals: a marker no longer anywhere in the INPUT cannot
   * be kept out of the output by anything, and a fixture that quietly stopped
   * carrying one would leave its half of this scan reading green forever.
   */
  it('actually feeds every planted value into the section', () => {
    // BOTH inputs, because the plant list covers both leak paths: the error text
    // only ever reaches the unreadable model, and a scan over one input would
    // call that plant missing or — worse, if the assertion were loosened to make
    // it pass — stop noticing a plant that really had gone.
    const serialisedInput = `${JSON.stringify(plantedInput())}\n${JSON.stringify(plantedUnreadableInput())}`

    for (const secret of SECRETS) {
      expect(serialisedInput).toContain(secret)
    }
  })

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
    expect(rowOf(model, 'Database write probe').value).toBe(UNRECOGNISED)
    // Derived from two booleans in a poisoned presence map, so the scan covers
    // the new read rather than stepping over it.
    expect(rowOf(model, 'Gateway event queue prefix').value).toBe('own-prefixed')
    // The census is printed beside a refused verdict and raises nothing on its
    // own, which is the property the whole row exists to hold.
    expect(rowOf(model, 'Co-resident queue consumers').value).toBe('5')
    expect(codesOf(model)).not.toContain('EVENT_QUEUE_SHARED')
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
