import * as crypto from 'crypto'
import { NextFunction, raw, Request, Response, Router } from 'express'

import { CaldavService } from '../Service/Caldav/CaldavService'
import { normalizeCaldavBasePath } from '../Service/Caldav/CaldavBasePath'
import { CaldavTokenMetadata } from '../Service/Caldav/CaldavTokenStore'
import { PublishedTodo } from '../Service/Caldav/ICalendarSerializer'

/**
 * Read-only CalDAV surface for the user's explicit plaintext calendar
 * projection. It never reads or decrypts note content.
 */

const DAV_HEADER = '1, calendar-access'
const CALENDAR_ALLOW_HEADER = 'OPTIONS, GET, HEAD, PROPFIND, REPORT'
const MAX_MULTIGET_HREFS = 1_000

interface CaldavLocals {
  token: CaldavTokenMetadata
}

export interface CaldavRouterOptions {
  basePath?: string
}

type Resource =
  | { kind: 'root' }
  | { kind: 'principal-collection' }
  | { kind: 'principal'; userUuid: string }
  | { kind: 'calendar-home'; userUuid: string }
  | { kind: 'calendar'; userUuid: string }
  | { kind: 'object'; userUuid: string; uid: string }

type ParsedResource = { resource: Resource | null; malformed: boolean }

function allowHeaderFor(resource: Resource): string {
  if (resource.kind === 'calendar') {
    return CALENDAR_ALLOW_HEADER
  }
  if (resource.kind === 'object') {
    return 'OPTIONS, GET, HEAD, PROPFIND'
  }
  return 'OPTIONS, PROPFIND'
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function sendXml(response: Response, status: number, body: string): void {
  response.status(status)
  response.setHeader('Content-Type', 'application/xml; charset=utf-8')
  response.setHeader('DAV', DAV_HEADER)
  response.send('<?xml version="1.0" encoding="utf-8"?>\n' + body)
}

function unauthorized(response: Response): void {
  response.setHeader('WWW-Authenticate', 'Basic realm="Standard Red Notes CalDAV", charset="UTF-8"')
  response.status(401).send('Unauthorized')
}

function strictBasicPassword(header: string | undefined): string | null {
  if (!header) {
    return null
  }
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header)
  if (!match || match[1].length % 4 !== 0) {
    return null
  }
  const encoded = match[1]
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded) {
    return null
  }
  const decoded = bytes.toString('utf8')
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) {
    return null
  }
  const separator = decoded.indexOf(':')
  if (separator <= 0 || separator === decoded.length - 1) {
    return null
  }
  return decoded.slice(separator + 1)
}

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

function parseResource(requestPath: string): ParsedResource {
  if (requestPath === '' || requestPath === '/') {
    return { resource: { kind: 'root' }, malformed: false }
  }
  if (!requestPath.startsWith('/') || requestPath.includes('//')) {
    return { resource: null, malformed: false }
  }
  const trimmed = requestPath.endsWith('/') ? requestPath.slice(0, -1) : requestPath
  const rawSegments = trimmed.split('/').slice(1)
  const decoded = rawSegments.map(safeDecode)
  if (decoded.some((segment) => segment === null)) {
    return { resource: null, malformed: true }
  }
  const segments = decoded as string[]
  if (segments.length === 1 && segments[0] === 'principals') {
    return { resource: { kind: 'principal-collection' }, malformed: false }
  }
  if (segments.length === 2 && segments[0] === 'principals' && segments[1].length > 0) {
    return { resource: { kind: 'principal', userUuid: segments[1] }, malformed: false }
  }
  if (segments[0] !== 'calendars' || segments[1]?.length === 0) {
    return { resource: null, malformed: false }
  }
  if (segments.length === 2) {
    return { resource: { kind: 'calendar-home', userUuid: segments[1] }, malformed: false }
  }
  if (segments.length === 3 && segments[2] === 'todos') {
    return { resource: { kind: 'calendar', userUuid: segments[1] }, malformed: false }
  }
  if (segments.length === 4 && segments[2] === 'todos' && segments[3].toLowerCase().endsWith('.ics')) {
    const uid = segments[3].slice(0, -4)
    if (uid.length > 0) {
      return { resource: { kind: 'object', userUuid: segments[1], uid }, malformed: false }
    }
  }
  return { resource: null, malformed: false }
}

