import type { DeploymentTopology, Remedy, RemedyEffort } from './diagnosticRemedies'
import {
  buildSectionModel,
  diagnosticFinding,
  diagnosticRow,
  EVIDENCE_ABSENT,
  EVIDENCE_DIRECT,
  evidenceProxy,
  outcomesForSection,
  reportLine,
  safeConstant,
  safeCount,
  safeDuration,
  safeEnum,
  safePercentBucket,
  safePresence,
  safeState,
  safeTokens,
  safeYesNo,
  type DiagnosticBlock,
  type DiagnosticFinding,
  type DiagnosticRow,
  type Evidence,
  type SafeValue,
  type SectionModel,
  type SectionTaggedOutcome,
  type Verdict,
} from './diagnosticsSections'
import { errorKind } from './healthReport'

/**
 * Standard Red Notes: the Database & internal communications section of the admin
 * diagnostics pane.
 *
 * "Internally" means the SERVER's own database and the SERVER's own
 * service-to-service calls. The browser's IndexedDB, its outbox and its origin
 * quota are the Browser and Account sections' subject and are not restated here;
 * this section never reads anything about the machine the pane is running on.
 *
 * -------------------------------------------------------------------------------
 * 1. What this section READS, and why it probes nothing of its own.
 * -------------------------------------------------------------------------------
 *
 * It reads the `/v1/admin/server-status` payload the Server pane already fetches
 * — the auth readiness probe (its database `SELECT 1` and its Redis `PING`), the
 * gateway's own Redis ping, and one readiness probe per backend service with its
 * wall-clock timing. Every one of those probes has ALREADY been taken by the time
 * this payload exists. A diagnostics read must not become a second health-check
 * load: six readiness probes per section render, on a deployment the operator is
 * reading this pane precisely BECAUSE it is struggling, is a diagnostic that
 * makes its own subject worse.
 *
 * So this module is pure and synchronous over a payload someone else fetched, and
 * the one surface in this pane that takes a fresh measurement stays the Checks
 * sub-tab, where the operator presses the button.
 *
 * `healthReport.ts` already reads this payload for the Server pane's copyable
 * report. Its `errorKind` classifier is REUSED here rather than re-written, with
 * a compile-time assertion (`EveryReadFailureIsClassified`) that this module's
 * admission tuple still covers every code that function can return — so the two
 * readouts cannot come to disagree about why the endpoint did not answer. Nothing
 * else in that file is reused: its output is a string report, and a string is the
 * wrong boundary for a section that has to carry verdicts and evidence.
 *
 * -------------------------------------------------------------------------------
 * 2. The secrecy contract is tightest in this section, so it is held NARROWLY.
 * -------------------------------------------------------------------------------
 *
 * This is the section about databases, caches and service addresses: it is the
 * one most able to leak and the one with the least to gain by it. The rule here
 * is therefore stricter than the pane's general one.
 *
 *   - NO service `detail` field is read, ever. It is free-form server text and it
 *     is exactly where a probe failure puts the address it could not reach
 *     (`unexpected status 503`, `unreachable`). The state this section needs is
 *     derivable WITHOUT it: `status: 'unknown'` is produced by exactly one branch
 *     of the probe — the one that never had an address to dial — so
 *     "not configured" is a closed-enum read, not a string match. Nothing in this
 *     module inspects `detail`, which is a stronger guarantee than scrubbing it.
 *   - NO service NAME off the wire reaches a row. The rows iterate this build's
 *     own closed tuple of service names and look each one up in the payload; a
 *     service a newer gateway reports is COUNTED and never named. A name is the
 *     one field in this payload with an address-shaped future.
 *   - NO address, port, connection string, database name, path or credential has
 *     a field to travel in. Every value below is a boolean, a closed enum, a
 *     bounded count, a duration or a percentage bucket.
 *   - The one string this section accepts is the status-read ERROR, and it is
 *     reduced to one of five closed codes by `errorKind` before anything is
 *     built from it. The message itself — which interpolates whatever the fetch
 *     threw, and is therefore the most address-shaped input in the section — is
 *     never stored, never printed and never put in the report.
 *
 * What is WITHHELD rather than silently dropped is stated: `extraReportLines`
 * says that addresses were never collected, that per-service failure detail is
 * read by nothing here, that queue identity appears as a separation state only,
 * and that the dead-outbox count this section wants does not exist yet. A reader
 * of the report can tell "not collected" from "not disclosed" from "not
 * reported", which is the distinction the whole pane is built on.
 *
 * -------------------------------------------------------------------------------
 * 3. A probe is not the call path. This is the section's central honesty problem.
 * -------------------------------------------------------------------------------
 *
 * The readiness probe resolves its base address from the `SERVICE_PROBE_URLS`
 * map, falling back to the raw service-URL setting. That is NOT necessarily the
 * address this gateway makes application calls on: the map is overridable, and on
 * the single container it deliberately points at supervisord sibling ports.
 *
 * So a green probe does not establish that the application's own calls to that
 * service succeed, and a failed probe does not conclusively establish that they
 * fail. The split this module makes, and the reason every row here is phrased as
 * a probe outcome rather than as a service verdict:
 *
 *   - The ROW states what was MEASURED — "the auth readiness probe answered",
 *     "the syncing-server probe did not answer" — and carries `EVIDENCE_DIRECT`
 *     with a full verdict, because the probe outcome is exactly what the row
 *     describes.
 *   - The FINDING states the INFERENCE — "internal calls to this service are
 *     failing" — on `evidenceProxy(..., necessaryCondition: false)`, so its
 *     `broken` claim caps to `undetermined` and the caveat names the gap. The
 *     probe travels with the call path without being required by it.
 *
 * That is why a service outage shows a red row and an UNKNOWN finding beside it.
 * It would have been easy to mark the probe `necessary` and keep a conclusive
 * finding; it would also have been false, and a caveat that overstates is this
 * pane's own recorded defect one level down.
 *
 * `necessary` IS claimed in exactly two places, and both are real necessary
 * conditions rather than convenient ones: the auth database answering (sign-in
 * cannot work without it, so its failure is conclusive) and the shared cache
 * answering ON A TOPOLOGY THAT NEEDS IT (the realtime lane's ticket, lease and
 * socket-budget state has nowhere else to live). The second derives its relation
 * from the reported topology, so on a deployment that reported no topology the
 * same finding is `correlated` and caps — the panel does not borrow a necessity
 * it has no evidence for.
 *
 * -------------------------------------------------------------------------------
 * 4. "A handle exists" is not "connected" — the row this repo earned the hard way.
 * -------------------------------------------------------------------------------
 *
 * `AppDataSource.dataSource` was once an UNCACHED getter: it built and returned a
 * brand-new, never-initialized `DataSource` on every read. `initialize()`
 * connected one instance, and every consumer wired after it — the sync-command
 * executor and the invite transaction runner among them — read the getter again
 * and received a fresh, unconnected handle instead. Every durable sync command
 * failed, on every topology, while the process looked up and the container
 * reported ready. The syncing server and auth now cache; the revisions and
 * websockets packages still carry the uncached shape, latent only because nothing
 * reads their getter twice.
 *
 * A readiness probe cannot see this. It reports that the SERVICE answers, and the
 * service answers perfectly. So "connected" and "a handle exists" is a row this
 * section wants and no endpoint reports — declared below as `DatastoreView`,
 * rendered "not reported" on absent evidence, with the field named in the
 * request list at the bottom of this header rather than invented here.
 *
 * -------------------------------------------------------------------------------
 * 5. What this section does NOT say, because another section owns it.
 * -------------------------------------------------------------------------------
 *
 * Environment & setup owns the CONFIGURATION of internal transport:
 * `SERVICE_PROXY_TYPE`, `boundServiceProxy`, the lane decision, the internal gRPC
 * secret's threshold state, and the per-call `transportFallback` counters. None
 * of it is restated here. This section's angle is the OUTCOME: are internal calls
 * being answered, with what latency, and in what failure class.
 *
 * The WebSocket section owns the realtime push bridge, the queue consumer loop
 * and the dispatched-push counter. This section's queue block is about which
 * queue the halves are POINTED AT, not about whether the loop is turning.
 *
 * -------------------------------------------------------------------------------
 * 6. Server fields this section wants and cannot read. (Not invented as rows.)
 * -------------------------------------------------------------------------------
 *
 * Every one of these would be a boolean, a closed enum, a bounded count or a
 * duration, and none of them needs a single address to express:
 *
 *   a. `datastore.connectionState` — `connected` / `handle-only` / `disconnected`
 *      per durable service. Section 4 above. The single highest-value field in
 *      this list: it is the only one that can see a defect this repo has
 *      actually shipped, on every topology at once.
 *   b. `datastore.migrationsApplied` + `pendingMigrations` — a boolean and a
 *      count. A schema one migration behind is a 500 on one route and nothing
 *      anywhere else.
 *   c. `datastore.poolInUse` + `poolSize` — two counts. Pool exhaustion presents
 *      as latency, which is the symptom this pane is worst at attributing.
 *   d. `datastore.readRoundTripMs` + `writeRoundTripMs` — two durations, measured
 *      by the service that owns the handle. A read-only replica, a full disk and
 *      a lock wait all pass a `SELECT 1` and fail a write.
 *   e. `datastore.deadOutboxRows` — one count. There is no requeue path for these
 *      rows, so the count is the whole diagnosis. NO ROW IS RENDERED for it
 *      until a server reports it: a row reading "not reported" for a number that
 *      has no producer invites the reading that the number is zero.
 *   f. `queues.separation` — `own-prefixed-queue` / `inherited-shared-queue` /
 *      `in-process-fan-out` / `none`. Section below.
 *   g. `services[].probedVia` — `probe-map` / `service-url` / `not-configured`.
 *      Closed enum. It would turn the central caveat of section 3 from a
 *      permanent hedge into a measured fact: a probe that resolved from the
 *      service URL IS the application's address, and its outcome could then
 *      carry direct evidence about the call path.
 *   h. `services[].readinessDepth` — `readiness` / `liveness-only`. The probe
 *      already knows: a service whose readiness route 404s is re-probed for
 *      liveness and reports `ok` with the fact buried in `detail`, which this
 *      module refuses to read. So an older image reports fully healthy here
 *      while only its process liveness was ever verified.
 *
 * None of these is edited into a server file by this section's author. The client
 * half reads them all as optional, so a server that grows them later needs no
 * client change, and this build degrades to "not reported" in the meantime.
 */

