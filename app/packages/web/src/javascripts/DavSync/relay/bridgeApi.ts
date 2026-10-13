import {
  DavTransport,
  RelayRequest,
  RelayResponseHeaderName,
  RelayResult,
  RemoteAnswer,
} from '../transport/DavTransport'

/**
 * Standard Red Notes: the app's side of the CalDAV bridge on the Standard Red
 * Notes server.
 *
 * Everything the server sends is read here, once, into shapes the rest of the
 * sync code can rely on. Nothing below trusts an answer to have the shape the
 * contract promises: a field of the wrong type makes the whole answer
 * "malformed" (or, for a relayed request, "nothing is known"), never a value
 * with a hole in it.
 *
 * The account's password passes through `createBridgeAccount` and
 * `replaceBridgeSecret` on its way to the server and is kept nowhere on this
 * side. No answer carries it.
 */

/** What the app's API service returns for any call: the HTTP status, and the parsed JSON body in `data`. */
export type ApiAnswer = { status: number; data?: unknown }

export type NewAccount = {
  kind: 'nextcloud' | 'caldav'
  url: string
  username: string
  secret: string
  credentialKind?: 'basic' | 'bearer'
}

export type BridgePin = { principalPath: string; calendarHomePath: string }

/** The eight calls of the bridge, as the API service of the app offers them. */
export interface DavBridgeApi {
  getDavBridgeConfig(): Promise<ApiAnswer>
  listDavBridgeAccounts(): Promise<ApiAnswer>
  createDavBridgeAccount(body: NewAccount): Promise<ApiAnswer>
  replaceDavBridgeAccountSecret(
    accountId: string,
    body: { secret: string; username?: string; credentialKind?: 'basic' | 'bearer' },
  ): Promise<ApiAnswer>
  pinDavBridgeAccount(accountId: string, body: BridgePin): Promise<ApiAnswer>
  deleteDavBridgeAccount(accountId: string): Promise<ApiAnswer>
  deleteAllDavBridgeAccounts(): Promise<ApiAnswer>
  relayDavBridgeRequest(
    accountId: string,
    envelope: { method: string; path: string; headers?: Record<string, string>; body?: string },
    timeoutMs?: number,
  ): Promise<ApiAnswer>
}

const BRIDGE_CALLS: readonly (keyof DavBridgeApi)[] = [
  'getDavBridgeConfig',
  'listDavBridgeAccounts',
  'createDavBridgeAccount',
  'replaceDavBridgeAccountSecret',
  'pinDavBridgeAccount',
  'deleteDavBridgeAccount',
  'deleteAllDavBridgeAccounts',
  'relayDavBridgeRequest',
]

/**
 * The bridge calls of an API service, or undefined when it has not got all of
 * them. The web app is typechecked against the library's sources and can be run
 * against an older build of it, so the types saying the calls exist is not
 * enough to call them.
 */
export function davBridgeApiOf(api: unknown): DavBridgeApi | undefined {
  if (typeof api !== 'object' || api === null) {
    return undefined
  }
  for (const name of BRIDGE_CALLS) {
    if (typeof (api as Record<string, unknown>)[name] !== 'function') {
      return undefined
    }
  }
  return api as DavBridgeApi
}

export type BridgeFailure =
  /** The server refused, and says why in `tag` (always one beginning `dav-`). */
  | { kind: 'refused'; httpStatus: number; tag: string; message: string; extra: Record<string, unknown> }
  /** The Standard Red Notes server could not be reached, or the session has a problem. */
  | { kind: 'transport'; httpStatus: number | null }
  /** The server answered that it did what was asked, in a shape that cannot be read. */
  | { kind: 'malformed' }

export type BridgeResult<T> = { ok: true; value: T } | { ok: false; failure: BridgeFailure }

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isCount = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

const REFUSAL_PREFIX = 'dav-'

