import { PinnedHttpError, PinnedHttpResponse, SsrfValidationError } from '@standardnotes/domain-core'

import { DavAccountPin, DavCredentialKind } from './DavAccountStore'
import { DavBridgeRefusal, davRefusal } from './DavBridgeRefusal'
import { DavNetworkPolicy } from './DavNetworkPolicy'
import { SecretString } from './SecretString'

/**
 * Standard Red Notes: the DAV relay.
 *
 * It forwards ONE request from a signed-in user's app to that user's own
 * external CalDAV account, adding the stored credential, and hands the answer
 * back. It stores nothing, caches nothing, parses neither XML nor iCalendar,
 * and never retries.
 *
 * What stops it from being a general proxy, each enforced here and not left to
 * the client:
 *
 *   origin lock   the request goes to the account's stored origin and nowhere
 *                 else; the caller supplies a path, never a URL;
 *   method list   OPTIONS, PROPFIND, REPORT, GET. Write methods are named so
 *                 that they can be refused by name: this build never forwards
 *                 one, whatever a client sends;
 *   path pin      once setup has found the account's calendar home, only paths
 *                 under it and under the principal are forwarded, so a stolen
 *                 session cannot use a stored Nextcloud password to read that
 *                 person's files or contacts. Before the pin, only discovery
 *                 methods are forwarded, and only for a short time after the
 *                 password was entered;
 *   header list   five request headers in, six response headers out;
 *   ceilings      body sizes both ways and one deadline for the whole exchange,
 *                 redirects included;
 *   redirects     followed only inside the account's origin, and every hop is
 *                 put through all of the above and the network policy again.
 */

export const DAV_READ_METHODS = ['OPTIONS', 'PROPFIND', 'REPORT', 'GET'] as const
export const DAV_WRITE_METHODS = ['PUT', 'DELETE', 'MKCALENDAR'] as const
/** Forwarded outside the pin while the discovery window is open. Nothing else is. */
export const DAV_DISCOVERY_METHODS: readonly string[] = ['OPTIONS', 'PROPFIND']

export type DavReadMethod = (typeof DAV_READ_METHODS)[number]

/**
 * Whether this build forwards write methods. It does not. Phase 1 of the bridge
 * is read-only as a property of the SERVER: a client bug, an old client or a
 * hostile one cannot change an external calendar through it.
 */
export const DAV_RELAY_WRITE_ENABLED = false

export const DAV_RELAY_LIMITS = {
  requestBodyBytes: 1024 * 1024,
  responseBodyBytes: 8 * 1024 * 1024,
  requestTimeoutMs: 30_000,
  pathLength: 2048,
  headerValueLength: 1024,
  responseHeaderValueLength: 4096,
  maxRedirects: 3,
  discoveryWindowSeconds: 900,
} as const

const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  depth: 'Depth',
  'if-match': 'If-Match',
  'if-none-match': 'If-None-Match',
  'content-type': 'Content-Type',
  prefer: 'Prefer',
}

const RESPONSE_HEADERS: readonly string[] = ['etag', 'content-type', 'dav', 'allow', 'retry-after']

const FOLLOWED_REDIRECT_STATUSES: readonly number[] = [301, 302, 307, 308]

const USER_AGENT = 'StandardRedNotes-DavBridge/1'

const CONTENT_TYPE_PATTERN =
  /^(application\/xml|text\/xml|text\/calendar)(\s*;\s*[a-z0-9-]+\s*=\s*("[\x20\x21\x23-\x7e]*"|[a-z0-9._+-]+))*$/i

export interface DavRelayRequest {
  method: DavReadMethod
  path: string
  /** Canonical header name -> value, already validated. */
  headers: Record<string, string>
  body: Buffer | undefined
}

export interface DavRemoteAnswer {
  status: number
  headers: Record<string, string>
  body: string
  bodyEncoding: 'utf8' | 'base64'
  path: string
  redirects: number
}

/** Everything the relay needs to know about the account. Built by the service, never by a client. */
export interface DavRelayTarget {
  /** The account's stored origin: scheme, host and port, nothing after. */
  origin: string
  credentialKind: DavCredentialKind
  username: string
  secret: SecretString
  pin: Pick<DavAccountPin, 'principalPath' | 'calendarHomePath'> | null
  discoveryOpen: boolean
  allowedPrivateOrigins: ReadonlySet<string>
}

