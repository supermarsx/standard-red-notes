import { utf8Length } from '../hash/sha256'
import { DavTransport, RelayRequest, RelayResult, RemoteAnswer } from '../transport/DavTransport'
import {
  APPLE_ICAL_NS,
  CALDAV_NS,
  CALENDARSERVER_NS,
  DAV_NS,
  Multistatus,
  MultistatusResponse,
  NEXTCLOUD_NS,
  allChildren,
  escapeXml,
  firstChild,
  parseMultistatus,
  pathOfHref,
  propertyKey,
  textOf,
} from './multistatus'

/**
 * Standard Red Notes: the part of CalDAV the sync engine speaks.
 *
 * Seven request shapes, written against an injected transport. There is no
 * retrying and no state here: each function sends what it must, reads the
 * answer, and reports either a value or exactly why there is none, so that the
 * engine above can decide what a failure means for a linked calendar.
 */

export type DavFailure =
  /** The relay would not forward the request. `tag` is one of its `dav-` tags. */
  | { kind: 'refused'; tag: string; message: string; extra: Record<string, unknown> }
  /** The Standard Red Notes server itself could not be reached, or the session has a problem. */
  | { kind: 'transport'; httpStatus: number | null }
  /** The other server answered with a status this request cannot use. */
  | { kind: 'remote-status'; status: number; path: string; retryAfter?: string }
  /** The other server answered 2xx with a body that is not what the request asked for. */
  | { kind: 'malformed'; path: string }

export type DavResult<T> = { ok: true; value: T } | { ok: false; failure: DavFailure }

const ok = <T>(value: T): DavResult<T> => ({ ok: true, value })
const fail = <T>(failure: DavFailure): DavResult<T> => ({ ok: false, failure })

const XML = 'application/xml; charset=utf-8'

const failureOf = (result: Exclude<RelayResult, { kind: 'remote' }>): DavFailure => {
  return result.kind === 'refused'
    ? { kind: 'refused', tag: result.tag, message: result.message, extra: result.extra }
    : { kind: 'transport', httpStatus: result.httpStatus }
}

const remoteStatus = (remote: RemoteAnswer): DavFailure => {
  const failure: DavFailure = { kind: 'remote-status', status: remote.status, path: remote.path }
  const retryAfter = remote.headers['retry-after']
  if (retryAfter !== undefined) {
    failure.retryAfter = retryAfter
  }
  return failure
}

/** Send a request that must be answered with a multistatus. */
async function multistatusRequest(
  transport: DavTransport,
  request: RelayRequest,
): Promise<DavResult<{ multistatus: Multistatus; remote: RemoteAnswer }>> {
  const result = await transport.request(request)
  if (result.kind !== 'remote') {
    return fail(failureOf(result))
  }
  const { remote } = result
  if (remote.status !== 207) {
    return fail(remoteStatus(remote))
  }
  const multistatus = remote.bodyEncoding === 'utf8' ? parseMultistatus(remote.body) : null
  if (!multistatus) {
    return fail({ kind: 'malformed', path: remote.path })
  }
  return ok({ multistatus, remote })
}

