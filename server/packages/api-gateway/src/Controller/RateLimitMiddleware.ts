import { createHash } from 'node:crypto'
import { NextFunction, Request, Response } from 'express'

import { IpAclDecision } from './IpAccessList'
import { resolveClientIpFromRequest } from './ClientIp'
import { safeErrorLogMetadata } from '../Service/Logging/SafeLog'

/**
 * Redis-backed IP rate limiting for the UNAUTHENTICATED, auth-adjacent gateway
 * endpoints (login, registration, MCP-token authenticate, magic-link request,
 * recovery). These are the brute-force / abuse surfaces that have no session in
 * front of them; the authenticated sync/proxy paths are deliberately NOT limited
 * here (an expensive AUTHENTICATED endpoint can opt into a per-USER tier via
 * createUserRateLimitMiddleware below).
 *
 * Implementation is a minimal fixed-window counter (INCR + EXPIRE) rather than a
 * new dependency, reusing the gateway's existing ioredis client. Keyed by client
 * IP (req.ip, which already honors the configured TRUST_PROXY so a proxied
 * deployment sees the real client, and a direct client cannot spoof
 * X-Forwarded-For).
 *
 * CONFIG: the tiers (window / max / enabled) are resolved PER REQUEST from a
 * provider (the ServerSettings overlay: admin value wins over env wins over the
 * safe defaults that reproduce the historical hardcoded behavior). A static
 * config object is still accepted for tests / callers that do not need the
 * overlay.
 *
 * IP LISTS: an optional admin-managed allow/block list is enforced BEFORE the
 * tiers — a blocklisted IP is rejected (403), an allowlisted IP bypasses the
 * tiers. See IpAccessList.
 *
 * HEADERS: a throttled (429) response carries Retry-After plus the standard
 * X-RateLimit-Limit / -Remaining / -Reset; allowed limited responses carry
 * Limit / Remaining. No per-user data is leaked to unauthenticated callers.
 *
 * FAIL-OPEN: if Redis is unavailable or errors (config resolution, IP-list
 * lookup, or the counter itself), we log and let the request through rather than
 * locking legitimate users out of login. A Redis outage briefly loses rate
 * limiting AND blocklist enforcement — a deliberate availability trade for a
 * self-hosted notes app. This is called out in the design notes.
 */

/** Minimal slice of ioredis this limiter needs (keeps it unit-testable). */
export interface RateLimitRedis {
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<number>
  ttl(key: string): Promise<number>
}

/**
 * Standard Red Notes: the counter contract for a store that can increment AND arm
 * the window in ONE step.
 *
 * `INCR` + (first hit only) `EXPIRE` is two round trips, which is fine against
 * Redis because a key with no TTL is still a key this process will re-`EXPIRE` on
 * its next first-hit. It is NOT fine against a store where the horizon lives in
 * the row itself (see {@link CacheEntryRateLimitStore}): a row written by the
 * `incr` half and never reached by the `expire` half has a wrong or missing
 * horizon, and a rate-limit counter that never expires is a PERMANENT LOCKOUT --
 * worse than no limit at all.
 *
 * So a store may offer this instead, and the limiter prefers it whenever it is
 * present. ioredis has no such method, so the Redis topologies keep taking the
 * `incr`/`expire` path byte for byte.
 */
export interface RateLimitWindowStore {
  incrementInWindow(key: string, windowSeconds: number): Promise<number>
  ttl(key: string): Promise<number>
}

/** Either counter backend. `undefined` at a call site means pass-through. */
export type RateLimitStore = RateLimitRedis | RateLimitWindowStore

const isWindowStore = (store: RateLimitStore): store is RateLimitWindowStore =>
  typeof (store as RateLimitWindowStore).incrementInWindow === 'function'

/**
 * Bump the fixed-window counter for `key` and return the post-increment count,
 * using whichever contract the store offers.
 */
