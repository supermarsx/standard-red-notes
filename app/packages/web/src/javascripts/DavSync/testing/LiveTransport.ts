import http from 'node:http'
import https from 'node:https'
import { DavTransport, RelayRequest, RelayResponseHeaderName, RelayResult } from '../transport/DavTransport'

/**
 * A stand-in for the Standard Red Notes relay, for RECORDING what a real CalDAV
 * server answers. It is test tooling: nothing in the app imports it, and it is
 * only ever pointed at a throwaway server on the developer's own machine.
 *
 * It applies the parts of the relay's contract that shape what the sync code
 * sees: same-origin redirects are followed for read methods (three at most), a
 * 401 becomes the relay's own `dav-password-rejected`, and only the six response
 * headers the relay hands back are handed back.
 */

export type LiveAccount = { origin: string; username: string; password: string }

export type RawAnswer = { status: number; headers: http.IncomingHttpHeaders; body: string }

const HANDED_BACK: RelayResponseHeaderName[] = ['etag', 'content-type', 'dav', 'allow', 'retry-after']
const READ_METHODS = new Set(['OPTIONS', 'PROPFIND', 'REPORT', 'GET'])
const MAX_REDIRECTS = 3

/** One request straight to the server, with the account's credentials. */
export function rawRequest(
  account: LiveAccount,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<RawAnswer> {
  const url = new URL(path, account.origin)
  const client = url.protocol === 'https:' ? https : http
  const payload = body === undefined ? undefined : Buffer.from(body, 'utf8')
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method,
        headers: {
          ...headers,
          authorization: `Basic ${Buffer.from(`${account.username}:${account.password}`).toString('base64')}`,
          'accept-encoding': 'identity',
          ...(payload ? { 'content-length': String(payload.length) } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    request.on('error', reject)
    request.end(payload)
  })
}

export class LiveTransport implements DavTransport {
  constructor(private readonly account: LiveAccount) {}

  async request(request: RelayRequest): Promise<RelayResult> {
    let path = request.path
    for (let redirects = 0; ; redirects++) {
      let answer: RawAnswer
      try {
        answer = await rawRequest(this.account, request.method, path, { ...request.headers }, request.body)
      } catch {
        return {
          kind: 'refused',
          httpStatus: 502,
          tag: 'dav-remote-unreachable',
          message: 'The server did not answer.',
          extra: { host: new URL(this.account.origin).host },
        }
      }
      if ([301, 302, 307, 308].includes(answer.status) && READ_METHODS.has(request.method)) {
        const location = new URL(String(answer.headers.location ?? ''), new URL(path, this.account.origin))
        if (location.origin !== new URL(this.account.origin).origin) {
          return {
            kind: 'refused',
            httpStatus: 409,
            tag: 'dav-redirect-other-origin',
            message: 'The server points to another address.',
            extra: { location: { origin: location.origin, path: location.pathname } },
          }
        }
        if (redirects >= MAX_REDIRECTS) {
          return {
            kind: 'refused',
            httpStatus: 502,
            tag: 'dav-too-many-redirects',
            message: 'Too many redirects.',
            extra: {},
          }
        }
        path = location.pathname
        continue
      }
      if (answer.status === 401) {
        return {
          kind: 'refused',
          httpStatus: 409,
          tag: 'dav-password-rejected',
          message: 'The account no longer accepts the stored password.',
          extra: {},
        }
      }
      const headers: Partial<Record<RelayResponseHeaderName, string>> = {}
      for (const name of HANDED_BACK) {
        const value = answer.headers[name]
        if (typeof value === 'string') {
          headers[name] = value
        }
      }
      return {
        kind: 'remote',
        remote: { status: answer.status, headers, body: answer.body, bodyEncoding: 'utf8', path, redirects },
      }
    }
  }
}
