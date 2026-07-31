const Redacted = '[REDACTED]'
const Circular = '[Circular]'
const Truncated = '[Truncated]'
const Accessor = '[Accessor]'
const Uninspectable = '[Uninspectable]'
const MaxDepth = 4
const MaxEntries = 24
const MaxStringLength = 256

const knownErrorCodes = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ERR_NETWORK',
])

function normalizedKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key)

  if (['user_id', 'request_id', 'connection_id'].includes(normalized)) {
    return false
  }

  return (
    normalized === 'authorization' ||
    normalized === 'cookie' ||
    normalized === 'cookies' ||
    normalized === 'set_cookie' ||
    normalized === 'body' ||
    normalized === 'config' ||
    normalized === 'content' ||
    normalized === 'data' ||
    normalized === 'email' ||
    normalized === 'message' ||
    normalized === 'password' ||
    normalized === 'payload' ||
    normalized === 'request' ||
    normalized === 'response' ||
    normalized === 'session' ||
    normalized === 'session_uuid' ||
    normalized.endsWith('_session_uuid') ||
    normalized.includes('api_key') ||
    normalized.includes('credential') ||
    normalized.includes('password') ||
    normalized.includes('secret') ||
    normalized.includes('session_key') ||
    normalized.includes('token')
  )
}

function safeDataProperty(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function safeErrorName(value: unknown): string {
  return typeof value === 'string' && ['Error', 'TypeError', 'RangeError'].includes(value) ? value : 'Error'
}

function safeErrorCode(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value
  }
  return typeof value === 'string' && knownErrorCodes.has(value) ? value : undefined
}

export function safeErrorLogMetadata(error: unknown): Record<string, unknown> {
  return {
    errorType: safeErrorName(safeDataProperty(error, 'name')),
    errorCode: safeErrorCode(safeDataProperty(error, 'code')),
  }
}

function sanitizeUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    const credentialContainer =
      /^(?:subscription-?tokens?|tokens?|credentials?|secrets?|passwords?|api-?keys?|magic-?links?|recovery|shares?|callbacks?)$/i
    const path = parsed.pathname
      .split('/')
      .map((segment, index, segments) => {
        const opaquePathSegment =
          /^[0-9a-f]{32,}$/i.test(segment) ||
          /^[A-Za-z0-9._~+=-]{48,}$/.test(segment) ||
          (segment.length >= 24 && /[a-z]/.test(segment) && /[A-Z]/.test(segment) && /\d/.test(segment))

        return credentialContainer.test(segments[index - 1] ?? '') || /@|%40/i.test(segment) || opaquePathSegment
          ? Redacted
          : segment
      })
      .join('/')
    let queryParameterCount = 0
    parsed.searchParams.forEach(() => {
      queryParameterCount += 1
    })
    return `${parsed.origin}${path}${queryParameterCount > 0 ? ` [query-parameter-count=${queryParameterCount}]` : ''}`
  } catch {
    return '[unparseable-url]'
  }
}

function sanitizeString(value: string): string {
  const sanitized = value
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => sanitizeUrl(url))
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${Redacted}`)
    .replace(
      /\b(authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?(?:key|uuid)|password|credential|client[_-]?secret|api[_-]?key|email)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      (_match, key: string, separator: string) => `${key}${separator}${Redacted}`,
    )
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, Redacted)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')

  return sanitized.length > MaxStringLength ? `${sanitized.slice(0, MaxStringLength)}${Truncated}` : sanitized
}

function isError(value: object): boolean {
  try {
    return value instanceof Error
  } catch {
    return false
  }
}

export function redactLogValue(value: unknown): unknown {
  const visited = new WeakSet<object>()

  const visit = (current: unknown, depth: number): unknown => {
    if (depth >= MaxDepth) {
      return Truncated
    }
    if (typeof current === 'string') {
      return sanitizeString(current)
    }
    if (current === null || ['number', 'boolean', 'undefined'].includes(typeof current)) {
      return current
    }
    if (typeof current === 'bigint') {
      return String(current).slice(0, MaxStringLength)
    }
    if (typeof current === 'symbol') {
      return '[Symbol]'
    }
    if (typeof current === 'function') {
      return '[Function]'
    }
    if (visited.has(current as object)) {
      return Circular
    }
    visited.add(current as object)

    if (isError(current as object)) {
      return safeErrorLogMetadata(current)
    }

    let ownKeys: PropertyKey[]
    try {
      ownKeys = Reflect.ownKeys(current as object)
    } catch {
      return Uninspectable
    }

    const result: Record<PropertyKey, unknown> = {}
    for (const key of ownKeys.slice(0, MaxEntries)) {
      if (typeof key === 'string' && isSensitiveKey(key)) {
        result[key] = Redacted
        continue
      }

      let descriptor: PropertyDescriptor | undefined
      try {
        descriptor = Object.getOwnPropertyDescriptor(current as object, key)
      } catch {
        result[key] = Uninspectable
        continue
      }
      if (!descriptor || !('value' in descriptor)) {
        result[key] = Accessor
        continue
      }

      result[key] = visit(descriptor.value, depth + 1)
    }
    if (ownKeys.length > MaxEntries) {
      result.truncated = true
    }
    return result
  }

  try {
    return visit(value, 0)
  } catch {
    return Uninspectable
  }
}

export function safeLogArguments(args: unknown[]): unknown[] {
  return args.map((argument) => redactLogValue(argument))
}
