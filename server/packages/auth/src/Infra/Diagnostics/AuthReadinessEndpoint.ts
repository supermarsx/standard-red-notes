import { Container } from 'inversify'

import TYPES from '../../Bootstrap/Types'

/**
 * Standard Red Notes: ONE implementation of the `/healthcheck/readiness`
 * answer, with two entry points.
 *
 * WHY THIS MODULE EXISTS. Follow-up to the same split that moved the
 * `/healthcheck/diagnostics` composition out of the annotated controller
 * (`AuthRuntimeDiagnosticsEndpoint`). The bundled home-server has no auth HTTP
 * port at all, so the gateway's `probeAuthReadiness()` — which dials
 * `${SERVICE_PROBE_URLS.auth}/healthcheck/readiness` and accepts nothing but a
 * 200 or a 503 carrying `{ status, checks }` — got no answer on the topology
 * most self-hosters deploy, and the admin pane's auth rows read unreachable
 * while auth was running in the very same process.
 *
 * Mounting auth's annotated controller is not the fix and never was: its
 * controllers declare UNPREFIXED bases (`/auth`, `/sessions`, `/users`,
 * `/internal`) on the assumption that a gateway sits in front of them, and the
 * single container shares one Express app on one port whose front-door nginx
 * proxies `^/(v1|v2|auth|subscription|healthcheck)(/|$)` straight through. So
 * the home-server serves this route from a loopback-only internal listener, out
 * of this module — the same module the annotated controller delegates to.
 *
 * Two copies of this composition is how one gets fixed and its twin does not,
 * which is why it is a module and not a method on the controller. The
 * particular things a second copy would get wrong:
 *
 *   - `redis: true` when NO cache is bound. `CACHE_TYPE=memory` (the
 *     self-hosted default) binds no `Auth_Redis` at all, and a second copy that
 *     reported `false` for "nothing to ping" would hold every such deployment
 *     permanently un-ready.
 *   - the key ORDER of `checks`, which is what a multi-container/single-
 *     container body diff is read on.
 *   - the per-probe timeout, and clearing its timer.
 *   - which statuses mean ready: `'ready'` -> 200, anything else -> 503.
 */

/**
 * How long each readiness probe may take.
 *
 * Deliberately NOT shared with the diagnostics route's `DB_PROBE_TIMEOUT_MS`,
 * which happens to hold the same number today: readiness is polled by the
 * orchestrator every few seconds and its budget is an availability decision,
 * while the diagnostics budget bounds a heavier one-off report. Coupling them
 * would mean a change to either silently retunes the other.
 */
export const READINESS_PROBE_TIMEOUT_MS = 2_000

/**
 * The two hard dependencies, in the order they are serialized.
 *
 * `db` is a real `SELECT 1` over the connection this service holds. `redis` is
 * a PING when a cache is bound and `true` when none is — see above.
 */
export type AuthReadinessChecks = {
  db: boolean
  redis: boolean
}

/**
 * The readiness body, byte-for-byte what the annotated route has always
 * answered. Closed unions and booleans only: nothing read off a probe
 * rejection, because that is exactly where a driver puts a host, a port and a
 * database name.
 */
export type AuthReadinessReport = {
  status: 'ready' | 'unavailable'
  checks: AuthReadinessChecks
}

/** What the report is composed from. */
export type AuthReadinessSources = {
  /**
   * The auth-owned entity manager. `SELECT 1` runs through it as a METHOD call
   * so TypeORM keeps its receiver — an extracted-and-called `query` reference
   * throws on `this`, which this probe would then report as a database that is
   * not answering.
   */
  database: { query(sql: string): Promise<unknown> }
  /**
   * The cache, when one is bound. ABSENT is not a failure: `CACHE_TYPE=memory`
   * binds no `Auth_Redis`, and there is then nothing whose health could be in
   * question.
   */
  redis?: { ping(): Promise<string> }
}

/**
 * Race a probe against a deadline, always clearing the timer.
 *
 * A rejection and a timeout are the same outcome to the caller — the dependency
 * did not answer inside the budget — so the two are not distinguished here.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('readiness check timed out')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/**
 * The HTTP status a readiness report answers with.
 *
 * One function rather than a `healthy &&` expression per entry point: 503 is
 * how an orchestrator is told to stop routing here, and an entry point that
 * answered 200 over a failing check would keep a broken instance in rotation.
 */
