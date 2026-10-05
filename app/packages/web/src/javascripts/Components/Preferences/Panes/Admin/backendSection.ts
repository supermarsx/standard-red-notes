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
 * service answers perfectly. So "connected" and "a handle exists" had to be a row
 * of its own — declared below as `DatastoreView` and rendered "not reported" while
 * nothing produced it. IT HAS A PRODUCER NOW: the service that owns the handle
 * reports the block, the gateway relays it through the auth runtime route, and
 * `handle-only` is a member. The block is still absent whenever that route does
 * not answer, which is a different absence from "nobody publishes this" and is
 * stated as one.
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
 * duration, and none of them needs a single address to express. ITEMS (a) TO (f)
 * ARE PUBLISHED NOW and are kept here, struck through in prose, because the
 * reason each was wanted is the reason each row reads the way it does:
 *
 *   a. `datastore.connectionState` — LANDED. `connected` / `handle-only` /
 *      `disconnected` / `other`, reported by the service that owns the handle.
 *      Section 4 above. The single highest-value field in this list: it is the
 *      only one that can see a defect this repo has actually shipped, on every
 *      topology at once.
 *   b. `datastore.migrationsApplied` + `pendingMigrations` — LANDED. A boolean and
 *      a bounded count. A schema one migration behind is a 500 on one route and
 *      nothing anywhere else. An ABSENT count means the schema was unreadable,
 *      never that none are pending.
 *   c. `datastore.poolInUse` + `poolSize` — LANDED. Two bounded counts. Pool
 *      exhaustion presents as latency, which is the symptom this pane is worst at
 *      attributing. ABSENT means the driver keeps no pool at all — SQLite, which
 *      is what the single container runs — and not an empty one.
 *   d. `datastore.readRoundTripMs` + `writeRoundTripMs` — LANDED, as bounded whole
 *      milliseconds measured by the service that owns the handle, with
 *      `writeProbe` beside them saying what the write ATTEMPT established. A
 *      read-only replica, a full disk and a lock wait all pass a `SELECT 1` and
 *      fail a write, and the write probe is the only row that separates them.
 *   e. `datastore.deadOutboxRows` — STILL WANTED. One count. There is no requeue
 *      path for these rows, so the count is the whole diagnosis. NO ROW IS
 *      RENDERED for it until a server reports it: a row reading "not reported"
 *      for a number that has no producer invites the reading that it is zero.
 *   f. `queues.separation` — LANDED, together with `queues.consumerCount`, and
 *      this is the one that mattered. The presence pair gave the PREFIX half; the
 *      missing half was whether a SECOND consumer exists, which only the gateway
 *      process can see because the sibling workers are supervisord programs in
 *      its own container. The server derives the verdict from both ONCE, so the
 *      count and the verdict cannot drift, and omits the verdict when it is not
 *      classifiable. The count is supporting evidence and NEVER a verdict here:
 *      `1` means "the only consumer I can see", which is also what a deployment
 *      whose workers live in another container reports.
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
 *   i. `files.authorizedTransfer` — `accepted` / `refused` / `not-attempted`. One
 *      closed enum, no address and no credential, and the single highest-value
 *      field this pane is missing. MEASURED, not hypothetical: on a deployment
 *      where file listing aborted, downloads hung forever and usage read zero
 *      permanently, every files row on this screen read green — probe answering,
 *      FILES_V1 advertised, no unmet condition, all three files variables set —
 *      because not one of them exercises the path a transfer takes: mint a valet
 *      token at auth, present it to the files service, have the files service
 *      accept it, and complete a ranged read. A presence boolean cannot express
 *      that and a readiness probe cannot see it; a three-state result of one real
 *      authorized round trip, made server-side between the two services, can.
 *      Until it exists `FILE_TRANSFER_UNVERIFIED` states the gap on every
 *      deployment rather than letting a screen of green imply the opposite.
 *
 *      *** AND THE OBVIOUS MECHANISM IS SCOPED, BECAUSE IT CANNOT HOLD HERE. ***
 *      Two services holding non-empty VALET_TOKEN_SECRET or AUTH_JWT_SECRET values
 *      whose CONTENTS disagree would satisfy every row above and refuse every
 *      transfer, exactly as two disagreeing internal gRPC secrets did. On the
 *      images this repo ships that is structurally impossible, and provable without
 *      reading a value: `server/docker/docker-entrypoint.sh` exports both keys
 *      ONCE, UNPREFIXED, before supervisord starts (and exits if either is empty);
 *      `supervisord.conf` gives no program an `environment=` of its own; auth
 *      (`Container.ts`) and files (`Container.ts`) each read that same unprefixed
 *      key through `AbstractEnv.get()`, which reads `process.env`. Byte-identical
 *      by construction. The hypothesis stays live only where the two services are
 *      configured separately — and a reader of this pane must not be sent after it
 *      on a shape where it cannot apply.
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

