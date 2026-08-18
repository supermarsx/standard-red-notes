const EXPLICIT_ORIGIN_SCHEMES = new Set(['http:', 'https:', 'tauri:'])

/**
 * WebSocket sync is the primary transport unless an operator applies the exact
 * `false` kill switch. Rejecting misspellings keeps a broken rollout from
 * silently changing transport policy.
 */
export function parseWebSocketSyncEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === 'true') {
    return true
  }
  if (value === 'false') {
    return false
  }
  throw new Error('WEBSOCKET_SYNC_ENABLED must be exactly "true" or "false" when set.')
}

export function parseOptionalPositiveInteger(
  name: string,
  value: string | undefined,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value === undefined || value === '') {
    return undefined
  }
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${name} must be a positive integer when set.`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}.`)
  }
  return parsed
}

function parseExactOrigin(value: string): string | undefined {
  if (value === '*' || value === 'null') {
    return undefined
  }
  try {
    const url = new URL(value)
    if (!EXPLICIT_ORIGIN_SCHEMES.has(url.protocol) || url.username || url.password || url.search || url.hash) {
      return undefined
    }
    if (url.pathname !== '' && url.pathname !== '/') {
      return undefined
    }
    if (url.protocol === 'tauri:') {
      return `${url.protocol}//${url.host}` === value ? value : undefined
    }
    return url.origin === value || `${url.origin}/` === value ? url.origin : undefined
  } catch {
    return undefined
  }
}

/**
 * Explicit origins are strict deployment policy and therefore fail startup on
 * an unsafe member. When no list is supplied, PUBLIC_URL is reduced to its
 * exact http(s) origin; malformed/non-network URLs simply keep capability
 * negotiation closed.
 */
export function resolveWebSocketSyncAllowedOrigins(
  explicitOrigins: string | undefined,
  publicUrl: string | undefined,
): readonly string[] {
  if (explicitOrigins !== undefined && explicitOrigins !== '') {
    const resolved = new Set<string>()
    for (const value of explicitOrigins.split(',')) {
      const candidate = value.trim()
      const origin = parseExactOrigin(candidate)
      if (!candidate || !origin) {
        throw new Error(
          `WEBSOCKET_SYNC_ALLOWED_ORIGINS contains an unsafe or invalid origin: ${candidate || '<empty>'}`,
        )
      }
      resolved.add(origin)
    }
    return [...resolved]
  }

  if (!publicUrl) {
    return []
  }
  try {
    const url = new URL(publicUrl)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
      return []
    }
    return [url.origin]
  } catch {
    return []
  }
}
