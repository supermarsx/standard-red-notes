import { Request } from 'express'

export const MAX_VALET_TOKEN_LENGTH = 8 * 1024

function validToken(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      return undefined
    }
    value = value[0]
  }

  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_VALET_TOKEN_LENGTH) {
    return undefined
  }

  return value
}

/**
 * Read a bounded valet credential without assuming body-parser created a body.
 * Query-string credentials are intentionally rejected because URLs are commonly
 * retained by access logs, browser history, reverse proxies, and tracing.
 */
export function readValetToken(request: Request): string | undefined {
  const headerToken = request.headers['x-valet-token']
  if (headerToken !== undefined) {
    return validToken(headerToken)
  }

  const bodyToken =
    request.body !== null && typeof request.body === 'object'
      ? (request.body as Record<string, unknown>).valetToken
      : undefined

  return validToken(bodyToken)
}
