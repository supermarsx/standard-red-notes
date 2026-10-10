import { NextFunction, Request, RequestHandler, Response } from 'express'

import { normalizeCaldavBasePath } from '../Service/Caldav/CaldavBasePath'

/**
 * Standard Red Notes: let a CalDAV client's OPTIONS request reach the CalDAV
 * router instead of being answered as a browser CORS preflight.
 *
 * WHY THIS EXISTS: `cors()` is mounted app-wide with the package default
 * `preflightContinue: false`, so it answers EVERY `OPTIONS` with 204 and ENDS
 * the request. The CalDAV router's own `OPTIONS` handler — the one that returns
 * `DAV: 1, calendar-access` and the `Allow` list — is therefore unreachable on a
 * real deployment, while it answers perfectly in a unit test that mounts the
 * router on a bare app. A stock client (Apple Calendar, Thunderbird, DAVx5) does
 * an OPTIONS during account setup, reads no `DAV` header, concludes the URL is
 * not a CalDAV server and refuses to add the account. The feed then looks
 * "deployed and working" from every direction except the only one that matters.
 *
 * Skipping CORS here is correct rather than merely convenient: this surface is
 * authenticated with HTTP Basic by a native client, not by a browser carrying an
 * Origin, so it has no preflight to satisfy and no credentialed cross-origin
 * response to protect. The router supplies its own `DAV` and `Allow` headers and
 * gates itself (404 when the feature is off, 401 without a valid scoped token),
 * so nothing is exposed that the router would not already expose to a GET.
 *
 * Scoped to the CalDAV mount ONLY, matched the same way the router matches it
 * (exact base path, or the base path followed by `/`), so `/davsomething` is not
 * swept in.
 */
export function createCaldavCorsBypass(corsMiddleware: RequestHandler, basePath: string): RequestHandler {
  const normalized = normalizeCaldavBasePath(basePath)
  const prefix = `${normalized}/`
  return (request: Request, response: Response, next: NextFunction): void => {
    if (request.path === normalized || request.path.startsWith(prefix)) {
      next()
      return
    }
    corsMiddleware(request, response, next)
  }
}
