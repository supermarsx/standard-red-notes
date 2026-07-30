const DEFAULT_HTTP_TIMEOUT_MS = 10_000
const MAX_HTTP_TIMEOUT_MS = 60_000
const MAX_ERROR_DETAIL_LENGTH = 300

export function providerTimeoutSignal(timeoutMs?: number): AbortSignal {
  const boundedTimeout =
    Number.isSafeInteger(timeoutMs) && (timeoutMs as number) > 0
      ? Math.min(timeoutMs as number, MAX_HTTP_TIMEOUT_MS)
      : DEFAULT_HTTP_TIMEOUT_MS

  return AbortSignal.timeout(boundedTimeout)
}

export async function responseErrorDetail(response: Response, secrets: string[]): Promise<string> {
  try {
    return redactAndBound(await response.text(), secrets)
  } catch {
    return ''
  }
}

export function transportFailureReason(prefix: string, error: unknown, secrets: string[]): string {
  const errorName =
    typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : ''
  if (errorName === 'AbortError' || errorName === 'TimeoutError') {
    return `${prefix} timed out.`
  }

  const detail = redactAndBound(error instanceof Error ? error.message : String(error), secrets)

  return `${prefix} failed${detail ? `: ${detail}` : ''}.`
}

export function redactAndBound(value: string, secrets: string[]): string {
  let redacted = value
  const variants = secrets
    .flatMap((secret) => {
      const trimmed = secret.trim()
      if (trimmed.length === 0) {
        return []
      }

      return [trimmed, encodeURIComponent(trimmed), Buffer.from(trimmed).toString('base64')]
    })
    .filter((secret, index, values) => values.indexOf(secret) === index)
    .sort((left, right) => right.length - left.length)

  for (const secret of variants) {
    redacted = redacted.split(secret).join('[REDACTED]')
  }

  return redacted
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_DETAIL_LENGTH)
}