/* -------------------------------------------------------------------------- */
/* Why the status read failed, reusing the health report's one classifier     */
/* -------------------------------------------------------------------------- */

/**
 * The closed codes a failed status read is reduced to.
 *
 * `errorKind` in `healthReport.ts` already maps a load-error message onto
 * exactly these, and it is reused rather than re-implemented: the Server pane's
 * report and this section must not come to disagree about why the endpoint did
 * not answer. That file's own tuple is private, so coverage is asserted against
 * the function's RETURN TYPE below — a code added over there fails this module to
 * compile instead of arriving as "other (unrecognised)" on a row whose whole job
 * is to name the cause.
 */
export const BACKEND_READ_FAILURES = ['unauthorized', 'forbidden', 'not-found', 'unreachable', 'other'] as const

export type BackendReadFailure = (typeof BACKEND_READ_FAILURES)[number]

type UnclassifiedReadFailure = Exclude<ReturnType<typeof errorKind>, BackendReadFailure>
type AssertNever<T extends never> = T
export type EveryReadFailureIsClassified = AssertNever<UnclassifiedReadFailure>

/* -------------------------------------------------------------------------- */
/* Closed vocabularies                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The services this build knows how to label.
 *
 * The rows iterate THIS tuple and look each name up in the payload, rather than
 * iterating the payload's own array. A name off the wire therefore never becomes
 * a row label, and a service a newer gateway reports is counted instead of
 * named — the same rule `healthReport.ts` applies to containers and providers.
 */
export const KNOWN_SERVICES = [
  'api-gateway',
  'auth',
  'syncing-server',
  'files',
  'revisions',
  'websocket-gateway',
] as const

export type KnownService = (typeof KNOWN_SERVICES)[number]

/** The statuses the gateway's probe can report. Closed, server-side. */
const SERVICE_STATUSES = ['ok', 'degraded', 'down', 'unknown'] as const

type ServiceStatus = (typeof SERVICE_STATUSES)[number]

/**
 * What a probe OUTCOME is, once `status` and `reachable` are read together.
 *
 * Five members because the pair carries five situations and the status alone
 * carries four of them badly. `down` with `reachable: true` is a service that
 * ANSWERED and declared itself not ready; `down` with `reachable: false` is a
 * connection that never completed. Same status code, different container to look
 * at, so they are kept apart.
 *
 * `not-configured` is derived from `status: 'unknown'`, which exactly one branch
 * of the gateway's probe produces — the one with no address to dial. It is read
 * from the closed status rather than from the free-form `detail` string that
 * branch also sets, so no server text is inspected to reach it.
 */
export const SERVICE_OUTCOMES = ['answering', 'degraded', 'refusing', 'unreachable', 'not-configured'] as const

export type ServiceOutcome = (typeof SERVICE_OUTCOMES)[number]

/** How the gateway's own Redis client answered, or that there is not one. */
export const CACHE_OUTCOMES = ['answering', 'not-answering', 'none-configured'] as const

export type CacheOutcome = (typeof CACHE_OUTCOMES)[number]

/**
 * Whether THIS topology needs shared cache state at all.
 *
 * Derived from the reported deployment shape, and deliberately three-valued: on
 * the single container the realtime lane's ticket, lease and socket-budget state
 * lives in the one process that holds the sockets, so no Redis is needed and
 * "none configured" is correct rather than alarming. On the bundled compose stack
 * it is required. With no reported topology the requirement is undetermined, and
 * the finding that depends on it loses its claim to necessity accordingly.
 */
export const CACHE_REQUIREMENTS = ['required', 'not-required'] as const

export type CacheRequirement = (typeof CACHE_REQUIREMENTS)[number]

/** How domain events and realtime pushes leave the process. */
export const FAN_OUT_MODES = ['queue-backed', 'in-process'] as const

/**
 * The queue-identity states a server could report, and the reason the field is
 * wanted.
 *
 * `inherited-shared-queue` is a measured defect of this repo, not a hypothetical:
 * the compose stack's workers inherited the gateway's `SQS_QUEUE_URL`, both
 * halves consumed from one queue, and roughly four in five realtime pushes —
 * plus revision and e-mail events — were delivered to whichever consumer won the
 * race and then deleted. Nothing logged an error; the fix was to give the
 * in-process gateway its own `API_GATEWAY_SQS_*` prefix.
 *
 * Presence cannot express it. `SQS_QUEUE_URL` being set says a queue exists, and
 * says nothing about whether two consumers are pointed at the same one, which is
 * the entire question. A separation STATE can express it with no URL at all, and
 * is requested as item (f) of the header's list.
 */
export const QUEUE_SEPARATIONS = ['own-prefixed-queue', 'inherited-shared-queue', 'in-process-fan-out', 'none'] as const

/** The states a durable service's `DataSource` handle can be in. See header §4. */
export const DATABASE_CONNECTION_STATES = ['connected', 'handle-only', 'disconnected'] as const

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Facts about the durable store that no endpoint this pane can read reports yet.
 *
 * Declared here, produced nowhere, exactly as the contract's
 * `LaneDegradationLedgerView` and the payload's `TransportFallbackView` were
 * declared before their producers existed. Every field is optional and typed
 * wide where it is the SERVER's enum, so a newer server's member degrades to
 * "other (unrecognised)" through `safeEnum` instead of being rendered as one of
 * the members this build does know.
 *
 * There is nothing in this shape that could carry a connection string, a
 * database name or a credential — which matters, because the whole reason it
 * exists is to make a DATABASE failure observable.
 */
export type DatastoreView = {
  /** `connected` / `handle-only` / `disconnected`. The defect in header §4. */
  connectionState?: string
  /** Whether every migration this build ships has been applied. */
  migrationsApplied?: boolean
  /** How many migrations the live schema is behind. `0` means up to date. */
  pendingMigrations?: number
  /** Connections checked out of the pool right now. */
  poolInUse?: number
  /** The pool's configured maximum. */
  poolSize?: number
  /** A real read round trip, measured by the service that owns the handle. */
  readRoundTripMs?: number
  /** A real write round trip. A read-only replica passes a read and fails this. */
  writeRoundTripMs?: number
  /**
   * Outbox rows that exhausted their attempts. There is no requeue path for
   * them, so the count is the whole diagnosis — and NO ROW is rendered for it
   * until a server reports it. See header item (e).
   */
  deadOutboxRows?: number
}

/** Which queue the halves of this deployment are pointed at. See header item (f). */
export type QueueView = {
  /** One of `QUEUE_SEPARATIONS`, typed wide because it is the server's enum. */
  separation?: string
}

export type BackendSectionInput = {
  /**
   * Raw `adminGetServerStatus()` payload. UNTRUSTED and typed `unknown` on
   * purpose: it is read by allowlist, field by field, exactly as
   * `healthReport.ts` reads it. A typed view here would be a claim about a
   * server this build cannot be recompiled against.
   */
  serverStatus?: unknown
  /**
   * Why the status read failed, if it did. Reduced to a closed code by
   * `errorKind` immediately; the message itself is never stored or printed.
   */
  statusError?: string | null
  /**
   * `payload.deployment`. Read ONLY for the cache requirement and the fan-out
   * mode — this section makes no configuration claim, and does not restate a
   * single row Environment & setup owns.
   */
  topology?: DeploymentTopology
  /** Not reported by any endpoint today. See header §4 and item (a). */
  datastore?: DatastoreView
  /** Not reported by any endpoint today. See header item (f). */
  queues?: QueueView
  outcomes?: readonly SectionTaggedOutcome[]
}

/* -------------------------------------------------------------------------- */
/* Reading the payload by allowlist                                           */
/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A boolean, or `undefined` for anything else — including a literal `null`. */
const booleanOrAbsent = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

/**
 * A finite, non-negative number, or `undefined`.
 *
 * `undefined` rather than `0` for a malformed figure, because a zero here would
 * be a MEASUREMENT: zero milliseconds is a plausible latency and zero pending
 * migrations is a healthy schema. A number that arrives malformed is a fact about
 * the server, not a value to round down into a reassuring one.
 */
function numberOrAbsent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

type ProbeReading = {
  /** Present only when the payload carried an entry for this service at all. */
  outcome?: ServiceOutcome
  responseTimeMs?: number
}

/**
 * One service's probe outcome, from the closed `status` and `reachable` fields
 * ONLY.
 *
 * The status is admitted against this build's own closed tuple FIRST, so a
 * status a newer gateway reports can never fall through into one of the branches
 * below: it produces no outcome at all, which reads "not reported".
 *
 * `detail` is not read here and is not read anywhere in this module. The one
 * state that would otherwise need it — "never configured" — is reachable from
 * `status: 'unknown'`, which exactly one branch of the probe produces.
 */
function readOutcome(rawStatus: unknown, reachable: boolean | undefined): ServiceOutcome | undefined {
  const status: ServiceStatus | undefined = SERVICE_STATUSES.find((candidate) => candidate === rawStatus)
  if (status === undefined) {
    return undefined
  }
  if (status === 'unknown') {
    return 'not-configured'
  }
  if (reachable === false) {
    return 'unreachable'
  }
  if (status === 'ok') {
    return 'answering'
  }
  if (status === 'degraded') {
    return 'degraded'
  }

  return 'refusing'
}

type ServicesReading = {
  byName: Readonly<Partial<Record<KnownService, ProbeReading>>>
  /** How many entries the payload carried, whether or not this build knows them. */
  reported: number | undefined
  /** Entries whose name this build does not recognise. Counted, never named. */
  unrecognised: number | undefined
}

const NO_SERVICES: ServicesReading = { byName: {}, reported: undefined, unrecognised: undefined }

/**
 * Index the payload's services array by this build's own closed names.
 *
 * Iterating the tuple rather than the array is what keeps a wire-supplied name
 * out of every row; the array is walked only to COUNT what it holds.
 */
