const MAX_PROVIDER_DETAIL_LENGTH = 240

const cleanDetail = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }
  const withoutControls = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character
    })
    .join('')
  const cleaned = withoutControls.replace(/\s+/g, ' ').trim()
  return cleaned ? cleaned.slice(0, MAX_PROVIDER_DETAIL_LENGTH) : undefined
}

const jsonErrorDetail = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  const nested = record.error
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const nestedRecord = nested as Record<string, unknown>
    return cleanDetail(nestedRecord.message) ?? cleanDetail(nestedRecord.detail)
  }
  return cleanDetail(record.message) ?? cleanDetail(record.detail)
}

const responseDetail = async (response: Response): Promise<string | undefined> => {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      return jsonErrorDetail(await response.json())
    } catch {
      return undefined
    }
  }
  if (contentType.includes('text/html')) {
    return undefined
  }
  try {
    const text = await response.text()
    if (/^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(text)) {
      return undefined
    }
    return cleanDetail(text)
  } catch {
    return undefined
  }
}

export type AssistantHttpTarget = 'direct' | 'proxy'

/** Build a bounded, plain-text and actionable HTTP error without echoing HTML. */
export async function assistantHttpError(response: Response, target: AssistantHttpTarget): Promise<string> {
  const detail = await responseDetail(response)
  const prefix = target === 'direct' ? 'Assistant endpoint' : 'Assistant server proxy'
  let guidance = ''

  if (target === 'direct' && (response.status === 404 || response.status === 405)) {
    guidance =
      ' Check that Base URL is the OpenAI-compatible API root (for example http://localhost:1234/v1 for LM Studio). ' +
      'If you meant this Standard Red Notes server, choose Server proxy.'
  } else if (target === 'proxy' && response.status === 404) {
    guidance = ' The server does not expose the assistant proxy route; update and restart the server deployment.'
  } else if (response.status === 401 || response.status === 403) {
    guidance =
      target === 'proxy'
        ? ' Sign in again and confirm that your account is allowed to use the assistant.'
        : ' Check the configured API key or subscription credential.'
  } else if (response.status === 429) {
    guidance =
      ' The configured request or token limit has been reached; wait for its reset or contact the administrator.'
  }

  return `${prefix} returned HTTP ${response.status}.${guidance}${detail ? ` Provider message: ${detail}` : ''}`
}

/** Map fetch failures to a stable message instead of leaking browser internals. */
export function assistantNetworkError(error: unknown, target: AssistantHttpTarget): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'Assistant request was cancelled.'
  }
  const prefix =
    target === 'direct' ? 'Could not reach the assistant endpoint.' : 'Could not reach the assistant proxy.'
  const guidance =
    target === 'direct'
      ? ' Check that the service is running and that its CORS policy allows this app. For LM Studio, enable its local server and CORS support.'
      : ' Check your connection and whether the Standard Red Notes server is healthy.'
  return `${prefix}${guidance}`
}