const incrementRateLimitCounter = async (
  store: RateLimitStore,
  key: string,
  windowSeconds: number,
): Promise<number> => {
  if (isWindowStore(store)) {
    return store.incrementInWindow(key, windowSeconds)
  }

  const count = await store.incr(key)
  // First hit in this window: attach the TTL so the counter self-resets.
  if (count === 1) {
    await store.expire(key, windowSeconds)
  }

  return count
}

export interface RateLimitLogger {
  warn(message: string, metadata?: Record<string, unknown>): void
}

export interface RateLimitRule {
  /** Namespace for the Redis key + a label for logging/metrics. */
  bucket: string
  /** Max requests permitted per window per IP. */
  limit: number
  /** Fixed-window length in seconds. */
  windowSeconds: number
  /** Whether this rule applies to the given request. */
  match: (method: string, normalizedPath: string) => boolean
  /**
   * Optional subject override: the string the counter is keyed on for this
   * request, or `undefined` to key on the client IP as every other rule does.
   * The realtime-token bucket counts per SESSION when a bearer credential is
   * presented, so one busy NAT does not starve every user behind it.
   */
  subject?: (request: Request) => string | undefined
}

export interface RateLimitConfig {
  enabled: boolean
  rules: RateLimitRule[]
}

export interface RateLimitLimits {
  windowSeconds: number
  /** login / recovery-login tier. */
  loginMax: number
  /** registration / mcp-authenticate / magic-link tier. */
  registrationMax: number
}

/** A provider resolves the effective config per request (from the overlay). */
export type RateLimitConfigProvider = RateLimitConfig | (() => Promise<RateLimitConfig>)

/** Optional IP allow/block list checked before the tiers. */
export interface IpAccessListLike {
  classify(clientIp: string): Promise<IpAclDecision>
}

/** Optional best-effort telemetry sink for the admin Anti-abuse view. */
export interface RateLimitMetricsLike {
  recordThrottle(event: { bucket: string; ip: string; method: string; path: string }): Promise<void>
  recordBlock(): Promise<void>
}

/**
 * PURE limit logic (unit-tested): given the post-increment counter value and the
 * configured ceiling, is this request within the allowance?
 */
export const isWithinRateLimit = (countAfterIncrement: number, limit: number): boolean => {
  return countAfterIncrement <= limit
}

