export type RequestBodyLogMetadata = {
  kind: 'absent' | 'object' | 'array' | 'primitive' | 'uninspectable'
  fieldCount?: number
  elementCount?: number
  primitiveType?: string
}

/**
 * Return structural request-body metadata without ever serializing values.
 * Authentication, recovery, import, and settings bodies can contain passwords,
 * tokens, encrypted payloads, and third-party credentials; none belong in logs,
 * even at debug level or while handling an unrelated server error.
 */
export function requestBodyLogMetadata(body: unknown): RequestBodyLogMetadata {
  if (body === undefined || body === null) {
    return { kind: 'absent' }
  }

  if (Array.isArray(body)) {
    return { kind: 'array', elementCount: body.length }
  }

  if (typeof body === 'object') {
    try {
      return { kind: 'object', fieldCount: Object.keys(body).length }
    } catch {
      return { kind: 'uninspectable' }
    }
  }

  return { kind: 'primitive', primitiveType: typeof body }
}
