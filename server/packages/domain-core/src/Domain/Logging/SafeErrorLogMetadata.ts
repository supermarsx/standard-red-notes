export type SafeErrorLogMetadata = Readonly<{
  errorType: string
  errorCode?: string | number
  status?: number
}>

const KnownErrorTypes = new Set([
  'AbortError',
  'AggregateError',
  'AxiosError',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TimeoutError',
  'TypeError',
  'URIError',
])

const KnownErrorCodes = new Set([
  'AbortError',
  'EACCES',
  'EADDRINUSE',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOENT',
  'EPIPE',
  'ETIMEDOUT',
  'ERR_BAD_REQUEST',
  'ERR_BAD_RESPONSE',
  'ERR_CANCELED',
  'ERR_NETWORK',
  'SQLITE_BUSY',
  'TimeoutError',
])

function safeDataProperty(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }

  try {
    let current: object | null = value
    for (let depth = 0; current !== null && depth < 3; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor && 'value' in descriptor) {
        return descriptor.value
      }
      current = Object.getPrototypeOf(current)
    }
    return undefined
  } catch {
    return undefined
  }
}

function safeErrorType(value: unknown): string {
  return typeof value === 'string' && KnownErrorTypes.has(value) ? value : 'Error'
}

function safeErrorCode(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 999) {
    return value
  }
  if (typeof value === 'string' && KnownErrorCodes.has(value)) {
    return value
  }
  return undefined
}

/**
 * Returns a deliberately tiny error classification for operational logs.
 *
 * The implementation reads data properties only and never exposes exception
 * messages, stacks, errno values, URLs, SQL text, request/response objects, or
 * provider bodies. Callers may add independently derived booleans, counts, and
 * stable identifiers when those fields are safe for their context.
 */
export function safeErrorLogMetadata(error: unknown): SafeErrorLogMetadata {
  const response = safeDataProperty(error, 'response')
  const statusCandidate = safeDataProperty(error, 'status') ?? safeDataProperty(response, 'status')
  const status =
    typeof statusCandidate === 'number' &&
    Number.isSafeInteger(statusCandidate) &&
    statusCandidate >= 100 &&
    statusCandidate <= 599
      ? statusCandidate
      : undefined

  return {
    errorType: safeErrorType(safeDataProperty(error, 'name')),
    errorCode: safeErrorCode(safeDataProperty(error, 'code')),
    status,
  }
}
