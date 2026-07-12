import { Application, Request, Response } from 'express'

// Standard Red Notes: post-build JSON-404 fallback for the standalone files
// service. It replaces the old AnnotatedFallbackController (@controller('') +
// @all('/{*splat}') -> this.notFound()), which is INERT under Express 5 /
// inversify-express-utils 6.5.0: mergePaths('', '/{*splat}') collapses to a
// double-slash '//{*splat}' that path-to-regexp 8 never matches, so unmatched
// requests fell through to Express's default `Cannot GET` finalhandler instead of
// a clean 404.
//
// This MUST be registered AFTER server.build() (which mounts the inversify
// controller router at '/'), so it only ever sees genuinely-unmatched requests and
// cannot shadow any real route. An in-router catch-all (the naive @controller('/')
// "fix") would instead register FIRST and 404 the entire service — do not use it.
//
// The body mirrors this service's own error-config shape ({ error: { message } })
// so a 404 is JSON-shaped like every other error response, and the status is a
// correct 404 rather than Express's default HTML.
export function registerNotFoundFallback(app: Application): void {
  app.use((_request: Request, response: Response) => {
    response.status(404).json({ error: { message: 'Not Found' } })
  })
}
