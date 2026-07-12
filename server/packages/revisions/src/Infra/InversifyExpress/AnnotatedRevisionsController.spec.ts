import 'reflect-metadata'

import * as http from 'http'
import { AddressInfo } from 'net'
import { Request, Response, NextFunction } from 'express'
import { Container } from 'inversify'
import { InversifyExpressServer } from 'inversify-express-utils'

import TYPES from '../../Bootstrap/Types'
import { AnnotatedRevisionsController } from './AnnotatedRevisionsController'

// Boot-mounted regression guard for the multi-container revisions service.
//
// The bug (fixed in the sibling file): the controller used `@controller('')` — an EMPTY
// base — which inversify-express-utils `mergePaths('', '/items/:itemUuid/revisions')`
// collapses to a DOUBLE-leading-slash `//items/:itemUuid/revisions`. Under Express 5 +
// path-to-regexp 8 that is a DISTINCT pattern from the single-slash path the api-gateway
// proxies, so the standalone service 404'd note history on docker-compose (multi-container).
//
// A handler-level unit test (see Base/BaseRevisionsController.spec.ts) cannot catch this:
// the route still *registers*, just at the wrong path. So this guard boots the REAL
// InversifyExpressServer app for the revisions service and hits the routes over HTTP,
// asserting the canonical single-slash paths are REGISTERED (reach the auth middleware →
// 401) and NOT missing (404), and that the double-slash path is no longer the reachable one.
describe('AnnotatedRevisionsController (boot-mounted route registration)', () => {
  const itemUuid = '00000000-0000-0000-0000-0000000000aa'
  const revisionUuid = '00000000-0000-0000-0000-0000000000bb'

  let server: http.Server
  let baseUrl: string

  beforeAll((done) => {
    const container = new Container()

    // The controller's constructor @inject dependencies. Registration only instantiates
    // the controller (it stores these refs); the use cases/mappers are never invoked here
    // because every request is rejected by the auth middleware before the handler runs.
    container.bind(TYPES.Revisions_GetRevisionsMetada).toConstantValue({})
    container.bind(TYPES.Revisions_GetRevision).toConstantValue({})
    container.bind(TYPES.Revisions_DeleteRevision).toConstantValue({})
    container.bind(TYPES.Revisions_RevisionHttpMapper).toConstantValue({})
    container.bind(TYPES.Revisions_RevisionMetadataHttpMapper).toConstantValue({})

    // Stand-in for ApiGatewayAuthMiddleware: a plain express middleware (NOT a BaseMiddleware),
    // so inversify-express-utils uses it verbatim. It rejects every request with 401 — exactly
    // the "route matched, auth gate reached" signal we assert (a MISSING route would 404 instead).
    container
      .bind(TYPES.Revisions_ApiGatewayAuthMiddleware)
      .toConstantValue((_request: Request, response: Response, _next: NextFunction) => {
        response.status(401).send({ error: { tag: 'invalid-auth', message: 'Invalid login credentials.' } })
      })

    // Referenced so the `@controller` decorator metadata is registered before build().
    void AnnotatedRevisionsController

    const app = new InversifyExpressServer(container).build()
    server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${port}`
      done()
    })
  })

  afterAll((done) => {
    server.close(() => done())
  })

  const getStatus = (path: string, method = 'GET'): Promise<number> =>
    new Promise((resolve, reject) => {
      const request = http.request(`${baseUrl}${path}`, { method }, (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode as number))
      })
      request.on('error', reject)
      request.end()
    })

  it('registers GET /items/:itemUuid/revisions on a single slash (reaches auth → 401, not 404)', async () => {
    const status = await getStatus(`/items/${itemUuid}/revisions`)

    expect(status).toBe(401)
    expect(status).not.toBe(404)
  })

  it('registers GET /items/:itemUuid/revisions/:uuid (reaches auth → 401, not 404)', async () => {
    const status = await getStatus(`/items/${itemUuid}/revisions/${revisionUuid}`)

    expect(status).toBe(401)
    expect(status).not.toBe(404)
  })

  it('registers DELETE /items/:itemUuid/revisions/:uuid (reaches auth → 401, not 404)', async () => {
    const status = await getStatus(`/items/${itemUuid}/revisions/${revisionUuid}`, 'DELETE')

    expect(status).toBe(401)
    expect(status).not.toBe(404)
  })

  it('does NOT register the double-slash path (//items/... → 404) — the empty-base regression', async () => {
    const status = await getStatus(`//items/${itemUuid}/revisions`)

    expect(status).toBe(404)
  })
})