/** The refusal an answer carries, when it carries one. A 200 never does. */
function refusalOf(answer: ApiAnswer): Extract<BridgeFailure, { kind: 'refused' }> | undefined {
  if (answer.status === 200 || !isRecord(answer.data) || !isRecord(answer.data.error)) {
    return undefined
  }
  const { tag, message, ...extra } = answer.data.error
  if (typeof tag !== 'string' || !tag.startsWith(REFUSAL_PREFIX)) {
    return undefined
  }
  return {
    kind: 'refused',
    httpStatus: answer.status,
    tag,
    message: typeof message === 'string' ? message : '',
    extra,
  }
}

/**
 * Why an answer is not a success. Anything without a `dav-` tag (an expired
 * session, the server's general rate limit, no network) is not the bridge
 * speaking: nothing is known, and nothing a linked calendar holds may change
 * because of it.
 */
function failureOf(answer: ApiAnswer): BridgeFailure {
  const refusal = refusalOf(answer)
  if (refusal) {
    return refusal
  }
  if (answer.status >= 200 && answer.status < 300) {
    return { kind: 'malformed' }
  }
  const noAnswer = isRecord(answer.data) && answer.data.networkFailure === true
  return { kind: 'transport', httpStatus: noAnswer ? null : answer.status }
}

const RESPONSE_HEADERS: readonly RelayResponseHeaderName[] = [
  'etag',
  'content-type',
  'dav',
  'allow',
  'retry-after',
  'location',
]

function remoteAnswerOf(value: unknown): RemoteAnswer | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const { status, headers, body, bodyEncoding, path, redirects } = value
  if (
    !isCount(status) ||
    status < 100 ||
    status > 599 ||
    typeof body !== 'string' ||
    (bodyEncoding !== 'utf8' && bodyEncoding !== 'base64') ||
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    !isCount(redirects) ||
    (headers !== undefined && !isRecord(headers))
  ) {
    return undefined
  }
  const kept: RemoteAnswer['headers'] = {}
  for (const name of RESPONSE_HEADERS) {
    const header = headers?.[name]
    if (typeof header === 'string') {
      kept[name] = header
    }
  }
  return { status, headers: kept, body, bodyEncoding, path, redirects }
}

/**
 * What an answer to a relayed request means. "The other server said X" is a 200
 * that carries a well-formed `remote`, whatever X is; a refusal is never a 200
 * and carries a `dav-` tag; everything else says nothing about the other server.
 */
export function relayResultOf(answer: ApiAnswer): RelayResult {
  if (answer.status === 200 && isRecord(answer.data)) {
    const remote = remoteAnswerOf(answer.data.remote)
    if (remote) {
      return { kind: 'remote', remote }
    }
  }
  const failure = failureOf(answer)
  if (failure.kind === 'refused') {
    return failure
  }
  return { kind: 'transport', httpStatus: failure.kind === 'transport' ? failure.httpStatus : answer.status }
}

/** How much longer than the relay's own deadline the app waits for the relay's answer. */
export const RELAY_ANSWER_MARGIN_MS = 15_000
const DEFAULT_RELAY_DEADLINE_MS = 30_000
const MAX_RELAY_DEADLINE_MS = 120_000

/** How long to wait for one relayed request, given how long the relay says it waits for the other server. */
export function relayDeadlineMs(relayTimeoutMs: number | undefined): number {
  const relay = isCount(relayTimeoutMs) && relayTimeoutMs > 0 ? relayTimeoutMs : DEFAULT_RELAY_DEADLINE_MS
  return Math.min(relay, MAX_RELAY_DEADLINE_MS) + RELAY_ANSWER_MARGIN_MS
}

/** Requests to one account, through the relay. */
export class RelayTransport implements DavTransport {
  constructor(
    private readonly api: DavBridgeApi,
    private readonly accountId: string,
    private readonly deadlineMs: number,
  ) {}