/** Strip a trailing slash (but keep root "/") so "/v1/users/" == "/v1/users". */
export const normalizeRateLimitPath = (path: string): string => {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/**
 * The default rule set: a login tier (login + recovery-login), a stricter
 * "sensitive" tier (registration, MCP-token authenticate, magic-link request),
 * and an exact GET rule for the public subscription OAuth callback. The callback
 * gets its own bucket so random valid-looking state/code probes cannot consume
 * login allowance; it reuses the more generous login ceiling to avoid disrupting
 * legitimate provider redirects. Extend/retune via the overlay/env limits.
 */
/** The realtime control-plane endpoints the `realtime-tokens` bucket covers (N41). */
export const REALTIME_TOKEN_PATHS: readonly string[] = [
  '/v1/sockets/tokens',
  '/v1/sockets/sync/ticket',
  '/sockets/tokens',
]

/**
 * Standard Red Notes: the SECOND-FACTOR gate, which the `auth-second-factor`
 * bucket covers.
 *
 * Both of these proxy to `auth.pkceParams` (ActionsController v1 `@httpGet`,
 * ActionsControllerV2 `@httpPost`), and that controller method is where VerifyMFA
 * runs — the TOTP, U2F, magic-link, app-password and trusted-device checks all
 * live behind these two paths, with no session required to reach them.
 *
 * Both verbs are matched on both paths rather than only the pair each version
 * currently declares, so adding (or moving) a verb on either version cannot
 * silently drop the route out of its bucket again. `/v1/recovery/login-params` is
 * a different endpoint (recovery key params) and keeps its place in `auth-login`.
 */
export const SECOND_FACTOR_PATHS: readonly string[] = ['/v1/login-params', '/v2/login-params']

/**
 * Standard Red Notes: SESSION REFRESH, which the `auth-session-refresh` bucket
 * covers.
 *
 * `POST /v1/sessions/refresh` (SessionsController, `@httpPost('/refresh')` — the
 * one route on that controller with no `RequiredCrossServiceTokenMiddleware`)
 * accepts a refresh token and returns a rotated session pair. It is a CREDENTIAL
 * ENDPOINT reachable without a live access-token session, and it sat in no bucket
 * at all, so it had no per-address ceiling of any kind.
 *
 * Only `/v1` exists today and it declares POST; both verbs are listed on both
 * version prefixes anyway, for exactly the reason the second-factor bucket was
 * written that way — a verb change or a `/v2` sibling (there is already a `/v2`
 * for actions, payments and revisions) must not be able to drop the route out of
 * its bucket again. The AUTHENTICATED session-management routes on the same
 * controller (`GET /v1/sessions`, `DELETE /v1/sessions`, `DELETE
 * /v1/sessions/:uuid`) are deliberately not here: they sit behind the
 * cross-service token middleware and check no credential of their own.
 *
 * Not reachable over the socket RPC lane either: `/v1/sessions` is already a
 * member of LoopbackSyncApiRpcAdapter's FORBIDDEN_RPC_ROUTE_FAMILIES, so this
 * gateway bucket is the only entrance there is.
 */
export const SESSION_REFRESH_PATHS: readonly string[] = ['/v1/sessions/refresh', '/v2/sessions/refresh']

/**
 * Standard Red Notes: THE REFRESH CEILING, and why it is this generous.
 *
 * A limit that strands a real user is worse than no limit: a throttled refresh
 * means the access token expires, the client cannot sync, and the person is
 * effectively signed out by their own rate limiter. Two things make a legitimate
 * burst larger than intuition suggests:
 *
 *   - SEVERAL TABS OR DEVICES SHARE ONE ADDRESS. Refresh is keyed on the client
 *     IP (see below), and each browser tab is its own app instance with its own
 *     in-flight-refresh deduplication, so N tabs behind one NAT legitimately
 *     issue N refreshes within the same second.
 *   - A SUPERSEDED REFRESH TOKEN STAYS REPLAYABLE FOR 120 SECONDS BY DESIGN — a
 *     cooldown that exists so a client whose response was dropped can retry the
 *     same token instead of losing its session. Those retries are legitimate
 *     traffic and have to fit inside the allowance.
 *
 * Against that, the legitimate STEADY-STATE rate is almost nothing. The client
 * refreshes reactively — only after a 498 on some other request — and
 * ACCESS_TOKEN_AGE defaults to 5 184 000 seconds, sixty days, so one session
 * refreshes about six times a year. Nothing refreshes on a timer.
 *
 * So: six times the login tier, with a FLOOR of 30 per window. At stock settings
 * (loginMax 10) that is 60 per 60 seconds per address — enough for sixty distinct
 * sessions behind one address to refresh in the same minute, something that could
 * only happen once every sixty days even if they were all created at the same
 * instant, and enough for a mass reconnect after a network blip with cooldown
 * replays on top. The floor matters because an operator who HARDENS the login
 * tier (loginMax 3, say) must not accidentally break session refresh for a
 * household behind one address; the multiplier matters because an operator who
 * raises the login tier has a busy server and should get headroom here too.
 */
export const SESSION_REFRESH_LIMIT_MULTIPLIER = 6
export const SESSION_REFRESH_MIN_LIMIT = 30
export const sessionRefreshLimit = (loginMax: number): number =>
  Math.max(SESSION_REFRESH_MIN_LIMIT, loginMax * SESSION_REFRESH_LIMIT_MULTIPLIER)

/**
 * Standard Red Notes: the ceiling for the `realtime-tokens` bucket, which covers
 * the two per-socket mints in {@link REALTIME_TOKEN_PATHS}.
 *
 * WHY IT IS NOT THE LOGIN CEILING. It was `loginMax` — 10 per 60 s at stock
 * settings — on the reading that "a legitimate client mints once per socket, so
 * the login ceiling is ample". Both halves of that are true and the conclusion
 * still does not follow, because this is the endpoint a client must call to COME
 * BACK. Measured on compose: after a gateway restart, recovery took 60,557 ms —
 * the eleventh mint answered 429 with `Retry-After: 60`, so the socket stayed
 * down for the rest of the window. A brief outage became a minute of downtime,
 * caused by the limiter rather than by the outage.
 *
 * The login tier exists to slow down GUESSING an unknown secret. Nothing is
 * guessed here: both paths sit behind `RequiredCrossServiceTokenMiddleware`, so
 * the caller already holds a valid session, and what comes back is single-use
 * with a 30-second TTL. A ticket is worth less than the bearer that bought it.
 * So the login ceiling is not "ample" for this endpoint, it is the wrong
 * dimension — it is sized for an attacker's patience, and this endpoint's load
 * is set by how often healthy clients reconnect.
 *
 * WHAT IT STILL PROTECTS. Exactly what a 30-second single-use ticket does not
 * already cover: the unmetered HMAC/JWT signature and the Redis ticket-store
 * write that an AUTHENTICATED caller can otherwise drive at line rate. That is
 * the whole of the cost, and it stays bounded — 2 mints per second per session
 * at stock settings is a three-orders-of-magnitude reduction from line rate, the
 * bucket is still per-session so the cost is attributed to whoever causes it,
 * and a session that trips it still feeds the throttle telemetry and the
 * adaptive-escalation signal.
 *
 * WHY TWELVE, WITH A FLOOR. Same shape as {@link sessionRefreshLimit} and for
 * the same reasons: the multiplier so an operator who raises the login tier has
 * a busy server and gets headroom here too, the floor so an operator who HARDENS
 * the login tier (loginMax 3, say) cannot accidentally make recovery the thing
 * that breaks. At stock settings that is 120 per 60 seconds per session. The
 * figure has to clear the worst HEALTHY case — every socket a session is allowed
 * to hold re-tickets at once when a gateway restarts, and the gateway's own
 * per-user socket ceiling is 1,024 by default (4 as the single container's
 * entrypoint projects it) — and it also has to clear a client that is redialling
 * badly: a reconnect loop at roughly 1 Hz consumes half of this allowance and
 * therefore cannot lock the session out, which matters because the bucket is
 * keyed per session and shared across tabs.
 *
 * WHY THE KEY IS STILL THE SESSION. Keying per socket or per `deviceId` would
 * isolate one looping tab from the others, but `deviceId` is the caller's own
 * field, so a client that rotated it would have no ceiling at all — and the
 * caller is already authenticated, so that is a real bypass rather than a
 * theoretical one. Per-session keying is right for attributing the cost; the
 * cross-tab lockout is fixed by the ceiling being out of a healthy session's
 * reach, not by subdividing the key.
 */
export const REALTIME_RECONNECT_LIMIT_MULTIPLIER = 12
export const REALTIME_RECONNECT_MIN_LIMIT = 120
export const realtimeReconnectLimit = (loginMax: number): number =>
  Math.max(REALTIME_RECONNECT_MIN_LIMIT, loginMax * REALTIME_RECONNECT_LIMIT_MULTIPLIER)

/**
 * Per-session subject for the realtime-token bucket: a digest of the presented
 * bearer credential (never the credential itself — it is a Redis key). A rotated
 * bogus bearer only buys 401s from the cross-service token middleware, never a
 * mint, so keying on it does not open a bypass; a request with no credential
 * falls back to the IP.
 */
export const realtimeTokenSubject = (request: Request): string | undefined => {
  const authorization = request.headers.authorization
  if (typeof authorization !== 'string' || authorization.length === 0) {
    return undefined
  }

  return `session:${createHash('sha256').update(authorization).digest('hex').slice(0, 32)}`
}

export const buildDefaultRateLimitRules = (limits: RateLimitLimits): RateLimitRule[] => {
  const postTo =
    (paths: string[]) =>
    (method: string, normalizedPath: string): boolean =>
      method.toUpperCase() === 'POST' && paths.includes(normalizedPath)
  const getTo =
    (paths: string[]) =>
    (method: string, normalizedPath: string): boolean =>
      method.toUpperCase() === 'GET' && paths.includes(normalizedPath)

  return [
    {
      bucket: 'auth-login',
      limit: limits.loginMax,
      windowSeconds: limits.windowSeconds,
      match: postTo([
        '/v1/login',
        '/v2/login',
        '/v1/recovery/login',
        '/v1/recovery/login-params',
        '/v1/account-recovery/lookup',
      ]),
    },
    {
      /**
       * Standard Red Notes: the second-factor gate (see SECOND_FACTOR_PATHS).
       *
       * These two paths sat in NO bucket while `/v1/login` next to them sat in
       * `auth-login`, so the one endpoint that verifies a 6-digit second factor
       * was the one endpoint an unauthenticated caller could retry without any
       * per-address ceiling. The account-side brake (BaseAuthController.pkceParams
       * now counts a rejected second factor, which drives the progressive delay
       * ramp and the lock) is the better-targeted half of the fix because it keys
       * on the account; this is the belt to that braces, and it is what caps the
       * app-password/trusted-device bcrypt work and the account-existence probing
       * that present no credential and so are deliberately never counted.
       *
       * LIMIT: the login ceiling (default 10 per 60s per address), its own bucket
       * so second-factor retries and sign-in attempts never consume each other's
       * allowance. A 2FA sign-in spends 2 of it (one request to learn a code is
       * wanted, one carrying the code) and each mistype spends 1 more, so a person
       * who mistypes three times and then succeeds spends 5 of 10 and never sees a
       * 429 — while a guesser is held to 10 attempts a minute against a TOTP that
       * rotates every 30 seconds, and to ~150 attempts against the 10^6-wide
       * magic-link code during its entire 15-minute life. Tunable by the same
       * admin/env knob as the login tier (security.rateLimit.loginMax /
       * RATE_LIMIT_LOGIN_MAX); shared-NAT callers share the ceiling, as they
       * already do on every other bucket here.
       */
      bucket: 'auth-second-factor',
      limit: limits.loginMax,
      windowSeconds: limits.windowSeconds,
      match: (method: string, normalizedPath: string): boolean => {
        const verb = method.toUpperCase()

        return (verb === 'GET' || verb === 'POST') && SECOND_FACTOR_PATHS.includes(normalizedPath)
      },
    },
    {
      /**
       * Standard Red Notes: session refresh (see SESSION_REFRESH_PATHS and
       * sessionRefreshLimit for the paths and the ceiling).
       *
       * Its own bucket, so a refresh storm after a network blip cannot consume the
       * sign-in allowance and a sign-in attempt cannot consume the refresh
       * allowance — the second property is the one that matters, because being
       * unable to refresh is being signed out.
       *
       * KEYED ON THE CLIENT IP, with no `subject` override, like every other auth
       * bucket here. The realtime-token bucket keys on a digest of the presented
       * bearer because a rotated bogus bearer buys nothing there; that reasoning
       * does NOT carry over to this endpoint. A rotated credential here would buy
       * the full session lookup on every request, so keying on it would hand an
       * attacker an unlimited allowance — and a cookie-based session presents no
       * Authorization header at all, so half the callers would silently fall back
       * to the IP anyway. Shared-NAT callers therefore share this ceiling, which
       * is exactly why it is set six times higher than the login tier.
       *
       * WHAT IT IS AND IS NOT FOR. A refresh token is long and random, so this is
       * not a guessing brake; it caps the unmetered session lookup, token rotation
       * and session write that any unauthenticated caller could previously drive
       * at line rate, and it puts the endpoint inside the throttle telemetry and
       * the adaptive-escalation signal that every other credential endpoint is
       * already inside.
       */
      bucket: 'auth-session-refresh',
      limit: sessionRefreshLimit(limits.loginMax),
      windowSeconds: limits.windowSeconds,
      match: (method: string, normalizedPath: string): boolean => {
        const verb = method.toUpperCase()

        return (verb === 'GET' || verb === 'POST') && SESSION_REFRESH_PATHS.includes(normalizedPath)
      },
    },
    {
      bucket: 'auth-sensitive',
      limit: limits.registrationMax,
      windowSeconds: limits.windowSeconds,
      match: postTo([
        '/v1/users',
        '/v1/mcp-tokens/authenticate',
        '/v1/mfa/magic-link/request',
        '/v1/users/email-confirmation/resend',
      ]),
    },
    {
      bucket: 'assistant-pairing-callback',
      limit: limits.loginMax,
      windowSeconds: limits.windowSeconds,
      match: getTo(['/v1/assistant/subscription/callback']),
    },
    {
      // Standard Red Notes (N41): the realtime control plane. Minting a
      // connection token and issuing a sync ticket each sign a JWT/HMAC and, on
      // the sync lane, touch Redis, and neither sat inside any bucket before. A
      // reconnect storm is charged to the session that causes it.
      //
      // The CEILING is this bucket's own, not the login tier's: see
      // realtimeReconnectLimit for why "a legitimate client mints once per
      // socket, so the login ceiling is ample" was the wrong reading of a
      // RECOVERY endpoint.
      bucket: 'realtime-tokens',
      limit: realtimeReconnectLimit(limits.loginMax),
      windowSeconds: limits.windowSeconds,
      match: postTo([...REALTIME_TOKEN_PATHS]),
      subject: realtimeTokenSubject,
    },
  ]
}

const TOO_MANY_REQUESTS = {
  error: {
    message: 'Too many requests. Please wait a moment and try again.',
  },
}

const IP_BLOCKED = {
  error: {
    message: 'Your network address has been blocked by the server administrator.',
  },
}

// Standard Red Notes: key on THE canonical resolver so the rate limiter, the IP
// allow/block list and the auth session IP all agree on ONE address. It honors
// TRUST_PROXY (via request.ip) + the optional CLIENT_IP_HEADER and normalizes the
// result (IPv6-mapped IPv4 unwrapped, etc.), so an attacker cannot bypass a limit
// or block by spoofing X-Forwarded-For when the app isn't configured to trust a proxy.
const clientIpOf = (request: Request, clientIpHeader?: string): string =>
  resolveClientIpFromRequest(request, clientIpHeader) || 'unknown'

/** Set the standard rate-limit headers on a limited response. */
const setRateLimitHeaders = (
  response: Response,
  limit: number,
  countAfterIncrement: number,
  resetSeconds?: number,
): void => {
  const remaining = Math.max(0, limit - countAfterIncrement)
  response.setHeader('X-RateLimit-Limit', String(limit))
  response.setHeader('X-RateLimit-Remaining', String(remaining))
  if (resetSeconds !== undefined) {
    response.setHeader('X-RateLimit-Reset', String(resetSeconds))
  }
}

/**
 * Build the Express middleware. Returns a no-op pass-through when no Redis client
 * is available, so installing it unconditionally is safe.
 */
export const createRateLimitMiddleware = (options: {
  /**
   * The counter store: an ioredis client on the Redis topologies, a
   * {@link RateLimitWindowStore} ({@link CacheEntryRateLimitStore}) on the
   * no-Redis arm, `undefined` when neither exists (pass-through).
   */
  redis: RateLimitStore | undefined
  config: RateLimitConfigProvider
  logger: RateLimitLogger
  ipAccessList?: IpAccessListLike
  metrics?: RateLimitMetricsLike
  /** Item 5 hook: fired (fire-and-forget) when an IP trips a tier. */
  onThrottle?: (clientIp: string, bucket: string) => void
  /** Optional trusted client-IP header name (CLIENT_IP_HEADER; empty = off). */
  clientIpHeader?: string
  now?: () => number
}): ((request: Request, response: Response, next: NextFunction) => void) => {
  const { redis, config, logger, ipAccessList, metrics, onThrottle, clientIpHeader } = options
  const now = options.now ?? ((): number => Date.now())
  const resolveConfig = typeof config === 'function' ? config : async (): Promise<RateLimitConfig> => config

  if (redis === undefined) {
    return (_request: Request, _response: Response, next: NextFunction): void => {
      next()
    }
  }

  return (request: Request, response: Response, next: NextFunction): void => {
    void (async (): Promise<void> => {
      const path = normalizeRateLimitPath(request.path)
      const ip = clientIpOf(request, clientIpHeader)

      // IP allow/block list — enforced BEFORE the tiers. Fails open (a Redis
      // error degrades to 'none' inside classify) so an outage never hard-blocks.
      if (ipAccessList !== undefined) {
        try {
          const decision = await ipAccessList.classify(ip)
          if (decision === 'blocked') {
            void metrics?.recordBlock()
            response.status(403).send(IP_BLOCKED)
            return
          }
          if (decision === 'allowed') {
            next()
            return
          }
        } catch (error) {
          logger.warn('IP access-list check failed open.', safeErrorLogMetadata(error))
        }
      }

      let resolved: RateLimitConfig
      try {
        resolved = await resolveConfig()
      } catch (error) {
        // A broken overlay must not take the auth surfaces down.
        logger.warn('Rate-limit config resolution failed open.', safeErrorLogMetadata(error))
        next()
        return
      }

      if (!resolved.enabled || resolved.rules.length === 0) {
        next()
        return
      }

      const rule = resolved.rules.find((candidate) => candidate.match(request.method, path))
      if (rule === undefined) {
        next()
        return
      }

      const key = `rl:${rule.bucket}:${rule.subject?.(request) ?? ip}`
      try {
        const count = await incrementRateLimitCounter(redis, key, rule.windowSeconds)

        if (isWithinRateLimit(count, rule.limit)) {
          setRateLimitHeaders(response, rule.limit, count)
          next()
          return
        }

        let retryAfterSeconds = rule.windowSeconds
        try {
          const ttl = await redis.ttl(key)
          if (ttl > 0) {
            retryAfterSeconds = ttl
          }
        } catch {
          // best-effort Retry-After; fall back to the window length.
        }
        response.setHeader('Retry-After', String(retryAfterSeconds))
        setRateLimitHeaders(response, rule.limit, count, Math.floor(now() / 1000) + retryAfterSeconds)

        // Standard Red Notes: THE REFUSAL MUST NOT DEPEND ON THE TELEMETRY.
        //
        // These two are a metrics sink and an escalation hook, both best-effort and
        // both supplied by the caller. A synchronous throw from either used to
        // escape into the fail-open catch below, which calls next() -- so a broken
        // hook silently converted a 429 into an ALLOWED request, and the limiter
        // reported itself as "failed open" while looking entirely healthy.
        //
        // That was unreachable only for as long as nothing ever throttled: the
        // no-Redis arm was a pass-through, and `onThrottle` there dereferences an
        // undefined escalation client. Giving that arm a real counter made the
        // latent throw reachable on the very first refusal (measured: every 11th
        // login answered 401 with a correct `Retry-After: 49` on the same
        // response). The install sites no longer pass a hook they cannot serve, and
        // this catch makes it structurally impossible for any future hook to spend
        // a refusal.
        try {
          void metrics?.recordThrottle({ bucket: rule.bucket, ip, method: request.method, path })
          onThrottle?.(ip, rule.bucket)
        } catch (error) {
          logger.warn('Rate-limit throttle telemetry failed.', safeErrorLogMetadata(error))
        }

        response.status(429).send(TOO_MANY_REQUESTS)
      } catch (error) {
        // FAIL-OPEN: a Redis outage must not lock users out of auth endpoints.
        logger.warn('Rate limiter failed open.', safeErrorLogMetadata(error))
        next()
      }
    })()
  }
}

/* ------------------------------------------------------------------------- *
 * Per-USER tier (item 4) — an opt-in limiter for expensive AUTHENTICATED
 * endpoints, keyed on the authenticated user uuid (from response.locals.user,
 * set by the auth middleware that must run BEFORE this one). Reuses the same
 * Redis fixed-window + headers + metrics. Disabled (max <= 0) => pass-through.
 * ------------------------------------------------------------------------- */

export interface UserRateLimitConfig {
  bucket: string
  windowSeconds: number
  /** Max requests per window per user; <= 0 disables the limiter (pass-through). */
  max: number
}

export type UserRateLimitConfigProvider = UserRateLimitConfig | (() => Promise<UserRateLimitConfig>)

export const createUserRateLimitMiddleware = (options: {
  /** Same contract as {@link createRateLimitMiddleware}'s `redis`. */
  redis: RateLimitStore | undefined
  config: UserRateLimitConfigProvider
  logger: RateLimitLogger
  metrics?: RateLimitMetricsLike
  /** Optional trusted client-IP header name (CLIENT_IP_HEADER; empty = off). */
  clientIpHeader?: string
  now?: () => number
}): ((request: Request, response: Response, next: NextFunction) => void) => {
  const { redis, config, logger, metrics, clientIpHeader } = options
  const now = options.now ?? ((): number => Date.now())
  const resolveConfig = typeof config === 'function' ? config : async (): Promise<UserRateLimitConfig> => config

  if (redis === undefined) {
    return (_request: Request, _response: Response, next: NextFunction): void => {
      next()
    }
  }

  return (request: Request, response: Response, next: NextFunction): void => {
    void (async (): Promise<void> => {
      let resolved: UserRateLimitConfig
      try {
        resolved = await resolveConfig()
      } catch (error) {
        logger.warn('Per-user rate-limit config resolution failed open.', safeErrorLogMetadata(error))
        next()
        return
      }

      if (resolved.max <= 0) {
        next()
        return
      }

      const user = (response.locals as { user?: { uuid?: string } }).user
      const uuid = user?.uuid
      // No authenticated user on locals => nothing to key on; let the normal
      // auth gate handle it (never our job to 401 here).
      if (uuid === undefined || uuid === '') {
        next()
        return
      }

      const key = `rl:user:${resolved.bucket}:${uuid}`
      try {
        const count = await incrementRateLimitCounter(redis, key, resolved.windowSeconds)

        if (isWithinRateLimit(count, resolved.max)) {
          setRateLimitHeaders(response, resolved.max, count)
          next()
          return
        }

        let retryAfterSeconds = resolved.windowSeconds
        try {
          const ttl = await redis.ttl(key)
          if (ttl > 0) {
            retryAfterSeconds = ttl
          }
        } catch {
          // best-effort.
        }
        response.setHeader('Retry-After', String(retryAfterSeconds))
        setRateLimitHeaders(response, resolved.max, count, Math.floor(now() / 1000) + retryAfterSeconds)
        void metrics?.recordThrottle({
          bucket: `user:${resolved.bucket}`,
          ip: clientIpOf(request, clientIpHeader),
          method: request.method,
          path: normalizeRateLimitPath(request.path),
        })
        response.status(429).send(TOO_MANY_REQUESTS)
      } catch (error) {
        logger.warn('Per-user rate limiter failed open.', safeErrorLogMetadata(error))
        next()
      }
    })()
  }
}
