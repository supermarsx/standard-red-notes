import * as crypto from 'crypto'
import { Router, Request, Response, NextFunction, raw } from 'express'

import { CaldavService } from '../Service/Caldav/CaldavService'
import { CaldavTokenMetadata } from '../Service/Caldav/CaldavTokenStore'
import { PublishedTodo } from '../Service/Caldav/ICalendarSerializer'

/**
 * Standard Red Notes: read-only CalDAV HTTP surface.
 *
 * Mounted at a base path (default `/dav`) as a self-contained Express sub-router
 * so the non-standard verbs (OPTIONS / PROPFIND / REPORT) and XML bodies stay
 * isolated from the inversify-express controllers. Express 5's router natively
 * supports these methods.
 *
 * URL layout (PRINCIPAL == userUuid):
 *   /dav/                                      service root (well-known target)
 *   /dav/principals/<userUuid>/                principal
 *   /dav/calendars/<userUuid>/                 calendar-home-set
 *   /dav/calendars/<userUuid>/todos/           the VTODO calendar collection
 *   /dav/calendars/<userUuid>/todos/<uid>.ics  a single VTODO object
 *
 * AUTH: every request authenticates via HTTP Basic, where the password is a
 * scoped CalDAV token (`<uuid>.<secret>`). The username is ignored (clients send
 * something; the token is the credential). A client may only address its OWN
 * principal/calendar; cross-user paths 403. Missing/invalid creds -> 401 with a
 * WWW-Authenticate challenge.
 *
 * GATING: the whole router 404s (feature absent) unless the env master switch is
 * on. A valid scoped token additionally proves the user opted in.
 *
 * SCOPE (first slice): OPTIONS, PROPFIND, REPORT (calendar-query +
 * calendar-multiget), GET. Read-only — PUT/DELETE/MKCALENDAR/PROPPATCH and
 * two-way sync are deferred.
 */

const DAV_HEADER = '1, 3, calendar-access'
const ALLOW_HEADER = 'OPTIONS, GET, HEAD, PROPFIND, REPORT'

function etagFor(todo: PublishedTodo): string {
  const basis = `${todo.uid}:${todo.updatedAt ?? ''}:${todo.completed ? 1 : 0}`
  return '"' + crypto.createHash('sha1').update(basis).digest('hex') + '"'
}