function readServices(status: Record<string, unknown> | undefined): ServicesReading {
  const entries = Array.isArray(status?.services) ? status.services : undefined
  if (entries === undefined) {
    return NO_SERVICES
  }

  const byName: Partial<Record<KnownService, ProbeReading>> = {}
  let recognised = 0

  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue
    }
    const name = KNOWN_SERVICES.find((candidate) => candidate === entry.name)
    if (name === undefined) {
      continue
    }
    // Counted as recognised BEFORE the duplicate check, deliberately: a second
    // entry for a service this build knows is a duplicate, not an unrecognised
    // service, and counting it in the "names withheld" row would send an
    // operator looking for a service that was never reported.
    recognised += 1
    if (byName[name] !== undefined) {
      continue
    }
    const outcome = readOutcome(entry.status, booleanOrAbsent(entry.reachable))
    const responseTimeMs = numberOrAbsent(entry.responseTimeMs)
    byName[name] = {
      ...(outcome === undefined ? {} : { outcome }),
      ...(responseTimeMs === undefined ? {} : { responseTimeMs }),
    }
  }

  return { byName, reported: entries.length, unrecognised: Math.max(0, entries.length - recognised) }
}

/* -------------------------------------------------------------------------- */
/* Row helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Absent is not false, held structurally rather than remembered.
 *
 * Every directly-observed row in this file routes through here, so a row cannot
 * claim direct evidence for a field the server never sent. The specific failure
 * it prevents in THIS section is the one `healthReport.ts` names in its own
 * header: a status endpoint that answered 401 once produced a report that read
 * as the server having refused every capability. A payload that did not arrive
 * is silence, and silence is not a negative answer.
 */
function absentOr(observed: unknown, verdict: Verdict): { verdict: Verdict; evidence: Evidence } {
  return observed === undefined || observed === null
    ? { verdict: 'undetermined', evidence: EVIDENCE_ABSENT }
    : { verdict, evidence: EVIDENCE_DIRECT }
}

function observedRow(input: {
  label: SafeValue
  observed: unknown
  value: SafeValue
  verdict: Verdict
  note: string
}): DiagnosticRow {
  return diagnosticRow({
    label: input.label,
    value: input.value,
    ...absentOr(input.observed, input.verdict),
    note: input.note,
  })
}

/**
 * The inference a probe outcome licenses about the CALL PATH, as the proxy it is.
 *
 * `necessaryCondition: false` is not modesty for its own sake. The probe resolves
 * its base address from the overridable `SERVICE_PROBE_URLS` map and only falls
 * back to the service-URL setting the application itself uses, so the two
 * addresses can differ — which means a failing probe does not conclusively
 * establish that application calls fail, and a passing one establishes even less.
 * The relation is `correlated`, both arms cap to `undetermined`, and the caveat
 * says so. Item (g) of the header's request list is the field that would make
 * this direct.
 */
const CALL_PATH_PROXY: Evidence = evidenceProxy({
  observed: 'that the readiness probe this gateway took for that service did not answer',
  cannotConfirm: 'that the address this gateway makes its application calls on is failing too',
  necessaryCondition: false,
})

/* -------------------------------------------------------------------------- */
/* Remedies owned by this module                                              */
/* -------------------------------------------------------------------------- */

/**
 * `peer-service` is the honest effort for most of this section, and it is the
 * member that made these findings reportable at all.
 *
 * A dead database container, an unreachable cache and a service whose readiness
 * route is refusing are all fixed on a DIFFERENT service in this deployment.
 * Before this member existed they had to borrow `wait`, whose chip reads
 * "Transient" — which understates a database that is not coming back on its own
 * to the point of advising the operator to do nothing at all.
 */
const REPAIR_ANOTHER_SERVICE: RemedyEffort = 'peer-service'

const CONFIG_AND_RESTART: RemedyEffort = 'restart'

function remedyForAuthDatabaseDown(): Remedy {
  return {
    code: 'AUTH_DATABASE_NOT_ANSWERING',
    summary:
      "The auth service's own readiness check reports its database not answering. Sign-in, session validation and every socket command that revalidates a session fail while this holds. The fix is on the database service, not in any setting on this screen.",
    steps: [
      'Check the database service is running and accepting connections. On the bundled compose stack that is the db service; on the single container it is the bundled database under supervisord.',
      'Check the database has disk. A full volume answers connections and fails writes, which presents as this check passing intermittently rather than failing outright.',
      'Do not change the auth database settings first. This check is a round trip over the connection the auth service ALREADY built at boot, so it failing means the far end stopped answering — a changed setting would not be read until a restart anyway.',
      'Re-read this pane once the database answers. Nothing here needs restarting for the check to recover.',
    ],
    effort: REPAIR_ANOTHER_SERVICE,
    basis: 'verified',
    because: [
      "The auth service's readiness endpoint ran its database check and reported it failing. That is a real round trip, taken by the service that owns the connection.",
      'A failing database check is a necessary condition of sign-in failing, which is why the finding above keeps its verdict rather than capping it.',
      'No address, port or database name is read or reported by this pane, so this remedy cannot tell you WHICH database — only that the one the auth service holds is not answering.',
    ],
  }
}

function remedyForSharedCacheUnreachable(requirement: CacheRequirement | undefined): Remedy {
  return {
    code: 'SHARED_CACHE_NOT_ANSWERING',
    summary:
      'This gateway has a Redis client and the ping did not answer. The cache service is the thing to repair; no variable on this deployment changes the outcome while it is down.',
    steps: [
      'Check the cache service is running and reachable from the gateway. A client that was bound at boot and now times out is a far-end failure, not a configuration one.',
      requirement === 'required'
        ? 'Treat this as load-bearing on this topology: the realtime lane keeps its tickets, command leases and per-user socket budget in shared state, so while the cache is down new sockets are refused and the lane cannot be re-established.'
        : 'Read the requirement row beside this one before acting. If this topology does not need shared state, a cache that was configured anyway is worth fixing or removing, but it is not what is breaking the lane.',
      'Do not switch CACHE_TYPE to memory to make this row go green. That silences the symptom and removes the shared state a multi-process deployment needs; the configuration rows for it live in the Environment & setup section.',
      'Re-read this pane once the cache answers. The ping is taken fresh on every status read.',
    ],
    effort: REPAIR_ANOTHER_SERVICE,
    basis: 'verified',
    because: [
      'The gateway reported that it holds a Redis client and that its ping did not succeed within the status endpoint timeout.',
      requirement === 'required'
        ? 'The reported deployment shape is the bundled compose stack, where shared cache state is required rather than optional.'
        : 'The deployment shape was not reported, so whether this cache is required here could not be established — the finding above caps its claim accordingly.',
    ],
  }
}

function remedyForSharedCacheAbsentWhereRequired(): Remedy {
  return {
    code: 'SHARED_CACHE_ABSENT',
    summary:
      'This deployment shape needs shared cache state and this gateway has no Redis client at all. Configure one and restart — no rebuild.',
    steps: [
      'Open the Environment & setup section and read the CACHE_TYPE and REDIS_URL rows. Those are the two settings that decide whether a client is bound, and that section is where their presence and relevance are reported; this one only reports that the client is missing.',
      'Set the cache type and the connection for the cache service, then restart the gateway. The binding is made once, when the container is configured — a value that arrives afterwards is not read.',
      'Do not expect the realtime lane to work in the meantime. Tickets, command leases and the per-user socket budget are the shared state this client holds, and one process cannot hold them for a fleet.',
    ],
    effort: CONFIG_AND_RESTART,
    basis: 'verified',
    because: [
      'The gateway reported no Redis client, and the reported deployment shape is the bundled compose stack rather than the single container.',
      'On the single container this would be correct and expected — the one process holding the sockets also holds that state — which is why this finding is raised only on a shape that needs it.',
    ],
  }
}

/**
 * ONE finding for every failing probe, not one each.
 *
 * The services are named from this build's OWN closed tuple — the same source
 * the row labels come from — so the prose cannot carry a name off the wire. The
 * rows above already say which service failed and in what way; this remedy's job
 * is to say that the action is on the other end, and that the probe outcome does
 * not license the conclusion an operator will jump to.
 */
function remedyForInternalServiceUnreachable(failed: readonly KnownService[], anyUnreachable: boolean): Remedy {
  return {
    code: 'INTERNAL_SERVICE_PROBE_FAILED',
    summary: `${failed.length === 1 ? 'A readiness probe this gateway takes is' : `${failed.length} readiness probes this gateway takes are`} failing: ${failed.join(', ')}. The services they probe are what has to be repaired; nothing on this screen is a setting that changes the outcome.`,
    steps: [
      anyUnreachable
        ? 'Check that each service listed is running. A probe that does not connect is either a stopped service or a network path that does not exist, and both are on the other end.'
        : 'Check the logs of each service listed. They answered the probe, so the processes are alive and something they depend on is not — most often their own database or cache.',
      'Read the latency row beside them. A probe that failed slowly was waiting for its deadline; one that failed instantly was refused outright, which is a different far end and a different fix.',
      'Do not treat a failed probe as proof that application calls are failing. The probe resolves its own base address, which can differ from the one this gateway makes real calls on — that is exactly why the finding above reports as undetermined instead of claiming an outage.',
      'Re-read this pane after repairing the service. Every probe is taken fresh on each status read; nothing is cached, and nothing here needs a restart.',
    ],
    effort: REPAIR_ANOTHER_SERVICE,
    basis: 'verified',
    because: [
      anyUnreachable
        ? 'At least one probe reported the service unreachable: the connection itself did not complete.'
        : 'Every failing probe reported the service reachable: it answered, and the answer was not a ready one.',
      'This pane never reports which address was probed. The services are named from this build own closed list, and no address, port or path is read from the payload at all.',
    ],
  }
}

/**
 * The one probe failure that is EXPECTED, and the remedy whose job is to stop an
 * operator acting on it.
 *
 * No websocket gateway process runs in the single-container image — the gateway
 * is composed in-process instead — so its probe target is unset and it reports
 * "not configured" forever. Sending the operator after `WEB_SOCKET_SERVER_URL`
 * here is the confidently-wrong advice this pane exists to end: setting it points
 * the probe at a service that does not exist, and the realtime lane it would
 * appear to fix is working.
 */