/**
 * The HALF of that question presence CAN now answer, and the exact line where it
 * stops.
 *
 * `DIAGNOSTIC_ENV_KEYS` used to carry `SQS_QUEUE_URL` and no prefixed
 * counterpart, so a gateway consuming its own queue and one consuming the
 * workers' produced an identical presence map. It now carries
 * `API_GATEWAY_SQS_QUEUE_URL` as well, and that is a genuinely different reading:
 * the container writes the gateway's dotenv from the `API_GATEWAY_` prefix, so a
 * queue the gateway OWNS arrives under the prefixed name while one it merely
 * INHERITED arrives bare and alone.
 *
 * *** WHAT THESE THREE STATES DO NOT SAY. *** None of them is `collided`.
 * Presence cannot show a SECOND CONSUMER, and a standalone gateway with no
 * workers produces exactly the same two booleans as a gateway splitting a queue
 * with four of them. `not-own-prefixed` is therefore the configuration in which
 * the measured defect is POSSIBLE and not evidence that it is happening; the
 * separation row below keeps that verdict unresolved and names the field that
 * would settle it. A row that read "inherited-shared-queue" off these booleans
 * would be the pane asserting an outage it cannot see — which is the failure this
 * whole section exists to end, pointed the other way.
 */
export const GATEWAY_QUEUE_PREFIXES = ['own-prefixed', 'not-own-prefixed', 'no-queue-configured'] as const

export type GatewayQueuePrefix = (typeof GATEWAY_QUEUE_PREFIXES)[number]

/**
 * The states a durable service's `DataSource` handle can be in. See header §4.
 *
 * `other` is the SERVER's own collapse of a token its own build could not name,
 * and it is a member here so that it renders as itself rather than as this
 * build's "other (unrecognised)". The two are different facts — one is a server
 * that could not name what it read, the other is a client behind its server —
 * and the row's note says which.
 */
export const DATABASE_CONNECTION_STATES = ['connected', 'handle-only', 'disconnected', 'other'] as const

export type DatabaseConnectionState = (typeof DATABASE_CONNECTION_STATES)[number]

/**
 * What the WRITE probe established, as the service that owns the handle reports
 * it.
 *
 * The probe is a zero-row DML — a self-assignment under an impossible predicate
 * — so it matches no row, takes no row lock and writes no undo record, and a
 * read-only server, a read-only replica and a revoked UPDATE grant all REFUSE
 * it. That is the whole value of the row: those three states pass every read this
 * pane can take, including the auth readiness query, and fail every real write.
 *
 * `accepted` is reported as a NECESSARY condition rather than as health. A
 * statement that changes nothing being accepted does not establish that a write
 * with rows to change would succeed — a full volume, a constraint or a trigger
 * all still refuse that — so the positive arm caps and the negative arm, which is
 * conclusive, survives.
 */
export const WRITE_PROBE_OUTCOMES = ['accepted', 'refused', 'timed-out', 'not-attempted', 'other'] as const

export type WriteProbeOutcome = (typeof WRITE_PROBE_OUTCOMES)[number]

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Facts about the durable store, as `payload.datastore`.
 *
 * Declared here before a producer existed, exactly as the contract's
 * `LaneDegradationLedgerView` and the payload's `TransportFallbackView` were.
 * The producer exists now: the service that OWNS the handle reports it, and the
 * gateway relays it through the auth runtime route — so the whole block is absent
 * whenever that route did not answer, which the Environment section's probe row
 * states. Every field is optional and typed wide where it is the SERVER's enum,
 * so a newer server's member degrades to "other (unrecognised)" through
 * `safeEnum` instead of being rendered as one of the members this build knows.
 *
 * *** ABSENT IS NOT ZERO, FIELD BY FIELD, AND EACH ABSENCE MEANS SOMETHING
 * DIFFERENT. *** No `pendingMigrations` means the schema was UNREADABLE, not that
 * none are pending. No `poolInUse`/`poolSize` means the driver keeps no pool at
 * all — SQLite — and not an empty pool. No round trip means that probe did not
 * complete. Each is rendered as its own state; collapsing any of them onto a
 * zero would be the panel reporting a measurement nobody took.
 *
 * There is nothing in this shape that could carry a connection string, a
 * database name or a credential — which matters, because the whole reason it
 * exists is to make a DATABASE failure observable.
 */