export type DavRelayOutcome =
  | { kind: 'remote'; answer: DavRemoteAnswer; requestBytes: number; responseBytes: number }
  /** The remote answered 401. Never handed to a client as a remote answer; the service acts on it. */
  | { kind: 'unauthorized'; requestBytes: number }

/** The exchange was cancelled from this side (the caller left, or the account was removed). */
export class DavRelayAbortedError extends Error {
  constructor() {
    super('The relayed request was cancelled.')
    this.name = 'DavRelayAbortedError'
  }
}

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isPrintableAscii = (value: string): boolean => /^[\x20-\x7e]*$/.test(value)

/**
 * Validates a path and returns it unchanged. A path is forwarded only when it
 * is already in the one canonical spelling, so that the prefix check against
 * the pin and the request line the remote receives are about the same string.
 *
 * Refused: anything that is not an absolute path; a query or a fragment; a
 * backslash; an empty segment (`//`); a `.` or `..` segment, plain or
 * percent-encoded; an encoded slash, backslash or control character; a raw
 * space, control or non-ASCII character; a malformed percent escape; and any
 * path the URL parser would rewrite.
 */
export function assertValidDavPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > DAV_RELAY_LIMITS.pathLength) {
    throw davRefusal.invalidPath('path-shape')
  }
  if (!value.startsWith('/')) {
    throw davRefusal.invalidPath('path-not-absolute')
  }
  if (!/^[\x21-\x7e]*$/.test(value)) {
    throw davRefusal.invalidPath('path-raw-character')
  }
  if (value.includes('?') || value.includes('#')) {
    throw davRefusal.invalidPath('path-query')
  }
  if (value.includes('\\')) {
    throw davRefusal.invalidPath('path-backslash')
  }
  if (/%(?![0-9a-fA-F]{2})/.test(value)) {
    throw davRefusal.invalidPath('path-escape')
  }

  const segments = value.split('/')
  for (let index = 1; index < segments.length; index++) {
    const segment = segments[index]
    if (segment === '') {
      // Only the last segment may be empty: that is a trailing slash.
      if (index !== segments.length - 1) {
        throw davRefusal.invalidPath('path-empty-segment')
      }
      continue
    }
    let decoded = ''
    for (let position = 0; position < segment.length; position++) {
      if (segment[position] !== '%') {
        decoded += segment[position]
        continue
      }
      const code = parseInt(segment.slice(position + 1, position + 3), 16)
      if (code === 0x2f || code === 0x5c) {
        throw davRefusal.invalidPath('path-encoded-separator')
      }
      if (code < 0x20 || code === 0x7f) {
        throw davRefusal.invalidPath('path-encoded-control')
      }
      decoded += String.fromCharCode(code)
      position += 2
    }
    if (decoded === '.' || decoded === '..') {
      throw davRefusal.invalidPath('path-dot-segment')
    }
  }

  let parsed: URL
  try {
    parsed = new URL(value, 'http://dav.invalid')
  } catch {
    throw davRefusal.invalidPath('path-unparseable')
  }
  if (
    parsed.origin !== 'http://dav.invalid' ||
    parsed.pathname !== value ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw davRefusal.invalidPath('path-not-canonical')
  }

  return value
}

/** A pinned prefix: a valid path that is a directory and is not the whole server. */
export function assertValidDavPinPath(value: unknown, field: string): string {
  let path: string
  try {
    path = assertValidDavPath(value)
  } catch {
    throw davRefusal.invalidInput(field)
  }
  if (!path.endsWith('/') || path === '/') {
    throw davRefusal.invalidInput(field)
  }
  return path
}

const isUnder = (path: string, prefix: string): boolean => path === prefix || path.startsWith(prefix)

/**
 * Turns the JSON envelope a client sent into a request the relay will forward,
 * or throws the refusal. Everything is checked against a list of what is
 * allowed; nothing is copied through because it "looked harmless".
 */
