/**
 * Standard Red Notes: the RUNTIME half of the admin Diagnostics payload — the
 * rows that read "no endpoint publishes this" because the fact lives in a
 * process the panel cannot reach.
 *
 * Three different kinds of fact live here, and they are kept apart because they
 * fail independently:
 *
 *   1. GATEWAY-LOCAL and free. `process.uptime()`, and the internal gRPC
 *      secret's THRESHOLD state derived from two closed enums the deployment
 *      report already carries. Neither needs any I/O.
 *   2. AUTH-OWNED and fetched. The effective session-cookie attributes, the
 *      legacy-session switch, and the durable store's state. The gateway holds
 *      no database handle and never resolves a cookie attribute, so these can
 *      only come from the auth process — over the SAME internal probe URL the
 *      readiness probe already uses.
 *   3. DERIVED FROM TOPOLOGY. The queue-separation verdict, which is the one
 *      field in this module that presence alone provably cannot express.
 *
 * *** WHY QUEUE SEPARATION NEEDS A SERVER AND NOT A PRESENCE BOOLEAN ***
 *
 * `API_GATEWAY_SQS_QUEUE_URL` joined `DIAGNOSTIC_ENV_KEYS`, which makes
 * own-prefixed vs not-own-prefixed derivable from presence. `collided` is NOT
 * derivable from presence, and that is a statement about the booleans rather
 * than a preference: a standalone gateway holding one bare `SQS_QUEUE_URL` and a
 * compose stack whose workers inherited the gateway's bare `SQS_QUEUE_URL`
 * produce IDENTICAL presence readings. The second is the deployment that lost
 * roughly four in five realtime pushes plus revision and e-mail events, because
 * a queue delivers each message once and the two consumers split the traffic
 * instead of each seeing it. Nothing logged an error — both halves succeeded, on
 * different messages.
 *
 * What separates them is whether a SECOND consumer is pointed at that same bare
 * queue, which only the server can see: the sibling workers are supervisord
 * programs in this container, so their presence is a topology fact the gateway
 * can read and the browser cannot. When the gateway cannot see the other
 * consumers — no supervisord, or a control channel that did not answer — the
 * verdict is OMITTED rather than guessed. A row reading "not reported" is better
 * than a row that says `own-prefixed-queue` over a collision.
 *
 * *** SECURITY BOUNDARY — the same contract as `DeploymentDiagnostics` ***
 *
 * Every field is a boolean, a member of a CLOSED union, a bounded count or a
 * bounded whole-millisecond duration. There is no `string` field in any type
 * this module exports.
 *
 * The auth-sourced half is the part that needed a structural answer rather than
 * a promise, because it arrives OFF THE WIRE from another process. It is read by
 * ALLOWLIST, field by field:
 *
 *   - every enum is admitted against a tuple THIS build declares and collapses
 *     to `'other'` otherwise, so a newer auth — or a compromised one — cannot
 *     push free-form text through a field this build believed was an enum;
 *   - every number must be finite, non-negative and within a bound declared
 *     here; one outside it is DROPPED rather than clamped, because clamping
 *     would put a figure on an operator's screen that no process measured;
 *   - every boolean must actually be a boolean; a string is not coerced;
 *   - no other key is copied. A field auth grows later is simply not read until
 *     this module is taught about it.
 *
 * PER-SERVICE FAILURE DETAIL IS NOT READ, anywhere, deliberately. It is
 * free-form server text and it is exactly where a probe failure puts a host and
 * a port. The auth diagnostics route does not emit any, and this reader would
 * drop it if it did.
 */

import { DeploymentMode } from './DeploymentDiagnostics'

/* -------------------------------------------------------------------------- */
/* Bounds this build declares                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The ceiling on a reported round trip. The auth probe abandons at 2s, so a
 * larger figure is impossible rather than merely unexpected — and the gateway
 * checks the bound AGAIN rather than trusting that, because the whole point of
 * this reader is that the producer is another process.
 */
export const MAX_ROUND_TRIP_MS = 2_000

/** Bounds on the two census figures and the migration count. */
export const MAX_REPORTED_MIGRATIONS = 9_999
export const MAX_REPORTED_POOL = 9_999

/** A sanity ceiling on a reported uptime: a hundred years of seconds. */
export const MAX_UPTIME_SECONDS = 3_153_600_000

/* -------------------------------------------------------------------------- */
/* Closed vocabularies                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What the gateway's read of the auth runtime route established.
 *
 * Four members because the four situations have four different fixes, and
 * because collapsing them would make an absent datastore block ambiguous:
 * `not-configured` is a gateway with no auth probe URL at all, `unreachable` is
 * a dial that did not complete (the bundled home server, where auth runs
 * in-process and has no HTTP listener), and `unreadable` is an answer whose body
 * carried nothing this build could admit — an auth older than the route, or a
 * proxy that answered in its place.
 */
