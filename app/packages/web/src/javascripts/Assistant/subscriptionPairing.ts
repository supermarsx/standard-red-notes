export const DEFAULT_ASSISTANT_SUBSCRIPTION_ID = 'default'

export function isValidAssistantSubscriptionId(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value)
}

export function isValidAssistantPairingState(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1'
}

function hasUnambiguousNetworkUrlSyntax(raw: string): boolean {
  if (raw.trim() !== raw) {
    return false
  }
  for (const character of raw) {
    const codePoint = character.codePointAt(0) ?? 0
    if (
      character === '\\' ||
      /\s/u.test(character) ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return false
    }
  }
  const authority = /^(?:https?):\/\/([^/?#]+)/i.exec(raw)?.[1]
  return Boolean(authority && !authority.includes('@'))
}

function hasExplicitRawLoopbackAuthority(raw: string): boolean {
  const authority = /^(?:http):\/\/([^/?#]+)/i.exec(raw)?.[1]
  return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(authority ?? '')
}

/**
 * Validate the server-returned external OAuth destination again in the browser.
 * This prevents javascript/data navigation even if a server is misconfigured.
 */
export function safeAssistantAuthorizeUrl(raw: string, expectedState?: string): string | null {
  try {
    if (!hasUnambiguousNetworkUrlSyntax(raw)) {
      return null
    }
    const url = new URL(raw)
    const safeProtocol =
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && isLoopbackHost(url.hostname) && hasExplicitRawLoopbackAuthority(raw))
    if (!safeProtocol || url.username || url.password || url.hash) {
      return null
    }
    if (
      expectedState !== undefined &&
      (!isValidAssistantPairingState(expectedState) ||
        url.searchParams.getAll('state').length !== 1 ||
        url.searchParams.get('state') !== expectedState)
    ) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

/** Display-only provider origin; deliberately excludes path, query, and state. */
export function assistantAuthorizeOrigin(raw: string): string | null {
  const safe = safeAssistantAuthorizeUrl(raw)
  return safe ? new URL(safe).origin : null
}
