import 'reflect-metadata'

import * as http from 'http'
import { AddressInfo } from 'net'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Request, Response } from 'express'
import { Container } from 'inversify'
import { controller, httpGet, InversifyExpressServer } from 'inversify-express-utils'

import { TYPES } from './Bootstrap/Types'
import { registerCaldavRoutes } from './Caldav/registerCaldavRoutes'
import { registerWorkflowsUiProxy } from './Workflows/registerWorkflowsUiProxy'
import { CaldavService } from './Service/Caldav/CaldavService'
import { CaldavTokenStore } from './Service/Caldav/CaldavTokenStore'
import { PublishedCalendarStore } from './Service/Caldav/PublishedCalendarStore'
import { WorkflowsService } from './Service/Workflows/WorkflowsService'
import { WorkflowsPairingStore } from './Service/Workflows/WorkflowsPairingStore'
import { createFallbackHandler, API_GATEWAY_WELCOME_HTML } from './Controller/FallbackController'

// Boot-mounted dual gate for the post-build welcome/404 fallback (t57).
//
// The former root @controller('') Legacy/FallbackController were INERT (their empty
// base collapsed to a never-matching '//{*splat}' under Express 5), so unmatched
// requests fell through to Express's default `Cannot GET /path` HTML. t57 replaces
// them with a POST-BUILD app.use() handler (createFallbackHandler) mounted AFTER
// server.build() — i.e. after the inversify controller router — so it catches only
// genuinely-unmatched requests and cannot shadow anything.
//
// This spec boots a REAL InversifyExpressServer (ephemeral port, real Node http) that
// mirrors the fixed bin/server.ts wiring: CalDAV + Workflows registered in setConfig
// (BEFORE build()), real /healthcheck + /v1 + /v2 controllers, then the post-build
// fallback. It asserts BOTH directions:
//   (a) genuinely-unmatched -> the fallback (welcome HTML for GET /, JSON 404 else),
//       NOT Express's default `Cannot GET`.
//   (b) every legitimate route STILL reaches its own handler (the /healthcheck, /v1
//       and /v2 controllers, plus the pre-build /dav 401 and /workflows-ui 403), NOT
//       the fallback — i.e. no new shadowing.

const HEALTH_SENTINEL = 'HEALTH-OK-SENTINEL'
const V1_SENTINEL = 'V1-OK-SENTINEL'
const V2_SENTINEL = 'V2-OK-SENTINEL'

@controller('/healthcheck')
class SpecHealthController {
  @httpGet('/')
  public health(_request: Request, response: Response): void {
    response.status(200).send(HEALTH_SENTINEL)
  }
}
void SpecHealthController

@controller('/v1/spec')
class SpecV1Controller {
  @httpGet('/ping')
  public ping(_request: Request, response: Response): void {
    response.status(200).send(V1_SENTINEL)
  }
}
void SpecV1Controller

@controller('/v2/spec')
class SpecV2Controller {
  @httpGet('/ping')
  public ping(_request: Request, response: Response): void {
    response.status(200).send(V2_SENTINEL)
  }
}
void SpecV2Controller

interface HttpResult {
  status: number
  body: string
  headers: http.IncomingHttpHeaders
}

async function buildContainer(dir: string): Promise<Container> {
  const container = new Container()

  // Real CaldavService, feature ENABLED — a request without credentials hits the
  // router's own 401 Basic-auth challenge (an unmistakable router signal).
  const caldavTokenStore = new CaldavTokenStore(path.join(dir, 'caldav-tokens.json'))
  const publishedStore = new PublishedCalendarStore(path.join(dir, 'caldav-published.json'))
  const caldavService = new CaldavService(true, caldavTokenStore, publishedStore)
  container.bind(TYPES.ApiGateway_CaldavService).toConstantValue(caldavService)
  container.bind(TYPES.ApiGateway_CALDAV_BASE_PATH).toConstantValue('/dav')

  // Real WorkflowsService, feature ENABLED — a request without the UI-access cookie
  // hits the proxy's own 403 'workflows-ui-unauthorized' gate (a router signal).
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

describe('post-build welcome/404 fallback (boot-mounted)', () => {
  let dir: string
  let server: http.Server
  let baseUrl: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fallback-'))

    const container = await buildContainer(dir)
    const inversifyServer = new InversifyExpressServer(container)

    // Mirror the fixed bin/server.ts: register /dav + /workflows-ui in setConfig,
    // BEFORE build() mounts the controller router.
    inversifyServer.setConfig((app) => {
      registerCaldavRoutes(app, container)
      registerWorkflowsUiProxy(app, container)
    })

    const app = await inversifyServer.build()

    // The fix: post-build fallback, AFTER the controller router (exactly as the
    // production entrypoint wires it).
    app.use(createFallbackHandler({ welcomeHtml: API_GATEWAY_WELCOME_HTML }))

    server = app.listen(0)
    baseUrl = await urlWhenListening(server)
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(dir, { recursive: true, force: true })
  })

  // (a) genuinely-unmatched requests reach the fallback.

  it('serves the welcome HTML at GET / (not Express default, not 404)', async () => {
    const result = await requestOf(baseUrl, 'GET', '/')
    expect(result.status).toBe(200)
    expect(result.body).toContain('Welcome to the Standard Notes server infrastructure')
    expect(result.body).not.toContain('Cannot GET')
  })

  it('serves a JSON 404 for an unmatched path (not Express default `Cannot GET`)', async () => {
    const result = await requestOf(baseUrl, 'GET', '/definitely/not/a/route')
    expect(result.status).toBe(404)
    expect(result.headers['content-type']).toMatch(/application\/json/)
    expect(JSON.parse(result.body)).toEqual({ error: { message: 'Not Found' } })
    expect(result.body).not.toContain('Cannot GET')
  })

  it('serves a JSON 404 for a non-GET request to / (welcome is GET-only)', async () => {
    const result = await requestOf(baseUrl, 'POST', '/')
    expect(result.status).toBe(404)
    expect(JSON.parse(result.body)).toEqual({ error: { message: 'Not Found' } })
  })

  // (b) every legitimate route still reaches its own handler — no new shadowing.

  it('reaches the /healthcheck controller (200), not the fallback', async () => {
    const result = await requestOf(baseUrl, 'GET', '/healthcheck')
    expect(result.status).toBe(200)
    expect(result.body).toBe(HEALTH_SENTINEL)
  })

  it('reaches a /v1 controller route (200), not the fallback', async () => {
    const result = await requestOf(baseUrl, 'GET', '/v1/spec/ping')
    expect(result.status).toBe(200)
    expect(result.body).toBe(V1_SENTINEL)
  })

  it('reaches a /v2 controller route (200), not the fallback', async () => {
    const result = await requestOf(baseUrl, 'GET', '/v2/spec/ping')
    expect(result.status).toBe(200)
    expect(result.body).toBe(V2_SENTINEL)
  })

  it('reaches the pre-build CalDAV router (401 Basic challenge), not the fallback', async () => {
    const result = await requestOf(baseUrl, 'OPTIONS', '/dav/')
    expect(result.status).toBe(401)
    expect(result.headers['www-authenticate']).toMatch(/Basic/)
    expect(result.body).not.toContain('Not Found')
  })

  it('reaches the pre-build Workflows-UI proxy (403 unauthorized gate), not the fallback', async () => {
    const result = await requestOf(baseUrl, 'GET', '/workflows-ui/')
    expect(result.status).toBe(403)
    expect(result.body).toContain('workflows-ui-unauthorized')
  })
})
