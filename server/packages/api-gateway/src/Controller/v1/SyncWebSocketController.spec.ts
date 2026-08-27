import 'reflect-metadata'

import { Request, Response } from 'express'
import { Container } from 'inversify'
import type { SyncGatewayAccess } from '@standard-red-notes/websocket-gateway'

import { Logger } from 'winston'

import { TYPES } from '../../Bootstrap/Types'
import { SyncWebSocketController } from './SyncWebSocketController'
import { SyncWebSocketAccessService, syncWebSocketAccessService } from '../../Service/Sync/SyncWebSocketAccessService'
import { SyncGateDiagnosticsRecorder, syncGateDiagnostics } from '../../Service/Sync/SyncGateDiagnostics'
import type { SyncPreconditionState } from '../../Service/Sync/SyncWebSocketPreconditions'

function responseDouble(locals: Record<string, unknown> = {}): {
  response: Response
  status: jest.Mock
  send: jest.Mock
} {
  const send = jest.fn()
  const status = jest.fn(() => ({ send }))
  return { response: { locals, status } as unknown as Response, status, send }
}

const readyProvider = (): SyncGatewayAccess => ({
  capabilities: () => ({ capabilities: [{ id: 'ws-sync', version: 1, endpoint: '/sockets/sync' }] }),
  issueTicket: jest.fn(async () => ({
    ticket: 'opaque-ticket',
    expiresAt: 123_456,
    endpoint: '/sockets/sync',
    capability: 'ws-sync',
    version: 1,
  })),
})

describe('SyncWebSocketController', () => {
  beforeEach(() => syncWebSocketAccessService.clearProvider())
  afterEach(() => syncWebSocketAccessService.clearProvider())

  it('advertises capability-off as an empty stable response', () => {
    const controller = new SyncWebSocketController()
    const { response, status, send } = responseDouble()

    controller.capabilities({} as Request, response)

    expect(status).toHaveBeenCalledWith(200)
    expect(send).toHaveBeenCalledWith({ capabilities: [] })
  })

  it('advertises the exact v1 endpoint only while the gateway provider is ready', () => {
    const provider = readyProvider()
    syncWebSocketAccessService.setProvider(provider)
    const { response, send } = responseDouble()

    new SyncWebSocketController().capabilities({} as Request, response)

    expect(send).toHaveBeenCalledWith({
      capabilities: [{ id: 'ws-sync', version: 1, endpoint: '/sockets/sync' }],
    })
  })

  it('issues a server-side ticket bound to authenticated user, session, device and bearer token', async () => {
    const provider = readyProvider()
    syncWebSocketAccessService.setProvider(provider)
    const { response, status, send } = responseDouble({
      user: { uuid: 'user-1' },
      session: { uuid: 'session-1' },
    })
    const request = {
      body: { deviceId: 'device-1' },
      headers: { authorization: 'Bearer session-token' },
    } as unknown as Request

    await new SyncWebSocketController().ticket(request, response)

    expect(provider.issueTicket).toHaveBeenCalledWith({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      deviceId: 'device-1',
      authorization: 'Bearer session-token',
    })
    expect(status).toHaveBeenCalledWith(200)
    expect(send).toHaveBeenCalledWith({
      ticket: 'opaque-ticket',
      expiresAt: 123_456,
      endpoint: '/sockets/sync',
      capability: 'ws-sync',
      version: 1,
    })
  })

  it.each([
    [{ body: { deviceId: '../bad' }, headers: { authorization: 'Bearer token' } }, {}, 400, 'INVALID_DEVICE'],
    [{ body: { deviceId: 'device-1' }, headers: {} }, { user: { uuid: 'user-1' } }, 401, 'AUTH_REJECTED'],
  ])('fails closed for invalid ticket input', async (request, locals, expectedStatus, code) => {
    syncWebSocketAccessService.setProvider(readyProvider())
    const result = responseDouble(locals)

    await new SyncWebSocketController().ticket(request as unknown as Request, result.response)

    expect(result.status).toHaveBeenCalledWith(expectedStatus)
    expect(result.send).toHaveBeenCalledWith({ error: { code } })
  })

  it('returns 503 when startup, adapter readiness, or the kill switch leaves capability off', async () => {
    const { response, status, send } = responseDouble({
      user: { uuid: 'user-1' },
      session: { uuid: 'session-1' },
    })
    const request = {
      body: { deviceId: 'device-1' },
      headers: { authorization: 'Bearer token' },
    } as unknown as Request

    await new SyncWebSocketController().ticket(request, response)

    expect(status).toHaveBeenCalledWith(503)
    expect(send).toHaveBeenCalledWith({ error: { code: 'SYNC_DISABLED' } })
  })
})