export function parseDavRelayEnvelope(raw: unknown): DavRelayRequest {
  if (!isJsonObject(raw)) {
    throw davRefusal.invalidInput('body')
  }

  const method = raw.method
  if (typeof method !== 'string') {
    throw davRefusal.invalidInput('method')
  }
  if ((DAV_WRITE_METHODS as readonly string[]).includes(method)) {
    // Named so that it can be refused by name. See DAV_RELAY_WRITE_ENABLED.
    throw davRefusal.writesDisabled(method)
  }
  if (!(DAV_READ_METHODS as readonly string[]).includes(method)) {
    // Echo only a value that is short and plain; the method is caller input.
    throw davRefusal.methodNotAllowed(/^[A-Za-z-]{1,24}$/.test(method) ? method : 'invalid')
  }

  const path = assertValidDavPath(raw.path)

  const headers: Record<string, string> = {}
  if (raw.headers !== undefined) {
    if (!isJsonObject(raw.headers)) {
      throw davRefusal.invalidInput('headers')
    }
    for (const [name, value] of Object.entries(raw.headers)) {
      const canonical = Object.prototype.hasOwnProperty.call(REQUEST_HEADERS, name) ? REQUEST_HEADERS[name] : undefined
      if (canonical === undefined) {
        throw davRefusal.headerNotAllowed(/^[a-z0-9-]{1,40}$/.test(name) ? name : 'invalid', 'header-name')
      }
      if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.length > DAV_RELAY_LIMITS.headerValueLength ||
        !isPrintableAscii(value)
      ) {
        throw davRefusal.headerNotAllowed(name, 'header-value')
      }
      headers[canonical] = value
    }
  }

  if (headers.Depth !== undefined && headers.Depth !== '0' && headers.Depth !== '1') {
    throw davRefusal.headerNotAllowed('depth', 'header-depth')
  }
  const contentType = headers['Content-Type']
  if (contentType !== undefined) {
    const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)
    if (!CONTENT_TYPE_PATTERN.test(contentType) || (charset !== null && charset[1].toLowerCase() !== 'utf-8')) {
      throw davRefusal.headerNotAllowed('content-type', 'header-content-type')
    }
  }

  let body: Buffer | undefined
  if (raw.body !== undefined && raw.body !== null && raw.body !== '') {
    if (typeof raw.body !== 'string') {
      throw davRefusal.invalidInput('body')
    }
    // Checked on the string first so that a huge value is refused before it is
    // copied: UTF-8 never encodes a UTF-16 unit in fewer than one byte.
    if (raw.body.length > DAV_RELAY_LIMITS.requestBodyBytes) {
      throw davRefusal.requestTooLarge(DAV_RELAY_LIMITS.requestBodyBytes)
    }
    body = Buffer.from(raw.body, 'utf8')
    if (body.byteLength > DAV_RELAY_LIMITS.requestBodyBytes) {
      throw davRefusal.requestTooLarge(DAV_RELAY_LIMITS.requestBodyBytes)
    }
    if (method === 'GET' || method === 'OPTIONS') {
      throw davRefusal.invalidInput('body')
    }
    if (contentType === undefined) {
      throw davRefusal.headerNotAllowed('content-type', 'header-content-type-missing')
    }
  } else if (contentType !== undefined) {
    // A content type with nothing to describe is a client bug worth hearing about.
    throw davRefusal.headerNotAllowed('content-type', 'header-content-type-without-body')
  }

  return { method: method as DavReadMethod, path, headers, body }
}

export class DavRelay {
  constructor(
    private readonly policy: DavNetworkPolicy,
    private readonly now: () => number = () => Date.now(),
    private readonly timeoutMs: number = DAV_RELAY_LIMITS.requestTimeoutMs,
  ) {}