export type DatastoreView = {
  /** `connected` / `handle-only` / `disconnected` / `other`. The defect in header §4. */
  connectionState?: string
  /** `accepted` / `refused` / `timed-out` / `not-attempted` / `other`. */
  writeProbe?: string
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
  /**
   * One of `QUEUE_SEPARATIONS`, typed wide because it is the server's enum.
   *
   * OMITTED when the server could not classify it — a bare queue with no second
   * co-resident consumer to compare against, or no census at all, where a second
   * consumer could still exist in another container. That omission is the only
   * form this fact has for saying "I cannot tell", and it must not be rendered as
   * either answer.
   */
  separation?: string
  /**
   * Co-resident queue consumers: this gateway, when a queue is configured for it,
   * plus one for each supervisord worker beside it. A bounded cardinality, never
   * an address.
   *
   * *** SUPPORTING EVIDENCE, NEVER A VERDICT. *** `1` does NOT mean "no
   * collision": it means "the only consumer I can SEE", which is exactly what a
   * deployment whose workers run in another container reports. And ABSENT IS NOT
   * `1` — nothing at all means the control channel did not answer and no census
   * was taken. The verdict is `separation`, derived from this and the presence
   * pair ONCE, server-side, so the two cannot drift; this section renders the
   * verdict and prints the count beside it.
   */
  consumerCount?: number
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
  /**
   * Whether the running build recorded a revision at all — ONE boolean, derived by
   * the caller from the deployment marker Environment & setup already reads. Never
   * the revision itself: this section neither needs nor receives it.
   *
   * It is here for exactly one inference, and only because two unknowns compound:
   * a probe reports no depth, so an image predating the readiness route reports
   * "answering" having verified only liveness — and on an unstamped build nothing
   * can establish whether the image is new enough for that to be impossible.
   * Absent means the caller did not say, and then no claim is made.
   */
  buildIdentified?: boolean
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

/**
 * The same, for a figure rendered by `safeCount` — which additionally requires a
 * whole number.
 *
 * *** WHY THIS IS NOT JUST `numberOrAbsent`. *** `safeCount` refuses a
 * non-integer and prints "not reported"; `numberOrAbsent` admits one. A count of
 * `1.5` therefore produced a row whose VALUE said "not reported" while its
 * EVIDENCE said `direct` — the panel claiming it looked and got an answer, over
 * a figure it had just refused to print. That is the row disagreeing with itself,
 * which is the one defect this contract exists to make impossible, and it is a
 * latent bug in every count-shaped row rather than only the new one.
 *
 * Durations keep `numberOrAbsent`: a fractional millisecond is a legitimate
 * measurement and `safeDuration` prints it, so integrality there would refuse
 * real readings.
 */
function countOrAbsent(value: unknown): number | undefined {
  const number = numberOrAbsent(value)

  return number !== undefined && Number.isInteger(number) ? number : undefined
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

/**
 * The store that reads and will not write.
 *
 * `peer-service` rather than `restart`: all three causes are on the database
 * itself or on the grant it was reached with, and nothing in this app's
 * configuration changes any of them. It is not `rebuild` either — no new image
 * helps a replica that is read-only by design.
 */
function remedyForRefusedWrites(): Remedy {
  return {
    code: 'DATABASE_WRITES_REFUSED',
    summary:
      "The database accepted a read and refused a statement that changes nothing, so it will refuse every real write. The fix is on the database or on the grant, not on this deployment's configuration.",
    steps: [
      'Check whether the server is open read-only, or whether the address this service was given points at a READ REPLICA. A replica answers every read on this screen perfectly and refuses all DML, which is exactly this reading.',
      'Check the UPDATE grant on the database user this service connects as. A revoked write grant produces the same outcome with the server fully writable.',
      'Check for a full volume on the database host. A store with no room left refuses writes while reads keep being served from what is already there.',
      'Do not restart this app to clear it. The probe is re-run on every read of this pane, so the row answers again the moment the store accepts a write.',
    ],
    effort: 'peer-service',
    basis: 'verified',
    because: [
      'The service that owns the connection reported that a zero-row write statement was REFUSED. It matches no row, takes no lock and writes no undo record, so nothing about the statement itself can be the cause.',
      'Every read-based check on this screen — including the auth readiness query — passes in this state, which is why it is worth a row of its own rather than being inferred from latency.',
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

const MIGRATION_COUNT_UNREPORTED = safeConstant('(count not reported)')

/**
 * The two absences in this block that are NOT a missing measurement but a
 * measurement that does not apply.
 *
 * A driver that keeps no pool at all — SQLite, which the bundled single container
 * runs — reports neither pool figure, and that is a correct and complete answer.
 * Rendering it as "not reported" invites the operator to go looking for the pool
 * rows on a deployment that has no pool, and rendering it as `0 of 0` would be
 * worse: a fabricated saturation reading over a driver that cannot saturate.
 */
const NO_POOL = safeConstant('no pool kept by this driver')

/** The schema could not be read at all, which is not "nothing is pending". */
const SCHEMA_UNREADABLE = safeConstant('schema not readable')

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
  const writeProbe = WRITE_PROBE_OUTCOMES.find((candidate) => candidate === datastore.writeProbe)
  const applied = booleanOrAbsent(datastore.migrationsApplied)
  const pending = countOrAbsent(datastore.pendingMigrations)
  const readMs = numberOrAbsent(datastore.readRoundTripMs)
  const writeMs = numberOrAbsent(datastore.writeRoundTripMs)

  const poolInUse = countOrAbsent(datastore.poolInUse)
  const poolSize = countOrAbsent(datastore.poolSize)
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
  ]

  /**
   * *** THE COLLAPSE, AND THE ROWS IT NOW GIVES WAY TO. ***
   *
   * While nothing produced `connectionState`, `migrationsApplied`, `poolInUse`,
   * `readRoundTripMs` or `writeRoundTripMs`, all five rendered "not reported" in a
   * column directly under two rows that DID report, and an operator reading that
   * column reasonably concluded the diagnostics were failing rather than that the
   * fields did not exist. They were collapsed into one named row, the way the
   * admission block in `websocketSection.ts` is.
   *
   * The service that owns the handle reports all of them now, so on a deployment
   * whose auth runtime route answers the rows are back, field by field, exactly as
   * this comment promised. The collapse SURVIVES for the deployments where it is
   * still the truth — a server older than the block, and any deployment whose auth
   * process cannot be probed — and its one row now says which of those it is
   * instead of implying nobody publishes the facts.
   *
   * It keeps `undetermined`, which is what each of the five carried. Dropping to
   * `informational` would LOWER this section's worst verdict — the section would
   * read healthy off one answering readiness probe — and a section that
   * establishes two facts out of eight has not established that the database is
   * well.
   */
  /**
   * The gate is over the RAW fields, never over the parsed ones, and that
   * distinction is the whole correctness of the collapse. `connectionState`
   * parses to `undefined` for a state this build does not recognise, and
   * `poolReported` is false when only one half of the pair arrived — both are
   * cases where the server DID report and the row must stay, saying "other
   * (unrecognised)" or "not reported of 10". Gating on the parsed values would
   * have swallowed exactly the readings this section exists to surface.
   */
  const datastoreSilent =
    datastore.connectionState === undefined &&
    datastore.writeProbe === undefined &&
    datastore.migrationsApplied === undefined &&
    datastore.pendingMigrations === undefined &&
    datastore.poolInUse === undefined &&
    datastore.poolSize === undefined &&
    datastore.readRoundTripMs === undefined &&
    datastore.writeRoundTripMs === undefined

  if (datastoreSilent) {
    rows.push(
      diagnosticRow({
        label: safeConstant('Connection, schema, pool and round trips'),
        value: safePresence(undefined),
        verdict: 'undetermined',
        evidence: EVIDENCE_ABSENT,
        note: "Six fields, named here rather than rendered as six empty rows: the data source's connection state, what a real write statement established, whether the live schema matches the build, connections checked out against the pool maximum, and the read and write round trips. They are reported by the service that OWNS the connection and reach this pane through the auth runtime route, so they are absent together and for one reason — a server older than the block, or an auth process that could not be probed, which the Environment & setup section's auth-runtime row states. They are deliberately NOT filled in from the readiness probes above: a probe that says a service answers says nothing about the state of its connection, its schema or its pool. Each appears as its own row the moment that route answers, and this block stays undetermined meanwhile because two answered facts out of eight is not a healthy database.",
      }),
    )
  } else {
    rows.push(
      diagnosticRow({
        label: safeConstant('Database connection state'),
        value: safeEnum(datastore.connectionState, DATABASE_CONNECTION_STATES),
        // Gated on the RAW field, not the parsed one: a state this build cannot
        // name was still REPORTED, so the evidence is direct and the value is the
        // refusal constant. Gating on the parsed value printed "other
        // (unrecognised)" while claiming nothing had been reported — the row
        // disagreeing with itself.
        //
        // `other` is the server collapsing a token IT could not name, so it
        // establishes nothing about the handle and must not be read as a fault
        // either. Only the two states that ARE a fault carry one.
        ...absentOr(
          datastore.connectionState,
          connectionState === 'connected'
            ? 'healthy'
            : connectionState === 'handle-only' || connectionState === 'disconnected'
              ? 'broken'
              : 'informational',
        ),
        note: 'Whether the durable service holds a CONNECTED data source or merely a handle, reported by the service that owns it. Not an academic row: this repo shipped a getter that rebuilt an unconnected data source on every read, so consumers wired after the connected one was built received a dead object and every durable command failed — on every topology, with the container reporting ready throughout. "handle-only" is exactly that state and is the member no readiness probe can see. "other" is the SERVER collapsing a token its own build could not name, which says nothing about the handle either way and carries no verdict; "other (unrecognised)" instead means this client is behind its server.',
      }),
      diagnosticRow({
        label: safeConstant('Database write probe'),
        value: safeEnum(datastore.writeProbe, WRITE_PROBE_OUTCOMES),
        verdict:
          writeProbe === 'accepted'
            ? 'healthy'
            : writeProbe === 'refused'
              ? 'broken'
              : writeProbe === 'timed-out'
                ? 'degraded'
                : 'informational',
        // Raw, for the same reason as the row above: an outcome this build cannot
        // name was still reported.
        evidence:
          datastore.writeProbe === undefined
            ? EVIDENCE_ABSENT
            : writeProbe === 'accepted' || writeProbe === 'refused'
              ? evidenceProxy({
                  observed:
                    'that a statement which changes no row was accepted or refused by the service that owns the connection',
                  cannotConfirm: 'that a real write, with rows to change, would succeed',
                  necessaryCondition: true,
                })
              : EVIDENCE_DIRECT,
        note: 'What a REAL write statement established, which no read can. The probe is a self-assignment under an impossible predicate, so it matches no row, takes no row lock and writes no undo record — and a read-only server, a read-only replica and a revoked UPDATE grant all refuse it while every read on this screen, including the auth readiness query above, still passes. "accepted" is reported as undetermined on purpose: a statement that changes nothing being accepted is necessary for a write to work and does not establish it, because a full volume, a constraint or a trigger refuses the real one. "refused" is conclusive and keeps its verdict. "not-attempted" is a deployment where the probe was not run rather than one that failed it.',
      }),
      diagnosticRow({
        label: safeConstant('Schema migrations'),
        // An absent `applied` inside a block that DID report is the schema being
        // unreadable, which is its own answer and not a missing field.
        value:
          applied === undefined
            ? SCHEMA_UNREADABLE
            : applied
              ? safeYesNo(true)
              : safeTokens(
                  safeYesNo(false),
                  pending === undefined ? MIGRATION_COUNT_UNREPORTED : safeCount(pending),
                  MIGRATIONS_PENDING,
                ),
        ...absentOr(applied, applied === true ? 'healthy' : 'degraded'),
        note: 'Whether the live schema matches the build. A schema one migration behind answers readiness, serves most routes and fails exactly the ones that touch the new columns, which presents as a single broken feature rather than as a database problem. A count is reported and no schema, table or column name is. AN ABSENT COUNT IS NOT ZERO: the migration table could not be read, so nothing is known about how far behind the schema is — reporting that as "none pending" would be the panel inventing the most reassuring reading available.',
      }),
      diagnosticRow({
        label: safeConstant('Connection pool in use'),
        /**
         * *** THREE READINGS, NOT TWO. ***
         *
         * NEITHER raw figure present, inside a block that otherwise reported, is
         * the driver keeping no pool — SQLite — which is a complete answer.
         * ONE figure present is a pair that cannot be read, and that keeps the
         * old composite rendering ("not reported of 10"): the half that did
         * arrive is still a fact, and NO_POOL there would claim the driver has no
         * pool over a server that just told us its maximum.
         */
        value:
          datastore.poolInUse === undefined && datastore.poolSize === undefined
            ? NO_POOL
            : safeTokens(safeCount(poolInUse), OF, safeCount(poolSize)),
        ...absentOr(
          poolReported ? true : undefined,
          poolSaturation !== undefined && poolSaturation >= 0.9 ? 'degraded' : 'informational',
        ),
        note: 'Connections checked out against the pool maximum. Exhaustion presents as latency rather than as an error — every query waits for a free connection and then succeeds — which is the symptom this pane is least able to attribute from a readiness probe alone. Two counts, never a connection string. NO FIGURES IS NOT AN EMPTY POOL: a driver that keeps no pool reports neither, which is the complete and correct answer on the SQLite the bundled single container runs, and there is nothing to exhaust there.',
      }),
      diagnosticRow({
        label: safeConstant('Database read round trip'),
        value: safeDuration(seconds(readMs)),
        ...absentOr(readMs, 'informational'),
        note: 'A read measured by the service that owns the connection, with no network hop or HTTP framing in it — the number the auth readiness duration above is a poor stand-in for, because that one also contains an internal hop and a cache ping. Absent means that probe did not complete, which is not a round trip of zero.',
      }),
      diagnosticRow({
        label: safeConstant('Database write round trip'),
        value: safeDuration(seconds(writeMs)),
        ...absentOr(writeMs, 'informational'),
        note: 'Reported separately from the read on purpose: a read-only replica, a full volume and a long lock wait all pass a read and fail a write. WHETHER the write was accepted at all is the probe row above — this is only how long it took — and absent here means the attempt did not complete rather than that it was instant.',
      }),
    )
  }

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

  if (writeProbe === 'refused') {
    findings.push(
      diagnosticFinding({
        code: safeConstant('DATABASE_WRITES_REFUSED'),
        title: 'The database refused a statement that changes nothing',
        detail:
          'The probe is a self-assignment under an impossible predicate: it matches no row, takes no lock and writes no undo record, so a store that refuses it refuses every real write too. Three deployments land here and all three pass every read on this screen — a server opened read-only, a read-only replica being written to, and a database user whose UPDATE grant was revoked. The symptom is that sign-in, sync and sharing all read fine and nothing can be saved.',
        verdict: 'broken',
        evidence: evidenceProxy({
          observed: 'that the service owning the connection had a zero-row write statement refused',
          cannotConfirm: 'which of the three causes applies on this deployment',
          necessaryCondition: true,
        }),
        remedy: remedyForRefusedWrites(),
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
      'The server\'s own database: one readiness query taken by the auth service, plus the connection state, write probe, schema, pool and round trips reported by the service that OWNS the handle. Those six arrive together through the auth runtime route and are collapsed into a single named row when that route did not answer, because six rows each reading "not reported" is read as six failures and is in fact one absent input; they are never filled in from the probes either, since a probe that says a service answers says nothing at all about the state of its connection, its schema or its pool. ABSENT IS NOT ZERO in any of them, and each absence has its own wording: an unreadable schema, a driver that keeps no pool, a probe that did not complete. No connection string, host, port or database name is read or reported anywhere in this section. A count of dead outbox rows is deliberately NOT shown as an empty row: there is still no producer for it, and an empty count invites the reading that it is zero.',
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
 * What a service probe's POSITIVE answer establishes — which is a good deal, and
 * still not what the lane behind it needs.
 *
 * Every one of these probes is an UNAUTHENTICATED `GET /healthcheck/readiness` —
 * falling back to plain `/healthcheck` liveness on a 404 — against a base address
 * the gateway resolves for itself.
 *
 * WHAT IT DOES ESTABLISH, for files, is stronger than the first version of this
 * comment credited: `files`' readiness route returns 200 only when its storage
 * capability check passed inside two seconds AND, where Redis is configured for
 * that service, Redis answered a PING inside two seconds; otherwise it answers
 * 503, which this module already reads as `degraded` and not as `answering`. So
 * "answering" rules out three real faults: the files process being down, its
 * uploads storage being unreachable, and its Redis being unreachable. That is
 * worth saying, because understating a signal sends an operator to re-check
 * something this screen has already cleared.
 *
 * WHAT IT CANNOT ESTABLISH is anything about an AUTHORIZED request: no probe
 * presents a credential, so no probe can see a credential the far end refuses, and
 * none of them completes a ranged read. That gap is not hypothetical — it is the
 * state this pane was measured in: every files row green on a deployment where file
 * listing aborted and downloads hung. So the verdict is capped: the row keeps its
 * fact and loses the claim, which is this contract's own mechanism applied to the
 * row that needed it.
 */
const PROBE_CANNOT_CONFIRM =
  'that an AUTHORIZED request to this service succeeds — the probe is unauthenticated, so a credential the far end refuses is invisible to it, and no probe completes a ranged read'

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
 * What the files probe was POINTED AT — two answers, and deliberately not three.
 *
 * `FILES_SERVER_PROBE_URL` unset does not disable the files probe: it falls back to
 * `http://localhost:<FILES_SERVER_PORT>`, loopback relative to the api-gateway
 * PROCESS. The question that matters is therefore not compose-versus-single, it is
 * whether the files process is CO-RESIDENT with the gateway — and in this repo it
 * always is:
 *
 *   - `docker-compose.yml` declares NO files service. Its one `server` container
 *     runs every backend process under one supervisord, which declares
 *     `[program:files]` and `[program:api-gateway]` as siblings with no per-program
 *     `environment=`, and the compose file's own comment names `server:3104 for
 *     files`. The entrypoint exports `FILES_SERVER_PORT=3104` unconditionally and
 *     then sets `API_GATEWAY_WEBSOCKET_SYNC_FILES_URL=http://localhost:$FILES_SERVER_PORT`
 *     itself; `files/bin/server.ts` listens with no host, so loopback reaches it.
 *   - The single-container image is the same arrangement, more so: `home-server`
 *     holds every service in ONE process.
 *
 * *** SO THERE IS NO SHIPPED TOPOLOGY ON WHICH THE LOOPBACK FALLBACK IS WRONG, AND
 * THIS FUNCTION HAD A THIRD STATE THAT SAID THERE WAS. *** It returned
 * `gateway-loopback` for every mode but `home-server`, which is the bundled compose
 * stack — the commonest deployment this repo produces, and the one that produced
 * the report this whole change came from. It withheld a correct probe result and
 * raised a `degraded` finding over a correctly configured deployment: the precise
 * cry-wolf failure this pass exists to remove, introduced by the pass itself.
 *
 * The only shape the fallback misses is a HAND-ROLLED split, where someone runs the
 * files service in a container of its own and does not set the probe URL. That is
 * indistinguishable from a shipped shape through the presence rows — the inputs this
 * module has — so it is not guessed at. It is named in the note instead, with the
 * variable that removes the ambiguity, and `mode` is no longer read here at all.
 */
export const FILES_PROBE_TARGETS = ['configured', 'colocated-by-default', 'unknown'] as const

export type FilesProbeTarget = (typeof FILES_PROBE_TARGETS)[number]

export function filesProbeTarget(topology: DeploymentTopology | undefined): FilesProbeTarget {
  const configured = presenceOf(topology, 'FILES_SERVER_PROBE_URL')
  if (configured === undefined) {
    return 'unknown'
  }

  return configured ? 'configured' : 'colocated-by-default'
}

const FILES_PROBE_TARGET_NOTE: Record<FilesProbeTarget, string> = {
  configured:
    ' FILES_SERVER_PROBE_URL is set, so the probe dialled the internal address this deployment configured for the files service.',
  'colocated-by-default':
    ' FILES_SERVER_PROBE_URL is not set, so the probe fell back to loopback on the files port — and on every topology this repo ships that IS the files process: both the bundled compose stack and the single container run it beside the gateway, so no address needed configuring. The one arrangement that would defeat it is a files service running in a container of its own without this variable set, and that cannot be told apart from here; set FILES_SERVER_PROBE_URL if that is your deployment. Either way the address is not the open question — the credential is.',
  unknown:
    ' Whether a probe address was configured could not be established: this deployment reported no presence entry for FILES_SERVER_PROBE_URL. On the shipped topologies the fallback reaches the files process anyway, so nothing is claimed either way.',
}

function buildCommunicationBlock(
  services: ServicesReading,
  topology: DeploymentTopology | undefined,
  buildIdentified: boolean | undefined,
): DiagnosticBlock {
  const rows: DiagnosticRow[] = []
  const filesTarget = filesProbeTarget(topology)

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
          value: outcome === undefined ? safePresence(undefined) : SERVICE_OUTCOME_VALUE[outcome],
          verdict: outcome === undefined ? 'undetermined' : SERVICE_VERDICT[outcome],
          evidence: outcome === undefined ? EVIDENCE_ABSENT : probeEvidence(service, outcome),
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
          'The files probe is worth more than nothing: its readiness route answers 200 only when the files service\'s storage check passed and, where Redis is configured for it, Redis answered — so a green probe rules out the process being down and its storage or Redis being unreachable. What no row here does is exercise the authorized path a real transfer takes: mint a valet token at auth, present it to the files service, have the files service accept it, and complete a ranged read. A credential the far end refuses is invisible to an unauthenticated probe, and so is a stalled range request. One topology note, so this does not send you after a mechanism that cannot apply: two services holding non-empty VALET_TOKEN_SECRET or AUTH_JWT_SECRET values that DISAGREE would satisfy every row here and refuse every transfer — but on the images this repo ships that cannot happen, because the entrypoint exports both keys once, unprefixed, before supervisord starts, with no per-program environment, and auth and files read that same key from that same process environment. It is a live hypothesis only where the services are configured separately. Read the files rows as "nothing visible is misconfigured", never as "file transfers work": if attachments are failing, this screen has not cleared the files lane, and the field that would is named in this section’s header.',
        verdict: 'undetermined',
        evidence: evidenceProxy({
          observed: 'that the files service answered an unauthenticated readiness route',
          cannotConfirm: PROBE_CANNOT_CONFIRM,
          necessaryCondition: true,
        }),
      }),
    )
  }

  /**
   * TWO UNKNOWNS THAT ONLY MATTER TOGETHER.
   *
   * A service whose readiness route 404s is re-probed for LIVENESS and reports `ok`
   * with that fact buried in a free-form `detail` this module refuses to read — so
   * an older image reports fully healthy here while only its process liveness was
   * ever verified. For `files` that route has no middleware and answers 200 or 503,
   * never 404, so on a CURRENT image the shallow path cannot fire at all.
   *
   * Which leaves exactly one question: is the running image current? On a build that
   * recorded no revision, nothing can answer it — so the depth of every probe on
   * this screen is unverifiable, and that is a statement neither the probe rows nor
   * the deployment-identity row can make alone. `undetermined`, because this is the
   * pane saying it cannot tell; it cannot fire on a stamped build, and it cannot
   * fire where no probe was reported.
   */
  if (buildIdentified === false && services.reported !== undefined) {
    findings.push(
      diagnosticFinding({
        code: safeConstant('PROBE_DEPTH_UNVERIFIABLE'),
        title: 'How deep these probes went cannot be established on an unidentified build',
        detail:
          'Each probe asks a readiness route first and falls back to a plain liveness route when that answers 404 — and it reports the shallow result as "ok", with the distinction in a free-form field this pane does not read because it can carry an address. On a current image that fallback cannot fire for the files service: its readiness route has no middleware and answers only 200 or 503. But this build recorded no revision, so nothing here establishes that the running image is current, and the two unknowns compound: an unverifiable probe depth on an unidentifiable build. Stamp the build (SRN_DEPLOY_REVISION at image build time) and this resolves itself — the Environment & setup section carries that row. Until then, read every "answering" on this screen as "answered something", and see this section’s header for the one field that would report probe depth directly.',
        verdict: 'undetermined',
        evidence: evidenceProxy({
          observed: 'that this build recorded no revision, and that the probe reports no depth',
          cannotConfirm: 'whether any given probe verified readiness or only liveness',
          necessaryCondition: false,
        }),
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

/**
 * The prefix state, derived from the two presence booleans and from nothing else.
 *
 * Deliberately `undefined` in the one combination that cannot be told apart: the
 * prefixed name absent and the bare name NOT REPORTED is consistent both with a
 * gateway reading an inherited queue and with a deployment that has no queue at
 * all, and those are opposite answers. Reporting either would be a coin toss
 * rendered as an observation.
 */
function queuePrefixOf(prefixed: boolean | undefined, bare: boolean | undefined): GatewayQueuePrefix | undefined {
  if (prefixed === undefined) {
    return undefined
  }
  if (prefixed) {
    return 'own-prefixed'
  }
  if (bare === undefined) {
    return undefined
  }
  return bare ? 'not-own-prefixed' : 'no-queue-configured'
}

const QUEUE_PREFIX_NOTE: Record<GatewayQueuePrefix, string> = {
  'own-prefixed':
    "This gateway has a queue of its own: the prefixed variable is set, and the container writes the gateway's dotenv from that prefix. That is the fix for the measured defect below being IN PLACE. It is not proof of separation — presence cannot compare two addresses, and nothing here reads one — but its absence is how the defect happens.",
  'not-own-prefixed':
    'A queue is configured and this gateway has none of its own, so it is reading whatever the bare name points at. CORRECT on a deployment with no other consumer, and the exact configuration of the measured defect on one with workers: a queue delivers each message once, so two consumers split the traffic instead of each seeing it. Which of those this is cannot be derived from presence, and the row below says so rather than guessing.',
  'no-queue-configured':
    'Neither name is set, so there is no queue for the halves of this deployment to share. Events fan out in-process, which is a supported configuration and is the single-node default.',
}

/**
 * *** THE THREE READINGS OF AN ABSENT VERDICT, AND WHY THEY ARE NOT ONE. ***
 *
 * `queues.separation` is omitted by the server when it cannot classify the
 * deployment, which is the only form this fact has for saying "I cannot tell". So
 * the row has to tell three absences apart:
 *
 *   - the whole `queues` block missing: a server older than it.
 *   - the block present and the verdict omitted: the server looked and could not
 *     classify — a bare queue with no second co-resident consumer, or no census
 *     at all, where a second consumer may still exist in another container.
 *   - a token outside this build's tuple: this client is behind its server.
 *
 * Rendering the second as the first would blame the server's age for a judgement
 * it deliberately withheld; rendering either as a VERDICT would be the panel
 * inventing the reassuring half of a question it was explicitly told is open.
 */
const SEPARATION_UNCLASSIFIED = safeConstant('not classifiable from here')

function buildQueueBlock(topology: DeploymentTopology | undefined, queues: QueueView | undefined): DiagnosticBlock {
  const reported = queues ?? {}
  const queueConfigured = presenceOf(topology, 'SQS_QUEUE_URL')
  const ownQueueConfigured = presenceOf(topology, 'API_GATEWAY_SQS_QUEUE_URL')
  const topicConfigured = presenceOf(topology, 'SNS_TOPIC_ARN')
  const fanOut = queueConfigured === undefined ? undefined : queueConfigured ? 'queue-backed' : 'in-process'
  const prefix = queuePrefixOf(ownQueueConfigured, queueConfigured)
  const separation = QUEUE_SEPARATIONS.find((candidate) => candidate === reported.separation)
  const consumers = countOrAbsent(reported.consumerCount)

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
    observedRow({
      label: safeConstant('Gateway event queue prefix'),
      observed: prefix,
      value: safeEnum(prefix, GATEWAY_QUEUE_PREFIXES),
      verdict: 'informational',
      note:
        prefix === undefined
          ? 'Whether this gateway has a queue of its OWN, derived from two presence booleans: the prefixed `API_GATEWAY_SQS_QUEUE_URL` and the bare `SQS_QUEUE_URL`. Not derivable here — the prefixed name was not reported, or it is absent while the bare name was not reported either, and that pair is consistent both with an inherited queue and with no queue at all. No address is read in any case. This row carries no verdict: it reports a configuration, and the separation row below is where the question it half-answers lives.'
          : `${QUEUE_PREFIX_NOTE[prefix]} Presence only — no queue address, endpoint or credential is read, and none could be. This row carries no verdict of its own, because the same two booleans are produced by a deployment where this is correct and by one where it is the fault.`,
    }),
    diagnosticRow({
      label: safeConstant('Co-resident queue consumers'),
      value: safeCount(consumers),
      ...absentOr(consumers, 'informational'),
      note: 'How many queue consumers live in THIS process group: the gateway, when a queue is configured for it, plus one for each supervisord worker beside it. A cardinality, never an address, and SUPPORTING EVIDENCE rather than a verdict — which is why it carries no tone whatever it reads. A ONE DOES NOT MEAN "NO COLLISION": it means "the only consumer I can see", which is exactly what a deployment whose workers run in another container reports. ABSENT DOES NOT MEAN ZERO OR ONE either: nothing at all means the control channel did not answer, so no census was taken. The verdict this feeds is the row below, which the server derives from this count and the queue presence pair together, once, so the two cannot disagree.',
    }),
    diagnosticRow({
      label: safeConstant('Queue separation'),
      value:
        reported.separation === undefined
          ? queues === undefined
            ? safePresence(undefined)
            : SEPARATION_UNCLASSIFIED
          : safeEnum(reported.separation, QUEUE_SEPARATIONS),
      // Only the collided member carries a verdict. `none` is tempting to call a
      // degradation and is not one on its own evidence: the server reaches it from
      // the MODE alone, and a compose deployment running no workers fans events out
      // in-process perfectly well. A verdict there would be a judgement about which
      // services the operator runs, made from a field that does not say.
      ...absentOr(separation, separation === 'inherited-shared-queue' ? 'broken' : 'informational'),
      note: `Whether the halves of this deployment consume SEPARATE queues or one between them — the highest-value fact in this block, and a measured defect of this repo rather than a hypothetical: workers once inherited the gateway queue address, both halves consumed from one queue, and roughly four in five realtime pushes plus revision and e-mail events went to whichever consumer won the race and were then deleted, with nothing logged, because both consumers succeeded on different messages. The verdict is derived ONCE, on the server, from the queue presence pair and the consumer census above, so this row and that count cannot drift apart. ${
        reported.separation === undefined
          ? queues === undefined
            ? 'Nothing was reported here: a server older than this block.'
            : 'THE SERVER LOOKED AND WITHHELD A VERDICT, which is a different answer from not looking and is the only form this fact has for saying so. It happens on a deployment reading a bare queue with no second co-resident consumer to compare against, or where no census could be taken at all — and a second consumer may still exist in another container, which this process cannot see. So no verdict, rather than the reassuring one.'
          : 'Only "inherited-shared-queue" carries a verdict here, and it is the proven one: a bare queue with a second co-resident consumer draining it. "none" is deliberately left without one — the server reaches it from the deployment MODE alone, and a compose deployment running no workers fans events out in-process perfectly well, so a tone there would be a judgement about which services are running made from a field that does not say. "in-process-fan-out" is the single container, where the fan-out is a function call and is correct rather than missing.'
      }`,
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
  const services = readServices(status)
  const outcomes = outcomesForSection(input.outcomes ?? [], 'backend')

  const blocks: DiagnosticBlock[] = [
    buildReadBlock(status, input.statusError),
    buildDatabaseBlock(status, datastore, services),
    buildCacheBlock(status, input.topology),
    buildCommunicationBlock(services, input.topology, input.buildIdentified),
    // The RAW optional, not a defaulted `{}`: an absent block is a server older
    // than it, and a present block with no verdict in it is a server that looked
    // and withheld one. Defaulting here would erase that distinction before the
    // row that depends on it ever sees it.
    buildQueueBlock(input.topology, input.queues),
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