function syncTokenFor(todos: PublishedTodo[]): string {
  const hash = crypto.createHash('sha1')
  for (const todo of todos) {
    hash.update(`${todo.uid}:${todo.updatedAt ?? ''}:${todo.completed ? 1 : 0};`)
  }
  return `http://standardrednotes.local/ns/sync/${hash.digest('hex')}`
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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

interface CaldavLocals {
  token: CaldavTokenMetadata
}

export interface CaldavRouterOptions {
  basePath?: string
}

export function createCaldavRouter(service: CaldavService, options: CaldavRouterOptions = {}): Router {
  const basePath = (options.basePath ?? '/dav').replace(/\/$/, '')
  const router = Router()

  // CalDAV bodies are XML; capture them raw (the global json/text parsers don't
  // cover application/xml or text/xml and we parse minimally ourselves).
  router.use(raw({ type: ['application/xml', 'text/xml', 'text/plain'], limit: '256kb' }) as never)

  // Feature master switch: when off, the surface does not exist.
  router.use((_request: Request, response: Response, next: NextFunction) => {
    if (!service.isEnabled()) {
      response.status(404).send('Not found')
      return
    }
    next()
  })

  // Basic-auth gate for every request.
  router.use((request: Request, response: Response, next: NextFunction) => {
    const header = request.headers.authorization
    if (!header || !header.toLowerCase().startsWith('basic ')) {
      unauthorized(response)
      return
    }
    let decoded: string
    try {
      decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8')
    } catch {
      unauthorized(response)
      return
    }
    const separator = decoded.indexOf(':')
    // Password (the token) is everything after the first ':'. Username is ignored.
    const password = separator >= 0 ? decoded.slice(separator + 1) : decoded

    void service
      .verifyToken(password)
      .then((token) => {
        if (!token) {
          unauthorized(response)
          return
        }
        ;(response.locals as unknown as CaldavLocals).token = token
        next()
      })
      .catch(() => unauthorized(response))
  })

  const principalHref = (userUuid: string): string => `${basePath}/principals/${userUuid}/`
  const calendarHomeHref = (userUuid: string): string => `${basePath}/calendars/${userUuid}/`
  const calendarHref = (userUuid: string): string => `${basePath}/calendars/${userUuid}/todos/`
  const objectHref = (userUuid: string, uid: string): string =>
    `${basePath}/calendars/${userUuid}/todos/${encodeURIComponent(uid)}.ics`

  // Reject any attempt to address another user's resources.
  const enforceOwnership = (response: Response, pathUserUuid: string | undefined): boolean => {
    const token = (response.locals as unknown as CaldavLocals).token
    if (pathUserUuid !== undefined && pathUserUuid !== token.userUuid) {
      response.status(403).send('Forbidden')
      return false
    }
    return true
  }

  // ---- OPTIONS: advertise DAV capabilities. ----
  const handleOptions = (_request: Request, response: Response): void => {
    response.setHeader('DAV', DAV_HEADER)
    response.setHeader('Allow', ALLOW_HEADER)
    response.setHeader('Content-Length', '0')
    response.status(200).end()
  }
  router.options('/{*splat}', handleOptions)
  router.options('/', handleOptions)

  // ---- PROPFIND ----
  const propfindResponse = (href: string, propsXml: string): string =>
    `  <response>\n    <href>${xmlEscape(href)}</href>\n    <propstat>\n      <prop>\n${propsXml}\n      </prop>\n      <status>HTTP/1.1 200 OK</status>\n    </propstat>\n  </response>`

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

  const calendarCollectionProps = (userUuid: string, syncToken: string): string =>
    [
      '        <resourcetype><collection/><C:calendar xmlns:C="urn:ietf:params:xml:ns:caldav"/></resourcetype>',
      '        <displayname>Published Todos</displayname>',
      `        <current-user-principal><href>${xmlEscape(principalHref(userUuid))}</href></current-user-principal>`,
      '        <C:supported-calendar-component-set xmlns:C="urn:ietf:params:xml:ns:caldav"><C:comp name="VTODO"/></C:supported-calendar-component-set>',
      '        <C:calendar-description xmlns:C="urn:ietf:params:xml:ns:caldav">Reminders published from Standard Red Notes</C:calendar-description>',
      '        <getcontenttype>text/calendar; charset=utf-8; component=VTODO</getcontenttype>',
      `        <sync-token>${xmlEscape(syncToken)}</sync-token>`,
    ].join('\n')

  const objectProps = (todo: PublishedTodo): string =>
    [
      '        <resourcetype/>',
      `        <getetag>${xmlEscape(etagFor(todo))}</getetag>`,
      '        <getcontenttype>text/calendar; charset=utf-8; component=VTODO</getcontenttype>',
    ].join('\n')

  const buildMultistatus = (responses: string[]): string =>
    `<multistatus xmlns="DAV:">\n${responses.join('\n')}\n</multistatus>`

  const handlePropfind = async (request: Request, response: Response): Promise<void> => {
    const token = (response.locals as unknown as CaldavLocals).token
    const userUuid = token.userUuid
    const depth = (request.headers.depth as string | undefined) ?? '0'
    // Normalize the path relative to the mount base.
    const rel = request.path.replace(/\/$/, '')

    // Service root or principals collection -> principal info.
    if (rel === '' || rel === '/' || rel.startsWith('/principals')) {
      const segs = rel.split('/').filter(Boolean)
      const pathUser = segs[0] === 'principals' ? segs[1] : undefined
      if (!enforceOwnership(response, pathUser)) {
        return
      }
      sendXml(response, 207, buildMultistatus([propfindResponse(principalHref(userUuid), principalProps(userUuid))]))
      return
    }

    const segments = rel.split('/').filter(Boolean)
    // /calendars/<user>/...
    if (segments[0] === 'calendars') {
      const pathUser = segments[1]
      if (!enforceOwnership(response, pathUser)) {
        return
      }
      const todos = await service.listTodos(userUuid)
      const syncToken = syncTokenFor(todos)

      // Calendar-home: /calendars/<user>/  -> list the todo calendar collection.
      if (segments.length === 2) {
        const responses = [
          propfindResponse(calendarHomeHref(userUuid), [
            '        <resourcetype><collection/></resourcetype>',
            '        <displayname>Calendars</displayname>',
          ].join('\n')),
        ]
        if (depth !== '0') {
          responses.push(propfindResponse(calendarHref(userUuid), calendarCollectionProps(userUuid, syncToken)))
        }
        sendXml(response, 207, buildMultistatus(responses))
        return
      }

      // The calendar collection itself: /calendars/<user>/todos/
      if (segments.length === 3 && segments[2] === 'todos') {
        const responses = [
          propfindResponse(calendarHref(userUuid), calendarCollectionProps(userUuid, syncToken)),
        ]
        if (depth !== '0') {
          for (const todo of todos) {
            responses.push(propfindResponse(objectHref(userUuid, todo.uid), objectProps(todo)))
          }
        }
        sendXml(response, 207, buildMultistatus(responses))
        return
      }
    }

    // Anything else: empty multistatus (nothing there).
    sendXml(response, 207, buildMultistatus([]))
  }
  ;(router as unknown as { propfind: Router['get'] }).propfind('/{*splat}', (req, res) => {
    void handlePropfind(req, res)
  })
  ;(router as unknown as { propfind: Router['get'] }).propfind('/', (req, res) => {
    void handlePropfind(req, res)
  })

  // ---- REPORT: calendar-query / calendar-multiget ----
  const handleReport = async (request: Request, response: Response): Promise<void> => {
    const token = (response.locals as unknown as CaldavLocals).token
    const userUuid = token.userUuid
    const segments = request.path.replace(/\/$/, '').split('/').filter(Boolean)
    if (segments[0] === 'calendars' && !enforceOwnership(response, segments[1])) {
      return
    }

    const body = bodyToString(request)
    const allTodos = await service.listTodos(userUuid)

    let selected: PublishedTodo[] = allTodos
    // calendar-multiget: filter to the explicitly requested object hrefs.
    if (/calendar-multiget/i.test(body)) {
      const requestedUids = extractRequestedUids(body)
      if (requestedUids.length > 0) {
        const byUid = new Map(allTodos.map((todo) => [todo.uid, todo]))
        selected = requestedUids.map((uid) => byUid.get(uid)).filter((todo): todo is PublishedTodo => Boolean(todo))
      }
    }

    const responses = selected.map((todo) => {
      const ics = service.serializeCalendar([todo])
      return (
        `  <response>\n    <href>${xmlEscape(objectHref(userUuid, todo.uid))}</href>\n` +
        `    <propstat>\n      <prop>\n        <getetag>${xmlEscape(etagFor(todo))}</getetag>\n` +
        `        <C:calendar-data xmlns:C="urn:ietf:params:xml:ns:caldav">${xmlEscape(ics)}</C:calendar-data>\n` +
        '      </prop>\n      <status>HTTP/1.1 200 OK</status>\n    </propstat>\n  </response>'
      )
    })

    sendXml(response, 207, buildMultistatus(responses))
  }
  ;(router as unknown as { report: Router['get'] }).report('/{*splat}', (req, res) => {
    void handleReport(req, res)
  })
  ;(router as unknown as { report: Router['get'] }).report('/', (req, res) => {
    void handleReport(req, res)
  })

  // ---- GET: a single VTODO object as text/calendar. ----
  const handleGet = async (request: Request, response: Response): Promise<void> => {
    const token = (response.locals as unknown as CaldavLocals).token
    const userUuid = token.userUuid
    const segments = request.path.split('/').filter(Boolean)

    // /calendars/<user>/todos/<uid>.ics
    if (segments[0] === 'calendars' && segments[2] === 'todos' && segments[3]) {
      if (!enforceOwnership(response, segments[1])) {
        return
      }
      const rawUid = segments[3].replace(/\.ics$/i, '')
      const uid = decodeURIComponent(rawUid)
      const todo = await service.getTodo(userUuid, uid)
      if (!todo) {
        response.status(404).send('Not found')
        return
      }
      const ics = service.serializeCalendar([todo])
      response.setHeader('Content-Type', 'text/calendar; charset=utf-8')
      response.setHeader('ETag', etagFor(todo))
      response.status(200).send(ics)
      return
    }

    // GET on the collection returns the whole calendar (handy for debugging /
    // simple subscribers).
    if (segments[0] === 'calendars' && segments[2] === 'todos') {
      if (!enforceOwnership(response, segments[1])) {
        return
      }
      const todos = await service.listTodos(userUuid)
      const ics = service.serializeCalendar(todos)
      response.setHeader('Content-Type', 'text/calendar; charset=utf-8')
      response.status(200).send(ics)
      return
    }

    response.status(404).send('Not found')
  }
  router.get('/{*splat}', (req, res) => {
    void handleGet(req, res)
  })

  return router
}

function bodyToString(request: Request): string {
  const body = request.body as unknown
  if (Buffer.isBuffer(body)) {
    return body.toString('utf8')
  }
  if (typeof body === 'string') {
    return body
  }
  return ''
}

/**
 * Pull the UIDs out of the <href> elements of a calendar-multiget body. We match
 * the `<...>/todos/<uid>.ics` tail of each href.
 */
function extractRequestedUids(body: string): string[] {
  const uids: string[] = []
  const hrefRegex = /<(?:[A-Za-z0-9]+:)?href>\s*([^<]+?)\s*<\/(?:[A-Za-z0-9]+:)?href>/gi
  let match: RegExpExecArray | null
  while ((match = hrefRegex.exec(body)) !== null) {
    const href = match[1]
    const tail = /\/todos\/([^/]+?)\.ics$/i.exec(href.trim())
    if (tail) {
      try {
        uids.push(decodeURIComponent(tail[1]))
      } catch {
        uids.push(tail[1])
      }
    }
  }
  return uids
}