describe('SyncWebSocketController refusal logging', () => {
  const loggerDouble = (): { logger: Logger; warn: jest.Mock } => {
    const warn = jest.fn()
    return { logger: { warn, info: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger, warn }
  }

  const recorderWith = (observation: {
    connectionTokenSecretPresent: boolean
    webSocketSyncEnabled: boolean
    redisBound: boolean
    syncingServerGrpcBound: boolean
  }): SyncGateDiagnosticsRecorder => {
    const recorder = new SyncGateDiagnosticsRecorder()
    recorder.record({ ...observation, filesAdvertised: false })
    return recorder
  }

  const ticketRequest = (): Request =>
    ({
      body: { deviceId: 'device-1' },
      headers: { authorization: 'Bearer session-token' },
    }) as unknown as Request

  beforeEach(() => syncWebSocketAccessService.clearProvider())
  afterEach(() => syncWebSocketAccessService.clearProvider())

  // The regression guard for the whole bug: the 503 used to write NOTHING
  // server-side, and the one warning that did exist ("durable backend and shared
  // Redis state are required") could not tell an operator WHICH was missing.
  it('names the specific unmet precondition when a ticket is refused with SYNC_DISABLED', async () => {
    const { logger, warn } = loggerDouble()
    const controller = new SyncWebSocketController(
      logger,
      syncWebSocketAccessService,
      recorderWith({
        connectionTokenSecretPresent: true,
        webSocketSyncEnabled: true,
        redisBound: false,
        syncingServerGrpcBound: true,
      }),
    )
    const { response, status } = responseDouble({ user: { uuid: 'user-1' }, session: { uuid: 'session-1' } })

    await controller.ticket(ticketRequest(), response)

    expect(status).toHaveBeenCalledWith(503)
    expect(warn).toHaveBeenCalledTimes(1)
    const [message, metadata] = warn.mock.calls[0]
    expect(message).toContain('REDIS_UNBOUND')
    expect(message).toContain('REDIS_URL')
    expect(message).not.toContain('SYNCING_SERVER_GRPC_UNBOUND')
    expect(metadata).toMatchObject({ code: 'SYNC_DISABLED', unmetPreconditions: ['REDIS_UNBOUND'] })
  })

  it('distinguishes the kill switch from an unbound syncing proxy in the same refusal', async () => {
    const { logger, warn } = loggerDouble()
    const controller = new SyncWebSocketController(
      logger,
      syncWebSocketAccessService,
      recorderWith({
        connectionTokenSecretPresent: false,
        webSocketSyncEnabled: false,
        redisBound: true,
        syncingServerGrpcBound: false,
      }),
    )

    await controller.ticket(
      ticketRequest(),
      responseDouble({ user: { uuid: 'user-1' }, session: { uuid: 'session-1' } }).response,
    )

    expect(warn.mock.calls[0][1].unmetPreconditions).toEqual([
      'WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING',
      'WEBSOCKET_SYNC_DISABLED_BY_CONFIGURATION',
      'SYNCING_SERVER_GRPC_UNBOUND',
    ])
  })

  it('logs the silent empty capability list with its cause', () => {
    const { logger, warn } = loggerDouble()
    const controller = new SyncWebSocketController(
      logger,
      syncWebSocketAccessService,
      recorderWith({
        connectionTokenSecretPresent: true,
        webSocketSyncEnabled: false,
        redisBound: true,
        syncingServerGrpcBound: true,
      }),
    )
    const { response, send } = responseDouble()

    controller.capabilities({} as Request, response)

    expect(send).toHaveBeenCalledWith({ capabilities: [] })
    expect(warn.mock.calls[0][1]).toMatchObject({
      code: 'EMPTY_CAPABILITY_LIST',
      unmetPreconditions: ['WEBSOCKET_SYNC_DISABLED_BY_CONFIGURATION'],
    })
  })

  // A client that retries a failing capability negotiation must not be able to
  // drive unbounded log volume; the suppressed count keeps the rate visible.
  it('throttles a retry storm to one line and counts what it suppressed', () => {
    const { logger, warn } = loggerDouble()
    const controller = new SyncWebSocketController(
      logger,
      syncWebSocketAccessService,
      recorderWith({
        connectionTokenSecretPresent: true,
        webSocketSyncEnabled: true,
        redisBound: false,
        syncingServerGrpcBound: true,
      }),
    )

    for (let attempt = 0; attempt < 50; attempt += 1) {
      controller.capabilities({} as Request, responseDouble().response)
    }

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][1].suppressedSinceLastLog).toBe(0)
  })

  it('never emits a secret, bearer token, device id or user identifier in refusal metadata', async () => {
    const { logger, warn } = loggerDouble()
    const secrets = ['s3cret-signing-key', 'redis://user:hunter2@cache:6379', 'Bearer-abcdef-session-token']
    const controller = new SyncWebSocketController(
      logger,
      syncWebSocketAccessService,
      recorderWith({
        connectionTokenSecretPresent: false,
        webSocketSyncEnabled: true,
        redisBound: false,
        syncingServerGrpcBound: false,
      }),
    )

    await controller.ticket(
      {
        body: { deviceId: 'device-1', password: secrets[0] },
        headers: { authorization: secrets[2], 'x-auth-token': secrets[0] },
      } as unknown as Request,
      responseDouble({ user: { uuid: 'user-uuid-1' }, session: { uuid: 'session-uuid-1' } }).response,
    )
    controller.capabilities({} as Request, responseDouble().response)

    expect(warn).toHaveBeenCalled()
    const emitted = JSON.stringify(warn.mock.calls)
    for (const secret of [...secrets, 'device-1', 'user-uuid-1', 'session-uuid-1']) {
      expect(emitted).not.toContain(secret)
    }
  })
})