function bodyToString(request: Request): string {
  const body = request.body as unknown
  if (Buffer.isBuffer(body)) {
    return body.toString('utf8')
  }
  return typeof body === 'string' ? body : ''
}

function strongEtag(representation: string): string {
  return `"${crypto.createHash('sha256').update(representation, 'utf8').digest('hex')}"`
}

function splitEtags(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function weakTag(tag: string): string {
  return tag.replace(/^W\//i, '')
}

function preconditionsPass(request: Request, response: Response, etag: string): boolean {
  const ifMatch = request.headers['if-match']
  if (typeof ifMatch === 'string') {
    const candidates = splitEtags(ifMatch)
    if (!candidates.includes('*') && !candidates.includes(etag)) {
      response.setHeader('ETag', etag)
      response.status(412).end()
      return false
    }
  }

  const ifNoneMatch = request.headers['if-none-match']
  if (typeof ifNoneMatch === 'string') {
    const candidates = splitEtags(ifNoneMatch)
    if (candidates.includes('*') || candidates.some((candidate) => weakTag(candidate) === etag)) {
      response.setHeader('ETag', etag)
      response.status(304).end()
      return false
    }
  }
  return true
}

function asyncRoute(
  handler: (request: Request, response: Response) => Promise<void>,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    handler(request, response).catch(next)
  }
}

function parseDepth(request: Request): '0' | '1' | null {
  const value = request.headers.depth
  if (value === undefined) {
    return '0'
  }
  return value === '0' || value === '1' ? value : null
}

function buildMultistatus(responses: string[]): string {
  return `<multistatus xmlns="DAV:">\n${responses.join('\n')}\n</multistatus>`
}

function propfindResponse(href: string, propsXml: string): string {
  return (
    `  <response>\n    <href>${xmlEscape(href)}</href>\n    <propstat>\n      <prop>\n${propsXml}\n` +
    '      </prop>\n      <status>HTTP/1.1 200 OK</status>\n    </propstat>\n  </response>'
  )
}

function statusResponse(href: string, status: string): string {
  return `  <response>\n    <href>${xmlEscape(href)}</href>\n    <status>HTTP/1.1 ${status}</status>\n  </response>`
}

function dangerousXml(body: string): boolean {
  return /<!DOCTYPE|<!ENTITY/i.test(body)
}

type ReportKind = 'calendar-query' | 'calendar-multiget'

function reportKind(body: string): ReportKind | null {
  if (body.length === 0 || dangerousXml(body) || !isStructurallyWellFormedXml(body)) {
    return null
  }
  const withoutDeclaration = body.replace(/^\s*<\?xml[^>]*\?>/i, '')
  const match = /^\s*<(?:[A-Za-z_][\w.-]*:)?(calendar-query|calendar-multiget)\b/i.exec(withoutDeclaration)
  if (!match) {
    return null
  }
  const kind = match[1].toLowerCase() as ReportKind
  const closing = new RegExp(`</(?:[A-Za-z_][\\w.-]*:)?${kind}\\s*>\\s*$`, 'i')
  return closing.test(withoutDeclaration) ? kind : null
}

function decodeXmlText(value: string): string | null {
  if (/&(?!#x[0-9a-f]+;|#\d+;|amp;|lt;|gt;|quot;|apos;)/i.test(value)) {
    return null
  }
  let valid = true
  const decoded = value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_full, entity: string) => {
    switch (entity.toLowerCase()) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default: {
        const radix = entity[1].toLowerCase() === 'x' ? 16 : 10
        const digits = radix === 16 ? entity.slice(2) : entity.slice(1)
        const codePoint = Number.parseInt(digits, radix)
        if (
          !Number.isSafeInteger(codePoint) ||
          codePoint <= 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          valid = false
          return ''
        }
        return String.fromCodePoint(codePoint)
      }
    }
  })
  return valid ? decoded : null
}

const XML_NAME = '[A-Za-z_][A-Za-z0-9_.:-]*'
const XML_ATTRIBUTE = `${XML_NAME}\\s*=\\s*(?:"[^"]*"|'[^']*')`
const XML_START_TAG = new RegExp(`^(${XML_NAME})(?:\\s+${XML_ATTRIBUTE})*\\s*(\\/)?$`)
const XML_END_TAG = new RegExp(`^\\/(${XML_NAME})\\s*$`)
const XML_DECLARATION = new RegExp(`^\\?xml(?:\\s+${XML_ATTRIBUTE})*\\s*\\?$`, 'i')