export const AUTH_RUNTIME_PROBE_OUTCOMES = ['answered', 'unreachable', 'not-configured', 'unreadable'] as const

export type AuthRuntimeProbeOutcome = (typeof AUTH_RUNTIME_PROBE_OUTCOMES)[number]

/**
 * The states a durable service's `DataSource` handle can be in, plus `'other'`
 * for a token this build cannot read. `handle-only` is the member that matters:
 * an initialized handle whose queries do not complete, which every readiness
 * probe in this repo reports as a perfectly healthy service.
 */
export const DATABASE_CONNECTION_STATES = ['connected', 'handle-only', 'disconnected'] as const

export type DatabaseConnectionState = (typeof DATABASE_CONNECTION_STATES)[number] | 'other'

/** What the write probe established. See the auth-side doc for what it does and does not measure. */
export const WRITE_PROBE_OUTCOMES = ['accepted', 'refused', 'timed-out', 'not-attempted'] as const

export type WriteProbeOutcome = (typeof WRITE_PROBE_OUTCOMES)[number] | 'other'

/**
 * Which queue the halves of this deployment are pointed at.
 *
 * The tuple is the one the panel already declares, member for member, so a
 * verdict served from here cannot render as "other (unrecognised)" on the
 * client that asked for it.
 */
export const QUEUE_SEPARATIONS = ['own-prefixed-queue', 'inherited-shared-queue', 'in-process-fan-out', 'none'] as const

export type QueueSeparation = (typeof QUEUE_SEPARATIONS)[number]

/**
 * A ceiling on the consumer census. The shipped image supervises one gateway and
 * four workers; the bound is generous enough for a deployment that grows more
 * and is what makes the field a BOUNDED count rather than an open number.
 */
export const MAX_REPORTED_CONSUMERS = 64

/*
 * NO SECRET-THRESHOLD FIELD LIVES HERE, deliberately.
 *
 * The internal gRPC secret's threshold state is DERIVED from the lane decision
 * plus one presence boolean, both of which `deployment` already carries, and the
 * panel already derives it there. A second derivation on this side would be two
 * implementations of one rule that can disagree — and the one that disagrees
 * silently is the server's, because the panel would still render its own. The
 * threshold is resolvable from what is already published; it is not republished.
 *
 * Note also that `deployment.internalGrpcSecretState` is NOT the threshold. It
 * is a PROVENANCE state (`supplied`, `persisted`, `minted-persisted`,
 * `minted-ephemeral`, `mint-failed`, `not-colocated`) and answers a different
 * question: where the secret came from, not whether it is long enough.
 */

/* -------------------------------------------------------------------------- */
/* The views this module serves                                               */
/* -------------------------------------------------------------------------- */

export type DatastoreDiagnosticsView = {
  connectionState: DatabaseConnectionState
  /** Whether every migration the auth build ships has been applied. Absent = unreadable. */
  migrationsApplied?: boolean
  /** How many migrations the live schema is behind. `0` means up to date. */
  pendingMigrations?: number
  /** Connections checked out of the pool right now. */
  poolInUse?: number
  /** The pool's configured maximum. */
  poolSize?: number
  /** A real read round trip, in whole bounded milliseconds. */
  readRoundTripMs?: number
  /** A real write round trip, in whole bounded milliseconds. */
  writeRoundTripMs?: number
  writeProbe: WriteProbeOutcome
}

export type RuntimeDiagnosticsView = {
  /** How long the GATEWAY process has been up, in whole seconds. */
  processUptimeSeconds: number
  authRuntimeProbe: AuthRuntimeProbeOutcome
  /** How long the AUTH process has been up. Differs from the gateway's when one half restarted alone. */
  authProcessUptimeSeconds?: number
  /** The EFFECTIVE `Secure` attribute on the session cookie. Not a presence boolean. */
  cookieSecure?: boolean
  /** The EFFECTIVE `Partitioned` attribute on the session cookie. Not a presence boolean. */
  cookiePartitioned?: boolean
  /** `E2E_TESTING === 'true'` in the auth process, which forces legacy header sessions. */
  e2eTesting?: boolean
}