  async request(request: RelayRequest): Promise<RelayResult> {
    const envelope: { method: string; path: string; headers?: Record<string, string>; body?: string } = {
      method: request.method,
      path: request.path,
    }
    if (request.headers !== undefined) {
      const headers: Record<string, string> = {}
      for (const name of Object.keys(request.headers) as (keyof typeof request.headers)[]) {
        const value = request.headers[name]
        if (value !== undefined) {
          headers[name] = value
        }
      }
      envelope.headers = headers
    }
    if (request.body !== undefined) {
      envelope.body = request.body
    }
    let answer: ApiAnswer
    try {
      answer = await this.api.relayDavBridgeRequest(this.accountId, envelope, this.deadlineMs)
    } catch {
      return { kind: 'transport', httpStatus: null }
    }
    return relayResultOf(answer)
  }
}

export type BridgeLimits = {
  maxAccounts: number
  requestBodyBytes: number
  responseBodyBytes: number
  requestTimeoutMs: number
  pathLength: number
  discoveryWindowSeconds: number
  requestsPerTenMinutes: number
  writesPerMinute: number
  accountValidationsPerHour: number
}

export type BridgeConfig = {
  /** The operator's switch. */
  enabled: boolean
  /** Whether this person is permitted. */
  allowed: boolean
  /** Whether the bridge can be used now, by this person, in a way this build understands. */
  available: boolean
  mode: string
  writeEnabled: boolean
  methods: string[]
  limits: BridgeLimits
}

const LIMIT_NAMES: readonly (keyof BridgeLimits)[] = [
  'maxAccounts',
  'requestBodyBytes',
  'responseBodyBytes',
  'requestTimeoutMs',
  'pathLength',
  'discoveryWindowSeconds',
  'requestsPerTenMinutes',
  'writesPerMinute',
  'accountValidationsPerHour',
]

/** The only way of working this build implements: the server relays and keeps no calendar content. */
export const BRIDGE_MODE = 'relay'

function configOf(value: Record<string, unknown>): BridgeConfig | undefined {
  if (!isRecord(value.limits)) {
    return undefined
  }
  const { enabled, allowed, available, mode, writeEnabled, methods } = value
  if (
    typeof enabled !== 'boolean' ||
    typeof allowed !== 'boolean' ||
    typeof available !== 'boolean' ||
    typeof mode !== 'string' ||
    typeof writeEnabled !== 'boolean' ||
    !Array.isArray(methods)
  ) {
    return undefined
  }
  const limits = {} as BridgeLimits
  for (const name of LIMIT_NAMES) {
    const limit = value.limits[name]
    if (!isCount(limit)) {
      return undefined
    }
    limits[name] = limit
  }
  return {
    enabled,
    allowed,
    available: available && mode === BRIDGE_MODE,
    mode,
    writeEnabled,
    methods: methods.filter((method): method is string => typeof method === 'string'),
    limits,
  }
}

export type BridgeAccountStatus = 'unverified' | 'ok' | 'password-rejected' | 'secret-unreadable' | 'unknown'

/** One account as the server describes it. There is no field for the password, and never will be. */
export type BridgeAccount = {
  id: string
  kind: 'nextcloud' | 'caldav'
  origin: string
  entryPath: string
  username: string
  credentialKind: 'basic' | 'bearer'
  status: BridgeAccountStatus
  pin: BridgePin | null
  /** Until when discovery may look anywhere on the origin, as an instant in milliseconds; null once closed. */
  discoveryOpenUntil: number | null
  createdAt: string
  updatedAt: string
}

const KNOWN_STATUSES: readonly BridgeAccountStatus[] = ['unverified', 'ok', 'password-rejected', 'secret-unreadable']

function pinOf(value: unknown): BridgePin | null | undefined {
  if (value === null || value === undefined) {
    return null
  }
  if (!isRecord(value) || typeof value.principalPath !== 'string' || typeof value.calendarHomePath !== 'string') {
    return undefined
  }
  return { principalPath: value.principalPath, calendarHomePath: value.calendarHomePath }
}