/**
 * A deliberately small XML well-formedness gate for the two REPORT documents
 * this read-only server accepts. It validates one root, exact tag nesting,
 * quoted attributes, and entities without adding a general-purpose XML parser
 * or enabling DTD/entity expansion.
 */
function isStructurallyWellFormedXml(body: string): boolean {
  const stack: string[] = []
  let roots = 0
  let cursor = 0

  while (cursor < body.length) {
    const opening = body.indexOf('<', cursor)
    const text = opening === -1 ? body.slice(cursor) : body.slice(cursor, opening)
    if ((stack.length === 0 && text.trim().length > 0) || decodeXmlText(text) === null) {
      return false
    }
    if (opening === -1) {
      cursor = body.length
      break
    }

    let quote: '"' | "'" | null = null
    let closing = opening + 1
    for (; closing < body.length; closing++) {
      const character = body[closing]
      if (quote !== null) {
        if (character === quote) {
          quote = null
        }
        continue
      }
      if (character === '"' || character === "'") {
        quote = character
      } else if (character === '<') {
        return false
      } else if (character === '>') {
        break
      }
    }
    if (closing >= body.length || quote !== null) {
      return false
    }

    const tag = body.slice(opening + 1, closing).trim()
    if (decodeXmlText(tag) === null) {
      return false
    }
    if (tag.startsWith('?')) {
      if (roots !== 0 || stack.length !== 0 || !XML_DECLARATION.test(tag)) {
        return false
      }
      cursor = closing + 1
      continue
    }
    if (tag.startsWith('!')) {
      return false
    }

    const endTag = XML_END_TAG.exec(tag)
    if (endTag) {
      if (stack.pop() !== endTag[1]) {
        return false
      }
      cursor = closing + 1
      continue
    }

    const startTag = XML_START_TAG.exec(tag)
    if (!startTag) {
      return false
    }
    if (stack.length === 0) {
      roots += 1
      if (roots > 1) {
        return false
      }
    }
    if (startTag[2] !== '/') {
      stack.push(startTag[1])
    }
    cursor = closing + 1
  }

  return roots === 1 && stack.length === 0
}

function extractHrefs(body: string): string[] | null {
  const hrefs: string[] = []
  const hrefRegex = /<(?:[A-Za-z_][\w.-]*:)?href\b[^>]*>\s*([^<]*?)\s*<\/(?:[A-Za-z_][\w.-]*:)?href\s*>/gi
  let match: RegExpExecArray | null
  while ((match = hrefRegex.exec(body)) !== null) {
    if (hrefs.length >= MAX_MULTIGET_HREFS) {
      return null
    }
    const decoded = decodeXmlText(match[1])
    if (decoded === null || decoded.length === 0) {
      return null
    }
    hrefs.push(decoded)
  }
  return hrefs
}

