import { Container } from 'inversify'
import { DataSource, Repository } from 'typeorm'

import TYPES from '../../Bootstrap/Types'
import { CookieFactoryInterface } from '../../Domain/Auth/Cookies/CookieFactoryInterface'
import {
  AuthRuntimeDiagnosticsReport,
  DB_PROBE_TIMEOUT_MS,
  observeAuthRuntime,
} from '../../Domain/Diagnostics/AuthRuntimeDiagnostics'
import { InviteEventOutboxDispatcher } from '../../Domain/Invite/InviteEventOutboxDispatcher'
import { InviteEventOutboxRepositoryInterface } from '../../Domain/Invite/InviteEventOutboxRepositoryInterface'
import { createTypeORMDatastoreProbe } from '../TypeORM/TypeORMDatastoreProbe'
import { TypeORMInviteEventOutbox } from '../TypeORM/TypeORMInviteEventOutbox'
import { createTypeORMOutboxProbe } from '../TypeORM/TypeORMOutboxProbe'

/**
 * Standard Red Notes: ONE implementation of the `/healthcheck/diagnostics`
 * answer, with two entry points.
 *
 * WHY THIS MODULE EXISTS. The report is composed from four decisions that are
 * easy to get subtly different in a second copy — the shared answer window, the
 * "omit the queue block rather than report zero rows" arm, the cookie-factory
 * fallback, and the probe timeout. The annotated controller reaches it over HTTP
 * on auth's own internal port (the multi-container shape); the bundled
 * home-server reaches it through a loopback-only internal listener, because on
 * that topology auth has no HTTP port of its own and its annotated controllers
 * are deliberately never mounted — they declare UNPREFIXED bases such as
 * `/auth`, `/sessions` and `/internal`, which on a single shared port would
 * publish auth's internal surface at the public front door.
 *
 * Two copies of this composition is how one gets fixed and its twin does not,
 * which is why it is a module and not a method on the controller.
 */

/**
 * Standard Red Notes: how long a `/healthcheck/diagnostics` answer may be
 * re-served before the probes run again.
 *
 * The route performs real database work — a read, a zero-row write and a
 * migration read — and it is reachable by anything that can reach this service
 * on the internal network. A short shared answer bounds that to one probe set
 * per window however often it is asked, and costs the pane nothing: the admin
 * screen reads it once per load, and the facts it carries (a schema's migration
 * state, a pool census) do not change between two clicks.
 *
 * Module-level rather than per-instance because inversify-express-utils builds a
 * fresh controller per request, so instance state would never be reused — and
 * because the two entry points must share one window rather than hold one each.
 */
export const DIAGNOSTICS_CACHE_TTL_MS = 5_000

/**
 * The bindings the report is composed from.
 *
 * Every field but the data source is OPTIONAL, mirroring the controller's
 * `@optional()` injections: a container that predates one of them still answers
 * the route, and an absent outbox omits the census rather than reporting it as
 * zero rows.
 */
export type AuthRuntimeDiagnosticsSources = {
  /** The auth-owned `DataSource`. The read, write and migration probes run through it. */
  dataSource: DataSource
  /** The REAL session-cookie factory, asked for the effective attributes. */
  cookieFactory?: CookieFactoryInterface
  /** `E2E_TESTING === 'true'`, as this process resolved it. Never re-derived here. */
  forceLegacySessions?: boolean
  /** Counts the terminal rows. Absent omits the whole queue block. */
  outboxEntityRepository?: Repository<TypeORMInviteEventOutbox>
  /** Asked only whether it implements the requeue transition. */
  outboxRepository?: InviteEventOutboxRepositoryInterface
  /** Asked only whether a drain loop is armed. */
  outboxDispatcher?: InviteEventOutboxDispatcher
}

let cachedDiagnostics: { at: number; report: AuthRuntimeDiagnosticsReport } | undefined

/** Test seam: drop the shared answer so a spec can observe a fresh probe. */
export const clearAuthRuntimeDiagnosticsCache = (): void => {
  cachedDiagnostics = undefined
}

