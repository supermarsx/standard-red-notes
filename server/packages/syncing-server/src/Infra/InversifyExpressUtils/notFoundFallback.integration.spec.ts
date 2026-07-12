import 'reflect-metadata'

import * as http from 'http'
import { AddressInfo } from 'net'
import { Container } from 'inversify'
import { InversifyExpressServer, controller, httpGet } from 'inversify-express-utils'

import TYPES from '../../Bootstrap/Types'
import { notFoundFallback } from './notFoundFallback'
// Registering the REAL health-check controller proves a genuine production route
// still reaches its own handler in front of the fallback.
import { AnnotatedHealthCheckController } from './AnnotatedHealthCheckController'

// Boot-mounted dual-gate for the post-build JSON-404 fallback (t57-e2).
//
// The former AnnotatedFallbackController (@controller('') + @all('/{*splat}'))
// was INERT under Express 5, so unmatched requests fell through to Express's
// default `Cannot GET` text-404 and the intended JSON 404 never rendered. The
// fix mounts notFoundFallback via app.use() AFTER server.build(). This spec
// boots a real InversifyExpressServer on an ephemeral port and asserts BOTH
// directions:
//   (a) a genuinely-unmatched path now returns the JSON 404 fallback, and
//   (b) every legitimate route (real /healthcheck + a representative /items)
//       STILL reaches its own handler, never the fallback.
// A control server built WITHOUT the fallback pins that the fallback is exactly
// what restores the JSON body (otherwise Express's default text-404 answers).

// Representative legitimate syncing-server route. The real AnnotatedItemsController
// uses @controller('/items', TYPES.Sync_AuthMiddleware) and a heavy DI graph; this
// stand-in shares the real base path and returns a sentinel so we can assert the
// fallback does not shadow it. (The standalone syncing-server mounts at '/'; the
// '/v1' prefix is added by the api-gateway proxy, not here.)
const ITEMS_SENTINEL = 'ITEMS-CONTROLLER-REACHED'

@controller('/items')
class SpecItemsController {
  @httpGet('/')
  public get(): string {
    return ITEMS_SENTINEL
  }
}
// Referenced so the @controller metadata is registered before build().
void SpecItemsController
void AnnotatedHealthCheckController

interface HttpResult {
  status: number
  body: string
  headers: http.IncomingHttpHeaders
}

function buildContainer(): Container {
  const container = new Container()

  // Health-check controller deps. Only GET /healthcheck (returns 'OK') is
  // exercised, which touches neither, but the constructor injects them at
  // resolution so the bindings must exist. Redis is @optional but bound for
  // determinism.
  container
    .bind(TYPES.Sync_ORMItemRepository)
    .toConstantValue({ manager: { query: async () => [] } })
  container.bind(TYPES.Sync_Redis).toConstantValue({ ping: async () => 'PONG' })

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

async function bootServer(withFallback: boolean): Promise<http.Server> {
  const server = new InversifyExpressServer(buildContainer())
  const app = server.build()
  // Mirror bin/server.ts: the fallback is mounted AFTER build().
  if (withFallback) {
    app.use(notFoundFallback)
  }
  return app.listen(0)
}

describe('syncing-server post-build JSON-404 fallback (boot-mounted)', () => {
  describe('with the fallback wired (production placement)', () => {
    let server: http.Server
    let baseUrl: string

    beforeEach(async () => {
      server = await bootServer(true)
      baseUrl = await urlWhenListening(server)
    })

    afterEach((done) => {
      server.close(() => done())
    })

    // Gate (a): unmatched paths reach the JSON-404 fallback, not Express's text-404.
    it('returns the JSON 404 fallback for an unmatched GET', async () => {
      const result = await requestOf(baseUrl, 'GET', '/definitely/not/a/route')
      expect(result.status).toBe(404)
      expect(result.headers['content-type']).toMatch(/application\/json/)
      expect(JSON.parse(result.body)).toEqual({ error: { message: 'Not Found' } })
      expect(result.body).not.toMatch(/Cannot GET/)
    })

    it('returns the JSON 404 fallback for an unmatched POST (covers all methods)', async () => {
      const result = await requestOf(baseUrl, 'POST', '/nope')
      expect(result.status).toBe(404)
      expect(JSON.parse(result.body)).toEqual({ error: { message: 'Not Found' } })
    })

    // Gate (b): legitimate routes still win — the fallback shadows nothing.
    it('still reaches the real /healthcheck controller (200 OK), not the fallback', async () => {
      const result = await requestOf(baseUrl, 'GET', '/healthcheck')
      expect(result.status).toBe(200)
      expect(result.body).toBe('OK')
      expect(result.body).not.toContain('Not Found')
    })

    it('still reaches the representative /items route, not the fallback', async () => {
      const result = await requestOf(baseUrl, 'GET', '/items')
      expect(result.status).toBe(200)
      expect(result.body).toBe(ITEMS_SENTINEL)
      expect(result.body).not.toContain('Not Found')
    })
  })

  describe('control: without the fallback', () => {
    let server: http.Server
    let baseUrl: string

    beforeEach(async () => {
      server = await bootServer(false)
      baseUrl = await urlWhenListening(server)
    })

    afterEach((done) => {
      server.close(() => done())
    })

    // Pins that the fallback is what restores the JSON body: without it, the same
    // unmatched path yields Express's default text-404 instead.
    it('falls through to Express default text-404 for an unmatched GET', async () => {
      const result = await requestOf(baseUrl, 'GET', '/definitely/not/a/route')
      expect(result.status).toBe(404)
      expect(result.body).toMatch(/Cannot GET/)
      expect(result.body).not.toContain('"error"')
    })

    // Legit routes are unaffected by the fallback's absence.
    it('still reaches the real /healthcheck controller (200 OK)', async () => {
      const result = await requestOf(baseUrl, 'GET', '/healthcheck')
      expect(result.status).toBe(200)
      expect(result.body).toBe('OK')
    })
  })
})
