export type OpenAICompatibleRoute = 'chat/completions' | 'models' | 'audio/speech' | 'audio/transcriptions'

const ENDPOINT_SUFFIXES = ['/chat/completions', '/audio/transcriptions', '/audio/speech', '/models'] as const

const isLoopbackHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost' || normalized === '127.0.0.1'
}

const currentPageOrigin = (): string | undefined => {
  try {
    return globalThis.location?.origin
  } catch {
    return undefined
  }
}

/**
 * Parse and canonicalize the user-facing OpenAI-compatible base URL.
 *
 * The Preferences copy calls this a *base* URL, but people routinely paste a
 * host (`http://localhost:1234`) or the full Chat Completions route. Accept both
 * forms and persist one stable API root. A bare origin gets the conventional
 * `/v1` suffix used by LM Studio, Ollama and OpenAI.
 */
export function normalizeOpenAICompatibleBaseURL(raw: string): string {
  const value = raw.trim()
  if (!value) {
    throw new Error('Enter an OpenAI-compatible base URL.')
  }
  if (/\s|\\/.test(value)) {
    throw new Error('The assistant base URL contains unsupported whitespace or backslashes.')
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Enter a full assistant URL beginning with http:// or https://.')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The assistant base URL must use http:// or https://.')
  }
  if (url.username || url.password) {
    throw new Error('Put credentials in the API key field, not in the assistant URL.')
  }
  if (url.search || url.hash) {
    throw new Error('The assistant base URL cannot contain a query string or fragment.')
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error(
      'Plain HTTP assistant URLs are allowed only on http://localhost or http://127.0.0.1. Use HTTPS for every other host.',
    )
  }

  let path = url.pathname.replace(/\/+$/, '')
  const lowerPath = path.toLowerCase()
  const pastedEndpoint = ENDPOINT_SUFFIXES.find((suffix) => lowerPath.endsWith(suffix))
  if (pastedEndpoint) {
    path = path.slice(0, -pastedEndpoint.length).replace(/\/+$/, '')
  }
  if (!path) {
    path = pastedEndpoint ? '/' : '/v1'
  }

  url.pathname = path
  return url.toString().replace(/\/$/, '')
}

/**
 * Resolve one standard route without ever duplicating `/v1` or
 * `/chat/completions` when a full endpoint was pasted into Preferences.
 */
export function openAICompatibleEndpointURL(rawBaseURL: string, route: OpenAICompatibleRoute): string {
  return `${normalizeOpenAICompatibleBaseURL(rawBaseURL)}/${route}`
}

/**
 * Extract model ids that are safe to advertise to the tool-using assistant.
 * OpenRouter declares support with `supported_parameters`; generic compatible
 * servers omit it. Keep absent or malformed metadata backward compatible and
 * exclude only a valid string array that explicitly omits `tools`.
 */
export function discoverableOpenAICompatibleModelIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return []
  }
  const data = (payload as Record<string, unknown>).data
  if (!Array.isArray(data)) {
    return []
  }

  const ids: string[] = []
  for (const value of data) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue
    }
    const entry = value as Record<string, unknown>
    const parameters = entry.supported_parameters
    const explicitlyUnsupported =
      Array.isArray(parameters) &&
      parameters.every((parameter): parameter is string => typeof parameter === 'string') &&
      !parameters.includes('tools')
    if (!explicitlyUnsupported && typeof entry.id === 'string' && entry.id.length > 0) {
      ids.push(entry.id)
    }
  }
  return ids
}

/**
 * Catch the common production misconfiguration behind nginx's HTML 405 page:
 * Direct mode was pointed at the Standard Red Notes web origin instead of an
 * LLM API. A custom same-origin path remains valid for deployments that really
 * do mount an OpenAI-compatible service beside the app.
 */
export function directEndpointConfigurationError(rawBaseURL: string): string | undefined {
  let normalized: string
  try {
    normalized = normalizeOpenAICompatibleBaseURL(rawBaseURL)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }

  const pageOrigin = currentPageOrigin()
  if (!pageOrigin) {
    return undefined
  }

  const url = new URL(normalized)
  if (url.origin === pageOrigin && (url.pathname === '/v1' || url.pathname === '/')) {
    return (
      'This is the Standard Red Notes web address, not an AI model endpoint. ' +
      'Choose Server proxy for a server-managed provider, or use an OpenAI-compatible base URL such as ' +
      'http://localhost:1234/v1 for LM Studio.'
    )
  }
  return undefined
}
