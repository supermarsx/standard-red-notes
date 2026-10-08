/**
 * Standard Red Notes: the facts about the AUTH process that the admin
 * Diagnostics pane needs and that nothing could answer.
 *
 * WHY THIS LIVES IN AUTH AND NOT IN THE GATEWAY.
 *
 * Three of these facts are structurally unavailable anywhere else:
 *
 *   - The effective session-cookie attributes. `COOKIE_SECURE` and
 *     `COOKIE_PARTITIONED` are read by THIS process (`Bootstrap/Container.ts`,
 *     the `CookieFactory` construction) and BOTH DEFAULT TO TRUE when unset, so
 *     "the variable is not set" and "the attribute is off" are OPPOSITE answers
 *     and a presence boolean would invert the diagnosis. They are not
 *     browser-observable either: the session cookie is `HttpOnly`, so it is not
 *     script-readable, and a cookie's attributes are never exposed to a page
 *     even when the cookie is.
 *   - `E2E_TESTING`, which binds `FORCE_LEGACY_SESSIONS` here and forces legacy
 *     HEADER sessions for every user on the deployment. A deployment running
 *     with it on is in a mode where cookie-session faults cannot occur.
 *   - The durable store. The gateway holds NO database handle at all; auth owns
 *     one. A readiness probe reports that the SERVICE answers, and a service
 *     whose `DataSource` is a handle with no live connection answers perfectly.
 *
 * *** SECURITY BOUNDARY ***
 * Every field is a boolean, a member of a closed union, a bounded count, or a
 * bounded whole-millisecond duration. There is no `string` field in this
 * module's report type, and nothing here can carry a host, a port, a database
 * name, a schema name, a connection string, a migration name or a credential:
 *
 *   - the cookie attributes are read as two BOOLEANS off the real header the
 *     factory produces, and the header itself (which contains tokens) is
 *     discarded in the same expression;
 *   - the migration state is a COUNT and a boolean. Migration names are loaded
 *     in order to be counted and never leave this function;
 *   - a probe failure is reduced to a closed union member. The rejection value
 *     is not read, not logged into the report and not forwarded — a probe
 *     failure is exactly where a driver puts a host and a port.
 *
 * Do not add a `string` field here. Add a literal-union member instead.
 */

/** How long a single database probe may take before it is abandoned. */
export const DB_PROBE_TIMEOUT_MS = 2_000

/**
 * The ceiling on a reported round trip. Equal to the probe timeout, because a
 * probe that outlives it is abandoned and reports no figure at all — so a value
 * above the ceiling is impossible rather than merely unexpected, and clamping is
 * what makes the field a BOUNDED duration rather than an arbitrary number off a
 * clock.
 */
export const MAX_REPORTED_ROUND_TRIP_MS = DB_PROBE_TIMEOUT_MS

/** Bounds on the census figures, so none of them can report an unbounded number. */
export const MAX_REPORTED_MIGRATIONS = 9_999
export const MAX_REPORTED_POOL = 9_999

/**
 * The ceiling on the dead-outbox census.
 *
 * A million terminal rows is not a backlog an operator reads a figure for, it is
 * an incident; the bound is what makes the field a BOUNDED count rather than
 * `SELECT COUNT(*)` straight onto a screen, and a store that somehow holds more
 * reports the ceiling rather than an unbounded number.
 */
export const MAX_REPORTED_DEAD_LETTER_ROWS = 1_000_000

/**
 * The states a durable service's `DataSource` handle can be in.
 *
 * `handle-only` is the one that matters and the one no readiness probe can see:
 * an initialized `DataSource` whose queries do not complete. The service answers
 * HTTP, its process is live, and every route that touches the database fails.
 */
export type DatabaseConnectionState = 'connected' | 'handle-only' | 'disconnected'

/**
 * What the WRITE probe established, as a closed union.
 *
 * Stated honestly, because the row it feeds must not overclaim. The probe is a
 * zero-row DML (`UPDATE … WHERE 1 = 0`) against an auth-owned table, issued
 * through the service's own pool. It therefore exercises:
 *
 *   - statement ADMISSION — a read-only server or replica, a revoked `UPDATE`
 *     grant, a missing table — which is the case a `SELECT 1` passes and a real
 *     write fails, and the one an operator cannot otherwise see;
 *   - a full round trip through the same pool a real write uses.
 *
 * It does NOT exercise lock contention or disk pressure: zero matched rows take
 * no row locks and write no undo. `accepted` is therefore necessary and not
 * sufficient, and that is said rather than being hidden behind a figure that
 * implies more than was measured.
 */
export type WriteProbeOutcome = 'accepted' | 'refused' | 'timed-out' | 'not-attempted'