  async forward(target: DavRelayTarget, request: DavRelayRequest, signal?: AbortSignal): Promise<DavRelayOutcome> {
    // Independent of the envelope parser on purpose: this is the last line
    // before a socket opens, and it must hold for a caller that never went
    // through the parser.
    if (!(DAV_READ_METHODS as readonly string[]).includes(request.method)) {
      throw (DAV_WRITE_METHODS as readonly string[]).includes(request.method)
        ? davRefusal.writesDisabled(String(request.method))
        : davRefusal.methodNotAllowed('invalid')
    }

    const origin = new URL(target.origin)
    const host = origin.hostname
    const deadline = this.now() + this.timeoutMs
    const requestBytes = request.body?.byteLength ?? 0
    const headers = this.outboundHeaders(target, request)

    let path = request.path
    let redirects = 0

    for (;;) {
      this.authorizePath(request.method, path, target)

      const url = new URL(path, origin)
      // The origin lock. `path` has been validated, so this cannot differ; it
      // is asserted anyway because everything else rests on it.
      if (url.origin !== origin.origin || url.pathname !== path || url.search !== '') {
        throw davRefusal.invalidPath('origin-lock')
      }

      const remaining = deadline - this.now()
      if (remaining <= 0) {
        throw davRefusal.remoteTimeout(host)
      }

      let response: PinnedHttpResponse
      try {
        const decision = await this.policy.assertTargetAcceptable(url, target.allowedPrivateOrigins, false)
        const transport = await this.policy.transportFor(url, decision)
        response = await transport.request({
          url,
          method: request.method,
          headers,
          body: request.body,
          signal,
          timeoutMs: remaining,
          redirect: 'manual',
          decompress: false,
        })
      } catch (error) {
        throw this.refusalFor(error, url, signal)
      }

      const location = response.headers.get('location')
      if (FOLLOWED_REDIRECT_STATUSES.includes(response.status) && location !== null) {
        response.cancel()
        path = this.redirectedPath(location, url, origin)
        redirects += 1
        if (redirects > DAV_RELAY_LIMITS.maxRedirects) {
          throw davRefusal.tooManyRedirects()
        }
        continue
      }

      if (response.status === 401) {
        response.cancel()
        return { kind: 'unauthorized', requestBytes }
      }

      let bytes: Buffer
      try {
        bytes = await this.readBounded(response)
      } catch (error) {
        throw this.refusalFor(error, url, signal)
      }

      return {
        kind: 'remote',
        requestBytes,
        responseBytes: bytes.byteLength,
        answer: {
          status: response.status,
          headers: this.inboundHeaders(response, url, origin),
          ...this.encodeBody(bytes),
          path,
          redirects,
        },
      }
    }
  }

  /**
   * Where a request may go. Called for the first hop and for every redirect
   * hop, so a redirect cannot carry a request to a path a direct request would
   * have been refused for.
   */
  private authorizePath(method: string, path: string, target: DavRelayTarget): void {
    const pin = target.pin
    if (pin !== null && (isUnder(path, pin.principalPath) || isUnder(path, pin.calendarHomePath))) {
      return
    }
    if (target.discoveryOpen && DAV_DISCOVERY_METHODS.includes(method)) {
      return
    }
    if (pin === null && !target.discoveryOpen) {
      throw davRefusal.discoveryClosed()
    }
    throw davRefusal.pathNotAllowed(pin === null ? 'not-pinned' : 'outside-pin')
  }

  private redirectedPath(location: string, from: URL, origin: URL): string {
    let next: URL
    try {
      next = new URL(location, from)
    } catch {
      throw davRefusal.remoteUnreachable(origin.hostname, 'redirect-malformed')
    }
    if (next.origin !== origin.origin) {
      // Another host, another port or another scheme. Never followed: the
      // stored password belongs to the origin the user connected, and the
      // user decides whether to connect the other one.
      throw davRefusal.redirectOtherOrigin(origin.hostname, {
        origin: next.protocol === 'http:' || next.protocol === 'https:' ? next.origin : 'unsupported',
        path: next.protocol === 'http:' || next.protocol === 'https:' ? next.pathname : '/',
      })
    }
    // A query is not carried, so a redirect that needs one is refused as a
    // path the relay does not forward rather than followed without it.
    return assertValidDavPath(`${next.pathname}${next.search}`)
  }

  /**
   * THE ONLY PLACE THE SECRET IS REVEALED. The value goes into the header
   * object handed to the transport and nowhere else: not into an error, not
   * into a log call, not into anything returned to the caller.
   */
  private authorizationHeader(target: DavRelayTarget): string {
    if (target.credentialKind === 'bearer') {
      return `Bearer ${target.secret.reveal()}`
    }
    return `Basic ${Buffer.from(`${target.username}:${target.secret.reveal()}`, 'utf8').toString('base64')}`
  }

