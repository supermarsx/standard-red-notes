import 'reflect-metadata'

import * as http from 'http'
import { AddressInfo } from 'net'
import { NextFunction, Request, Response } from 'express'
import { Container } from 'inversify'
import { InversifyExpressServer } from 'inversify-express-utils'

import TYPES from '../../Bootstrap/Types'
import { registerNotFoundFallback } from './registerNotFoundFallback'
import { AnnotatedHealthCheckController } from './AnnotatedHealthCheckController'
import { AnnotatedFilesController } from './AnnotatedFilesController'
import { AnnotatedSharedVaultFilesController } from './AnnotatedSharedVaultFilesController'

// Boot-mounted dual-gate guard for the post-build JSON-404 fallback (t57-e3).
//
// The old AnnotatedFallbackController (@controller('') + @all('/{*splat}')) was INERT
// under Express 5 / inversify-express-utils 6.5.0, so unmatched requests fell through
// to Express's default `Cannot GET` finalhandler. registerNotFoundFallback restores a
// clean JSON 404 as a post-build app.use() handler. This spec boots the real files
// controller router on an ephemeral port and asserts BOTH directions:
//   (a) a genuinely-unmatched path now hits the JSON-404 fallback (not `Cannot GET`), and
//   (b) every legitimate route still reaches its OWN handler/middleware (not the fallback),
//       proving the post-build handler shadows nothing.
//
// The real controllers are registered so this exercises production wiring; the two valet
// auth middlewares are stubbed to a recognizable 401 so `/v1/files*` requests reach their
// own route (the controller-level middleware) without needing real token infrastructure —
// a 401 from the route's middleware is an unmistakable "route was reached" signal, distinct
// from both the fallback body and the healthcheck's 200.
const AUTH_SENTINEL = 'AUTH-MIDDLEWARE-SENTINEL'
const FALLBACK_MESSAGE = 'Not Found'

// Referenced so the @controller metadata is registered before build().
void AnnotatedHealthCheckController
void AnnotatedFilesController
void AnnotatedSharedVaultFilesController

interface HttpResult {
  status: number
  body: string
  headers: http.IncomingHttpHeaders
}

function buildContainer(): Container {
  const container = new Container()

  const stubAuthMiddleware = (_request: Request, response: Response, _next: NextFunction): void => {
    response.status(401).json({ sentinel: AUTH_SENTINEL })
  }

  // The valet-token controllers are instantiated at build() time (iemu reads each
  // controller.constructor), so every injected identifier must resolve — but the
  // stub middleware short-circuits before any use case runs, so plain constants suffice.
  const noop = {} as never
  container.bind(TYPES.Files_UploadFileChunk).toConstantValue(noop)
  container.bind(TYPES.Files_CreateUploadSession).toConstantValue(noop)
  container.bind(TYPES.Files_FinishUploadSession).toConstantValue(noop)
  container.bind(TYPES.Files_StreamDownloadFile).toConstantValue(noop)
  container.bind(TYPES.Files_GetFileMetadata).toConstantValue(noop)
  container.bind(TYPES.Files_RemoveFile).toConstantValue(noop)
  container.bind(TYPES.Files_MoveFile).toConstantValue(noop)
  container.bind(TYPES.Files_MAX_CHUNK_BYTES).toConstantValue(1024)
  container.bind(TYPES.Files_FILE_DOWNLOAD_DEADLINE_MS).toConstantValue(30_000)
  container.bind(TYPES.Files_Logger).toConstantValue({ error: () => undefined } as never)
  container.bind(TYPES.Files_ValetTokenAuthMiddleware).toConstantValue(stubAuthMiddleware)
  container.bind(TYPES.Files_SharedVaultValetTokenAuthMiddleware).toConstantValue(stubAuthMiddleware)

  return container
}

function urlWhenListening(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    const done = (): void => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    if (server.listening) {
      done()
    } else {
      server.once('listening', done)
    }
  })
}

