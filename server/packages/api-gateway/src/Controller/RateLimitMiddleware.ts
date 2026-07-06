import { NextFunction, Request, Response } from 'express'

/**
 * Redis-backed IP rate limiting for the UNAUTHENTICATED, auth-adjacent gateway
 * endpoints (login, registration, MCP-token authenticate, magic-link request,
 * recovery). These are the brute-force / abuse surfaces that have no session in
 * front of them; the authenticated sync/proxy paths are deliberately NOT limited.
 *
 * Implementation is a minimal fixed-window counter (INCR + EXPIRE) rather than a
 * new dependency (express-rate-limit / rate-limit-redis), reusing the gateway's
 * existing ioredis client. Keyed by client IP (req.ip, which already honors the
 * configured TRUST_PROXY so a proxied deployment sees the real client, and a
 * direct client cannot spoof X-Forwarded-For).
 *
 * FAIL-OPEN: if Redis is unavailable or errors, we log and let the request
 * through rather than locking legitimate users out of login. This trades a brief
 * loss of rate limiting during a Redis outage for availability, which is the
 * right call for a self-hosted notes app.
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
  /** Namespace for the Redis key + a label for logging. */
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
 * limited. Extend/retune via the limits passed in from env.
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
      match: postTo(['/v1/login', '/v2/login', '/v1/recovery/login', '/v1/recovery/login-params']),
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

/**
 * Build the Express middleware. Returns a no-op pass-through when disabled or
 * when no Redis client is available, so installing it unconditionally is safe.
 */
export const createRateLimitMiddleware = (options: {
  redis: RateLimitRedis | undefined
  config: RateLimitConfig
  logger: RateLimitLogger
}): ((request: Request, response: Response, next: NextFunction) => void) => {
  const { redis, config, logger } = options

  if (!config.enabled || redis === undefined || config.rules.length === 0) {
    return (_request: Request, _response: Response, next: NextFunction): void => {
      next()
    }
  }

  return (request: Request, response: Response, next: NextFunction): void => {
    const path = normalizeRateLimitPath(request.path)
    const rule = config.rules.find((candidate) => candidate.match(request.method, path))
    if (rule === undefined) {
      next()
      return
    }

    const ip = request.ip || request.socket?.remoteAddress || 'unknown'
    const key = `rl:${rule.bucket}:${ip}`

    void (async (): Promise<void> => {
      try {
        const count = await redis.incr(key)
        // First hit in this window: attach the TTL so the counter self-resets.
        if (count === 1) {
          await redis.expire(key, rule.windowSeconds)
        }

        if (isWithinRateLimit(count, rule.limit)) {
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
        response.status(429).send(TOO_MANY_REQUESTS)
      } catch (error) {
        // FAIL-OPEN: a Redis outage must not lock users out of auth endpoints.
        logger.warn(`Rate limiter failing open (Redis error) for ${rule.bucket}: ${(error as Error).message}`)
        next()
      }
    })()
  }
}