export type QueueDiagnosticsView = {
  /** Absent when the gateway cannot see the other consumers. See the header. */
  separation?: QueueSeparation
  /**
   * How many QUEUE CONSUMERS this process group contains: this gateway, when a
   * queue is configured for it, plus one for each co-resident supervisord worker
   * program. A cardinality, never an address.
   *
   * ABSENT IS NOT ZERO, and that distinction is the reason the verdict above is
   * published beside this count rather than replaced by it. `1` means "this
   * process is the only consumer I can see"; nothing at all means the control
   * channel did not answer and the census was never taken. A client reading `1`
   * as "no collision" would be wrong on exactly the deployment where the workers
   * live in another container.
   *
   * It counts CO-RESIDENT consumers, not consumers proven to share one queue.
   * Proving the sharing would mean reading each sibling service's own
   * configuration off disk to compare queue URLs — a new filesystem reach into
   * other services' config, coupled to one image layout, pulling real queue URLs
   * into this process purely to compare them, and STILL blind to a consumer in
   * another container. The pair of presence booleans already published answers
   * the sharing question for the mechanism that actually caused the defect (a
   * bare variable inherited by every sibling), so the count supplies the other
   * half and `separation` combines them once, here, where they cannot drift.
   */
  consumerCount?: number
}

/* -------------------------------------------------------------------------- */
/* Admission                                                                  */
/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A member of a tuple this build declared, or `'other'`.
 *
 * The rejected value is never echoed, not even in part. A partially scrubbed
 * string is not safe; a constant is.
 */
const admitToken = <T extends string>(value: unknown, allowed: readonly T[]): T | 'other' =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : 'other'

/** A boolean, or `undefined` for anything else — including a string `'true'`. */
const admitBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

/**
 * A whole, non-negative count within a bound this build declared, or
 * `undefined`.
 *
 * `undefined` rather than `0` for a malformed figure, because a zero here would
 * be a MEASUREMENT: zero milliseconds is a plausible round trip and zero pending
 * migrations is a healthy schema. A figure that arrives malformed is a fact about
 * the producer, not a value to round down into a reassuring one.
 *
 * AND `undefined` RATHER THAN THE BOUND for a figure above it, which is the same
 * argument in the other direction. Clamping `1e12` pending migrations to `9999`
 * would put a number on an operator's screen that no process ever measured —
 * the bound is this build's statement about what a conforming producer can
 * report, so a figure outside it is malformed by that contract and is treated
 * exactly like a `NaN`. A conforming auth cannot exceed these bounds: its own
 * probes abandon at the round-trip ceiling.
 */
const admitCount = (value: unknown, max: number): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined
  }

  const whole = Math.floor(value)

  return whole > max ? undefined : whole
}

/* -------------------------------------------------------------------------- */
/* Reading the auth runtime body                                              */
/* -------------------------------------------------------------------------- */

export type AuthRuntimeReading = {
  authProcessUptimeSeconds?: number
  cookieSecure?: boolean
  cookiePartitioned?: boolean
  e2eTesting?: boolean
  datastore?: DatastoreDiagnosticsView
}

/**
 * Read the auth diagnostics body by allowlist.
 *
 * Returns `undefined` when the body is not a record at all, which the caller
 * reports as `unreadable` — an auth older than the route, or something else
 * answering on its port. A body that IS a record but carries nothing admissible
 * yields an empty reading rather than invented values, and every field the panel
 * then shows reads "not reported".
 *
 * NOTHING is copied through. Each field is reconstructed from an admitted value,
 * so a key this build has never heard of cannot reach a client by riding along
 * in an object spread — which is the mechanism a passthrough would leak by.
 */
