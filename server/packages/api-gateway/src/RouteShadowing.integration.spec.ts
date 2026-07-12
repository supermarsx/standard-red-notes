import 'reflect-metadata'

import * as http from 'http'
import { AddressInfo } from 'net'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Request, Response } from 'express'
import { Container } from 'inversify'
import { controller, all, InversifyExpressServer } from 'inversify-express-utils'

import { TYPES } from './Bootstrap/Types'
import { registerCaldavRoutes } from './Caldav/registerCaldavRoutes'
import { registerWorkflowsUiProxy } from './Workflows/registerWorkflowsUiProxy'
import { CaldavService } from './Service/Caldav/CaldavService'
import { CaldavTokenStore } from './Service/Caldav/CaldavTokenStore'
import { PublishedCalendarStore } from './Service/Caldav/PublishedCalendarStore'
import { WorkflowsService } from './Service/Workflows/WorkflowsService'
import { WorkflowsPairingStore } from './Service/Workflows/WorkflowsPairingStore'

// Boot-mounted route-ordering regression guard (item 2, t56).
//
// INVARIANT UNDER TEST: the opt-in CalDAV router (/dav), the Workflows-UI proxy
// (/workflows-ui) and the WS token-mint route (POST /sockets/tokens) must be
// registered BEFORE server.build(). build() mounts the inversify controller router
// at rootPath '/'; that router's LAST route is a trailing catch-all
// @all('/{*splat}') (Legacy/FallbackController). Any of the three routes registered
// AFTER build() sits behind that catch-all in the app's layer stack, so a
// FUNCTIONING catch-all answers first and the opt-in route is unreachable. The fix
// (bin/server.ts + home-server HomeServer.ts) moves all three into setConfig, ahead
// of the controller router. This spec pins that ordering both ways.
//
// NOTE ON THE PRODUCTION CATCH-ALL (why this uses @controller('/')): the real
// Legacy/FallbackController use @controller('') — an EMPTY base. inversify-express-
// utils' mergePaths('', '/{*splat}') collapses the empty base to '/' and joins to a
// DOUBLE-slash '//{*splat}', which under Express 5 / path-to-regexp 8 matches NO
// single-slash path — so today the production catch-all is INERT and never actually
// shadows /dav etc. (the same empty-base class as the t53 revisions bug, but here it
// makes the catch-all dead rather than mis-placed). That is a separate, latent bug:
// the moment those controllers are repaired to a functioning catch-all (base '/'),
// every post-build route would be shadowed. So this guard deliberately models a
// WORKING catch-all with @controller('/') (which mergePaths resolves to the
// single-slash '/{*splat}' that matches everything), proving the fix keeps the three
// routes reachable in front of a catch-all that actually does its job.
const CATCH_ALL_SENTINEL = 'CATCH-ALL-SENTINEL'

@controller('/')
class SpecCatchAllController {
  @all('/{*splat}')
  public catchAll(_request: Request, response: Response): void {
    response.status(200).send(CATCH_ALL_SENTINEL)
  }
}
// Referenced so the @controller metadata is registered before build().
void SpecCatchAllController

interface HttpResult {
  status: number
  body: string
  headers: http.IncomingHttpHeaders
}

