/**
 * Standard Red Notes: reverse-proxy ("trust proxy") configuration for the files
 * service. Parses the `TRUST_PROXY` env var into the value express expects so
 * that, behind a TLS-terminating reverse proxy, req.secure / req.protocol /
 * req.ip reflect the X-Forwarded-Proto / X-Forwarded-For headers.
 *
 * Mirrors the express `trust proxy` API and the api-gateway parser:
 *   - unset / empty  -> the default ("loopback, linklocal, uniquelocal"): trusts
 *                       a proxy on loopback or a private/Docker network but not
 *                       arbitrary public clients, so direct access still works
 *                       and forwarded headers can't be spoofed remotely.
 *   - "true"/"false" -> boolean.
 *   - a number       -> trust exactly N proxy hops.
 *   - anything else  -> passed through verbatim (CSV IP/subnet lists, presets).
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

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed)
  }

  return trimmed
}