const propfind = (path: string, depth: '0' | '1', properties: string): RelayRequest => ({
  method: 'PROPFIND',
  path,
  headers: { depth, 'content-type': XML },
  body:
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<d:propfind xmlns:d="${DAV_NS}" xmlns:c="${CALDAV_NS}" xmlns:cs="${CALENDARSERVER_NS}" xmlns:ic="${APPLE_ICAL_NS}">` +
    `<d:prop>${properties}</d:prop></d:propfind>`,
})

/** The response that describes `path` itself, in an answer that may list its children too. */
const responseFor = (multistatus: Multistatus, remote: RemoteAnswer, path: string): MultistatusResponse | undefined =>
  multistatus.responses.find((response) => {
    const responsePath = pathOfHref(response.href, remote.path)
    return responsePath !== null && withSlash(responsePath) === withSlash(path)
  })

const withSlash = (path: string): string => (path.endsWith('/') ? path : `${path}/`)

/** The first `<d:href>` inside a property such as `current-user-principal`, as a collection path. */
const hrefProperty = (
  response: MultistatusResponse | undefined,
  key: string,
  remote: RemoteAnswer,
): string | undefined => {
  const property = response?.properties.get(key)
  const href = property ? textOf(firstChild(property, DAV_NS, 'href')) : ''
  if (href.length === 0) {
    return undefined
  }
  const path = pathOfHref(href, remote.path)
  return path === null ? undefined : withSlash(path)
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export type CalendarComponent = 'VEVENT' | 'VTODO' | 'VJOURNAL'

export type RemoteCollection = {
  /** The collection's path, ending in `/`. */
  path: string
  name: string
  /** What the collection says it holds. Empty when it does not say, which servers read as "anything". */
  components: CalendarComponent[]
  /**
   * Whether this account may write to it. `undefined` when the server did not
   * report privileges, which is not the same as being allowed.
   */
  canWrite: boolean | undefined
  color?: string
  ctag?: string
  syncToken?: string
}

export type Discovery = {
  principalPath: string
  calendarHomePath: string
  collections: RemoteCollection[]
}

/**
 * Where to look for the account's principal, in order. `/.well-known/caldav`
 * is the standard answer; the rest are where the servers people actually run
 * keep their DAV root when that redirect is missing.
 */
export const discoveryEntryPaths = (entryPath: string): string[] => {
  const candidates = ['/.well-known/caldav', entryPath, '/remote.php/dav/', '/dav.php/', '/']
  const unique: string[] = []
  for (const candidate of candidates) {
    const path = pathOfHref(candidate, '/')
    if (path !== null && !unique.includes(path)) {
      unique.push(path)
    }
  }
  return unique
}

/** Failures that say "not here, try the next place" rather than "stop". */
const isNotHere = (failure: DavFailure): boolean =>
  failure.kind === 'malformed' ||
  (failure.kind === 'remote-status' && [400, 403, 404, 405, 501].includes(failure.status))

/** The relay's refusal to follow a redirect that leaves the account's origin. */
const pointsElsewhere = (failure: DavFailure): boolean =>
  failure.kind === 'refused' && failure.tag === 'dav-redirect-other-origin'

/**
 * Find the account's principal, starting from the address the person typed.
 * Only `PROPFIND` is sent, because that is all the relay forwards before the
 * account's paths are pinned.
 *
 * A place that redirects to another origin is passed over, not obeyed and not
 * fatal: a server behind a proxy or a port mapping commonly sends
 * `/.well-known/caldav` to the wrong scheme or port while its real address
 * works. Only when nowhere else answers is the redirect what gets reported, so
 * that the person can be asked whether to connect to the address it names.
 * Anything else the relay refuses (a rejected password above all) stops the
 * search at once: asking four more places would be four more failed sign-ins.
 */
export async function findPrincipal(transport: DavTransport, entryPath: string): Promise<DavResult<string>> {
  let lastFailure: DavFailure = { kind: 'malformed', path: entryPath }
  let elsewhere: DavFailure | undefined
  for (const path of discoveryEntryPaths(entryPath)) {
    const answer = await multistatusRequest(transport, propfind(path, '0', '<d:current-user-principal/>'))
    if (!answer.ok) {
      if (pointsElsewhere(answer.failure)) {
        elsewhere = elsewhere ?? answer.failure
        continue
      }
      if (!isNotHere(answer.failure)) {
        return answer
      }
      lastFailure = answer.failure
      continue
    }
    const { multistatus, remote } = answer.value
    const principal = hrefProperty(
      responseFor(multistatus, remote, remote.path) ?? multistatus.responses[0],
      propertyKey(DAV_NS, 'current-user-principal'),
      remote,
    )
    if (principal) {
      return ok(principal)
    }
    lastFailure = { kind: 'malformed', path: remote.path }
  }
  return fail(elsewhere ?? lastFailure)
}

export async function findCalendarHome(transport: DavTransport, principalPath: string): Promise<DavResult<string>> {
  const answer = await multistatusRequest(transport, propfind(principalPath, '0', '<c:calendar-home-set/>'))
  if (!answer.ok) {
    return answer
  }
  const { multistatus, remote } = answer.value
  const home = hrefProperty(
    responseFor(multistatus, remote, principalPath) ?? multistatus.responses[0],
    propertyKey(CALDAV_NS, 'calendar-home-set'),
    remote,
  )
  return home ? ok(home) : fail({ kind: 'malformed', path: remote.path })
}

const COLLECTION_PROPERTIES =
  '<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><d:current-user-privilege-set/>' +
  '<cs:getctag/><d:sync-token/><ic:calendar-color/>'

const isComponent = (name: string): name is CalendarComponent =>
  name === 'VEVENT' || name === 'VTODO' || name === 'VJOURNAL'

const WRITE_PRIVILEGES = new Set(['all', 'write', 'write-content', 'bind'])

const collectionOf = (response: MultistatusResponse, remote: RemoteAnswer): RemoteCollection | null => {
  const path = pathOfHref(response.href, remote.path)
  const resourceType = response.properties.get(propertyKey(DAV_NS, 'resourcetype'))
  if (path === null || !resourceType) {
    return null
  }
  const types = allChildren(resourceType)
  const isCalendar = types.some((type) => type.namespaceURI === CALDAV_NS && type.localName === 'calendar')
  // Nextcloud keeps deleted calendars in a trash bin that is itself a collection under the home.
  const isTrash = types.some((type) => type.namespaceURI === NEXTCLOUD_NS)
  if (!isCalendar || isTrash) {
    return null
  }

  const components: CalendarComponent[] = []
  const componentSet = response.properties.get(propertyKey(CALDAV_NS, 'supported-calendar-component-set'))
  if (componentSet) {
    for (const component of allChildren(componentSet)) {
      const name = (component.getAttribute('name') ?? '').toUpperCase()
      if (isComponent(name) && !components.includes(name)) {
        components.push(name)
      }
    }
  }

  let canWrite: boolean | undefined
  const privilegeSet = response.properties.get(propertyKey(DAV_NS, 'current-user-privilege-set'))
  if (privilegeSet) {
    canWrite = allChildren(privilegeSet).some((privilege) =>
      allChildren(privilege).some((name) => name.namespaceURI === DAV_NS && WRITE_PRIVILEGES.has(name.localName)),
    )
  }

  const collectionPath = withSlash(path)
  const segments = collectionPath.split('/').filter((segment) => segment.length > 0)
  const lastSegment = segments.length > 0 ? decodeURIComponent(segments[segments.length - 1]) : collectionPath
  const collection: RemoteCollection = {
    path: collectionPath,
    name: textOf(response.properties.get(propertyKey(DAV_NS, 'displayname'))) || lastSegment,
    components,
    canWrite,
  }
  // Apple's colour is `#RRGGBB` with an optional alpha pair, which a chip cannot use.
  const color = /^#[0-9a-fA-F]{6}/.exec(textOf(response.properties.get(propertyKey(APPLE_ICAL_NS, 'calendar-color'))))
  if (color) {
    collection.color = color[0].toLowerCase()
  }
  const ctag = textOf(response.properties.get(propertyKey(CALENDARSERVER_NS, 'getctag')))
  if (ctag) {
    collection.ctag = ctag
  }
  const syncToken = textOf(response.properties.get(propertyKey(DAV_NS, 'sync-token')))
  if (syncToken) {
    collection.syncToken = syncToken
  }
  return collection
}

/** Every calendar directly under the calendar home, in the order the server listed them. */
export async function listCollections(
  transport: DavTransport,
  calendarHomePath: string,
): Promise<DavResult<RemoteCollection[]>> {
  const answer = await multistatusRequest(transport, propfind(calendarHomePath, '1', COLLECTION_PROPERTIES))
  if (!answer.ok) {
    return answer
  }
  const { multistatus, remote } = answer.value
  const collections: RemoteCollection[] = []
  for (const response of multistatus.responses) {
    const collection = collectionOf(response, remote)
    if (collection && collection.path !== withSlash(calendarHomePath)) {
      collections.push(collection)
    }
  }
  return ok(collections)
}

export async function discover(transport: DavTransport, entryPath: string): Promise<DavResult<Discovery>> {
  const principal = await findPrincipal(transport, entryPath)
  if (!principal.ok) {
    return principal
  }
  const home = await findCalendarHome(transport, principal.value)
  if (!home.ok) {
    return home
  }
  const collections = await listCollections(transport, home.value)
  if (!collections.ok) {
    return collections
  }
  return ok({ principalPath: principal.value, calendarHomePath: home.value, collections: collections.value })
}

/** One collection's tag and sync token: the cheap question "did anything change?". */
export async function readCollectionState(
  transport: DavTransport,
  collectionPath: string,
): Promise<DavResult<{ ctag?: string; syncToken?: string }>> {
  const answer = await multistatusRequest(transport, propfind(collectionPath, '0', '<cs:getctag/><d:sync-token/>'))
  if (!answer.ok) {
    return answer
  }
  const { multistatus, remote } = answer.value
  const response = responseFor(multistatus, remote, collectionPath) ?? multistatus.responses[0]
  const state: { ctag?: string; syncToken?: string } = {}
  const ctag = textOf(response?.properties.get(propertyKey(CALENDARSERVER_NS, 'getctag')))
  if (ctag) {
    state.ctag = ctag
  }
  const syncToken = textOf(response?.properties.get(propertyKey(DAV_NS, 'sync-token')))
  if (syncToken) {
    state.syncToken = syncToken
  }
  return ok(state)
}

// ---------------------------------------------------------------------------
// Listing and fetching entries
// ---------------------------------------------------------------------------

/** `YYYYMMDDTHHMMSSZ`, the form a CalDAV time range takes. */
export const caldavUtc = (epochMs: number): string =>
  new Date(epochMs)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')

export type EntryWindow = { startMs: number; endMs: number }

/** Ask a collection which of its entries match a filter, and read the answer as path and ETag. */
async function queryEntries(
  transport: DavTransport,
  collectionPath: string,
  component: 'VEVENT' | 'VTODO',
  componentFilter: string,
): Promise<DavResult<Map<string, string>>> {
  const answer = await multistatusRequest(transport, {
    method: 'REPORT',
    path: collectionPath,
    headers: { depth: '1', 'content-type': XML },
    body:
      '<?xml version="1.0" encoding="utf-8"?>' +
      `<c:calendar-query xmlns:d="${DAV_NS}" xmlns:c="${CALDAV_NS}"><d:prop><d:getetag/></d:prop>` +
      `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="${component}">${componentFilter}</c:comp-filter>` +
      '</c:comp-filter></c:filter></c:calendar-query>',
  })
  if (!answer.ok) {
    return answer
  }
  const { multistatus, remote } = answer.value
  const entries = new Map<string, string>()
  for (const response of multistatus.responses) {
    const path = pathOfHref(response.href, remote.path)
    const etag = textOf(response.properties.get(propertyKey(DAV_NS, 'getetag')))
    if (path !== null && etag.length > 0 && path.startsWith(withSlash(collectionPath))) {
      entries.set(path, etag)
    }
  }
  return ok(entries)
}

/**
 * The entries of one kind in a collection, as path and ETag.
 *
 * With a window, the server is asked for entries that fall in it, and it counts
 * a repeating series as in the window when any occurrence is. That is the
 * server's own expansion of rules this app may not be able to edit, and it is
 * the reason the listing is a query rather than a property listing.
 */
export function listEntries(
  transport: DavTransport,
  collectionPath: string,
  component: 'VEVENT' | 'VTODO',
  window?: EntryWindow,
): Promise<DavResult<Map<string, string>>> {
  const timeRange = window
    ? `<c:time-range start="${caldavUtc(window.startMs)}" end="${caldavUtc(window.endMs)}"/>`
    : ''
  return queryEntries(transport, collectionPath, component, timeRange)
}

/**
 * Every entry that has a repeat rule, whenever it falls, as path and ETag.
 *
 * Deciding whether a single event is in a window is trivial for a server;
 * deciding it for a series (exceptions, an end date stated in another zone,
 * all-day rules) is where servers differ, and one that answers too little
 * leaves an event silently missing. This listing is how the engine checks: it
 * expands, itself, the series the windowed listing did not return.
 */
export function listRepeatingEntries(
  transport: DavTransport,
  collectionPath: string,
  component: 'VEVENT' | 'VTODO',
): Promise<DavResult<Map<string, string>>> {
  return queryEntries(transport, collectionPath, component, '<c:prop-filter name="RRULE"/>')
}

export type FetchedEntry =
  | { state: 'found'; etag: string; data: string }
  /** The server says there is no such entry any more. */
  | { state: 'gone' }
  /** The entry is there but could not be read; `reason` is for the status line, not for a decision. */
  | { state: 'unreadable'; reason: string }

export const MULTIGET_BATCH = 50

/** Entries larger than this are not brought into a note. */
export const MAX_ENTRY_BYTES = 256 * 1024

const multigetBody = (paths: string[]): string =>
  '<?xml version="1.0" encoding="utf-8"?>' +
  `<c:calendar-multiget xmlns:d="${DAV_NS}" xmlns:c="${CALDAV_NS}"><d:prop><d:getetag/><c:calendar-data/></d:prop>` +
  paths.map((path) => `<d:href>${escapeXml(path)}</d:href>`).join('') +
  '</c:calendar-multiget>'

async function fetchBatch(
  transport: DavTransport,
  collectionPath: string,
  paths: string[],
  into: Map<string, FetchedEntry>,
): Promise<DavFailure | undefined> {
  const answer = await multistatusRequest(transport, {
    method: 'REPORT',
    path: collectionPath,
    headers: { depth: '1', 'content-type': XML },
    body: multigetBody(paths),
  })
  if (!answer.ok) {
    const { failure } = answer
    if (failure.kind === 'refused' && failure.tag === 'dav-response-too-large') {
      if (paths.length === 1) {
        into.set(paths[0], { state: 'unreadable', reason: 'too-large' })
        return undefined
      }
      const half = Math.ceil(paths.length / 2)
      return (
        (await fetchBatch(transport, collectionPath, paths.slice(0, half), into)) ??
        (await fetchBatch(transport, collectionPath, paths.slice(half), into))
      )
    }
    return failure
  }
  const { multistatus, remote } = answer.value
  for (const response of multistatus.responses) {
    const path = pathOfHref(response.href, remote.path)
    if (path === null || !paths.includes(path)) {
      continue
    }
    const data = response.properties.get(propertyKey(CALDAV_NS, 'calendar-data'))?.textContent ?? ''
    const etag = textOf(response.properties.get(propertyKey(DAV_NS, 'getetag')))
    if (response.status === 404 || response.status === 410) {
      into.set(path, { state: 'gone' })
    } else if (data.length === 0 || etag.length === 0) {
      into.set(path, { state: 'unreadable', reason: 'no-data' })
    } else if (utf8Length(data) > MAX_ENTRY_BYTES) {
      into.set(path, { state: 'unreadable', reason: 'too-large' })
    } else {
      into.set(path, { state: 'found', etag, data })
    }
  }
  // An entry the server did not mention at all is unreadable until proved gone. Radicale answers
  // "404" for it by name; servers built on sabre/dav (Nextcloud, Baïkal) leave it out without a
  // word, and so would a server that simply failed to return it.
  for (const path of paths) {
    if (!into.has(path)) {
      into.set(path, { state: 'unreadable', reason: 'not-in-answer' })
    }
  }
  return undefined
}

/** How many entries one fetch asks about one by one. Past it they stay "unreadable", which changes nothing. */
export const MAX_CONFIRMATIONS = 20

/**
 * Ask the server about one entry by name. Only its own "not found" makes an
 * entry gone; a refusal, a timeout or any other status leaves it as it was.
 */
export async function confirmEntry(transport: DavTransport, path: string): Promise<DavResult<'present' | 'gone'>> {
  const result = await transport.request(propfind(path, '0', '<d:getetag/>'))
  if (result.kind !== 'remote') {
    return fail(failureOf(result))
  }
  if (result.remote.status === 404 || result.remote.status === 410) {
    return ok('gone')
  }
  return result.remote.status === 207 ? ok('present') : fail(remoteStatus(result.remote))
}

/**
 * Fetch entries by path, fifty at a time. A failure of the whole request stops
 * and is returned.
 *
 * An entry the answer does not mention is then asked about by name, because
 * that silence means "deleted a moment ago" on some servers and nothing at all
 * on others. If the question itself cannot be asked, the entry stays unreadable:
 * a pass that could not find out must never conclude that an entry is gone.
 */
export async function fetchEntries(
  transport: DavTransport,
  collectionPath: string,
  paths: string[],
): Promise<DavResult<Map<string, FetchedEntry>>> {
  const entries = new Map<string, FetchedEntry>()
  for (let start = 0; start < paths.length; start += MULTIGET_BATCH) {
    const failure = await fetchBatch(transport, collectionPath, paths.slice(start, start + MULTIGET_BATCH), entries)
    if (failure) {
      return fail(failure)
    }
  }
  let asked = 0
  for (const path of paths) {
    const entry = entries.get(path)
    if (entry?.state !== 'unreadable' || entry.reason !== 'not-in-answer' || asked >= MAX_CONFIRMATIONS) {
      continue
    }
    asked += 1
    const confirmation = await confirmEntry(transport, path)
    if (confirmation.ok && confirmation.value === 'gone') {
      entries.set(path, { state: 'gone' })
    }
  }
  return ok(entries)
}
