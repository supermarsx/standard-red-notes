import { NextFunction, Request, Response } from 'express'

// Standard Red Notes: the cosmetic welcome page + 404 that the former
// @controller('') FallbackController (home-server) and LegacyController (standalone
// gateway) were meant to serve. Both declared an EMPTY controller base, which
// inversify-express-utils' mergePaths turns into a never-matching '//{*splat}' under
// Express 5 / path-to-regexp 8 — so those catch-alls were INERT and every unmatched
// request fell through to Express's default `Cannot GET /path` HTML 404.
//
// Restored here as a POST-BUILD `app.use()` handler (mounted AFTER server.build() in
// each entrypoint, i.e. after the inversify controller router and the setErrorConfig
// 500-handler). Because it runs strictly after the controller router it catches ONLY
// genuinely-unmatched requests and can NEVER shadow a real controller or a pre-build
// route (CalDAV /dav, Workflows-UI /workflows-ui, POST /sockets/tokens) — independent
// of controller import order. This is deliberately NOT an in-router catch-all: a live
// @all('/{*splat}') controller registers FIRST on the shared router and would shadow
// the whole service (worst in home-server, where it would front all five bundled
// services). See RouteShadowing.integration.spec.ts + Fallback.integration.spec.ts.
//
// The load-bearing legacy un-versioned proxy the old LegacyController also carried
// (proxying `/items/sync` etc. and legacy auth-endpoint redirects to the syncing/auth
// servers) is intentionally NOT restored — it has been dead since the Express-5
// upgrade with no recorded incident and the un-versioned client path is no longer
// supported.

export const API_GATEWAY_WELCOME_HTML =
  '<!DOCTYPE html><html lang="en"><head><meta name="robots" content="noindex"></head><body>Welcome to the Standard Notes server infrastructure. Learn more at https://docs.standardnotes.com</body></html>'

export const HOME_SERVER_WELCOME_HTML =
  '<!DOCTYPE html><html lang="en"><head><meta name="robots" content="noindex"></head><body>Your home server is up and running! Enter the URL of this page into Standard Notes when registering or signing in to begin using your home server.</body></html>'

// Build the post-build fallback middleware. Serves `welcomeHtml` for `GET /` and a
// JSON 404 (matching the app's `{ error: { message } }` error-body shape) for every
// other unmatched request. Kept as a normal 3-arg handler so Express treats it as a
// request handler, NOT a 4-arg error handler — leaving the existing setErrorConfig
// 500-handler untouched.
export const createFallbackHandler =
  (options: { welcomeHtml: string }) =>
  (request: Request, response: Response, _next: NextFunction): void => {
    if (request.method === 'GET' && request.path === '/') {
      response.send(options.welcomeHtml)

      return
    }

    response.status(404).json({ error: { message: 'Not Found' } })
  }
