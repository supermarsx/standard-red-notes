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
      // legitimate client mints once per socket, so the login ceiling is ample;
      // a reconnect storm is charged to the session that causes it.
      bucket: 'realtime-tokens',
      limit: limits.loginMax,
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
  redis: RateLimitRedis | undefined
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
        const count = await redis.incr(key)
        // First hit in this window: attach the TTL so the counter self-resets.
        if (count === 1) {
          await redis.expire(key, rule.windowSeconds)
        }

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

        void metrics?.recordThrottle({ bucket: rule.bucket, ip, method: request.method, path })
        onThrottle?.(ip, rule.bucket)

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
  redis: RateLimitRedis | undefined
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
        const count = await redis.incr(key)
        if (count === 1) {
          await redis.expire(key, resolved.windowSeconds)
        }

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
