import { Application } from 'express'

/**
 * Standard Red Notes: reverse-proxy ("trust proxy") configuration.
 *
 * When the stack runs behind a TLS-terminating reverse proxy (nginx, Traefik,
 * Caddy, ...) the proxy forwards the real client scheme and IP in the
 * `X-Forwarded-Proto` / `X-Forwarded-For` headers. Express only honors those
 * headers — i.e. `req.protocol`, `req.secure` and `req.ip` only reflect them —
 * when `app.set('trust proxy', ...)` is configured. Without it, `req.secure`
 * is always false (so Secure cookies / HTTPS detection misbehave) and `req.ip`
 * reports the proxy's address instead of the client's.
 *
 * This parser turns a single env var (`TRUST_PROXY`) into the value Express
 * expects. It intentionally mirrors the express `trust proxy` API:
 *
 *   - unset / empty  -> the supplied default (callers pass a safe default, e.g.
 *                       `loopback, linklocal, uniquelocal`, which trusts a proxy
 *                       running on loopback or a private/Docker network but NOT
 *                       arbitrary public clients — so direct, non-proxied access
 *                       keeps working and forwarded headers can't be spoofed by
 *                       a remote attacker).
 *   - "true"/"false" -> boolean (true = trust the left-most XFF entry / all hops;
 *                       use only when the proxy is the sole ingress).
 *   - a number       -> trust exactly N proxy hops (e.g. "1").
 *   - anything else  -> passed through verbatim, so CSV IP/subnet lists and the
 *                       express preset names ("loopback", "linklocal",
 *                       "uniquelocal") all work, e.g. "127.0.0.1, 172.16.0.0/12".
 *
 * The parsed value is `false` only when explicitly set to "false" — never as an
 * accidental default — so enabling proxy support is a deliberate, documented op.
 */
export type TrustProxyValue = boolean | number | string

export const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal'

export const parseTrustProxyValue = (
  rawValue: string | undefined,
  defaultValue: TrustProxyValue = DEFAULT_TRUST_PROXY,
): TrustProxyValue => {
  if (rawValue === undefined || rawValue === null) {
    return defaultValue
  }

  const trimmed = rawValue.trim()
  if (trimmed === '') {
    return defaultValue
  }

  const lowered = trimmed.toLowerCase()
  if (lowered === 'true') {
    return true
  }
  if (lowered === 'false') {
    return false
  }

  // A bare integer means "trust N hops". Guard against partial-number strings
  // like "1.2.3.4" (an IP) which must be passed through as a list instead.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed)
  }

  return trimmed
}

/**
 * Apply the parsed `TRUST_PROXY` value to an express app. Express treats the
 * absence of the setting as `false`, so we only set it when we have a concrete
 * value (which `parseTrustProxyValue` always returns).
 */
export const configureTrustProxy = (
  app: Application,
  rawValue: string | undefined,
  defaultValue: TrustProxyValue = DEFAULT_TRUST_PROXY,
): TrustProxyValue => {
  const value = parseTrustProxyValue(rawValue, defaultValue)
  app.set('trust proxy', value)

  return value
}
