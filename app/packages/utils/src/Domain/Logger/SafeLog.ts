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

/**
 * `SomethingError` is a class name chosen in source, never a runtime value, so it cannot carry
 * user data. Matching the shape rather than a fixed list keeps our own error taxonomy legible
 * in logs without the list drifting every time an error class is added.
 */
const errorClassNamePattern = /^[A-Za-z]{1,64}Error$/

/**
 * SCREAMING_SNAKE codes are likewise authored constants. Identifiers that could carry user data
 * (uuids, emails, hosts, tokens) all contain lowercase letters or punctuation this rejects.
 */
const constantErrorCodePattern = /^[A-Z][A-Z0-9_]{1,63}$/

function safeErrorName(value: unknown): string {
  if (typeof value !== 'string') {
    return 'Error'
  }
  return value === 'Error' || errorClassNamePattern.test(value) ? value : 'Error'
}

function safeErrorCode(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value
  }
  if (typeof value === 'string' && (knownErrorCodes.has(value) || constantErrorCodePattern.test(value))) {
    return value
  }
  return undefined
}

/**
 * *** `errorType` USED TO BE 'Error' FOR EVERY NATIVE ERROR, INCLUDING SUBCLASSES. ***
 *
 * `name` is an OWN property only on objects that assign one (our own classes, and the
 * object literals this file's tests are written from). On `new TypeError(...)` it lives
 * on `TypeError.prototype`, so an own-property read returned undefined and the field
 * reported `Error` — for a plain Error, a TypeError and a RangeError alike. The one
 * field meant to say which error this was could not distinguish them, and the spec
 * could not see it because its fixture was a literal with an own `name`.
 *
 * The prototype walk stays within DATA descriptors, so, exactly like `safeDataProperty`,
 * it never invokes an accessor; and the value still has to pass `safeErrorName`.
 */
function safeInheritedDataProperty(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  try {
    let current: object | null = value
    for (let depth = 0; current !== null && depth <= MaxDepth; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor) {
        return 'value' in descriptor ? descriptor.value : undefined
      }
      current = Object.getPrototypeOf(current)
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * The marker a call site sets on an error whose `message` is a string LITERAL authored
 * in this repository: `error.authoredLogMessage = true` (see `authoredLogMessage`).
 *
 * `message` is stripped from every other error ON PURPOSE, and that must not soften:
 * an upstream message routinely carries a bearer token, an e-mail address or a note
 * title, and this file's own spec pins `Bearer access-token-sentinel` as a message that
 * must never be logged. But the opposite failure is just as real — `Sync transport
 * recovery failed before collecting uploads { errorType: "Error", errorCode: undefined,
 * status: undefined }` is a production log line that says only that SOMETHING threw,
 * which is a diagnostic that cannot fail and cannot help.
 *
 * So the message is carried by an explicit opt-in rather than by a denylist over message
 * text: a shape test ("no e-mail, no URL, no digits") would pass "Dinner plans with
 * mum" and fail an authored sentence that happens to contain a number. The opt-in is
 * only ever correct for a literal; it is not for a message built from a value.
 *
 * It is still sanitized before it is logged, so a call site that marks an interpolated
 * message by mistake cannot turn this field into a credential channel.
 */
const AuthoredLogMessageMarker = 'authoredLogMessage'

/**
 * Marks `error`'s message as authored in source and therefore safe to log. Only ever
 * correct for a message that is a string literal — see `AuthoredLogMessageMarker`.
 */
export function authoredLogMessage<T extends Error>(error: T): T {
  try {
    Object.defineProperty(error, AuthoredLogMessageMarker, {
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    })
  } catch {
    // A frozen or sealed error simply keeps its message out of the log. Nothing a
    // logging helper is asked to do is worth turning a handled rejection into a throw.
  }
  return error
}

function safeAuthoredErrorMessage(error: unknown): string | undefined {
  if (safeDataProperty(error, AuthoredLogMessageMarker) !== true) {
    return undefined
  }
  const message = safeDataProperty(error, 'message')
  if (typeof message !== 'string' || message.length === 0) {
    return undefined
  }
  return sanitizeString(message)
}

/** Enough to name the throw site and its caller; a log line is not a crash report. */
const MaxLoggedStackFrames = 4

/**
 * `at Name (resource:line:column)` and the bare `at resource:line:column`, which between
 * them cover every frame V8, SpiderMonkey and JavaScriptCore emit that is of any use.
 * Numbered groups because this package targets a language level without named ones:
 * 1 = function name (optional), 2 = resource, 3 = line, 4 = column.
 */
const stackFramePattern = /\bat\s+(?:([A-Za-z_$][A-Za-z0-9_$.<>]{0,80})\s+)?\(?([^\s()]*?):(\d{1,9}):(\d{1,9})\)?\s*$/

/**
 * One frame, REBUILT from matched pieces rather than redacted in place. A stack cannot be
 * cleaned by removing the bad parts of it: on desktop and in Node every frame reads
 * `at fn (file:///C:/Users/<the user's name>/…)`, and `sanitizeString` only knows how to
 * sanitize http(s) URLs, so a stripped-and-logged frame would publish the account
 * holder's OS user name — exactly the class of thing this file exists to keep out of a
 * log. Each piece of the output therefore has to match a shape first: an
 * identifier-shaped function name, a basename-shaped resource, and decimal digits.
 * Anything else is dropped, including the whole frame.
 */
function safeStackFrame(line: string): string | undefined {
  const match = stackFramePattern.exec(line)
  if (!match) {
    return undefined
  }

  const basename = (match[2] ?? '').split(/[\\/]/).pop() ?? ''
  const resource = /^[A-Za-z0-9._-]{1,64}$/.test(basename) ? basename : '[resource]'
  const name = match[1] === undefined ? '' : `${match[1]} `

  return `at ${name}(${resource}:${match[3]}:${match[4]})`
}

/**
 * Frames only, so WHERE an unexpected error was thrown survives even when its message
 * cannot be logged. The header line (`Error: <message>`) is dropped: it embeds the very
 * message this function refuses to carry unmarked.
 *
 * Read through the accessor rather than `safeDataProperty`, because V8 installs `stack`
 * as an own ACCESSOR, so a data-descriptor read returns undefined for every real error.
 * Narrowed to `instanceof Error` so no arbitrary object's getter is ever invoked, and
 * guarded in case an engine's own getter throws.
 */
function safeErrorStack(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined
  }

  let raw: unknown
  try {
    raw = error.stack
  } catch {
    return undefined
  }
  if (typeof raw !== 'string') {
    return undefined
  }

  const frames: string[] = []
  for (const line of raw.split('\n')) {
    if (frames.length >= MaxLoggedStackFrames) {
      break
    }
    const frame = safeStackFrame(line)
    if (frame !== undefined) {
      frames.push(frame)
    }
  }

  return frames.length > 0 ? frames.join('\n') : undefined
}

export function safeErrorLogMetadata(error: unknown): Record<string, unknown> {
  const rawStatus = safeDataProperty(error, 'status')
  const status = typeof rawStatus === 'number' && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : undefined
  const message = safeAuthoredErrorMessage(error)
  const stack = safeErrorStack(error)

  return {
    errorType: safeErrorName(safeInheritedDataProperty(error, 'name')),
    errorCode: safeErrorCode(safeDataProperty(error, 'code')),
    status,
    ...(message !== undefined ? { message } : {}),
    ...(stack !== undefined ? { stack } : {}),
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