function accountOf(value: unknown): BridgeAccount | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const { id, kind, origin, entryPath, username, credentialKind, status, discoveryOpenUntil, createdAt, updatedAt } =
    value
  const pin = pinOf(value.pin)
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof origin !== 'string' ||
    origin.length === 0 ||
    typeof username !== 'string' ||
    pin === undefined
  ) {
    return undefined
  }
  let openUntil: number | null = null
  if (typeof discoveryOpenUntil === 'string') {
    const instant = Date.parse(discoveryOpenUntil)
    // An instant that cannot be read is a window that cannot be relied on: closed.
    openUntil = Number.isFinite(instant) ? instant : null
  }
  return {
    id,
    kind: kind === 'nextcloud' ? 'nextcloud' : 'caldav',
    origin,
    entryPath: typeof entryPath === 'string' && entryPath.startsWith('/') ? entryPath : '/',
    username,
    credentialKind: credentialKind === 'bearer' ? 'bearer' : 'basic',
    status: KNOWN_STATUSES.find((known) => known === status) ?? 'unknown',
    pin,
    discoveryOpenUntil: openUntil,
    createdAt: typeof createdAt === 'string' ? createdAt : '',
    updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
  }
}

/** Make a call and read its answer with `read`; a 2xx that `read` cannot make sense of is malformed. */
async function call<T>(
  send: () => Promise<ApiAnswer>,
  read: (data: Record<string, unknown>) => T | undefined,
): Promise<BridgeResult<T>> {
  let answer: ApiAnswer
  try {
    answer = await send()
  } catch {
    return { ok: false, failure: { kind: 'transport', httpStatus: null } }
  }
  if (answer.status >= 200 && answer.status < 300 && isRecord(answer.data)) {
    const value = read(answer.data)
    if (value !== undefined) {
      return { ok: true, value }
    }
  }
  return { ok: false, failure: failureOf(answer) }
}

const accountIn = (data: Record<string, unknown>): BridgeAccount | undefined => accountOf(data.account)

export function readBridgeConfig(api: DavBridgeApi): Promise<BridgeResult<BridgeConfig>> {
  return call(() => api.getDavBridgeConfig(), configOf)
}

/** Every account the server holds for this person. One it describes unreadably fails the whole listing. */
export function listBridgeAccounts(api: DavBridgeApi): Promise<BridgeResult<BridgeAccount[]>> {
  return call(
    () => api.listDavBridgeAccounts(),
    (data) => {
      if (!Array.isArray(data.accounts)) {
        return undefined
      }
      const accounts: BridgeAccount[] = []
      for (const entry of data.accounts) {
        const account = accountOf(entry)
        if (!account) {
          return undefined
        }
        accounts.push(account)
      }
      return accounts
    },
  )
}

export function createBridgeAccount(api: DavBridgeApi, account: NewAccount): Promise<BridgeResult<BridgeAccount>> {
  return call(() => api.createDavBridgeAccount(account), accountIn)
}

export function replaceBridgeSecret(
  api: DavBridgeApi,
  accountId: string,
  body: { secret: string; username?: string; credentialKind?: 'basic' | 'bearer' },
): Promise<BridgeResult<BridgeAccount>> {
  return call(() => api.replaceDavBridgeAccountSecret(accountId, body), accountIn)
}

export function pinBridgeAccount(
  api: DavBridgeApi,
  accountId: string,
  pin: BridgePin,
): Promise<BridgeResult<BridgeAccount>> {
  return call(() => api.pinDavBridgeAccount(accountId, pin), accountIn)
}

export function deleteBridgeAccount(api: DavBridgeApi, accountId: string): Promise<BridgeResult<true>> {
  return call(
    () => api.deleteDavBridgeAccount(accountId),
    (data): true | undefined => (data.deleted === true ? true : undefined),
  )
}

/** Remove every account the server holds for this person. The value is how many it removed. */
export function deleteAllBridgeAccounts(api: DavBridgeApi): Promise<BridgeResult<number>> {
  return call(
    () => api.deleteAllDavBridgeAccounts(),
    (data) => (isCount(data.deleted) ? data.deleted : undefined),
  )
}
