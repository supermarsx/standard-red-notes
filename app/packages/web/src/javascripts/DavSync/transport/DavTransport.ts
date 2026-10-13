/**
 * Standard Red Notes: how the calendar sync engine reaches a CalDAV server.
 *
 * The engine never talks to the other server itself. A browser cannot (no CORS
 * on a stock Nextcloud, and the app's own content security policy), so every
 * request goes through the Standard Red Notes server, which holds the account's
 * password and forwards one request at a time. This file is the engine's side of
 * that contract and nothing else: the shapes below are the relay's, taken from
 * its contract, and the engine is written against the interface so that tests
 * can replay recorded answers and a later transport (the desktop app's own HTTP
 * client) can stand in without the engine changing.
 */

export type RelayRequestHeaderName = 'depth' | 'if-match' | 'if-none-match' | 'content-type' | 'prefer'

export type RelayRequestHeaders = Partial<Record<RelayRequestHeaderName, string>>

export type RelayMethod = 'OPTIONS' | 'PROPFIND' | 'REPORT' | 'GET' | 'PUT' | 'DELETE' | 'MKCALENDAR'

export interface RelayRequest {
  method: RelayMethod
  /** An absolute path on the account's origin, already escaped. No query. */
  path: string
  headers?: RelayRequestHeaders
  body?: string
}

export type RelayResponseHeaderName = 'etag' | 'content-type' | 'dav' | 'allow' | 'retry-after' | 'location'

/** What the other server answered, handed through unchanged. */
export interface RemoteAnswer {
  status: number
  headers: Partial<Record<RelayResponseHeaderName, string>>
  body: string
  bodyEncoding: 'utf8' | 'base64'
  /** The path that produced the answer; differs from the request's after a same-origin redirect. */
  path: string
  redirects: number
}

/**
 * The three things that can come back, kept apart because they mean different
 * things to a sync pass:
 *
 *  - `remote`: the other server answered. Its status may still be 404 or 412.
 *  - `refused`: the relay would not forward the request, and says why in `tag`.
 *  - `transport`: neither; the Standard Red Notes server itself could not be
 *    reached, or the session has a problem. Nothing is known about the remote.
 */
export type RelayResult =
  | { kind: 'remote'; remote: RemoteAnswer }
  | { kind: 'refused'; httpStatus: number; tag: string; message: string; extra: Record<string, unknown> }
  | { kind: 'transport'; httpStatus: number | null }

export interface DavTransport {
  request(request: RelayRequest): Promise<RelayResult>
}