export function authReadinessStatusCode(report: AuthReadinessReport): 200 | 503 {
  return report.status === 'ready' ? 200 : 503
}

/**
 * The report to answer with when the composition could not run AT ALL.
 *
 * `resolveAuthReadinessReport` catches each probe on its own and so cannot
 * reject, but the entry point that serves it must still have an answer that
 * requires none of the code that just failed — and that answer has to be IN
 * THIS VOCABULARY. The gateway's readiness probe accepts a 503 and then reads
 * `status` and `checks` out of the body; handed a generic `{ error: { message } }`
 * it comes away with `status: undefined` and `checks: {}`, which
 * `authServiceEntry` scores as a healthy `'ok'` auth. So a failure here reports
 * every check FALSE rather than reporting nothing.
 *
 * A factory, not a shared constant: a caller cannot mutate the next failure's
 * answer, and a mutation to the literal is observable by a test.
 */
export function authReadinessUnavailableReport(): AuthReadinessReport {
  return { status: 'unavailable', checks: { db: false, redis: false } }
}

/**
 * Compose the readiness answer.
 *
 * NOT CACHED, deliberately, unlike the diagnostics report's shared 5s answer
 * window. Readiness is the deployment acceptance signal: an orchestrator
 * polling it is asking about NOW, and a re-served answer would report a
 * dependency that has just gone as still up (and, worse, one that has just come
 * back as still down). The work is bounded and cheap — one `SELECT 1` and one
 * PING — which is why the heavier diagnostics route exists separately.
 *
 * Never throws and never rejects: each probe is caught on its own, so one dead
 * dependency still reports the other's state rather than collapsing the route.
 */
export async function resolveAuthReadinessReport(
  sources: AuthReadinessSources,
  timeoutMs: number = READINESS_PROBE_TIMEOUT_MS,
): Promise<AuthReadinessReport> {
  const checks: AuthReadinessChecks = { db: false, redis: false }

  try {
    await withTimeout(sources.database.query('SELECT 1'), timeoutMs)
    checks.db = true
  } catch {
    checks.db = false
  }

  if (sources.redis) {
    try {
      await withTimeout(sources.redis.ping(), timeoutMs)
      checks.redis = true
    } catch {
      checks.redis = false
    }
  } else {
    // No cache is bound, so there is nothing that could be unhealthy. Reporting
    // `false` here would hold every `CACHE_TYPE=memory` deployment — the
    // self-hosted default — permanently un-ready.
    checks.redis = true
  }

  return { status: checks.db && checks.redis ? 'ready' : 'unavailable', checks }
}

/**
 * The narrow view of an inversify container this module needs.
 *
 * Structural rather than the class so the home-server composition can hand over
 * the shared container it already holds, and so a spec needs no container at
 * all.
 */
export type AuthReadinessBindings = Pick<Container, 'isBound' | 'get'>

/**
 * Read the readiness sources off a loaded auth container.
 *
 * `undefined` when the auth half of the container is not present, or when the
 * binding it is reached through carries no usable manager. The caller must then
 * NOT serve the route: an endpoint that answered without a database handle
 * would report `db: false` — "the database is down" — over a container that
 * simply has no auth in it, which is a different and far more alarming fact.
 *
 * `Auth_ORMRoleRepository` is the binding every auth container has and the one
 * the annotated controller reads the manager off, so the two entry points probe
 * the same connection. The cache is read behind `isBound` because
 * `CACHE_TYPE=memory` binds none.
 */
export function readAuthReadinessSources(container: AuthReadinessBindings): AuthReadinessSources | undefined {
  if (!container.isBound(TYPES.Auth_ORMRoleRepository)) {
    return undefined
  }

  const roleRepository = container.get<{ manager?: { query?: unknown } }>(TYPES.Auth_ORMRoleRepository)
  const manager = roleRepository?.manager
  if (manager === undefined || typeof manager.query !== 'function') {
    return undefined
  }

  return {
    database: manager as AuthReadinessSources['database'],
    redis: container.isBound(TYPES.Auth_Redis)
      ? container.get<AuthReadinessSources['redis']>(TYPES.Auth_Redis)
      : undefined,
  }
}