export function createCaldavRouter(service: CaldavService, options: CaldavRouterOptions = {}): Router {
  const basePath = normalizeCaldavBasePath(options.basePath ?? '/dav')
  const router = Router()

  const rootHref = `${basePath}/`
  const principalCollectionHref = `${basePath}/principals/`
  const principalHref = (userUuid: string): string => `${basePath}/principals/${encodeURIComponent(userUuid)}/`
  const calendarHomeHref = (userUuid: string): string => `${basePath}/calendars/${encodeURIComponent(userUuid)}/`
  const calendarHref = (userUuid: string): string => `${calendarHomeHref(userUuid)}todos/`
  const objectHref = (userUuid: string, uid: string): string =>
    `${calendarHref(userUuid)}${encodeURIComponent(uid)}.ics`

  router.use((_request: Request, response: Response, next: NextFunction) => {
    if (!service.isEnabled()) {
      response.status(404).send('Not found')
      return
    }
    next()
  })

  router.use((request: Request, response: Response, next: NextFunction) => {
    const password = strictBasicPassword(request.headers.authorization)
    if (password === null) {
      unauthorized(response)
      return
    }
    service
      .verifyToken(password)
      .then((token) => {
        if (!token || token.scope !== 'calendar-read') {
          unauthorized(response)
          return
        }
        ;(response.locals as unknown as CaldavLocals).token = token
        response.setHeader('DAV', DAV_HEADER)
        next()
      })
      .catch(next)
  })

  // Parse bounded REPORT bodies only after feature gating and authentication so
  // disabled or unauthenticated requests cannot bypass their 404/401 contract
  // by deliberately triggering a body-parser failure.
  router.use(raw({ type: ['application/xml', 'text/xml', 'text/plain'], limit: '256kb' }) as never)

  const tokenFor = (response: Response): CaldavTokenMetadata => (response.locals as unknown as CaldavLocals).token

  const ownedResource = (request: Request, response: Response): Resource | null => {
    const parsed = parseResource(request.path)
    if (parsed.malformed) {
      response.status(400).send('Malformed DAV resource path')
      return null
    }
    if (!parsed.resource) {
      response.status(404).send('Not found')
      return null
    }
    if ('userUuid' in parsed.resource && parsed.resource.userUuid !== tokenFor(response).userUuid) {
      response.status(403).send('Forbidden')
      return null
    }
    return parsed.resource
  }

  const handleOptions = (request: Request, response: Response): void => {
    const resource = ownedResource(request, response)
    if (!resource) {
      return
    }
    response.setHeader('Allow', allowHeaderFor(resource))
    response.setHeader('MS-Author-Via', 'DAV')
    response.setHeader('Content-Length', '0')
    response.status(200).end()
  }

  router.options('/', handleOptions)
  router.options('/{*splat}', handleOptions)

  const rootProps = (userUuid: string): string =>
    [
      '        <resourcetype><collection/></resourcetype>',
      '        <displayname>Standard Red Notes CalDAV</displayname>',
      `        <current-user-principal><href>${xmlEscape(principalHref(userUuid))}</href></current-user-principal>`,
      `        <principal-collection-set><href>${xmlEscape(principalCollectionHref)}</href></principal-collection-set>`,
    ].join('\n')

  const principalCollectionProps = (): string =>
    ['        <resourcetype><collection/></resourcetype>', '        <displayname>Principals</displayname>'].join('\n')

  const principalProps = (userUuid: string): string =>
    [
      '        <resourcetype><principal/><collection/></resourcetype>',
      `        <displayname>${xmlEscape(userUuid)}</displayname>`,
      `        <current-user-principal><href>${xmlEscape(principalHref(userUuid))}</href></current-user-principal>`,
      `        <principal-URL><href>${xmlEscape(principalHref(userUuid))}</href></principal-URL>`,
      `        <C:calendar-home-set xmlns:C="urn:ietf:params:xml:ns:caldav"><href>${xmlEscape(
        calendarHomeHref(userUuid),
      )}</href></C:calendar-home-set>`,
    ].join('\n')

  const calendarCollectionProps = (userUuid: string, etag: string): string =>
    [
      '        <resourcetype><collection/><C:calendar xmlns:C="urn:ietf:params:xml:ns:caldav"/></resourcetype>',
      '        <displayname>Published Todos</displayname>',
      `        <current-user-principal><href>${xmlEscape(principalHref(userUuid))}</href></current-user-principal>`,
      '        <C:supported-calendar-component-set xmlns:C="urn:ietf:params:xml:ns:caldav"><C:comp name="VTODO"/></C:supported-calendar-component-set>',
      '        <C:calendar-description xmlns:C="urn:ietf:params:xml:ns:caldav">Explicitly published Standard Red Notes todos</C:calendar-description>',
      '        <getcontenttype>text/calendar; charset=utf-8; component=VTODO</getcontenttype>',
      `        <getetag>${xmlEscape(etag)}</getetag>`,
      '        <supported-report-set><supported-report><report><C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"/></report></supported-report><supported-report><report><C:calendar-multiget xmlns:C="urn:ietf:params:xml:ns:caldav"/></report></supported-report></supported-report-set>',
    ].join('\n')

  const objectProps = (etag: string): string =>
    [
      '        <resourcetype/>',
      `        <getetag>${xmlEscape(etag)}</getetag>`,
      '        <getcontenttype>text/calendar; charset=utf-8; component=VTODO</getcontenttype>',
    ].join('\n')

  const handlePropfind = async (request: Request, response: Response): Promise<void> => {
    const resource = ownedResource(request, response)
    if (!resource) {
      return
    }
    const depth = parseDepth(request)
    if (depth === null) {
      sendXml(response, 403, '<error xmlns="DAV:"><propfind-finite-depth/></error>')
      return
    }
    const userUuid = tokenFor(response).userUuid

    if (resource.kind === 'root') {
      sendXml(response, 207, buildMultistatus([propfindResponse(rootHref, rootProps(userUuid))]))
      return
    }
    if (resource.kind === 'principal-collection') {
      const responses = [
        propfindResponse(principalCollectionHref, principalCollectionProps()),
        ...(depth === '1' ? [propfindResponse(principalHref(userUuid), principalProps(userUuid))] : []),
      ]
      sendXml(response, 207, buildMultistatus(responses))
      return
    }
    if (resource.kind === 'principal') {
      sendXml(response, 207, buildMultistatus([propfindResponse(principalHref(userUuid), principalProps(userUuid))]))
      return
    }
    if (resource.kind === 'calendar-home') {
      const responses = [
        propfindResponse(
          calendarHomeHref(userUuid),
          ['        <resourcetype><collection/></resourcetype>', '        <displayname>Calendars</displayname>'].join(
            '\n',
          ),
        ),
      ]
      if (depth === '1') {
        const todos = await service.listTodos(userUuid)
        const calendarEtag = strongEtag(service.serializeCalendar(todos))
        responses.push(propfindResponse(calendarHref(userUuid), calendarCollectionProps(userUuid, calendarEtag)))
      }
      sendXml(response, 207, buildMultistatus(responses))
      return
    }
    if (resource.kind === 'calendar') {
      const todos = await service.listTodos(userUuid)
      const calendarEtag = strongEtag(service.serializeCalendar(todos))
      const responses = [propfindResponse(calendarHref(userUuid), calendarCollectionProps(userUuid, calendarEtag))]
      if (depth === '1') {
        for (const todo of todos) {
          const etag = strongEtag(service.serializeCalendar([todo]))
          responses.push(propfindResponse(objectHref(userUuid, todo.uid), objectProps(etag)))
        }
      }
      sendXml(response, 207, buildMultistatus(responses))
      return
    }

    const todo = await service.getTodo(userUuid, resource.uid)
    if (!todo) {
      response.status(404).send('Not found')
      return
    }
    const etag = strongEtag(service.serializeCalendar([todo]))
    sendXml(response, 207, buildMultistatus([propfindResponse(objectHref(userUuid, todo.uid), objectProps(etag))]))
  }

  router.propfind('/', asyncRoute(handlePropfind))
  router.propfind('/{*splat}', asyncRoute(handlePropfind))

  const resourceFromMultigetHref = (href: string): Resource | null => {
    let pathname: string
    try {
      const parsed = new URL(href, 'http://caldav.invalid')
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null
      }
      pathname = parsed.pathname
    } catch {
      return null
    }
    const relative =
      pathname === basePath || pathname === `${basePath}/`
        ? '/'
        : pathname.startsWith(`${basePath}/`)
          ? pathname.slice(basePath.length)
          : ''
    if (relative.length === 0) {
      return null
    }
    const parsed = parseResource(relative)
    return parsed.malformed ? null : parsed.resource
  }

  const reportTodoResponse = (userUuid: string, todo: PublishedTodo): string => {
    const ics = service.serializeCalendar([todo])
    const etag = strongEtag(ics)
    return (
      `  <response>\n    <href>${xmlEscape(objectHref(userUuid, todo.uid))}</href>\n` +
      `    <propstat>\n      <prop>\n        <getetag>${xmlEscape(etag)}</getetag>\n` +
      `        <C:calendar-data xmlns:C="urn:ietf:params:xml:ns:caldav">${xmlEscape(ics)}</C:calendar-data>\n` +
      '      </prop>\n      <status>HTTP/1.1 200 OK</status>\n    </propstat>\n  </response>'
    )
  }

  const handleReport = async (request: Request, response: Response): Promise<void> => {
    const resource = ownedResource(request, response)
    if (!resource) {
      return
    }
    if (resource.kind !== 'calendar') {
      response.status(405).setHeader('Allow', allowHeaderFor(resource))
      response.end()
      return
    }

    const body = bodyToString(request)
    const kind = reportKind(body)
    if (!kind) {
      response.status(400).send('Unsupported or malformed DAV report')
      return
    }
    // This bounded implementation supports component selection but does not
    // claim RFC 4791 time-range filter support.
    if (kind === 'calendar-query' && /<(?:[A-Za-z_][\w.-]*:)?time-range\b/i.test(body)) {
      sendXml(
        response,
        403,
        '<error xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><C:supported-filter/></error>',
      )
      return
    }

    const userUuid = tokenFor(response).userUuid
    const allTodos = await service.listTodos(userUuid)
    if (kind === 'calendar-query') {
      const requestedComponents = Array.from(
        body.matchAll(/<(?:[A-Za-z_][\w.-]*:)?comp-filter\b[^>]*\bname\s*=\s*["']([^"']+)["']/gi),
        (match) => match[1].toUpperCase(),
      )
      const includeTodos =
        requestedComponents.length === 0 ||
        requestedComponents.includes('VTODO') ||
        (requestedComponents.length === 1 && requestedComponents[0] === 'VCALENDAR')
      const responses = includeTodos ? allTodos.map((todo) => reportTodoResponse(userUuid, todo)) : []
      sendXml(response, 207, buildMultistatus(responses))
      return
    }

    const hrefs = extractHrefs(body)
    if (!hrefs || hrefs.length === 0) {
      response.status(400).send('A calendar-multiget report requires at least one valid href')
      return
    }
    const byUid = new Map(allTodos.map((todo) => [todo.uid, todo]))
    const seenResponses = new Set<string>()
    const responses: string[] = []
    for (const href of hrefs) {
      const requested = resourceFromMultigetHref(href)
      if (!requested || requested.kind !== 'object' || requested.userUuid !== userUuid || !byUid.has(requested.uid)) {
        const key = `missing:${href}`
        if (!seenResponses.has(key)) {
          seenResponses.add(key)
          responses.push(statusResponse(href, '404 Not Found'))
        }
        continue
      }
      const key = `object:${requested.uid}`
      if (!seenResponses.has(key)) {
        seenResponses.add(key)
        responses.push(reportTodoResponse(userUuid, byUid.get(requested.uid) as PublishedTodo))
      }
    }
    sendXml(response, 207, buildMultistatus(responses))
  }

  router.report('/', asyncRoute(handleReport))
  router.report('/{*splat}', asyncRoute(handleReport))

  const handleGetOrHead = async (request: Request, response: Response, headOnly: boolean): Promise<void> => {
    const resource = ownedResource(request, response)
    if (!resource) {
      return
    }
    const userUuid = tokenFor(response).userUuid
    let ics: string
    if (resource.kind === 'object') {
      const todo = await service.getTodo(userUuid, resource.uid)
      if (!todo) {
        response.status(404).send('Not found')
        return
      }
      ics = service.serializeCalendar([todo])
    } else if (resource.kind === 'calendar') {
      ics = service.serializeCalendar(await service.listTodos(userUuid))
    } else {
      response.status(405).setHeader('Allow', 'OPTIONS, PROPFIND')
      response.end()
      return
    }

    const etag = strongEtag(ics)
    response.setHeader('Content-Type', 'text/calendar; charset=utf-8')
    response.setHeader('Cache-Control', 'private, must-revalidate')
    response.setHeader('Vary', 'Authorization')
    response.setHeader('ETag', etag)
    response.setHeader('Content-Length', String(Buffer.byteLength(ics, 'utf8')))
    if (!preconditionsPass(request, response, etag)) {
      return
    }
    response.status(200)
    if (headOnly) {
      response.end()
    } else {
      response.send(ics)
    }
  }

  router.head(
    '/',
    asyncRoute((request, response) => handleGetOrHead(request, response, true)),
  )
  router.head(
    '/{*splat}',
    asyncRoute((request, response) => handleGetOrHead(request, response, true)),
  )
  router.get(
    '/',
    asyncRoute((request, response) => handleGetOrHead(request, response, false)),
  )
  router.get(
    '/{*splat}',
    asyncRoute((request, response) => handleGetOrHead(request, response, false)),
  )

  const handleUnsupported = (request: Request, response: Response): void => {
    const resource = ownedResource(request, response)
    if (!resource) {
      return
    }
    response.setHeader('Allow', allowHeaderFor(resource))
    response.status(405).send('Method not allowed')
  }
  router.all('/', handleUnsupported)
  router.all('/{*splat}', handleUnsupported)

  // Express decodes wildcard parameters before invoking a handler. Contain a
  // malformed percent-encoding here so it is a client-path error, not a 500.
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof URIError) {
      response.status(400).send('Malformed DAV resource path')
      return
    }
    const parserError = error as { status?: unknown; type?: unknown }
    if (parserError.status === 413 || parserError.type === 'entity.too.large') {
      response.status(413).send('DAV request body is too large')
      return
    }
    next(error)
  })

  return router
}
