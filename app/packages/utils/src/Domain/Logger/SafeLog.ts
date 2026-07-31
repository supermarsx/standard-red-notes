const Redacted = '[REDACTED]'
const Circular = '[Circular]'
const Truncated = '[Truncated]'
const Accessor = '[Accessor]'
const Uninspectable = '[Uninspectable]'
const MaxDepth = 4
const MaxCollectionEntries = 24
const MaxStringLength = 256
const RelativeUrlBase = 'http://relative.invalid'

function normalizedKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key)

  if (['user_id', 'request_id'].includes(normalized)) {
    return false
  }

  return (
    normalized === 'authorization' ||
    normalized === 'cookie' ||
    normalized === 'cookies' ||
    normalized === 'set_cookie' ||
    normalized === 'config' ||
    normalized === 'request' ||
    normalized === 'response' ||
    normalized === 'body' ||
    normalized === 'data' ||
    normalized === 'payload' ||
    normalized === 'session' ||
    normalized === 'session_uuid' ||
    normalized === 'user' ||
    normalized === 'email' ||
    normalized === 'username' ||
    normalized === 'password' ||
    normalized === 'passcode' ||
    normalized === 'credential' ||
    normalized === 'content' ||
    normalized === 'encrypted' ||
    normalized === 'pkce' ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('credential') ||
    normalized.includes('code_challenge') ||
    normalized.includes('code_verifier') ||
    normalized.includes('api_key') ||
    normalized.includes('session_key') ||
    normalized.includes('key_params') ||
    normalized.includes('encrypted_')
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

function sanitizePathname(pathname: string): string {
  const segments = pathname.split('/')
  const credentialContainer =
    /^(?:subscription-?tokens?|tokens?|credentials?|secrets?|passwords?|api-?keys?|magic-?links?|recovery|shares?|callbacks?)$/i

  return segments
    .map((segment, index) => {
      const previousSegment = segments[index - 1] ?? ''
      const opaquePathSegment =
        /^[0-9a-f]{32,}$/i.test(segment) ||
        /^[A-Za-z0-9._~+=-]{48,}$/.test(segment) ||
        (segment.length >= 24 && /[a-z]/.test(segment) && /[A-Z]/.test(segment) && /\d/.test(segment))
      if (credentialContainer.test(previousSegment) || /@|%40/i.test(segment) || opaquePathSegment) {
        return Redacted
      }

      return segment
    })
    .join('/')
}

export function sanitizeUrlForSafeLog(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return '[unavailable-url]'
  }

  try {
    const parsed = new URL(rawUrl, RelativeUrlBase)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '[unparseable-url]'
    }

    const isAbsolute = /^[a-z][a-z\d+.-]*:\/\//i.test(rawUrl)
    const origin = isAbsolute ? parsed.origin : ''
    const pathname = sanitizePathname(parsed.pathname || '/')
    let queryParameterCount = 0
    parsed.searchParams.forEach(() => {
      queryParameterCount += 1
    })

    return `${origin}${pathname}${queryParameterCount > 0 ? ` [query-parameter-count=${queryParameterCount}]` : ''}`
  } catch {
    return '[unparseable-url]'
  }
}

function sanitizeString(value: string): string {
  const redacted = value
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${Redacted}`)
    .replace(
      /\b(authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|auth[_-]?token|offline[_-]?token|features[_-]?token|subscription[_-]?token|session[_-]?key|password|passcode|credential|client[_-]?secret|api[_-]?key|code[_-]?(?:challenge|verifier)|email)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      (_match, key: string, separator: string) => `${key}${separator}${Redacted}`,
    )
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, Redacted)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => sanitizeUrlForSafeLog(url))

  return redacted.length > MaxStringLength ? `${redacted.slice(0, MaxStringLength)}${Truncated}` : redacted
}

export function redactLogValue(value: unknown): unknown {
  const visited = new WeakSet<object>()

  const visit = (current: unknown, depth: number): unknown => {
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
    if (depth >= MaxDepth) {
      return Truncated
    }
    if (visited.has(current as object)) {
      return Circular
    }
    visited.add(current as object)

    let ownKeys: PropertyKey[]
    try {
      ownKeys = Reflect.ownKeys(current as object)
    } catch {
      return Uninspectable
    }

    const result: Record<PropertyKey, unknown> = {}
    const requiredSymbols = [Symbol.for('level'), Symbol.for('message'), Symbol.for('splat')]
    const requiredStringKeys = ['level', 'message']
    const prioritizedKeys = [
      ...requiredSymbols.filter((symbol) => ownKeys.includes(symbol)),
      ...requiredStringKeys.filter((key) => ownKeys.includes(key)),
      ...ownKeys
        .filter((key) => !requiredSymbols.includes(key as symbol) && !requiredStringKeys.includes(key as string))
        .slice(0, MaxCollectionEntries),
    ]

    for (const key of prioritizedKeys) {
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

      const propertyValue = descriptor.value
      if (typeof key === 'string' && /(url|uri|endpoint)$/i.test(key)) {
        result[key] = sanitizeUrlForSafeLog(propertyValue)
      } else {
        result[key] = visit(propertyValue, depth + 1)
      }
    }

    if (
      ownKeys.filter((key) => !requiredSymbols.includes(key as symbol) && !requiredStringKeys.includes(key as string))
        .length > MaxCollectionEntries
    ) {
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

// SAFE_LOG_SHARED_KERNEL_END

const knownErrorCodes = new Set([
  'AbortError',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ERR_BAD_REQUEST',
  'ERR_BAD_RESPONSE',
  'ERR_CANCELED',
  'ERR_NETWORK',
  'TimeoutError',
])

function safeErrorName(value: unknown): string {
  return typeof value === 'string' &&
    ['Error', 'TypeError', 'RangeError', 'AxiosError', 'AbortError', 'TimeoutError'].includes(value)
    ? value
    : 'Error'
}

function safeErrorCode(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value
  }
  if (typeof value === 'string' && knownErrorCodes.has(value)) {
    return value
  }
  return undefined
}

export function safeErrorLogMetadata(error: unknown): Record<string, unknown> {
  const rawStatus = safeDataProperty(error, 'status')
  const status = typeof rawStatus === 'number' && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined

  return {
    errorType: safeErrorName(safeDataProperty(error, 'name')),
    errorCode: safeErrorCode(safeDataProperty(error, 'code')),
    status,
  }
}

export function safeHttpLogMetadata(
  request: {
    url?: unknown
    verb?: unknown
  },
  response?: {
    status?: unknown
  },
): Record<string, unknown> {
  const rawMethod = safeDataProperty(request, 'verb')
  const rawStatus = safeDataProperty(response, 'status')
  const method = typeof rawMethod === 'string' && /^[A-Z]{3,10}$/i.test(rawMethod) ? rawMethod.toUpperCase() : undefined
  const status = typeof rawStatus === 'number' && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined

  return {
    method,
    url: sanitizeUrlForSafeLog(safeDataProperty(request, 'url')),
    status,
  }
}
