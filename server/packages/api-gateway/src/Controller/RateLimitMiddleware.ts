import { NextFunction, Request, Response } from 'express'

import { IpAclDecision } from './IpAccessList'
import { resolveClientIpFromRequest } from './ClientIp'

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
  warn(message: string): void
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
 * The default rule set: a login tier (login + recovery-login) and a stricter
 * "sensitive" tier (registration, MCP-token authenticate, magic-link request).
 * Paths are matched exactly against the normalized request path; only POST is
 * limited. Extend/retune via the limits passed in from the overlay/env.
 */
export const buildDefaultRateLimitRules = (limits: RateLimitLimits): RateLimitRule[] => {
  const postTo =
    (paths: string[]) =>
    (method: string, normalizedPath: string): boolean =>
      method.toUpperCase() === 'POST' && paths.includes(normalizedPath)

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
          logger.warn(`IP access-list check failing open (Redis error): ${(error as Error).message}`)
        }
      }

      let resolved: RateLimitConfig
      try {
        resolved = await resolveConfig()
      } catch (error) {
        // A broken overlay must not take the auth surfaces down.
        logger.warn(`Rate-limit config resolution failing open: ${(error as Error).message}`)
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

      const key = `rl:${rule.bucket}:${ip}`
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
        logger.warn(`Rate limiter failing open (Redis error) for ${rule.bucket}: ${(error as Error).message}`)
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
        logger.warn(`Per-user rate-limit config resolution failing open: ${(error as Error).message}`)
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
        logger.warn(
          `Per-user rate limiter failing open (Redis error) for ${resolved.bucket}: ${(error as Error).message}`,
        )
        next()
      }
    })()
  }
}
