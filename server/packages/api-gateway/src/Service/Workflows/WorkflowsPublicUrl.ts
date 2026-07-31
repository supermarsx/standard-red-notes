const MAX_PUBLIC_URL_LENGTH = 2_048
const LOOPBACK_IPV4_PATTERN = /^127(?:\.\d{1,3}){3}$/

export type WorkflowsPublicUrlError =
  | 'required'
  | 'too-long'
  | 'surrounding-whitespace'
  | 'control-character'
  | 'invalid-url'
  | 'unsafe-authority'
  | 'credentials'
  | 'query'
  | 'fragment'
  | 'insecure'
  | 'same-host'
  | 'cookie-domain'
  | 'invalid-cookie-domain'

export type WorkflowsPublicUrlValidation =
  { valid: true; url: string } | { valid: false; error: WorkflowsPublicUrlError }

export interface WorkflowsPublicUrlOptions {
  /**
   * The Standard Red Notes origin serving the current request. When known, the
   * n8n URL must use a different origin so SRN never acts as n8n's auth proxy.
   */
  applicationOrigin?: string | null
  /**
   * Optional configured SRN auth-cookie Domain. A sibling n8n hostname inside
   * that scope would receive the SRN cookie because cookie matching ignores
   * ports and origins, so it must be rejected.
   */
  forbiddenCookieDomain?: string | null
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || code === 0x7f) {
      return true
    }
  }
  return false
}

function isExplicitLoopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized === '[::1]') {
    return true
  }
  if (!LOOPBACK_IPV4_PATTERN.test(normalized)) {
    return false
  }
  return normalized
    .split('.')
    .slice(1)
    .every((part) => Number(part) >= 0 && Number(part) <= 255)
}

function parsedApplicationUrl(value: string | null | undefined): URL | null {
  if (!value) {
    return null
  }
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null
  } catch {
    return null
  }
}

function rawAuthorityHostname(authority: string): string | null {
  const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1)
  if (hostAndPort.startsWith('[')) {
    const close = hostAndPort.indexOf(']')
    return close > 0 ? hostAndPort.slice(0, close + 1) : null
  }
  const colon = hostAndPort.lastIndexOf(':')
  if (colon >= 0 && /^\d+$/.test(hostAndPort.slice(colon + 1))) {
    return hostAndPort.slice(0, colon)
  }
  return hostAndPort
}

/**
 * Validate the browser-facing n8n editor URL.
 *
 * This URL is navigation metadata only. Standard Red Notes never fetches it,
 * proxies it, appends credentials to it, or treats it as an authorization
 * boundary. HTTPS is mandatory outside explicit loopback development.
 */
export function validateWorkflowsPublicUrl(
  value: unknown,
  options: WorkflowsPublicUrlOptions = {},
): WorkflowsPublicUrlValidation {
  if (typeof value !== 'string' || value.length === 0) {
    return { valid: false, error: 'required' }
  }
  if (value.length > MAX_PUBLIC_URL_LENGTH) {
    return { valid: false, error: 'too-long' }
  }
  if (value !== value.trim()) {
    return { valid: false, error: 'surrounding-whitespace' }
  }
  if (containsControlCharacter(value) || value.includes('\\')) {
    return { valid: false, error: 'control-character' }
  }
  if (!/^https?:\/\//i.test(value)) {
    return { valid: false, error: 'invalid-url' }
  }

  // Reject user-info and encoded/deceptive authorities before URL canonicalizes
  // them. Paths may contain percent escapes; the authority may not.
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(value)?.[1]
  const authorityHostname = authority ? rawAuthorityHostname(authority) : null
  if (!authority || !authorityHostname || /[%\s]/.test(authority) || authorityHostname.endsWith('.')) {
    return { valid: false, error: 'unsafe-authority' }
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { valid: false, error: 'invalid-url' }
  }
  if (!parsed.hostname || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return { valid: false, error: 'invalid-url' }
  }
  if (authorityHostname.toLowerCase() !== parsed.hostname.toLowerCase()) {
    return { valid: false, error: 'unsafe-authority' }
  }
  if (parsed.username || parsed.password) {
    return { valid: false, error: 'credentials' }
  }
  if (parsed.search) {
    return { valid: false, error: 'query' }
  }
  if (parsed.hash) {
    return { valid: false, error: 'fragment' }
  }
  if (parsed.protocol === 'http:' && !isExplicitLoopback(parsed.hostname)) {
    return { valid: false, error: 'insecure' }
  }

  const applicationUrl = parsedApplicationUrl(options.applicationOrigin)
  if (applicationUrl && parsed.hostname.toLowerCase() === applicationUrl.hostname.toLowerCase()) {
    return { valid: false, error: 'same-host' }
  }

  const rawCookieDomain = options.forbiddenCookieDomain?.trim().toLowerCase()
  const cookieDomain = rawCookieDomain?.replace(/^\./, '')
  if (
    cookieDomain &&
    (!/^[a-z0-9.-]+$/.test(cookieDomain) ||
      cookieDomain.startsWith('.') ||
      cookieDomain.endsWith('.') ||
      cookieDomain.includes('..'))
  ) {
    return { valid: false, error: 'invalid-cookie-domain' }
  }
  const targetHostname = parsed.hostname.toLowerCase()
  if (cookieDomain && (targetHostname === cookieDomain || targetHostname.endsWith(`.${cookieDomain}`))) {
    return { valid: false, error: 'cookie-domain' }
  }

  return { valid: true, url: parsed.toString() }
}

export function workflowsPublicUrlErrorMessage(error: WorkflowsPublicUrlError): string {
  switch (error) {
    case 'required':
      return 'A public n8n URL is required.'
    case 'too-long':
      return `The public n8n URL may not exceed ${MAX_PUBLIC_URL_LENGTH} characters.`
    case 'surrounding-whitespace':
      return 'The public n8n URL must not contain surrounding whitespace.'
    case 'control-character':
      return 'The public n8n URL contains an unsafe character.'
    case 'unsafe-authority':
      return 'The public n8n URL contains a deceptive or unsafe authority.'
    case 'credentials':
      return 'The public n8n URL must not contain a username or password.'
    case 'query':
      return 'The public n8n URL must not contain a query string.'
    case 'fragment':
      return 'The public n8n URL must not contain a fragment.'
    case 'insecure':
      return 'The public n8n URL must use HTTPS; HTTP is allowed only for explicit loopback development.'
    case 'same-host':
      return 'The public n8n URL must use a different hostname from Standard Red Notes.'
    case 'cookie-domain':
      return 'The public n8n hostname falls inside the configured Standard Red Notes cookie domain.'
    case 'invalid-cookie-domain':
      return 'The configured Standard Red Notes cookie domain is invalid, so the public n8n URL is withheld.'
    default:
      return 'The public n8n URL is invalid.'
  }
}
