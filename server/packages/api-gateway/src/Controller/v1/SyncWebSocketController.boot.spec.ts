import 'reflect-metadata'

import express, { type NextFunction, type Request, type Response } from 'express'
import { Container } from 'inversify'
import { InversifyExpressServer } from 'inversify-express-utils'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

import { TYPES } from '../../Bootstrap/Types'
import './SyncWebSocketController'
import { syncWebSocketAccessService } from '../../Service/Sync/SyncWebSocketAccessService'
import { syncGateDiagnostics } from '../../Service/Sync/SyncGateDiagnostics'
import type { SyncPreconditionState } from '../../Service/Sync/SyncWebSocketPreconditions'

/**
 * Standard Red Notes: the realtime-sync routes exercised over REAL HTTP, through
 * the real Inversify container and the real Express adapter, with the boot gate
 * CLOSED — the normal state of any deployment that has not configured realtime
 * sync.
 *
 * Everything else that covers these two routes stops short of the transport.
 * `SyncWebSocketController.spec.ts` calls the handlers directly, and the route
 * sweep in `RouteDispatch.spec.ts` builds instances with `Object.create(...)`.
 * Neither can observe the failure mode this file exists for: a controller that
 * cannot be CONSTRUCTED. Inversify resolves controllers per request, so a
 * constructor argument it cannot resolve throws before the handler is entered
 * and Express turns it into a 500 — with the handler's own logic untouched and
 * every direct-call test still green. That is exactly how these two routes
 * regressed in production while the suite passed.
 *
 * `/capabilities` is public, static and consulted BEFORE a session exists — it is
 * how a client decides whether to use the realtime transport at all — so a 500
 * there is worse than a disabled lane: it breaks transport negotiation itself.
 * The contract these tests pin is that an unavailable lane is reported, never
 * crashed on: 200 with an empty list, and a clean 503 SYNC_DISABLED.
 */
jest.setTimeout(30_000)

const GATE_MET: SyncPreconditionState = {
  connectionTokenSecretPresent: true,
  webSocketSyncEnabled: true,
  redisBound: true,
  syncingServerGrpcBound: true,
}

/**
 * Each boot condition unmet on its own. Any real self-hosted deployment is one
 * of these — an instance with no SYNCING_SERVER_GRPC_URL is the common case.
 */
const UNMET_VARIANTS: ReadonlyArray<[string, Partial<SyncPreconditionState>]> = [
  ['the connection-token secret is absent', { connectionTokenSecretPresent: false }],
  ['sync is switched off by configuration', { webSocketSyncEnabled: false }],
  ['Redis is unbound', { redisBound: false }],
  ['the gRPC syncing proxy is unbound', { syncingServerGrpcBound: false }],
]

describe('SyncWebSocketController over HTTP with the boot gate closed', () => {
  let server: Server
  let origin: string

  beforeAll(async () => {
    const container = new Container()
    container.bind(TYPES.ApiGateway_Logger).toConstantValue({ warn: () => {} })
    // `/ticket` sits behind the cross-service token middleware. A stub that
    // populates the same locals keeps this spec about the gate, not about auth.
    container.bind(TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware).toConstantValue({
      execute: (_request: Request, response: Response, next: NextFunction) => {
        response.locals.user = { uuid: 'user-uuid-1' }
        response.locals.session = { uuid: 'session-uuid-1' }
        next()
      },
    })

    const app = await new InversifyExpressServer(container)
      // `/ticket` reads `request.body.deviceId`; without a JSON parser it would
      // refuse with INVALID_DEVICE and never reach the gate this spec is about.
      .setConfig((expressApp) => {
        expressApp.use(express.json())
      })
      .build()
    server = app.listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  beforeEach(() => syncWebSocketAccessService.clearProvider())
  afterEach(() => {
    syncWebSocketAccessService.clearProvider()
    syncGateDiagnostics.clear()
  })

  it.each(UNMET_VARIANTS)('answers GET /capabilities with 200 and an empty list when %s', async (_label, unmet) => {
    syncGateDiagnostics.record({ ...GATE_MET, ...unmet, filesAdvertised: false })

    const response = await fetch(`${origin}/v1/sockets/sync/capabilities`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ capabilities: [] })
  })

  it.each(UNMET_VARIANTS)('answers POST /ticket with 503 SYNC_DISABLED when %s', async (_label, unmet) => {
    syncGateDiagnostics.record({ ...GATE_MET, ...unmet, filesAdvertised: false })

    const response = await fetch(`${origin}/v1/sockets/sync/ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
      body: JSON.stringify({ deviceId: 'device-1' }),
    })

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: { code: 'SYNC_DISABLED' } })
  })

  it('answers both routes cleanly when the gate has not been recorded at all', async () => {
    syncGateDiagnostics.clear()

    const capabilities = await fetch(`${origin}/v1/sockets/sync/capabilities`)
    const ticket = await fetch(`${origin}/v1/sockets/sync/ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
      body: JSON.stringify({ deviceId: 'device-1' }),
    })

    expect(capabilities.status).toBe(200)
    await expect(capabilities.json()).resolves.toEqual({ capabilities: [] })
    expect(ticket.status).toBe(503)
    await expect(ticket.json()).resolves.toEqual({ error: { code: 'SYNC_DISABLED' } })
  })

  /**
   * `/capabilities` must stay reachable with no credentials at all — the client
   * calls it before it has a session. `RouteDispatch.spec.ts` pins the same fact
   * from the middleware metadata; this pins it from the wire.
   */
  it('serves /capabilities with no credentials whatsoever', async () => {
    syncGateDiagnostics.record({ ...GATE_MET, syncingServerGrpcBound: false, filesAdvertised: false })

    const response = await fetch(`${origin}/v1/sockets/sync/capabilities`, { headers: {} })

    expect(response.status).toBe(200)
  })
})