async function buildContainer(dir: string): Promise<Container> {
  const container = new Container()

  // Real CaldavService, feature ENABLED — so a request without credentials hits the
  // router's own 401 Basic-auth challenge (an unmistakable router signal, distinct
  // from the 200 catch-all sentinel).
  const caldavTokenStore = new CaldavTokenStore(path.join(dir, 'caldav-tokens.json'))
  const publishedStore = new PublishedCalendarStore(path.join(dir, 'caldav-published.json'))
  const caldavService = new CaldavService(true, caldavTokenStore, publishedStore)
  container.bind(TYPES.ApiGateway_CaldavService).toConstantValue(caldavService)
  container.bind(TYPES.ApiGateway_CALDAV_BASE_PATH).toConstantValue('/dav')

  // Real WorkflowsService, feature ENABLED — so a request without the UI-access
  // cookie hits the proxy's own 403 'workflows-ui-unauthorized' gate (a router
  // signal, distinct from the sentinel).
  const pairingStore = new WorkflowsPairingStore(path.join(dir, 'workflows-pairings.json'))
  const workflowsService = new WorkflowsService(
    {
      enabled: true,
      n8nUrl: 'http://127.0.0.1:5678',
      uiBasePath: '/workflows-ui',
      jwtSecret: 'spec-secret',
      cookieSecure: false,
      uiTokenTtlSeconds: 60,
    },
    pairingStore,
  )
  container.bind(TYPES.ApiGateway_WorkflowsService).toConstantValue(workflowsService)
  container.bind(TYPES.ApiGateway_Logger).toConstantValue({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  })
  container.bind(TYPES.ApiGateway_CLIENT_IP_HEADER).toConstantValue('')

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

describe('route ordering vs the build() catch-all (boot-mounted)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'route-order-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  describe('mounted BEFORE build() in setConfig — the fix', () => {
    let server: http.Server
    let baseUrl: string
    let mintHandler: ((request: Request, response: Response) => void) | undefined

    beforeEach(async () => {
      const container = await buildContainer(dir)
      const inversifyServer = new InversifyExpressServer(container)

      // Mirror the fixed bin/server.ts: register /dav, /workflows-ui and
      // /sockets/tokens inside setConfig, BEFORE build() mounts the catch-all router.
      inversifyServer.setConfig((app) => {
        registerCaldavRoutes(app, container)
        registerWorkflowsUiProxy(app, container)
        app.post('/sockets/tokens', (request: Request, response: Response) => {
          if (mintHandler) {
            mintHandler(request, response)
          } else {
            response.status(503).json({ error: { message: 'Realtime token minting is not enabled.' } })
          }
        })
      })

      const app = inversifyServer.build()
      server = app.listen(0)
      baseUrl = await urlWhenListening(server)
    })

    afterEach((done) => {
      mintHandler = undefined
      server.close(() => done())
    })

    it('reaches the CalDAV router (401 Basic challenge), not the catch-all', async () => {
      const result = await requestOf(baseUrl, 'OPTIONS', '/dav/')
      expect(result.body).not.toContain(CATCH_ALL_SENTINEL)
      expect(result.status).toBe(401)
      expect(result.headers['www-authenticate']).toMatch(/Basic/)
    })

    it('reaches the Workflows-UI proxy (403 unauthorized gate), not the catch-all', async () => {
      const result = await requestOf(baseUrl, 'GET', '/workflows-ui/')
      expect(result.body).not.toContain(CATCH_ALL_SENTINEL)
      expect(result.status).toBe(403)
      expect(result.body).toContain('workflows-ui-unauthorized')
    })

    it('reaches the /sockets/tokens dispatcher (503 when unwired), not the catch-all', async () => {
      const result = await requestOf(baseUrl, 'POST', '/sockets/tokens')
      expect(result.body).not.toContain(CATCH_ALL_SENTINEL)
      expect(result.status).toBe(503)
    })

    it('dispatches /sockets/tokens to the wired mint handler, not the catch-all', async () => {
      mintHandler = (_request: Request, response: Response): void => {
        response.status(200).json({ token: 'stub-connection-token' })
      }
      const result = await requestOf(baseUrl, 'POST', '/sockets/tokens')
      expect(result.body).not.toContain(CATCH_ALL_SENTINEL)
      expect(result.status).toBe(200)
      expect(result.body).toContain('stub-connection-token')
    })

    it('still routes an unrelated path to the catch-all (proving the catch-all IS functioning here)', async () => {
      const result = await requestOf(baseUrl, 'GET', '/some/unrelated/path')
      expect(result.status).toBe(200)
      expect(result.body).toBe(CATCH_ALL_SENTINEL)
    })
  })

  describe('mounted AFTER build() — the original placement, shadowed by a functioning catch-all', () => {
    let server: http.Server
    let baseUrl: string

    beforeEach(async () => {
      const container = await buildContainer(dir)
      const inversifyServer = new InversifyExpressServer(container)

      // The original (fragile) ordering: build() first (mounts the catch-all router at
      // '/'), THEN register the routes — so a functioning catch-all shadows them. This
      // is what the fix prevents.
      const app = inversifyServer.build()
      registerCaldavRoutes(app, container)
      registerWorkflowsUiProxy(app, container)
      app.post('/sockets/tokens', (_request, response) => response.status(200).json({ token: 'unreachable' }))

      server = app.listen(0)
      baseUrl = await urlWhenListening(server)
    })

    afterEach((done) => {
      server.close(() => done())
    })

    it('CalDAV /dav is shadowed by the catch-all', async () => {
      const result = await requestOf(baseUrl, 'OPTIONS', '/dav/')
      expect(result.body).toBe(CATCH_ALL_SENTINEL)
    })

    it('Workflows /workflows-ui is shadowed by the catch-all', async () => {
      const result = await requestOf(baseUrl, 'GET', '/workflows-ui/')
      expect(result.body).toBe(CATCH_ALL_SENTINEL)
    })

    it('POST /sockets/tokens is shadowed by the catch-all', async () => {
      const result = await requestOf(baseUrl, 'POST', '/sockets/tokens')
      expect(result.body).toBe(CATCH_ALL_SENTINEL)
    })
  })
})