function remedyForWebsocketGatewayNotProbed(): Remedy {
  return {
    code: 'WEBSOCKET_GATEWAY_NOT_PROBED',
    summary:
      'No websocket gateway is probed on this deployment, and on the single container that is correct: the gateway is composed in-process, so there is no separate service to probe. Do not set WEB_SOCKET_SERVER_URL to make this row go green.',
    steps: [],
    effort: 'none',
    basis: 'verified',
    because: [
      'The probe reported this service as not configured, which is the one branch that never had an address to dial.',
      'Setting a probe address for a service that does not run would turn an accurate "not configured" into an inaccurate "unreachable", and change nothing about whether the realtime lane works.',
      'What the realtime lane is actually doing is the WebSocket section to report, and it does not depend on this row.',
    ],
  }
}

function remedyForProbeNearDeadline(): Remedy {
  return {
    code: 'INTERNAL_PROBE_NEAR_DEADLINE',
    summary:
      'An internal readiness probe took most of the time it is allowed. It has not failed, and at this latency it is one slow response away from being reported unreachable.',
    steps: [
      'Look at the service named in the row above rather than at this gateway. The probe is a single readiness request; a slow answer is the far end being slow.',
      'Check the database and cache that service depends on first. Pool exhaustion and lock waits present as latency, which is the symptom this pane is least able to attribute on its own.',
      'Expect the row beside this one to flip between "answering" and "unreachable" while this holds. That alternation is this latency, not two different faults.',
    ],
    effort: REPAIR_ANOTHER_SERVICE,
    basis: 'verified',
    because: [
      'The slowest reported probe used at least three quarters of the deadline this gateway gives it.',
      'The deadline is a constant of this build, mirrored from the gateway own probe timeouts, so the fraction is derived without reading any configuration.',
    ],
  }
}

function remedyForDatabaseHandleNotConnected(): Remedy {
  return {
    code: 'DATABASE_HANDLE_NOT_CONNECTED',
    summary:
      'A durable service reports holding a database handle that was never connected. This is a code defect, not a setting: the handle is rebuilt on every read, so the connected one is discarded and consumers wired after boot get a dead object.',
    steps: [
      'Upgrade to a build whose data-source getter caches the instance it connected. No environment variable reaches this — the defect is in the accessor, and configuration cannot change which object it returns.',
      'Expect the symptom to be total and silent while it holds: the process starts, readiness passes, and every durable command fails on a connection that was never opened.',
      'Check the services that still carry the uncached shape rather than only the one reporting it. The revisions and websockets packages have the same accessor, latent only while nothing reads the getter twice.',
    ],
    effort: 'rebuild',
    basis: 'verified',
    because: [
      'The service reported a handle in the "handle-only" state: an instance exists and it was never initialized.',
      'This repo has shipped exactly this defect once, in the syncing server, and it broke every durable sync command on every topology while the container reported ready.',
    ],
  }
}

