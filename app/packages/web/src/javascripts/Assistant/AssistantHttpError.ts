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
  return formatAssistantHttpError(response.status, target, await responseDetail(response))
}

/** Same error contract for an already-decoded authenticated socket JSON response. */
export function assistantJsonHttpError(status: number, data: unknown, target: AssistantHttpTarget): string {
  return formatAssistantHttpError(status, target, jsonErrorDetail(data))
}

function formatAssistantHttpError(status: number, target: AssistantHttpTarget, detail?: string): string {
  const prefix = target === 'direct' ? 'Assistant endpoint' : 'Assistant server proxy'
  let guidance = ''

  if (target === 'direct' && (status === 404 || status === 405)) {
    guidance =
      ' Check that Base URL is the OpenAI-compatible API root (for example http://localhost:1234/v1 for LM Studio). ' +
      'If you meant this Standard Red Notes server, choose Server proxy.'
  } else if (target === 'proxy' && status === 404) {
    guidance = ' The server does not expose the assistant proxy route; update and restart the server deployment.'
  } else if (status === 401 || status === 403) {
    guidance =
      target === 'proxy'
        ? ' Sign in again and confirm that your account is allowed to use the assistant.'
        : ' Check the configured API key or subscription credential.'
  } else if (status === 429) {
    guidance =
      ' The configured request or token limit has been reached; wait for its reset or contact the administrator.'
  }

  return `${prefix} returned HTTP ${status}.${guidance}${detail ? ` Provider message: ${detail}` : ''}`
}

/** Map fetch failures to a stable message instead of leaking browser internals. */
export function assistantNetworkError(error: unknown, target: AssistantHttpTarget, signal?: AbortSignal): string {
  const code = transportErrorCode(signal?.aborted ? signal.reason : error)
  if (
    [
      'CHAT_RUN_LEASE_LOST',
      'DEADLINE_EXCEEDED',
      'BACKEND_TIMEOUT',
      'SESSION_REVOKED',
      'SESSION_NOT_AUTHORIZED',
      'SESSION_STALE',
      'CANCELLED',
    ].includes(code ?? '')
  ) {
    return assistantStreamError(error, target, signal)
  }
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
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

/** A stream has already reached the proxy: a body interruption is not a reachability diagnosis. */
export function assistantStreamError(error: unknown, target: AssistantHttpTarget, signal?: AbortSignal): string {
  const code = transportErrorCode(signal?.aborted ? signal.reason : error)
  if (code === 'CHAT_RUN_LEASE_LOST') {
    return 'The assistant response stopped because this chat lost run ownership. The partial answer has been kept. Reconnect before asking it to continue; the request was not replayed.'
  }
  if (code === 'DEADLINE_EXCEEDED' || code === 'BACKEND_TIMEOUT') {
    return 'The assistant response reached its time limit. The partial answer has been kept. You can ask it to continue; the request was not replayed.'
  }
  if (code === 'SESSION_REVOKED' || code === 'SESSION_NOT_AUTHORIZED' || code === 'SESSION_STALE') {
    return 'The assistant response stopped because the session needs to be renewed. The partial answer has been kept. Reconnect before asking it to continue.'
  }
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError') || code === 'CANCELLED') {
    return 'Assistant response was stopped. The partial answer has been kept.'
  }
  const source = target === 'proxy' ? 'assistant proxy' : 'assistant endpoint'
  return `The connection to the ${source} was interrupted during the response. The partial answer has been kept. You can ask it to continue; the request was not replayed.`
}

function transportErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}