/**
 * Standard Red Notes: the GATE-CLOSED path, exercised through a real Inversify
 * container rather than `new SyncWebSocketController(...)`.
 *
 * Every other test in this file — and the sweep in `RouteDispatch.spec.ts`,
 * which builds instances with `Object.create(prototype)` — bypasses the
 * constructor, so none of them can see a controller that cannot be CONSTRUCTED.
 * That is precisely how a constructor whose parameters Inversify could not
 * resolve shipped: it turned both routes into 500s in production while the whole
 * suite stayed green. These tests resolve the controller the way the
 * `inversify-express-utils` facade does (`bind(target).toSelf()`, resolved per
 * request) so the DI path itself is under test.
 *
 * The gate is genuinely unmet here — that is the normal state of any deployment
 * that has not configured realtime sync. `/capabilities` is public, static and
 * consulted BEFORE a session exists, so it must answer 200 with an empty list;
 * `/ticket` must answer a clean 503 SYNC_DISABLED. Neither may ever be a 500: a
 * known, expected configuration state is not a server error.
 */
describe('SyncWebSocketController with the boot gate closed', () => {
  const MET: SyncPreconditionState = {
    connectionTokenSecretPresent: true,
    webSocketSyncEnabled: true,
    redisBound: true,
    syncingServerGrpcBound: true,
  }

  /** Each of the four conditions, unmet one at a time. One of these is any given self-hosted deployment. */
  const UNMET_VARIANTS: ReadonlyArray<[string, Partial<SyncPreconditionState>]> = [
    ['the connection-token secret is absent', { connectionTokenSecretPresent: false }],
    ['sync is switched off by configuration', { webSocketSyncEnabled: false }],
    ['Redis is unbound', { redisBound: false }],
    ['the gRPC syncing proxy is unbound', { syncingServerGrpcBound: false }],
  ]

  const resolveThroughContainer = (): SyncWebSocketController => {
    const container = new Container()
    container.bind(TYPES.ApiGateway_Logger).toConstantValue({ warn: jest.fn() } as unknown as Logger)
    container.bind(SyncWebSocketController).toSelf()

    return container.get(SyncWebSocketController)
  }

  beforeEach(() => syncWebSocketAccessService.clearProvider())
  afterEach(() => {
    syncWebSocketAccessService.clearProvider()
    syncGateDiagnostics.clear()
  })

  it.each(UNMET_VARIANTS)('serves /capabilities as 200 with an empty list when %s', (_label, unmet) => {
    syncGateDiagnostics.record({ ...MET, ...unmet, filesAdvertised: false })
    const { response, status, send } = responseDouble()

    resolveThroughContainer().capabilities({} as Request, response)

    expect(status).toHaveBeenCalledWith(200)
    expect(send).toHaveBeenCalledWith({ capabilities: [] })
  })

  it.each(UNMET_VARIANTS)('refuses /ticket with a clean 503 SYNC_DISABLED when %s', async (_label, unmet) => {
    syncGateDiagnostics.record({ ...MET, ...unmet, filesAdvertised: false })
    const { response, status, send } = responseDouble({
      user: { uuid: 'user-uuid-1' },
      session: { uuid: 'session-uuid-1' },
    })

    await resolveThroughContainer().ticket(
      { body: { deviceId: 'device-1' }, headers: { authorization: 'Bearer token' } } as unknown as Request,
      response,
    )

    expect(status).toHaveBeenCalledWith(503)
    expect(send).toHaveBeenCalledWith({ error: { code: 'SYNC_DISABLED' } })
  })

  /**
   * The gate record is written by the boot gate AFTER app.build(), so a request
   * that lands during boot finds no observation at all. That must degrade to the
   * same clean answers, not to a 500 from an unrecorded report.
   */
  it('still answers cleanly when the gate has not been recorded at all', async () => {
    syncGateDiagnostics.clear()
    const capabilities = responseDouble()
    const ticket = responseDouble({ user: { uuid: 'user-uuid-1' }, session: { uuid: 'session-uuid-1' } })
    const controller = resolveThroughContainer()

    controller.capabilities({} as Request, capabilities.response)
    await controller.ticket(
      { body: { deviceId: 'device-1' }, headers: { authorization: 'Bearer token' } } as unknown as Request,
      ticket.response,
    )

    expect(capabilities.status).toHaveBeenCalledWith(200)
    expect(capabilities.send).toHaveBeenCalledWith({ capabilities: [] })
    expect(ticket.status).toHaveBeenCalledWith(503)
    expect(ticket.send).toHaveBeenCalledWith({ error: { code: 'SYNC_DISABLED' } })
  })

  /**
   * The controller must fall back to the module singletons the boot gate
   * late-binds, NOT to whatever the container happens to hold — otherwise a
   * container that resolved the optional parameters to `undefined` would report
   * a lane that is actually up as unavailable.
   */
  it('reads the live singleton provider bound after the container resolved it', () => {
    const controller = resolveThroughContainer()
    syncWebSocketAccessService.setProvider(readyProvider())
    const { response, status, send } = responseDouble()

    controller.capabilities({} as Request, response)

    expect(status).toHaveBeenCalledWith(200)
    expect(send).toHaveBeenCalledWith({
      capabilities: [{ id: 'ws-sync', version: 1, endpoint: '/sockets/sync' }],
    })
  })
})

describe('SyncWebSocketAccessService lifecycle', () => {
  it('does not let an old gateway clear a newer rolling-deploy provider', () => {
    const service = new SyncWebSocketAccessService()
    const oldProvider = readyProvider()
    const newProvider = readyProvider()
    service.setProvider(oldProvider)
    service.setProvider(newProvider)

    service.clearProvider(oldProvider)

    expect(service.capabilities()).toEqual(newProvider.capabilities())
  })
})