export function readAuthRuntimeBody(body: unknown): AuthRuntimeReading | undefined {
  if (!isRecord(body)) {
    return undefined
  }

  const reading: AuthRuntimeReading = {}

  const uptime = admitCount(body.processUptimeSeconds, MAX_UPTIME_SECONDS)
  if (uptime !== undefined) {
    reading.authProcessUptimeSeconds = uptime
  }

  const session = isRecord(body.session) ? body.session : undefined
  if (session !== undefined) {
    const cookieSecure = admitBoolean(session.cookieSecure)
    if (cookieSecure !== undefined) {
      reading.cookieSecure = cookieSecure
    }
    const cookiePartitioned = admitBoolean(session.cookiePartitioned)
    if (cookiePartitioned !== undefined) {
      reading.cookiePartitioned = cookiePartitioned
    }
    const e2eTesting = admitBoolean(session.e2eTesting)
    if (e2eTesting !== undefined) {
      reading.e2eTesting = e2eTesting
    }
  }

  const datastore = isRecord(body.datastore) ? body.datastore : undefined
  if (datastore !== undefined) {
    const view: DatastoreDiagnosticsView = {
      connectionState: admitToken(datastore.connectionState, DATABASE_CONNECTION_STATES),
      writeProbe: admitToken(datastore.writeProbe, WRITE_PROBE_OUTCOMES),
    }

    const migrationsApplied = admitBoolean(datastore.migrationsApplied)
    if (migrationsApplied !== undefined) {
      view.migrationsApplied = migrationsApplied
    }
    const pendingMigrations = admitCount(datastore.pendingMigrations, MAX_REPORTED_MIGRATIONS)
    if (pendingMigrations !== undefined) {
      view.pendingMigrations = pendingMigrations
    }
    const poolInUse = admitCount(datastore.poolInUse, MAX_REPORTED_POOL)
    if (poolInUse !== undefined) {
      view.poolInUse = poolInUse
    }
    const poolSize = admitCount(datastore.poolSize, MAX_REPORTED_POOL)
    if (poolSize !== undefined) {
      view.poolSize = poolSize
    }
    const readRoundTripMs = admitCount(datastore.readRoundTripMs, MAX_ROUND_TRIP_MS)
    if (readRoundTripMs !== undefined) {
      view.readRoundTripMs = readRoundTripMs
    }
    const writeRoundTripMs = admitCount(datastore.writeRoundTripMs, MAX_ROUND_TRIP_MS)
    if (writeRoundTripMs !== undefined) {
      view.writeRoundTripMs = writeRoundTripMs
    }

    reading.datastore = view
  }

  return reading
}

/* -------------------------------------------------------------------------- */
/* Derivations                                                                */
/* -------------------------------------------------------------------------- */

/**
 * How many queue consumers this process group contains.
 *
 * This gateway counts as one when a queue is configured for it at all, plus one
 * for each co-resident supervisord WORKER program. Workers are read by SUFFIX
 * rather than against a hardcoded list of four names, so a worker added to
 * `supervisord.conf` and to the control allowlist is counted without this
 * function being edited.
 *
 * `undefined` when the control channel said nothing — an image whose supervisord
 * conf lacks the `[supervisorctl]` socket sections, a gateway started outside
 * supervisord, a spawn that failed. THAT IS NOT ZERO, and it is not `1` either:
 * the census was never taken, and the verdict below treats it as the absence of
 * evidence it is.
 *
 * A STOPPED or FATAL worker is still counted. The program is defined in this
 * deployment and will drain that queue the moment it comes back, so excluding it
 * would make the collision disappear from the screen for exactly as long as the
 * worker was down — which is when an operator is most likely to be reading.
 */
export function deriveQueueConsumerCount(input: {
  queueConfigured: boolean
  supervisord: { available: boolean; statuses: Record<string, string> }
}): number | undefined {
  if (!input.supervisord.available) {
    return undefined
  }

  const workers = Object.keys(input.supervisord.statuses).filter((program) => program.endsWith('-worker')).length

  return Math.min((input.queueConfigured ? 1 : 0) + workers, MAX_REPORTED_CONSUMERS)
}

/**
 * Which queue the halves of this deployment are pointed at.
 *
 * The one verdict presence cannot express. See the module header for why, and
 * for why an unclassifiable combination is OMITTED instead of guessed.
 */
export function deriveQueueSeparation(input: {
  ownPrefixedQueuePresent: boolean
  bareQueuePresent: boolean
  mode: DeploymentMode
  consumerCount: number | undefined
}): QueueSeparation | undefined {
  // The fix is in place: the gateway's dotenv is projected from its own
  // `API_GATEWAY_` prefix, so the queue it consumes is its own whatever the
  // siblings are pointed at.
  if (input.ownPrefixedQueuePresent) {
    return 'own-prefixed-queue'
  }

  if (input.bareQueuePresent) {
    // A bare queue AND a second co-resident consumer: both halves drain the same
    // queue, each message is delivered once, and the traffic is split rather than
    // seen by both. This is the measured defect, not a hypothesis.
    if (input.consumerCount !== undefined && input.consumerCount > 1) {
      return 'inherited-shared-queue'
    }

    // A bare queue and no second consumer to compare against — or no census at
    // all. A second consumer could still exist in another container, and this
    // process cannot see it, so no verdict rather than a reassuring one.
    return undefined
  }

  // No queue at all. On the bundled single process the fan-out is a function
  // call into the same registry, which is correct rather than missing; on a
  // deployment that expects a queue, its absence is the finding.
  if (input.mode === 'home-server') {
    return 'in-process-fan-out'
  }
  if (input.mode === 'self-hosted') {
    return 'none'
  }

  // An unrecognised or unset MODE says nothing about whether a queue was
  // expected, so neither answer is established.
  return undefined
}