function remedyForPendingMigrations(pending: number | undefined): Remedy {
  return {
    code: 'DATABASE_MIGRATIONS_PENDING',
    summary:
      pending === undefined
        ? 'The live schema is behind the build. Run the migrations and restart — no rebuild.'
        : `The live schema is ${pending === 1 ? 'one migration' : `${pending} migrations`} behind the build. Run them and restart — no rebuild.`,
    steps: [
      'Let the service run its own migrations on start, or run them explicitly, depending on how this deployment is configured to migrate.',
      'Do not read a partially migrated schema as a healthy one. It answers readiness, serves most routes, and fails exactly the routes that touch the new columns — which presents as one broken feature rather than as a database problem.',
      'Restart the service after migrating, then re-read this pane.',
    ],
    effort: CONFIG_AND_RESTART,
    basis: 'verified',
    because: [
      'The service reported that not every migration this build ships has been applied.',
      'A count is reported and no schema, table or column name is: the diagnostic fact is how far behind, and the names are a fact about your data.',
    ],
  }
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** What an operator can do about each
 * reason the status endpoint did not answer.
 *
 * Written as a `Record` rather than a chain because the two authorization codes
 * and the three failure codes point at three completely different places, and a
 * fall-through here would send an operator to restart a container over a missing
 * role. A code added to the classifier fails compilation instead.
 */
const READ_FAILURE_EFFORT: Record<BackendReadFailure, RemedyEffort> = {
  unauthorized: 'none',
  forbidden: 'none',
  'not-found': 'rebuild',
  unreachable: REPAIR_ANOTHER_SERVICE,
  other: 'wait',
}

const READ_FAILURE_SUMMARY: Record<BackendReadFailure, string> = {
  unauthorized:
    'The status endpoint answered 401. This session is not authenticated to it, so this whole section has no data — which is NOT a report that the services are down.',
  forbidden:
    'The status endpoint answered 403. It requires the admin role and this account does not hold it, so this whole section has no data — which is NOT a report that the services are down.',
  'not-found':
    'This gateway build has no admin status endpoint, so none of this section can be read. Upgrading the server image is the only thing that changes it.',
  unreachable:
    'The status endpoint could not be reached at all. The gateway that serves it is the thing to look at, and until it answers nothing in this section is known either way.',
  other:
    'The status read failed for a reason this build does not classify. Nothing in this section is known; re-read before changing anything.',
}

const READ_FAILURE_STEPS: Record<BackendReadFailure, string[]> = {
  unauthorized: [],
  forbidden: [],
  'not-found': [
    'Upgrade the server image. The endpoint is server-side, so no client setting reaches it.',
    'Read the Environment & setup section meanwhile. The deployment identity block there says which build is live, which is the first thing to check against this.',
  ],
  unreachable: [
    'Check the gateway is running and reachable from this browser. Every other section that needs a server read will be empty for the same reason.',
    'Do not read the empty rows below as negative answers. They report "not reported" precisely so this failure cannot be mistaken for an outage of the services themselves.',
  ],
  other: [
    'Re-read the pane. A single failed read is usually transient, and this section takes no measurement of its own to retry.',
    'If it persists, the gateway logs for the status endpoint are the next place to look. The error text itself is deliberately not shown here or put in the report: it is the field a failed fetch puts an address into.',
  ],
}

function remedyForUnreadableStatus(kind: BackendReadFailure): Remedy {
  return {
    code: 'BACKEND_STATUS_UNREADABLE',
    summary: READ_FAILURE_SUMMARY[kind],
    steps: READ_FAILURE_STEPS[kind],
    effort: READ_FAILURE_EFFORT[kind],
    basis: 'verified',
    because: [
      'The admin status endpoint did not return a payload, and the failure was reduced to one of five closed codes.',
      'The error message itself is never stored, printed or put in the copyable report. It interpolates whatever the fetch threw, which is the most address-shaped input this section receives.',
    ],
  }
}

/* -------------------------------------------------------------------------- */
/* Block 1: could this section be read at all                                 */
/* -------------------------------------------------------------------------- */

const LABEL_ENDPOINT = safeConstant('Admin status endpoint')

const LABEL_FAILURE = safeConstant('Why the read failed')

function buildReadBlock(
  status: Record<string, unknown> | undefined,
  statusError: string | null | undefined,
): DiagnosticBlock {
  // A failure that is still CURRENT. A caller holding the last error alongside
  // a payload that did arrive has a stale error, not a failed read, and a model
  // that said "answered" and raised an unreadable-status finding in the same
  // breath would be contradicting itself on one screen.
  const failure: BackendReadFailure | undefined =
    status === undefined && typeof statusError === 'string' && statusError.length > 0
      ? errorKind(statusError)
      : undefined

  // Three states, not two. A payload means it answered; an error with no payload
  // means it did not; NEITHER means nobody has tried yet, and that is absent
  // evidence rather than a failure — the state this pane previously rendered as
  // a confident claim that the server had refused.
  const answered = status !== undefined ? true : failure !== undefined ? false : undefined

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: LABEL_ENDPOINT,
      value: safeState(answered, 'answered', 'did not answer'),
      ...absentOr(answered, answered === true ? 'healthy' : 'broken'),
      note: 'Whether the payload every other row in this section reads actually arrived. It is the first row on purpose: a section full of "not reported" means one of two completely different things, and this is the row that says which. No read at all is reported as undetermined, never as a failure.',
    }),
    diagnosticRow({
      label: LABEL_FAILURE,
      value: safeEnum(failure, BACKEND_READ_FAILURES),
      ...absentOr(failure, failure === 'unauthorized' || failure === 'forbidden' ? 'informational' : 'degraded'),
      note: 'One of five closed codes, classified by the same function the Server pane copyable report uses, so the two cannot disagree about why a read failed. The error TEXT is never shown and never entered in the report: it interpolates whatever the fetch threw, which is where an address reaches a diagnostic. A 401 or a 403 is reported as informational rather than as a fault — the services are not implicated by a permission answer.',
    }),
  ]

  const findings: DiagnosticFinding[] = []

  if (failure !== undefined) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('BACKEND_STATUS_UNREADABLE'),
        title: 'The admin status endpoint could not be read',
        detail:
          'Every row below reads "not reported" as a consequence. That is the panel saying it does not know — not that the database, the cache or any service answered badly. Those are materially different claims, and conflating them is how one 401 once produced a report that appeared to say the server had refused every capability.',
        verdict: failure === 'unauthorized' || failure === 'forbidden' ? 'informational' : 'degraded',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForUnreadableStatus(failure),
      }),
    )
  }

  return {
    heading: safeConstant('Status endpoint read'),
    description:
      'Whether this section has any data at all, and why not when it does not. This section takes no measurement of its own: it reads the probes the admin status endpoint has already run, so that opening a diagnostics pane cannot add six readiness probes to a deployment that is struggling.',
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* Block 2: the durable store                                                 */
/* -------------------------------------------------------------------------- */

const OF = safeConstant('of')

const UNREPORTED = safePresence(undefined)

const MIGRATION_COUNT_UNREPORTED = safeConstant('(count not reported)')

const MIGRATIONS_PENDING = safeConstant('pending')

/** Milliseconds to seconds, preserving "absent" as absent rather than as zero. */
const seconds = (ms: number | undefined): number | undefined => (ms === undefined ? undefined : ms / 1000)

function buildDatabaseBlock(
  status: Record<string, unknown> | undefined,
  datastore: DatastoreView,
  services: ServicesReading,
): DiagnosticBlock {
  const health = isRecord(status?.health) ? status.health : undefined
  const auth = isRecord(health?.auth) ? health.auth : undefined
  const checks = isRecord(auth?.checks) ? auth.checks : undefined
  const authDb = checks !== undefined && 'db' in checks ? booleanOrAbsent(checks.db) : undefined

  const authProbeMs = services.byName.auth?.responseTimeMs
  const connectionState = DATABASE_CONNECTION_STATES.find((candidate) => candidate === datastore.connectionState)
  const applied = booleanOrAbsent(datastore.migrationsApplied)
  const pending = numberOrAbsent(datastore.pendingMigrations)
  const readMs = numberOrAbsent(datastore.readRoundTripMs)
  const writeMs = numberOrAbsent(datastore.writeRoundTripMs)

  const poolInUse = numberOrAbsent(datastore.poolInUse)
  const poolSize = numberOrAbsent(datastore.poolSize)
  // Both halves or neither: one count on its own has no reading. A reported
  // maximum of zero is kept OUT of the saturation figure rather than dividing
  // by it, while the counts themselves are still printed.
  const poolReported = poolInUse !== undefined && poolSize !== undefined
  const poolSaturation =
    poolReported && (poolSize as number) > 0 ? (poolInUse as number) / (poolSize as number) : undefined

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('Auth database round trip'),
      value: safeState(authDb, 'answering', 'not answering'),
      ...absentOr(authDb, authDb === true ? 'healthy' : 'broken'),
      note: 'The auth service own readiness check, which is a real query over the connection it holds. Direct evidence, and narrow: it establishes that the database answers, and nothing about migration state, pool headroom or write capability. It is also the only database signal any endpoint this pane can read — the syncing server, revisions and files databases have no equivalent here.',
    }),
    diagnosticRow({
      label: safeConstant('Auth readiness round trip'),
      value: safeDuration(seconds(authProbeMs)),
      ...absentOr(authProbeMs, 'informational'),
      note: 'How long the whole auth readiness probe took: an internal network hop plus the database query plus the cache ping. It is reported as context rather than as a database measurement, because a slow answer here does not say which of the three was slow. Durations are bucketed to whole seconds, so "under 1s" is the healthy reading and anything printed in seconds is already most of the probe budget.',
    }),
    diagnosticRow({
      label: safeConstant('Database connection state'),
      value: safeEnum(datastore.connectionState, DATABASE_CONNECTION_STATES),
      ...absentOr(connectionState, connectionState === 'connected' ? 'healthy' : 'broken'),
      note: 'Whether a durable service holds a CONNECTED data source or merely a handle. Not an academic row: this repo shipped a getter that rebuilt an unconnected data source on every read, so consumers wired after the connected one was built received a dead object and every durable command failed — on every topology, with the container reporting ready throughout. No endpoint reports this yet, so it reads "not reported"; the field is named in this module header rather than guessed at from the probes.',
    }),
    diagnosticRow({
      label: safeConstant('Schema migrations'),
      value:
        applied === undefined
          ? UNREPORTED
          : applied
            ? safeYesNo(true)
            : safeTokens(
                safeYesNo(false),
                pending === undefined ? MIGRATION_COUNT_UNREPORTED : safeCount(pending),
                MIGRATIONS_PENDING,
              ),
      ...absentOr(applied, applied === true ? 'healthy' : 'degraded'),
      note: 'Whether the live schema matches the build. A schema one migration behind answers readiness, serves most routes and fails exactly the ones that touch the new columns, which presents as a single broken feature rather than as a database problem. A count is reported and no schema, table or column name is.',
    }),
    diagnosticRow({
      label: safeConstant('Connection pool in use'),
      value: poolReported ? safeTokens(safeCount(poolInUse), OF, safeCount(poolSize)) : UNREPORTED,
      ...absentOr(
        poolReported ? true : undefined,
        poolSaturation !== undefined && poolSaturation >= 0.9 ? 'degraded' : 'informational',
      ),
      note: 'Connections checked out against the pool maximum. Exhaustion presents as latency rather than as an error — every query waits for a free connection and then succeeds — which is the symptom this pane is least able to attribute from a readiness probe alone. Two counts, never a connection string.',
    }),
    diagnosticRow({
      label: safeConstant('Database read round trip'),
      value: safeDuration(seconds(readMs)),
      ...absentOr(readMs, 'informational'),
      note: 'A read measured by the service that owns the connection, with no network hop or HTTP framing in it. Requested and not yet reported. It is the number the auth readiness duration above is a poor stand-in for.',
    }),
    diagnosticRow({
      label: safeConstant('Database write round trip'),
      value: safeDuration(seconds(writeMs)),
      ...absentOr(writeMs, 'informational'),
      note: 'Reported separately from the read on purpose: a read-only replica, a full volume and a long lock wait all pass a read and fail a write. A deployment in that state looks entirely healthy to every check this pane can currently take.',
    }),
  ]

  const findings: DiagnosticFinding[] = []

  if (authDb === false) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('AUTH_DATABASE_NOT_ANSWERING'),
        title: "The auth service's database is not answering",
        detail:
          'Sign-in, session validation and every socket command that revalidates its session fail while this holds, because all of them read the auth database. The database service itself is what has to be repaired; nothing on this screen is a setting that changes the outcome.',
        verdict: 'broken',
        // The ONE place in this section that claims necessity, and it is a real
        // one: the auth database answering is a necessary condition of sign-in
        // working, so its failure is conclusive. The probe is also taken BY the
        // service that owns the connection, so there is no probe-address gap
        // here of the kind that caps every service finding below.
        evidence: evidenceProxy({
          observed: "that the auth service's own readiness check reports its database not answering",
          cannotConfirm: 'which operations are already failing for users',
          necessaryCondition: true,
        }),
        remedy: remedyForAuthDatabaseDown(),
      }),
    )
  }

  if (connectionState === 'handle-only') {
    findings.push(
      diagnosticFinding({
        code: safeConstant('DATABASE_HANDLE_NOT_CONNECTED'),
        title: 'A durable service holds a data source that was never connected',
        detail:
          'The connected instance was replaced by a fresh, unconnected one, so consumers wired after boot received a dead object. Readiness passes and the process looks healthy; every durable command against that handle fails. This is a code defect and no configuration reaches it.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForDatabaseHandleNotConnected(),
      }),
    )
  }

  if (applied === false) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('DATABASE_MIGRATIONS_PENDING'),
        title: 'The live schema is behind the build',
        detail:
          'A partially migrated schema is the failure that looks like a feature bug: readiness passes, most routes work, and the routes touching the new columns answer 500. The count beside this says how far behind, which is the only part of a schema this pane will report.',
        verdict: 'degraded',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForPendingMigrations(pending),
      }),
    )
  }

  return {
    heading: safeConstant('Durable storage'),
    description:
      'The server\'s own database, as far as any endpoint this pane can read reports it — which today is one readiness query taken by the auth service. The remaining rows are the fields this section has asked for and does not have; they read "not reported" rather than being filled in from the probes, because a probe that says a service answers says nothing at all about the state of its connection, its schema or its pool. No connection string, host, port or database name is read or reported anywhere in this section. A count of dead outbox rows is deliberately NOT shown as an empty row: there is no producer for it, and an empty count invites the reading that it is zero.',
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* Block 3: shared cache                                                      */
/* -------------------------------------------------------------------------- */

const CACHE_OUTCOME_VALUE: Record<CacheOutcome, SafeValue> = {
  answering: safeConstant('answering'),
  'not-answering': safeConstant('not answering'),
  'none-configured': safeConstant('no client bound'),
}

/**
 * Four states from one tri-state field plus silence, kept apart.
 *
 * `health.gateway.redis` is `true` for a ping that answered, `false` for one that
 * did not, and a literal `null` for "this gateway has no Redis client to ping".
 * `undefined` is the fourth: the server said nothing. Collapsing `null` into
 * `false` would report a correctly cacheless single container as a cache outage,
 * and collapsing `undefined` into either would be the panel asserting it looked.
 */
function readCacheOutcome(value: unknown): CacheOutcome | undefined {
  if (value === true) {
    return 'answering'
  }
  if (value === false) {
    return 'not-answering'
  }
  if (value === null) {
    return 'none-configured'
  }

  return undefined
}

/**
 * Whether shared cache state is needed HERE, from the reported deployment shape.
 *
 * Only two shapes settle it. The single container holds its realtime shared
 * state in the one process that holds the sockets, so it needs none; the bundled
 * compose stack runs several processes and needs it. `unset` and `other` are a
 * process started outside the shipped entrypoints, and an unreported topology is
 * silence — both leave the requirement undetermined, which is what strips the
 * cache finding of its claim to necessity.
 */
export function describeCacheRequirement(topology: DeploymentTopology | undefined): CacheRequirement | undefined {
  if (topology?.recorded !== true) {
    return undefined
  }
  if (topology.mode === 'home-server') {
    return 'not-required'
  }
  if (topology.mode === 'self-hosted') {
    return 'required'
  }

  return undefined
}

function buildCacheBlock(
  status: Record<string, unknown> | undefined,
  topology: DeploymentTopology | undefined,
): DiagnosticBlock {
  const health = isRecord(status?.health) ? status.health : undefined
  const gateway = isRecord(health?.gateway) ? health.gateway : undefined
  const auth = isRecord(health?.auth) ? health.auth : undefined
  const checks = isRecord(auth?.checks) ? auth.checks : undefined

  const gatewayCache = gateway !== undefined && 'redis' in gateway ? readCacheOutcome(gateway.redis) : undefined
  const authCache = checks !== undefined && 'redis' in checks ? booleanOrAbsent(checks.redis) : undefined
  const requirement = describeCacheRequirement(topology)

  const rows: DiagnosticRow[] = [
    diagnosticRow({
      label: safeConstant('Gateway cache ping'),
      value: gatewayCache === undefined ? safePresence(undefined) : CACHE_OUTCOME_VALUE[gatewayCache],
      ...absentOr(
        gatewayCache,
        gatewayCache === 'answering' ? 'healthy' : gatewayCache === 'not-answering' ? 'broken' : 'informational',
      ),
      note: 'A real ping on the client this gateway holds, taken fresh on every status read. Four states and not two: "no client bound" is a reported fact and is CORRECT on the single container, where the realtime shared state lives in the one process holding the sockets — so it is informational, not a fault. A client that exists and does not answer is the broken one.',
    }),
    diagnosticRow({
      label: safeConstant('Auth cache ping'),
      value: safeState(authCache, 'answering', 'not answering'),
      ...absentOr(authCache, authCache === true ? 'healthy' : 'degraded'),
      note: 'A DIFFERENT client, in a different process, from the row above. The two fail independently and have different fixes, which is why they are two rows: the auth service uses its cache for session and rate-limit state, and the gateway uses its own for realtime tickets, leases and socket budgets.',
    }),
    diagnosticRow({
      label: safeConstant('Shared cache needed here'),
      value: safeEnum(requirement, CACHE_REQUIREMENTS),
      ...absentOr(requirement, 'informational'),
      note: 'Derived from the reported deployment shape, and the row that decides whether "no client bound" above is a problem or the intended configuration. It carries no verdict of its own. The SETTINGS behind it — CACHE_TYPE, the connection variables, and whether this topology reads them at all — are the Environment & setup section to report, and are not restated here.',
    }),
  ]

  const findings: DiagnosticFinding[] = []

  if (gatewayCache === 'not-answering') {
    findings.push(
      diagnosticFinding({
        code: safeConstant('SHARED_CACHE_NOT_ANSWERING'),
        title: 'The gateway holds a cache client that is not answering',
        detail:
          'A client bound at boot that now fails its ping is a far-end failure. On a topology that needs shared state this closes the realtime lane: tickets cannot be minted, command leases cannot be taken, and the per-user socket budget cannot be read.',
        verdict: 'broken',
        // The relation is DERIVED, not asserted. Shared cache state is a
        // necessary condition of the realtime lane only on a shape that has more
        // than one process to share it between; with no reported topology this
        // panel has no evidence for necessity and the claim caps to
        // undetermined instead of borrowing one.
        evidence: evidenceProxy({
          observed: 'that the cache client this gateway holds did not answer its ping',
          cannotConfirm: 'that the realtime lane is failing as a result',
          necessaryCondition: requirement === 'required',
        }),
        remedy: remedyForSharedCacheUnreachable(requirement),
      }),
    )
  }

  if (gatewayCache === 'none-configured' && requirement === 'required') {
    findings.push(
      diagnosticFinding({
        code: safeConstant('SHARED_CACHE_ABSENT'),
        title: 'This deployment shape needs shared cache state and has none',
        detail:
          'The reported shape is the bundled compose stack, where more than one process has to agree about tickets, command leases and socket budgets. One process cannot hold that state for a fleet, so the realtime lane cannot work here until a cache client is bound.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForSharedCacheAbsentWhereRequired(),
      }),
    )
  }

  return {
    heading: safeConstant('Shared cache'),
    description:
      'The two cache clients this deployment holds, reported as the independent facts they are. Both rows are a real round trip rather than a configuration reading — whether a connection variable is set, and whether this topology even reads it, belongs to Environment & setup and is not repeated here.',
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* Block 4: internal service communication                                    */
/* -------------------------------------------------------------------------- */

const SERVICE_LABEL: Record<KnownService, SafeValue> = {
  'api-gateway': safeConstant('This gateway, self-reported'),
  auth: safeConstant('Auth service probe'),
  'syncing-server': safeConstant('Syncing server probe'),
  files: safeConstant('Files service probe'),
  revisions: safeConstant('Revisions service probe'),
  'websocket-gateway': safeConstant('WebSocket gateway probe'),
}

const FILES_PROBE_NOT_THE_FILES_SERVICE = safeConstant('did not probe the files service')

const SERVICE_OUTCOME_VALUE: Record<ServiceOutcome, SafeValue> = {
  answering: safeConstant('answering'),
  degraded: safeConstant('answering, not ready'),
  refusing: safeConstant('answering, refusing'),
  unreachable: safeConstant('did not connect'),
  'not-configured': safeConstant('not configured'),
}

/**
 * *** EXHAUSTIVE `Record` ON PURPOSE. *** What each service's probe means when it
 * reads badly — and, for two of them, when it does not.
 */
const SERVICE_NOTE: Record<KnownService, string> = {
  'api-gateway':
    'Not a probe. The process that answered this request adds itself to the list as reachable, unconditionally, so this row is a constant and is reported as undetermined rather than green. It is kept because its absence would be meaningful: a payload with no self-entry is not a payload this build understands.',
  auth: 'The one probe with a dependency check behind it: the auth readiness route runs a database query and a cache ping before answering, so this row failing and the storage rows failing are the same event seen twice. Every authenticated request on this deployment passes through this service.',
  'syncing-server':
    'The durable backend for notes. This probe failing is the clearest internal-communication cause of note syncing falling back to HTTP — but it is not proof of it: the probe resolves its own base address, which can differ from the one this gateway makes real calls on.',
  files:
    'The files lane only. This probe failing leaves notes syncing normally while uploads and downloads fail, which is why it is its own row rather than part of a single backend verdict.',
  revisions:
    'Note history. A failure here is invisible until someone opens a revision list, so it is the probe most likely to be red for days without a complaint.',
  'websocket-gateway':
    'Expected to read "not configured" on the single container, where the gateway is composed in-process and there is no separate service to probe. Do not set a probe address to make this row go green: it would turn an accurate "not configured" into an inaccurate "unreachable" and change nothing about the realtime lane.',
}

/**
 * The deadline each probe is given, mirrored from the gateway's own timeouts.
 *
 * A constant of this build rather than a reported field, so the saturation row
 * below is derived without reading any configuration. `api-gateway` has no
 * deadline because it is not probed at all.
 */
const PROBE_DEADLINE_MS: Record<KnownService, number | undefined> = {
  'api-gateway': undefined,
  auth: 3000,
  'syncing-server': 2500,
  files: 2500,
  revisions: 2500,
  'websocket-gateway': 2500,
}

/** Outcomes that are a failure of communication rather than a configuration fact. */
const SERVICE_FAILED: Record<ServiceOutcome, boolean> = {
  answering: false,
  degraded: true,
  refusing: true,
  unreachable: true,
  'not-configured': false,
}

const SERVICE_VERDICT: Record<ServiceOutcome, Verdict> = {
  answering: 'healthy',
  degraded: 'degraded',
  refusing: 'broken',
  unreachable: 'broken',
  'not-configured': 'informational',
}

type SlowestProbe = {
  service: KnownService | undefined
  seconds: number | undefined
  fractionOfDeadline: number | undefined
}

const NO_SLOWEST: SlowestProbe = { service: undefined, seconds: undefined, fractionOfDeadline: undefined }

/**
 * The slowest probe, as a duration AND as a fraction of its own deadline.
 *
 * Both, because neither is enough on its own. A duration is what an operator
 * thinks in, and the duration constructor buckets to whole seconds so "under 1s"
 * covers the entire healthy range. The fraction is what makes the row
 * actionable: a probe at four fifths of its deadline has not failed and is one
 * slow response away from being reported unreachable, and that is invisible in
 * "2s".
 *
 * `api-gateway` is excluded because it is not probed, and a service with no
 * reported timing is skipped rather than counted as zero.
 */
function slowestProbe(services: ServicesReading): SlowestProbe {
  let found: SlowestProbe = NO_SLOWEST

  for (const service of KNOWN_SERVICES) {
    const deadline = PROBE_DEADLINE_MS[service]
    const ms = services.byName[service]?.responseTimeMs
    if (deadline === undefined || ms === undefined) {
      continue
    }
    if (found.seconds !== undefined && ms / 1000 <= found.seconds) {
      continue
    }
    found = { service, seconds: ms / 1000, fractionOfDeadline: ms / deadline }
  }

  return found
}

/**
 * What a service probe's POSITIVE answer establishes, which is much less than the
 * word "answering" suggests.
 *
 * Every one of these probes is an UNAUTHENTICATED `GET /healthcheck/readiness` —
 * falling back to plain `/healthcheck` liveness on a 404 — against a base address
 * the gateway resolves for itself. So a 200 establishes that something answered an
 * unauthenticated route at an address the gateway chose. It does not establish
 * that the service does the work the lane behind it needs, and it establishes
 * nothing whatever about an AUTHORIZED request: no probe presents a credential, so
 * no probe can see a credential the far end refuses.
 *
 * That gap is not hypothetical. It is the state this pane was measured in: every
 * files row green — probe "answering", FILES_V1 advertised, all three files
 * variables set — on a deployment where file listing aborted, downloads hung and
 * usage read zero. The verdict is capped so the row keeps its fact and loses the
 * claim, which is this contract's own mechanism applied to the row that needed it.
 */
const PROBE_CANNOT_CONFIRM =
  'that an AUTHORIZED request to this service succeeds — the probe is unauthenticated, so a credential the far end refuses is invisible to it'

function probeEvidence(service: KnownService, outcome: ServiceOutcome): Evidence {
  // A probe that failed, failed. Negative readings keep direct evidence: the
  // point of capping is that a green probe over-claims, not that a red one does.
  if (SERVICE_FAILED[outcome] || outcome === 'not-configured') {
    return EVIDENCE_DIRECT
  }

  return evidenceProxy({
    observed: `that ${service} answered an unauthenticated readiness route at the address this gateway probes it on`,
    cannotConfirm: PROBE_CANNOT_CONFIRM,
    necessaryCondition: true,
  })
}

/**
 * What the files probe was actually POINTED AT, from two closed inputs.
 *
 * `FILES_SERVER_PROBE_URL` unset does not disable the files probe — it falls back
 * to `http://localhost:<FILES_SERVER_PORT>`, which is loopback RELATIVE TO THE
 * API-GATEWAY PROCESS. On the single container that is right: the files service is
 * a supervisord sibling on that same loopback. On anything multi-container it is
 * not the files service at all, and whatever did answer there is not the service
 * that stores the files.
 *
 * Both facts are already on the wire as closed values — a presence boolean and the
 * deployment mode — so this needs no new endpoint and reads no address. A row that
 * cannot establish what it probed must not report that the files service answered.
 */
export const FILES_PROBE_TARGETS = ['configured', 'colocated-sibling', 'gateway-loopback', 'unknown'] as const

export type FilesProbeTarget = (typeof FILES_PROBE_TARGETS)[number]

export function filesProbeTarget(topology: DeploymentTopology | undefined): FilesProbeTarget {
  const configured = presenceOf(topology, 'FILES_SERVER_PROBE_URL')
  if (configured === undefined) {
    return 'unknown'
  }
  if (configured) {
    return 'configured'
  }

  const mode = topology?.mode
  if (mode === undefined) {
    return 'unknown'
  }

  return mode === 'home-server' ? 'colocated-sibling' : 'gateway-loopback'
}

const FILES_PROBE_TARGET_NOTE: Record<FilesProbeTarget, string> = {
  configured:
    ' FILES_SERVER_PROBE_URL is set, so the probe dialled the internal address this deployment configured for the files service.',
  'colocated-sibling':
    ' FILES_SERVER_PROBE_URL is not set, so the probe fell back to this container’s own loopback — which on the single container IS the files service, running as a sibling process under supervisord. The address is right here; the credential is still untested.',
  'gateway-loopback':
    ' *** FILES_SERVER_PROBE_URL IS NOT SET AND THIS IS NOT A SINGLE CONTAINER. *** The probe therefore fell back to loopback inside the API-GATEWAY container, where the files service does not run. Whatever answered is not the service that stores this account’s files, so this row establishes nothing about the files service and is reported as undetermined whatever it read. Set FILES_SERVER_PROBE_URL to the internal address the gateway reaches the files service on, and this row starts meaning something.',
  unknown:
    ' Which address the probe dialled could not be established: that needs the deployment’s presence block and its MODE, and one of them was not reported. No claim is made about what answered.',
}

function buildCommunicationBlock(services: ServicesReading, topology: DeploymentTopology | undefined): DiagnosticBlock {
  const rows: DiagnosticRow[] = []
  const filesTarget = filesProbeTarget(topology)
  // A probe pointed at the WRONG container's loopback cannot report on the files
  // service in either direction, so the value is withheld as well as the verdict.
  // Printing "answering" with a caveat underneath it would leave the word an
  // operator skims saying the opposite of the sentence that qualifies it — which is
  // how every files row on this screen came to read green over a dead lane.
  const filesProbeBlind = filesTarget === 'gateway-loopback'

  for (const service of KNOWN_SERVICES) {
    const outcome = services.byName[service]?.outcome

    if (service === 'api-gateway') {
      // A hardcoded `reachable: true` must never paint green. The row keeps the
      // fact and loses the claim: a positive reading on a constant is capped by
      // a correlated proxy, which is the whole mechanism of this contract
      // applied to its most obvious instance.
      rows.push(
        diagnosticRow({
          label: SERVICE_LABEL[service],
          value: outcome === undefined ? safePresence(undefined) : SERVICE_OUTCOME_VALUE[outcome],
          verdict: outcome === undefined ? 'undetermined' : 'healthy',
          evidence:
            outcome === undefined
              ? EVIDENCE_ABSENT
              : evidenceProxy({
                  observed: 'that the gateway which answered this request listed itself as reachable',
                  cannotConfirm: 'that this gateway is healthy in any respect it did not test',
                  necessaryCondition: false,
                }),
          note: SERVICE_NOTE[service],
        }),
      )
      continue
    }

    if (service === 'files') {
      rows.push(
        diagnosticRow({
          label: SERVICE_LABEL[service],
          value:
            outcome === undefined
              ? safePresence(undefined)
              : filesProbeBlind
                ? FILES_PROBE_NOT_THE_FILES_SERVICE
                : SERVICE_OUTCOME_VALUE[outcome],
          verdict: outcome === undefined || filesProbeBlind ? 'undetermined' : SERVICE_VERDICT[outcome],
          evidence:
            outcome === undefined
              ? EVIDENCE_ABSENT
              : filesProbeBlind
                ? evidenceProxy({
                    observed: 'that something answered a readiness route on the api-gateway container’s own loopback',
                    cannotConfirm: 'that the files service was probed at all, let alone that it answered',
                    necessaryCondition: false,
                  })
                : probeEvidence(service, outcome),
          note: `${SERVICE_NOTE[service]}${FILES_PROBE_TARGET_NOTE[filesTarget]}`,
        }),
      )
      continue
    }

    rows.push(
      diagnosticRow({
        label: SERVICE_LABEL[service],
        value: outcome === undefined ? safePresence(undefined) : SERVICE_OUTCOME_VALUE[outcome],
        verdict: outcome === undefined ? 'undetermined' : SERVICE_VERDICT[outcome],
        evidence: outcome === undefined ? EVIDENCE_ABSENT : probeEvidence(service, outcome),
        note: SERVICE_NOTE[service],
      }),
    )
  }

  const slowest = slowestProbe(services)
  const nearDeadline = slowest.fractionOfDeadline !== undefined && slowest.fractionOfDeadline >= 0.75

  rows.push(
    diagnosticRow({
      label: safeConstant('Slowest internal probe'),
      value:
        slowest.seconds === undefined
          ? safePresence(undefined)
          : safeTokens(
              safeDuration(slowest.seconds),
              safePercentBucket(slowest.fractionOfDeadline),
              safeConstant('of its deadline'),
            ),
      ...absentOr(slowest.seconds, nearDeadline ? 'degraded' : 'informational'),
      note: 'The slowest answer any probed service gave, with how much of its allowed time it used. The fraction is the actionable half: a probe at four fifths of its deadline has not failed, and is one slow response away from being reported as unreachable — which is what an operator sees as a service that "flaps". The deadline is a constant of this build, so no configuration is read to derive it.',
    }),
    diagnosticRow({
      label: safeConstant('Service nearest its deadline'),
      value: safeEnum(slowest.service, KNOWN_SERVICES),
      ...absentOr(slowest.service, 'informational'),
      note: "Which probe the duration beside this belongs to. Named from this build's own closed list of services; a name reported by a newer gateway is counted in the row below and never printed.",
    }),
    diagnosticRow({
      label: safeConstant('Services reported'),
      value: safeCount(services.reported),
      ...absentOr(services.reported, 'informational'),
      note: 'How many entries the payload carried. A count rather than a list, because the rows above are built from this build own closed names: a service a newer gateway reports is counted here and is never turned into a row label.',
    }),
    diagnosticRow({
      label: safeConstant('Unrecognised services reported'),
      value: safeCount(services.unrecognised),
      ...absentOr(services.unrecognised, 'informational'),
      note: 'Entries whose name this build has no row for. They are not dropped silently — an unknown-but-reported service is still evidence — and they are not named either, because a name off the wire is the one field in this payload with an address-shaped future.',
    }),
  )

  const findings: DiagnosticFinding[] = []

  /**
   * *** THE READING THIS WHOLE BLOCK GOT WRONG, STATED AS A FINDING. ***
   *
   * On the deployment that produced the report behind this change, file listing
   * aborted, downloads hung forever, previews failed and the account's usage read
   * zero — while this screen showed FILES_V1 advertised, no unmet files condition,
   * all three files variables set, and this probe "answering". Every row was
   * individually defensible and the screen as a whole was wrong, because NOTHING on
   * it tests an authorized file transfer: the probe carries no credential, the boot
   * gate reports a composition decision, and a presence boolean reports that a
   * variable is non-empty and not that two services agree about its contents.
   *
   * So the absence is stated rather than left to be inferred from a screen of green.
   * `undetermined` and not `broken`: this is the pane saying it cannot answer, which
   * is the honest verdict and the one the Overview router should send a reader to
   * look at. It is emitted whenever the files probe is reported at all, including —
   * especially — when that probe reads perfectly.
   */
  if (services.byName.files?.outcome !== undefined) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('FILE_TRANSFER_UNVERIFIED'),
        title: 'Nothing on this screen establishes that a file transfer works',
        detail:
          'Every files row on this pane reports a readiness probe, a boot-time composition decision or a variable being non-empty. None of them exercises the authorized path a real upload or download takes: mint a valet token at auth, present it to the files service, and have the files service accept it. Two services each holding a non-empty VALET_TOKEN_SECRET or AUTH_JWT_SECRET that DISAGREE satisfy every row on this screen and refuse every transfer — the same shape as the internal gRPC secret, where exactly this happened. Read the files rows as "nothing is obviously misconfigured", never as "file transfers work". If attachments are failing, this screen has not cleared the files lane, and the fields that would are named in this section’s header.',
        verdict: 'undetermined',
        evidence: evidenceProxy({
          observed: 'that the files service answered an unauthenticated readiness route',
          cannotConfirm: PROBE_CANNOT_CONFIRM,
          necessaryCondition: true,
        }),
      }),
    )
  }

  if (filesProbeBlind && services.byName.files?.outcome !== undefined) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('FILES_PROBE_TARGET_WRONG'),
        title: 'The files probe is pointed at the gateway’s own loopback',
        detail:
          'FILES_SERVER_PROBE_URL is not set, so the files probe falls back to loopback — and this deployment is not the single container, where loopback is where the files service runs. The probe therefore dialled the api-gateway container, and its answer says nothing about the files service in either direction. This is the one files row on the screen that an operator can repair into meaning something, which is why it is reported separately from the lane itself.',
        verdict: 'degraded',
        evidence: EVIDENCE_DIRECT,
        remedy: {
          code: 'FILES_PROBE_TARGET_WRONG',
          summary:
            'Set FILES_SERVER_PROBE_URL to the internal address this gateway reaches the files service on, so the probe tests the files service instead of itself. Restart only — no rebuild.',
          steps: [
            'Set FILES_SERVER_PROBE_URL to the address the api-gateway can reach the files service on from inside the deployment network. WEBSOCKET_SYNC_FILES_URL is usually already that address.',
            'Do NOT use FILES_SERVER_URL. In this fork’s entrypoint that is the PUBLIC files URL — the app front door’s /files prefix — and it is not reachable from inside the container.',
            'Restart the gateway, then re-read this pane. The row will begin reporting the files service, and it still will not establish that an authorized transfer succeeds: no probe on this screen does.',
          ],
          effort: CONFIG_AND_RESTART,
          basis: 'verified',
          because: [
            'The deployment reported that FILES_SERVER_PROBE_URL is not set, and reported a MODE that is not the single container.',
            'With no probe URL the gateway falls back to its own loopback on a fixed internal port, which on a multi-container deployment is not the files service.',
          ],
        },
      }),
    )
  }

  const failed = KNOWN_SERVICES.filter((service) => {
    const outcome = services.byName[service]?.outcome
    return service !== 'api-gateway' && outcome !== undefined && SERVICE_FAILED[outcome]
  })

  if (failed.length > 0) {
    const anyUnreachable = failed.some((service) => services.byName[service]?.outcome === 'unreachable')
    findings.push(
      diagnosticFinding({
        code: safeConstant('INTERNAL_SERVICE_PROBE_FAILED'),
        title:
          failed.length === 1
            ? 'An internal readiness probe is failing'
            : 'Several internal readiness probes are failing',
        detail:
          'The rows above name which ones and in what way. The inference that this gateway application calls to those services are failing too is NOT claimed: the probe resolves its own base address and it can differ from the one real calls use, so the probe travels with the call path without being required by it.',
        verdict: 'broken',
        evidence: CALL_PATH_PROXY,
        remedy: remedyForInternalServiceUnreachable(failed, anyUnreachable),
      }),
    )
  }

  if (services.byName['websocket-gateway']?.outcome === 'not-configured') {
    findings.push(
      diagnosticFinding({
        code: safeConstant('WEBSOCKET_GATEWAY_NOT_PROBED'),
        title: 'No websocket gateway is probed on this deployment',
        detail:
          'Stated as a finding rather than left as a quiet row because the obvious action on it is the wrong one. On the single container the gateway is composed in-process and there is nothing to probe, so this is the expected reading and setting a probe address would make the row worse, not better.',
        verdict: 'informational',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForWebsocketGatewayNotProbed(),
      }),
    )
  }

  if (nearDeadline) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('INTERNAL_PROBE_NEAR_DEADLINE'),
        title: 'An internal probe is close to its deadline',
        detail:
          'Nothing has failed. This is the state that precedes a service appearing to flap between answering and unreachable, and it is the only warning available before the first timeout — a probe is either inside its deadline or it is a failure, with nothing in between.',
        verdict: 'degraded',
        evidence: EVIDENCE_DIRECT,
        remedy: remedyForProbeNearDeadline(),
      }),
    )
  }

  return {
    heading: safeConstant('Internal service communication'),
    description:
      'Whether this gateway reaches the other services, with what latency and in what failure class. Every row states what was MEASURED — a readiness probe outcome — rather than a verdict about the service, because the probe resolves its own base address and that address can differ from the one real calls use; the findings carry that inference separately and cap it. Which TRANSPORT the gateway uses to reach auth and the syncing server, and the per-call counters for it, are Environment & setup to report and are not restated here. Per-service failure detail is read by nothing in this module: it is free-form server text and is exactly where a probe failure puts the address it could not reach.',
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* Block 5: event delivery and queues                                         */
/* -------------------------------------------------------------------------- */

function presenceOf(topology: DeploymentTopology | undefined, key: string): boolean | undefined {
  if (topology?.recorded !== true) {
    return undefined
  }

  const presence = topology.presence
  if (presence === undefined || !(key in presence)) {
    return undefined
  }

  return presence[key] === true
}

function buildQueueBlock(topology: DeploymentTopology | undefined, queues: QueueView): DiagnosticBlock {
  const queueConfigured = presenceOf(topology, 'SQS_QUEUE_URL')
  const topicConfigured = presenceOf(topology, 'SNS_TOPIC_ARN')
  const fanOut = queueConfigured === undefined ? undefined : queueConfigured ? 'queue-backed' : 'in-process'
  const separation = QUEUE_SEPARATIONS.find((candidate) => candidate === queues.separation)

  const rows: DiagnosticRow[] = [
    observedRow({
      label: safeConstant('Event fan-out'),
      observed: fanOut,
      value: safeEnum(fanOut, FAN_OUT_MODES),
      verdict: 'informational',
      note: 'How domain events and realtime pushes leave this process: over a queue, or in-process. Derived from whether a queue is configured at all, which is a presence boolean — no queue address is read, and none could be. Both modes are correct configurations, so this row carries no verdict; it is the context the separation row below is read against.',
    }),
    diagnosticRow({
      label: safeConstant('Event topic configured'),
      value: safePresence(topicConfigured),
      ...absentOr(topicConfigured, 'informational'),
      note: 'Whether a publish topic is configured alongside the queue. Presence only. Absent is a supported configuration on a single-node deployment, which fans events out in-process instead, so this is never a fault on its own.',
    }),
    diagnosticRow({
      label: safeConstant('Queue separation'),
      value: safeEnum(queues.separation, QUEUE_SEPARATIONS),
      ...absentOr(separation, separation === 'inherited-shared-queue' ? 'broken' : 'informational'),
      note: 'Whether the in-process gateway consumes its OWN queue or one it inherited from a sibling. This is the highest-value fact in this block and no endpoint reports it. It is a measured defect of this repo rather than a hypothetical: workers once inherited the gateway queue address, both halves consumed from one queue, and roughly four in five realtime pushes — plus revision and e-mail events — went to whichever consumer won the race and were then deleted, with nothing logged. Presence cannot express it: a queue being configured says a queue exists and says nothing about how many consumers are pointed at it. A separation STATE can, with no address at all, and it is requested in this module header.',
    }),
  ]

  const findings: DiagnosticFinding[] = []

  if (separation === 'inherited-shared-queue') {
    findings.push(
      diagnosticFinding({
        code: safeConstant('EVENT_QUEUE_SHARED'),
        title: 'Two consumers are reading one event queue',
        detail:
          'Each message is delivered to whichever consumer takes it first and is then deleted, so the other half of the deployment never sees it. The visible symptom is intermittent: most realtime pushes do not arrive, revision and e-mail events go missing, and every individual component looks healthy because each one is processing the messages it did win.',
        verdict: 'broken',
        evidence: EVIDENCE_DIRECT,
        remedy: {
          code: 'EVENT_QUEUE_SHARED',
          summary:
            'Give the in-process gateway its own queue instead of the one the workers consume. On the bundled compose stack that is the API_GATEWAY_SQS_* prefix, which the entrypoint projects separately. Restart only — no rebuild.',
          steps: [
            'Set the API_GATEWAY_SQS_* variables so the in-process gateway has its own queue, endpoint and credentials rather than inheriting the bare SQS_QUEUE_URL the workers read.',
            'Do not point both halves at one queue and expect fan-out. A queue delivers each message once; two consumers on it is a split of the traffic, not a copy of it.',
            'Restart, then confirm by watching pushes arrive on a second device rather than by re-reading this row — the row reports configuration separation, and delivery is what you are actually checking.',
          ],
          effort: CONFIG_AND_RESTART,
          basis: 'verified',
          because: [
            'The deployment reported that the in-process gateway consumes a queue it did not configure for itself.',
            'This exact state was measured live on the bundled compose stack and cost roughly four in five realtime pushes. It is recorded here because nothing in the system logs it: both consumers succeed, on different messages.',
          ],
        },
      }),
    )
  }

  return {
    heading: safeConstant('Event delivery and queues'),
    description:
      'Which queue the halves of this deployment are pointed at. Whether the consumer loop is actually turning, whether a push bridge is attached and how many pushes have been dispatched are the WebSocket section to report, and are not restated here. Nothing in this block reads or reports a queue address, an endpoint or a credential: a separation STATE answers the diagnostic question, and an address would answer nothing this block asks.',
    rows,
    findings,
  }
}

/* -------------------------------------------------------------------------- */
/* The section                                                                */
/* -------------------------------------------------------------------------- */

const REPORT_NO_ADDRESSES = reportLine(
  safeConstant('Addresses'),
  safeConstant(
    'never collected; this section carries reachability states, closed status codes, counts, durations and buckets only',
  ),
)

const REPORT_NO_DETAIL = reportLine(
  safeConstant('Per-service failure detail'),
  safeConstant('read by nothing here; it is free-form server text and is where a probe failure puts an address'),
)

const REPORT_NO_ERROR_TEXT = reportLine(
  safeConstant('Status-read error text'),
  safeConstant('never stored or printed; reduced to one of five closed codes before anything is built from it'),
)

const REPORT_SERVICE_NAMES = reportLine(
  safeConstant('Service names'),
  safeConstant("only this build's own closed list; a service a newer server reports is counted, never named"),
)

const REPORT_QUEUE_IDENTITY = reportLine(
  safeConstant('Queue identity'),
  safeConstant('reported as a separation state only; no queue address, endpoint or credential is read'),
)

const REPORT_DEAD_OUTBOX = reportLine(
  safeConstant('Dead outbox rows'),
  safeConstant(
    'no endpoint this pane can read reports a count, and no row is shown for it; there is also no requeue path for the rows it would describe',
  ),
)

/**
 * Build the Database & internal communications section.
 *
 * Pure and synchronous over a payload someone else fetched. Every input is
 * optional, and every absent input produces rows reading "not reported" on
 * absent evidence rather than a negative verdict — which in this section is the
 * difference between "the status endpoint did not answer" and "your database is
 * down", two claims that have already been confused once in this directory.
 */
export function buildBackendSection(input: BackendSectionInput = {}): SectionModel {
  const status = isRecord(input.serverStatus) ? input.serverStatus : undefined
  const datastore = input.datastore ?? {}
  const queues = input.queues ?? {}
  const services = readServices(status)
  const outcomes = outcomesForSection(input.outcomes ?? [], 'backend')

  const blocks: DiagnosticBlock[] = [
    buildReadBlock(status, input.statusError),
    buildDatabaseBlock(status, datastore, services),
    buildCacheBlock(status, input.topology),
    buildCommunicationBlock(services, input.topology),
    buildQueueBlock(input.topology, queues),
  ]

  if (outcomes.length > 0) {
    blocks.push({
      heading: safeConstant('Operator-triggered checks'),
      description:
        'Results from the last run on the Checks sub-tab. Read-only here: a run is started in exactly one place, so the paragraph explaining what it does to your own account appears exactly once.',
      rows: [],
      findings: [],
      outcomes,
    })
  }

  return buildSectionModel({
    id: 'backend',
    blocks,
    extraReportLines: [
      REPORT_NO_ADDRESSES,
      REPORT_NO_DETAIL,
      REPORT_NO_ERROR_TEXT,
      REPORT_SERVICE_NAMES,
      REPORT_QUEUE_IDENTITY,
      REPORT_DEAD_OUTBOX,
    ],
  })
}