export type AuthRuntimeDatastoreReport = {
  connectionState: DatabaseConnectionState
  /** Whether every migration this build ships has been applied. Absent = unreadable. */
  migrationsApplied?: boolean
  /** How many migrations the live schema is behind. `0` means up to date. */
  pendingMigrations?: number
  /** Connections checked out of the pool right now. Absent where the driver has no pool. */
  poolInUse?: number
  /** The pool's configured maximum. Absent where the driver has no pool. */
  poolSize?: number
  /** A real read round trip, in whole bounded milliseconds. */
  readRoundTripMs?: number
  /** A real write round trip, in whole bounded milliseconds. */
  writeRoundTripMs?: number
  writeProbe: WriteProbeOutcome
}

export type AuthRuntimeSessionReport = {
  /** The EFFECTIVE `Secure` attribute, read off the real cookie header. */
  cookieSecure: boolean
  /** The EFFECTIVE `Partitioned` attribute, read off the real cookie header. */
  cookiePartitioned: boolean
  /** `E2E_TESTING === 'true'`, i.e. the bound `FORCE_LEGACY_SESSIONS`. */
  e2eTesting: boolean
}

/**
 * Standard Red Notes: the DEAD-OUTBOX census, for the pane's one remaining row
 * with no producer anywhere in the tree.
 *
 * WHAT A DEAD ROW IS. The invite-event outbox moves a record to a TERMINAL state
 * when its delivery attempts are exhausted. A terminal row is never claimed
 * again: the dispatcher's claim predicate matches only pending and
 * stale-dispatching rows, so the event it carries — a realtime invalidation some
 * client is waiting for — is not retried by anything and the row sits there
 * until retention cleanup removes it. Nothing logs a second time, no endpoint
 * reports it, and the pane states in its own report that no count exists.
 *
 * WHY IT LIVES HERE. The same reason the datastore block does: the gateway holds
 * no database handle, and this is a row count in a table this service owns.
 *
 * SECRECY. A count and a boolean. No row identifier, no event identifier, no
 * affected user, no error code and no timestamp — a dead row's `last_error_code`
 * is free-form-adjacent server text and its payload names users, so neither has
 * a field here to travel in.
 */
export type AuthRuntimeQueueReport = {
  /**
   * How many rows are in the terminal state, bounded. `0` is a real and healthy
   * reading. The whole block is OMITTED when the count could not be taken, so an
   * uncountable store never reads as an empty one.
   */
  deadLetterRows: number
  /**
   * Whether a counted row can be put back on the queue by this deployment: the
   * store implements the requeue transition AND a drain loop for that outbox is
   * armed in this process group.
   *
   * BOTH HALVES MATTER and neither is sufficient. A store with no requeue
   * transition holds rows that are lost for good — the remedy is to re-trigger
   * whatever produced the event, not to retry it. A store that HAS the
   * transition but whose dispatcher is not running holds rows a requeue would
   * move back to pending and nothing would then pick up, which looks like a fix
   * and is not one. `false` is therefore the signal that the count beside it is
   * a backlog nobody is going to drain.
   */
  deadLetterRequeueable: boolean
}

export type AuthRuntimeDiagnosticsReport = {
  /** How long THIS process has been up, in whole seconds. A duration, never an instant. */
  processUptimeSeconds: number
  session: AuthRuntimeSessionReport
  datastore: AuthRuntimeDatastoreReport
  /**
   * Absent when the census could not be taken: no outbox probe bound, a store
   * that is not answering, or a count that failed (the un-migrated worker, whose
   * table does not exist yet). ABSENT IS NOT ZERO — zero dead rows is the
   * healthy reading an operator acts on.
   */
  queue?: AuthRuntimeQueueReport
}

/**
 * The database seam.
 *
 * A narrow structural type rather than a `DataSource`, so the report is unit
 * testable without a database and so nothing in this module can reach a
 * connection option. Every method either resolves with a figure or REJECTS; no
 * method returns an error, because an error is the one value here that could
 * carry an address.
 */
export type DatastoreProbe = {
  /** `DataSource.isInitialized`. */
  initialized: boolean
  /** A read that must round-trip to the server. */
  read(): Promise<void>
  /** A zero-row DML that must be admitted and must round-trip. */
  write(): Promise<void>
  /** How many migrations the live schema is behind. */
  pendingMigrations(): Promise<number>
  /** Pool census, or `undefined` where the driver keeps no pool (SQLite). */
  pool(): { inUse: number; size: number } | undefined
}

/**
 * The outbox seam.
 *
 * A narrow structural type for the same reason `DatastoreProbe` is one: nothing
 * in this module can then reach a connection option, a table name or a row. The
 * count either resolves or REJECTS, and the rejection is never inspected.
 */