  private outboundHeaders(target: DavRelayTarget, request: DavRelayRequest): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      // No compression: the response ceiling then counts the bytes that were
      // actually sent, and a small compressed body cannot expand past it.
      'Accept-Encoding': 'identity',
      ...request.headers,
      Authorization: this.authorizationHeader(target),
    }
    if (request.body !== undefined) {
      // An explicit length, so the body is not sent chunked: some DAV servers
      // behind older proxies refuse a chunked request.
      headers['Content-Length'] = String(request.body.byteLength)
    }
    return headers
  }

  private inboundHeaders(response: PinnedHttpResponse, from: URL, origin: URL): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const name of RESPONSE_HEADERS) {
      const value = response.headers.get(name)
      if (value !== null && value.length <= DAV_RELAY_LIMITS.responseHeaderValueLength && isPrintableAscii(value)) {
        headers[name] = value
      }
    }
    const location = response.headers.get('location')
    if (location !== null) {
      try {
        const target = new URL(location, from)
        if (target.origin === origin.origin) {
          headers.location = target.pathname
        }
      } catch {
        // An unparseable Location is simply not passed on.
      }
    }
    return headers
  }

  private async readBounded(response: PinnedHttpResponse): Promise<Buffer> {
    const limit = DAV_RELAY_LIMITS.responseBodyBytes
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > limit) {
      response.cancel()
      throw davRefusal.responseTooLarge(limit)
    }

    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value === undefined) {
        continue
      }
      total += value.byteLength
      if (total > limit) {
        // Stop reading at the ceiling. The declared length above is only a
        // courtesy; this count is what actually bounds memory.
        await Promise.resolve(reader.cancel()).catch(() => undefined)
        response.cancel()
        throw davRefusal.responseTooLarge(limit)
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    }
    return Buffer.concat(chunks, total)
  }

  private encodeBody(bytes: Buffer): Pick<DavRemoteAnswer, 'body' | 'bodyEncoding'> {
    try {
      return { body: new TextDecoder('utf-8', { fatal: true }).decode(bytes), bodyEncoding: 'utf8' }
    } catch {
      return { body: bytes.toString('base64'), bodyEncoding: 'base64' }
    }
  }

  /**
   * Maps a failure onto a refusal from the closed list. The failure's own text
   * is never used: Node's network errors name addresses and ports, and a TLS
   * error can quote a certificate.
   */
  private refusalFor(error: unknown, url: URL, signal: AbortSignal | undefined): unknown {
    if (error instanceof DavBridgeRefusal) {
      return error
    }
    if (error instanceof SsrfValidationError) {
      return this.policy.refusalFor(error, url, false)
    }
    const host = url.hostname
    if (error instanceof PinnedHttpError) {
      return error.tag === 'request-timeout'
        ? davRefusal.remoteTimeout(host)
        : davRefusal.remoteUnreachable(host, 'transport')
    }
    if (signal?.aborted === true) {
      return new DavRelayAbortedError()
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (typeof code !== 'string' || code.length === 0) {
      // Every network failure Node reports carries a code. Something without
      // one is a defect in this code, and calling it "the remote did not
      // answer" would hide it behind a plausible message.
      return error
    }
    if (TLS_ERROR_CODES.has(code) || code.startsWith('CERT_') || code.startsWith('ERR_SSL_')) {
      return davRefusal.tlsFailed(host)
    }
    return davRefusal.remoteUnreachable(host, NETWORK_ERROR_TAGS[code] ?? 'network')
  }
}

const TLS_ERROR_CODES: ReadonlySet<string> = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'EPROTO',
])

/** Node error code -> log tag. A closed list; anything else is logged as `network`. */
const NETWORK_ERROR_TAGS: Readonly<Record<string, string>> = {
  ECONNREFUSED: 'refused',
  ECONNRESET: 'reset',
  EHOSTUNREACH: 'host-unreachable',
  ENETUNREACH: 'net-unreachable',
  ETIMEDOUT: 'connect-timeout',
  EPIPE: 'pipe',
  EAI_AGAIN: 'dns-temporary',
}