/**
 * Compose the report, re-serving the shared answer inside the cache window.
 *
 * *** WHAT CAN COME OUT OF HERE ***
 * Booleans, members of closed unions, bounded counts and bounded whole-
 * millisecond durations — see `AuthRuntimeDiagnostics`, whose report type
 * contains no `string` field at all. No probe failure detail is read, so there
 * is no field for the host, port or database name a driver error carries. The
 * gateway re-reads this body BY ALLOWLIST before serving it to an admin, so
 * even a newer or misbehaving auth cannot push free-form text to a client.
 */
export async function resolveAuthRuntimeDiagnosticsReport(
  sources: AuthRuntimeDiagnosticsSources,
  now: number = Date.now(),
): Promise<AuthRuntimeDiagnosticsReport> {
  if (cachedDiagnostics !== undefined && now - cachedDiagnostics.at < DIAGNOSTICS_CACHE_TTL_MS) {
    return cachedDiagnostics.report
  }

  const report = await observeAuthRuntime({
    uptimeSeconds: process.uptime(),
    // A container that predates the cookie binding reports both attributes OFF
    // rather than failing the route; the gateway's reader carries the
    // distinction no further, because the attributes default to ON when the
    // variables are unset and a fabricated reading here would invert the
    // diagnosis. An absent factory is impossible on a booted auth server —
    // `Auth_CookieFactory` is bound unconditionally — so this arm exists only
    // for construction without a container.
    cookies: sources.cookieFactory ?? { createCookieHeaderValue: (): string[] => [] },
    e2eTesting: sources.forceLegacySessions === true,
    datastore: createTypeORMDatastoreProbe(sources.dataSource),
    // Absent when no outbox entity repository is bound, which omits the queue
    // block entirely. A zero-row census over a store this process cannot count
    // would read as an empty outbox, and an empty outbox is the healthy answer
    // an operator stops looking at.
    ...(sources.outboxEntityRepository === undefined
      ? {}
      : {
          outbox: createTypeORMOutboxProbe(
            sources.outboxEntityRepository,
            sources.outboxRepository,
            sources.outboxDispatcher,
          ),
        }),
    timeoutMs: DB_PROBE_TIMEOUT_MS,
  })

  cachedDiagnostics = { at: now, report }

  return report
}

/**
 * The narrow view of an inversify container this module needs.
 *
 * Structural rather than the class so the home-server composition can hand over
 * the shared container it already holds without this module reaching for
 * anything but these two methods, and so a spec needs no container at all.
 */
export type AuthDiagnosticsBindings = Pick<Container, 'isBound' | 'get'>

/**
 * Read the sources off a loaded auth container.
 *
 * `undefined` when the auth half of the container is not present at all.
 * `Auth_ORMRoleRepository` is the binding every auth container has and the one
 * the data source is reached through, so its absence means there is nothing to
 * report — and the caller must then NOT mount a route, rather than mount one
 * that answers with a fabricated reading.
 *
 * Every optional binding is read behind `isBound`, so a container built by an
 * older auth answers with the blocks it can and omits the rest.
 */
export function readAuthRuntimeDiagnosticsSources(
  container: AuthDiagnosticsBindings,
): AuthRuntimeDiagnosticsSources | undefined {
  if (!container.isBound(TYPES.Auth_ORMRoleRepository)) {
    return undefined
  }

  const roleRepository = container.get<{ manager?: { connection?: DataSource } }>(TYPES.Auth_ORMRoleRepository)
  const dataSource = roleRepository?.manager?.connection
  if (dataSource === undefined) {
    return undefined
  }

  const optional = <T>(identifier: symbol): T | undefined =>
    container.isBound(identifier) ? container.get<T>(identifier) : undefined

  return {
    dataSource,
    cookieFactory: optional<CookieFactoryInterface>(TYPES.Auth_CookieFactory),
    forceLegacySessions: optional<boolean>(TYPES.Auth_FORCE_LEGACY_SESSIONS),
    outboxEntityRepository: optional<Repository<TypeORMInviteEventOutbox>>(TYPES.Auth_ORMInviteEventOutboxRepository),
    outboxRepository: optional<InviteEventOutboxRepositoryInterface>(TYPES.Auth_InviteEventOutboxRepository),
    outboxDispatcher: optional<InviteEventOutboxDispatcher>(TYPES.Auth_InviteEventOutboxDispatcher),
  }
}