export type OutboxProbe = {
  /**
   * How many rows are in the terminal state. Rejects when the count cannot be
   * taken — a table that does not exist on a worker that has not migrated, a
   * statement the store refused.
   */
  deadRows(): Promise<number>
  /**
   * Whether this store implements the requeue transition for a terminal row.
   * A property of the build, read from the repository rather than assumed.
   */
  requeueTransitionAvailable: boolean
  /**
   * Whether a drain loop for this outbox is armed in this process group, so a
   * requeued row would actually be picked up. Read live: a dispatcher that has
   * been stopped for shutdown is not armed, and a container started for CLI work
   * never arms one.
   */
  drainArmed(): boolean
}

/**
 * The real cookie header this process would set, so the attributes reported are
 * the ones a browser would actually receive.
 *
 * Reading the two environment variables again here is the obvious alternative
 * and it is the wrong one: it is a SECOND resolution of a default-true setting,
 * and the pane would then report what a reader of the environment believes
 * rather than what the factory does. The factory is asked instead, with constant
 * inputs, and only two booleans survive the call.
 */
export type CookieHeaderSource = {
  createCookieHeaderValue(dto: {
    sessionUuid: string
    accessToken: string
    refreshToken: string
    refreshTokenExpiration: Date
  }): string[]
}

/** Constant, non-secret inputs for the attribute read. Never emitted. */
const PROBE_COOKIE_INPUT = {
  sessionUuid: 'diagnostics-probe',
  accessToken: 'diagnostics-probe',
  refreshToken: 'diagnostics-probe',
  refreshTokenExpiration: new Date(0),
}

/**
 * Whether an attribute is present on a `Set-Cookie` value, matched as a WHOLE
 * attribute between delimiters so a token's CONTENT can never satisfy it. A bare
 * `includes('Secure')` would be satisfied by an access token that happened to
 * contain those six characters, which is how an attribute row comes to lie.
 */
const hasCookieAttribute = (headerValues: readonly string[], attribute: string): boolean => {
  const pattern = new RegExp('(?:^|;)\\s*' + attribute + '\\s*(?:;|$)')

  return headerValues.some((value) => pattern.test(value))
}

export function readCookieAttributes(source: CookieHeaderSource): {
  cookieSecure: boolean
  cookiePartitioned: boolean
} {
  const headerValues = source.createCookieHeaderValue({ ...PROBE_COOKIE_INPUT })

  return {
    cookieSecure: hasCookieAttribute(headerValues, 'Secure'),
    cookiePartitioned: hasCookieAttribute(headerValues, 'Partitioned'),
  }
}

/** A whole, non-negative integer clamped to `max`, or `undefined`. */
const boundedCount = (value: number, max: number): number | undefined => {
  if (!Number.isFinite(value) || value < 0) {
    return undefined
  }

  return Math.min(Math.floor(value), max)
}

type Clock = () => number

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('probe timed out')), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

/**
 * Time a probe, reporting only an outcome token and a bounded whole-millisecond
 * duration. The rejection value is NEVER inspected: a driver error message is
 * where a host, a port and a database name live.
 */
async function timeProbe(
  run: () => Promise<void>,
  timeoutMs: number,
  now: Clock,
): Promise<{ outcome: 'ok' | 'failed' | 'timed-out'; elapsedMs: number }> {
  const started = now()
  try {
    await withTimeout(run(), timeoutMs)
  } catch {
    // Deliberately blind: the only things read off a failed probe are that it
    // failed and whether the clock had already passed the deadline.
    const elapsedMs = Math.max(0, now() - started)

    return { outcome: elapsedMs >= timeoutMs ? 'timed-out' : 'failed', elapsedMs }
  }

  return { outcome: 'ok', elapsedMs: Math.max(0, now() - started) }
}

