import { escapeXml } from '../protocol/multistatus'
import { DavTransport, RelayRequest, RelayResult } from '../transport/DavTransport'

/**
 * A stand-in for one calendar collection, for the paths a real server cannot be
 * made to take on demand: a relay that refuses, an answer that never comes, an
 * entry that vanishes between two requests, a note that changes mid-pass.
 *
 * Its answers have the SHAPE of a sabre/dav server's (which is what Nextcloud
 * and Baïkal are). They are written by hand and prove nothing about what real
 * servers send; that is what the recorded sessions are for. What this proves is
 * what the engine does with an answer of that shape.
 *
 * It does not evaluate a time range: a windowed listing returns every entry
 * unless `outsideWindow` names it.
 */
export class MemoryCalendar implements DavTransport {
  readonly sent: RelayRequest[] = []
  /** Entries by name. */
  readonly entries = new Map<string, { etag: string; data: string }>()
  /** Names a windowed listing leaves out. */
  readonly outsideWindow = new Set<string>()
  /** Called before each request is answered; return a result to answer with that instead. */
  intercept: ((request: RelayRequest, index: number) => RelayResult | undefined | void) | undefined
  /** Whether a multiget names a missing entry with a 404 (as Radicale does) or leaves it out (as sabre does). */
  namesMissingEntries = false

  private revision = 0

  constructor(readonly collectionPath: string) {}

  /** Create or replace an entry, as another calendar app would. */
  put(name: string, data: string): void {
    this.revision += 1
    this.entries.set(name, { etag: `"etag-${this.revision}"`, data })
  }

  remove(name: string): void {
    if (this.entries.delete(name)) {
      this.revision += 1
    }
  }

  get ctag(): string {
    return `ctag-${this.revision}`
  }

  /** How many requests of a kind were sent: `REPORT calendar-multiget`, `PROPFIND`, … */
  count(kind: string): number {
    return this.sent.filter((request) => `${request.method} ${this.kindOf(request)}`.startsWith(kind)).length
  }

  private kindOf(request: RelayRequest): string {
    const body = request.body ?? ''
    if (body.includes('calendar-multiget')) {
      return 'calendar-multiget'
    }
    if (body.includes('calendar-query')) {
      return body.includes('prop-filter') ? 'calendar-query repeating' : 'calendar-query'
    }
    return request.path === this.collectionPath ? 'collection' : 'entry'
  }

  async request(request: RelayRequest): Promise<RelayResult> {
    const index = this.sent.length
    this.sent.push(request)
    const instead = this.intercept?.(request, index)
    if (instead) {
      return instead
    }
    if (!request.path.startsWith(this.collectionPath)) {
      return this.answer(request, 404, '')
    }
    const kind = this.kindOf(request)
    if (request.method === 'PROPFIND' && kind === 'collection') {
      return this.multistatus(request, [
        this.response(this.collectionPath, `<cs:getctag>${escapeXml(this.ctag)}</cs:getctag>`),
      ])
    }
    if (request.method === 'PROPFIND') {
      const entry = this.entries.get(request.path.slice(this.collectionPath.length))
      return entry
        ? this.multistatus(request, [this.response(request.path, `<d:getetag>${escapeXml(entry.etag)}</d:getetag>`)])
        : this.answer(request, 404, '')
    }
    if (request.method === 'REPORT' && kind.startsWith('calendar-query')) {
      const windowed = (request.body ?? '').includes('time-range')
      const responses: string[] = []
      for (const [name, entry] of this.entries) {
        if (windowed && this.outsideWindow.has(name)) {
          continue
        }
        if (kind.endsWith('repeating') && !entry.data.includes('RRULE')) {
          continue
        }
        responses.push(
          this.response(`${this.collectionPath}${name}`, `<d:getetag>${escapeXml(entry.etag)}</d:getetag>`),
        )
      }
      return this.multistatus(request, responses)
    }
    if (request.method === 'REPORT' && kind === 'calendar-multiget') {
      const responses: string[] = []
      for (const match of (request.body ?? '').matchAll(/<d:href>([^<]*)<\/d:href>/g)) {
        const path = match[1].replace(/&amp;/g, '&')
        const entry = this.entries.get(path.slice(this.collectionPath.length))
        if (entry) {
          responses.push(
            this.response(
              path,
              `<d:getetag>${escapeXml(entry.etag)}</d:getetag><cal:calendar-data>${escapeXml(entry.data)}</cal:calendar-data>`,
            ),
          )
        } else if (this.namesMissingEntries) {
          responses.push(
            `<d:response><d:href>${escapeXml(path)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`,
          )
        }
      }
      return this.multistatus(request, responses)
    }
    return this.answer(request, 405, '')
  }

  private response(path: string, properties: string): string {
    return (
      `<d:response><d:href>${escapeXml(path)}</d:href><d:propstat><d:prop>${properties}</d:prop>` +
      '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>'
    )
  }

  private multistatus(request: RelayRequest, responses: string[]): RelayResult {
    return this.answer(
      request,
      207,
      '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" ' +
        'xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">' +
        `${responses.join('')}</d:multistatus>`,
    )
  }

  private answer(request: RelayRequest, status: number, body: string): RelayResult {
    return {
      kind: 'remote',
      remote: {
        status,
        headers: body.length > 0 ? { 'content-type': 'application/xml; charset=utf-8' } : {},
        body,
        bodyEncoding: 'utf8',
        path: request.path,
        redirects: 0,
      },
    }
  }
}

/** The relay refusing a request, with one of its `dav-` tags. */
export const refusal = (tag: string, httpStatus: number, extra: Record<string, unknown> = {}): RelayResult => ({
  kind: 'refused',
  httpStatus,
  tag,
  message: tag,
  extra,
})
