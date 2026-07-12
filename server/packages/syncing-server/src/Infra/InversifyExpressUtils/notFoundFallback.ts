import { Request, Response } from 'express'

// Post-build JSON-404 fallback for the standalone syncing-server.
//
// This replaces the former AnnotatedFallbackController (@controller('') +
// @all('/{*splat}')), which was INERT under Express 5 / inversify-express-utils
// 6.5.0: mergePaths('', '/{*splat}') collapses to a double-slash '//{*splat}'
// that never matches a single-slash path, so unmatched requests fell through to
// Express's default `Cannot GET`/`Cannot POST` text-404 instead of the intended
// JSON 404 (the same empty-base defect as the t53 revisions bug).
//
// It MUST be mounted with app.use() AFTER server.build() — i.e. after the
// inversify controller router (mounted at rootPath '/') and after the
// setErrorConfig 500 handler. Registered there it catches ONLY genuinely
// unmatched requests and cannot shadow any real route, regardless of controller
// import order (unlike an in-router @controller('/') catch-all, which — because
// the fallback controller imports first — would shadow the entire service).
//
// Kept a 3-arg handler on purpose: Express only routes error flow (next(err)) to
// 4-arg handlers, so thrown-error requests still reach the 500 handler and never
// land here.
export const notFoundFallback = (_request: Request, response: Response): void => {
  response.status(404).json({ error: { message: 'Not Found' } })
}