export async function observeDatastore(
  probe: DatastoreProbe,
  options: { timeoutMs?: number; now?: Clock } = {},
): Promise<AuthRuntimeDatastoreReport> {
  const timeoutMs = options.timeoutMs ?? DB_PROBE_TIMEOUT_MS
  const now = options.now ?? Date.now

  if (!probe.initialized) {
    // No live handle at all: nothing is probed, because a probe through an
    // uninitialized DataSource is a different failure from a sick connection and
    // reporting it as one is how `handle-only` loses its meaning.
    return { connectionState: 'disconnected', writeProbe: 'not-attempted' }
  }

  const read = await timeProbe(() => probe.read(), timeoutMs, now)
  if (read.outcome !== 'ok') {
    // The handle exists and the store does not answer. THE defect no readiness
    // probe can see. Nothing further is attempted: a write probe and a migration
    // read against a store that just failed a `SELECT 1` add no information and
    // two more timeouts to the admin request.
    return { connectionState: 'handle-only', writeProbe: 'not-attempted' }
  }

  const report: AuthRuntimeDatastoreReport = {
    connectionState: 'connected',
    writeProbe: 'not-attempted',
  }
  const readRoundTripMs = boundedCount(read.elapsedMs, MAX_REPORTED_ROUND_TRIP_MS)
  if (readRoundTripMs !== undefined) {
    report.readRoundTripMs = readRoundTripMs
  }

  const write = await timeProbe(() => probe.write(), timeoutMs, now)
  report.writeProbe = write.outcome === 'ok' ? 'accepted' : write.outcome === 'timed-out' ? 'timed-out' : 'refused'
  if (write.outcome === 'ok') {
    const writeRoundTripMs = boundedCount(write.elapsedMs, MAX_REPORTED_ROUND_TRIP_MS)
    if (writeRoundTripMs !== undefined) {
      report.writeRoundTripMs = writeRoundTripMs
    }
  }

  try {
    const pending = boundedCount(await withTimeout(probe.pendingMigrations(), timeoutMs), MAX_REPORTED_MIGRATIONS)
    if (pending !== undefined) {
      report.pendingMigrations = pending
      report.migrationsApplied = pending === 0
    }
  } catch {
    // Unreadable: BOTH fields stay absent rather than defaulting to applied.
    // `migrationsApplied: true` over an unread schema is the flattering reading
    // this whole module exists to refuse.
  }

  let census: { inUse: number; size: number } | undefined
  try {
    census = probe.pool()
  } catch {
    census = undefined
  }
  if (census !== undefined) {
    const inUse = boundedCount(census.inUse, MAX_REPORTED_POOL)
    const size = boundedCount(census.size, MAX_REPORTED_POOL)
    if (inUse !== undefined) {
      report.poolInUse = inUse
    }
    if (size !== undefined) {
      report.poolSize = size
    }
  }

  return report
}

/**
 * Take the dead-outbox census, or report nothing.
 *
 * `undefined` for every arm that did not produce a figure, which is the whole
 * discipline this block needs: a count nobody took must not reach a screen as
 * `0`, because `0` is the healthy reading and the one an operator stops looking
 * at. A malformed figure is treated the same way — not clamped into a plausible
 * backlog no process counted.
 *
 * The rejection is never inspected. A store refusing a `COUNT(*)` reports its
 * table, its schema and sometimes its host in the error.
 */
export async function observeOutbox(
  probe: OutboxProbe,
  options: { timeoutMs?: number; now?: Clock } = {},
): Promise<AuthRuntimeQueueReport | undefined> {
  const timeoutMs = options.timeoutMs ?? DB_PROBE_TIMEOUT_MS

  let counted: number
  try {
    counted = await withTimeout(probe.deadRows(), timeoutMs)
  } catch {
    return undefined
  }

  const deadLetterRows = boundedCount(counted, MAX_REPORTED_DEAD_LETTER_ROWS)
  if (deadLetterRows === undefined) {
    return undefined
  }

  let drainArmed = false
  try {
    drainArmed = probe.drainArmed()
  } catch {
    // A dispatcher that cannot answer is not an armed one. The count still
    // stands; what is unknown is whether anything would drain a requeue.
    drainArmed = false
  }

  return {
    deadLetterRows,
    deadLetterRequeueable: probe.requeueTransitionAvailable && drainArmed,
  }
}

export async function observeAuthRuntime(input: {
  uptimeSeconds: number
  cookies: CookieHeaderSource
  e2eTesting: boolean
  datastore: DatastoreProbe
  /** Absent on a container with no outbox bound; the queue block is then omitted. */
  outbox?: OutboxProbe
  timeoutMs?: number
  now?: Clock
}): Promise<AuthRuntimeDiagnosticsReport> {
  const { cookieSecure, cookiePartitioned } = readCookieAttributes(input.cookies)
  const datastore = await observeDatastore(input.datastore, { timeoutMs: input.timeoutMs, now: input.now })

  const report: AuthRuntimeDiagnosticsReport = {
    processUptimeSeconds: boundedCount(input.uptimeSeconds, Number.MAX_SAFE_INTEGER) ?? 0,
    session: { cookieSecure, cookiePartitioned, e2eTesting: input.e2eTesting },
    datastore,
  }

  // NOT ATTEMPTED over a store that just failed its read probe, for the reason
  // the datastore block stops there itself: a count against a store that did not
  // answer a `SELECT 1` adds no information and one more timeout to an admin
  // request. The block is then absent, which is the honest reading.
  if (input.outbox !== undefined && datastore.connectionState === 'connected') {
    const queue = await observeOutbox(input.outbox, { timeoutMs: input.timeoutMs, now: input.now })
    if (queue !== undefined) {
      report.queue = queue
    }
  }

  return report
}