function requestOf(baseUrl: string, method: string, routePath: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${routePath}`, { method }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode as number, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('files post-build JSON-404 fallback (boot-mounted)', () => {
  let server: http.Server
  let baseUrl: string

  beforeEach(async () => {
    const inversifyServer = new InversifyExpressServer(buildContainer())
    const app = await inversifyServer.build()
    registerNotFoundFallback(app)
    server = app.listen(0)
    baseUrl = await urlWhenListening(server)
  })

  afterEach((done) => {
    server.close(() => done())
  })

  describe('(a) unmatched request hits the fallback', () => {
    it('returns a clean JSON 404 for an unknown path, not Express default `Cannot GET`', async () => {
      const result = await requestOf(baseUrl, 'GET', '/definitely/not/a/route')

      expect(result.status).toBe(404)
      expect(result.body).not.toContain('Cannot GET')
      expect(result.headers['content-type']).toMatch(/application\/json/)
      expect(JSON.parse(result.body)).toEqual({ error: { message: FALLBACK_MESSAGE } })
    })

    it('returns the JSON 404 for the root path (no controller owns `/`)', async () => {
      const result = await requestOf(baseUrl, 'GET', '/')

      expect(result.status).toBe(404)
      expect(result.body).not.toContain('Cannot GET')
      expect(JSON.parse(result.body)).toEqual({ error: { message: FALLBACK_MESSAGE } })
    })

    it('falls back for an unmatched method on a known base', async () => {
      const result = await requestOf(baseUrl, 'DELETE', '/healthcheck')

      expect(result.status).toBe(404)
      expect(JSON.parse(result.body)).toEqual({ error: { message: FALLBACK_MESSAGE } })
    })
  })

  describe('(b) legitimate routes still reach their own handler, not the fallback', () => {
    it('GET /healthcheck reaches the health controller (200 OK), not the fallback', async () => {
      const result = await requestOf(baseUrl, 'GET', '/healthcheck')

      expect(result.status).toBe(200)
      expect(result.body).toBe('OK')
      expect(result.body).not.toContain(FALLBACK_MESSAGE)
    })

    it('POST /v1/files/upload/create-session reaches the valet auth middleware (401), not the fallback', async () => {
      const result = await requestOf(baseUrl, 'POST', '/v1/files/upload/create-session')

      expect(result.status).toBe(401)
      expect(result.body).toContain(AUTH_SENTINEL)
      expect(result.body).not.toContain(FALLBACK_MESSAGE)
    })

    // The client sends DELETE to the collection path with NO trailing slash
    // (`joinPaths(filesHost, '/v1/files')`), while the route is declared as
    // `@controller('/v1/files') + @httpDelete('/')`. Under Express 5 those are
    // normalized to the same route, but nothing else in the suite proves it —
    // and a delete that 404s at the router would surface to the user as a
    // generic "could not be deleted" with no way to tell it from a real refusal.
    it('DELETE /v1/files (no trailing slash) reaches the valet auth middleware (401), not the fallback', async () => {
      const result = await requestOf(baseUrl, 'DELETE', '/v1/files')

      expect(result.status).toBe(401)
      expect(result.body).toContain(AUTH_SENTINEL)
      expect(result.body).not.toContain(FALLBACK_MESSAGE)
    })

    it('DELETE /v1/shared-vault/files (no trailing slash) reaches its own middleware (401), not the fallback', async () => {
      const result = await requestOf(baseUrl, 'DELETE', '/v1/shared-vault/files')

      expect(result.status).toBe(401)
      expect(result.body).toContain(AUTH_SENTINEL)
      expect(result.body).not.toContain(FALLBACK_MESSAGE)
    })

    it('POST /v1/shared-vault/files/upload/create-session reaches its own middleware (401), not the fallback', async () => {
      const result = await requestOf(baseUrl, 'POST', '/v1/shared-vault/files/upload/create-session')

      expect(result.status).toBe(401)
      expect(result.body).toContain(AUTH_SENTINEL)
      expect(result.body).not.toContain(FALLBACK_MESSAGE)
    })
  })
})
