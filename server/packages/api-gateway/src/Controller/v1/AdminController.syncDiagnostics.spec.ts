import 'reflect-metadata'

import { Request, Response } from 'express'

import { AdminController } from './AdminController'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'
import { syncGateDiagnostics } from '../../Service/Sync/SyncGateDiagnostics'
import { syncWebSocketAccessService } from '../../Service/Sync/SyncWebSocketAccessService'
import { deploymentDiagnostics, observeDeployment } from '../../Service/Diagnostics/DeploymentDiagnostics'

jest.mock('../../Service/Assistant/providers/factory', () => ({
  configuredProviders: jest.fn().mockReturnValue([]),
}))

/**
 * Standard Red Notes: the gateway-LOCAL /v1/admin/sync-diagnostics endpoint.
 *
 * Two properties matter here and nothing else does. First, it must be admin-only
 * — it reports deployment topology, and the whole feature is worthless if it
 * widens access. Second, and the reason the endpoint is shaped the way it is: it
 * must NEVER carry a configured value. The recorder it reads from accepts only
 * booleans and literal keys precisely so a URL or a secret has no field to travel
 * in, and the last test in this file holds that end-to-end by planting secrets in
 * the environment and scanning the whole serialized response for them.
 *
 * The unavailable path is covered first because it is the state real deployments
 * are actually in: WEBSOCKET_SYNC_ENABLED defaults on, so the lane is normally
 * off because Redis or the gRPC syncing proxy is unbound — and saying WHICH is
 * the entire point of the endpoint.
 */
describe('AdminController sync-diagnostics', () => {
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  const makeController = () => new AdminController({} as ServiceProxyInterface, {} as EndpointResolverInterface)

  const responseWith = (roles: Array<{ name: string }>): Response => {
    jsonMock = jest.fn()
    statusMock = jest.fn(() => ({ json: jsonMock }))
    return {
      locals: { user: { uuid: 'admin-1' }, roles },
      setHeader: jest.fn(),
      status: statusMock,
      json: jsonMock,
    } as unknown as Response
  }

  const adminResponse = () => responseWith([{ name: 'ADMIN_USER' }])

  const payload = (): Record<string, never> => jsonMock.mock.calls[0][0]

  beforeEach(() => {
    syncGateDiagnostics.clear()
    deploymentDiagnostics.clear()
    syncWebSocketAccessService.clearProvider()
  })

  afterAll(() => {
    syncGateDiagnostics.clear()
    deploymentDiagnostics.clear()
    syncWebSocketAccessService.clearProvider()
  })

  it('refuses a non-admin with 403 and answers nothing', () => {
    const response = responseWith([{ name: 'CORE_USER' }])

    makeController().getSyncDiagnostics({} as Request, response)

    expect(statusMock).toHaveBeenCalledWith(403)
    expect(jsonMock).toHaveBeenCalledWith({ error: { message: 'Admin role required.' } })
  })

  it('refuses a session carrying no roles at all', () => {
    const response = responseWith([])

    makeController().getSyncDiagnostics({} as Request, response)

    expect(statusMock).toHaveBeenCalledWith(403)
  })

  it('names the single unmet condition rather than a category', () => {
    // The deployment this feature was built for: the kill switch is on (default),
    // the signing secret is set, Redis is bound — only the durable backend is
    // missing. The lane now COMES UP in this state and serves collaboration,
    // API RPC, invite events and files; only SYNC_ITEMS is withheld, so the two
    // are reported separately rather than as one dead lane.
    syncGateDiagnostics.record({
      connectionTokenSecretPresent: true,
      webSocketSyncEnabled: true,
      redisBound: true,
      syncingServerGrpcBound: false,
      filesAdvertised: false,
    })
    const response = adminResponse()

    makeController().getSyncDiagnostics({} as Request, response)

    const { gate } = payload() as unknown as {
      gate: {
        recorded: boolean
        syncLaneEnabled: boolean
        syncItemsAdvertised: boolean
        unmetCodes: string[]
        unmetPreconditions: unknown[]
      }
    }
    expect(gate.recorded).toBe(true)
    expect(gate.syncLaneEnabled).toBe(true)
    expect(gate.syncItemsAdvertised).toBe(false)
    // The condition stays visible and named in the panel regardless.
    expect(gate.unmetCodes).toEqual(['SYNCING_SERVER_GRPC_UNBOUND'])
    expect(gate.unmetPreconditions).toHaveLength(1)
  })

  it('reports the lane and SYNC_ITEMS as both healthy when the durable port is bound', () => {
    syncGateDiagnostics.record({
      connectionTokenSecretPresent: true,
      webSocketSyncEnabled: true,
      redisBound: true,
      syncingServerGrpcBound: true,
      filesAdvertised: true,
    })
    const response = adminResponse()

    makeController().getSyncDiagnostics({} as Request, response)

    const { gate } = payload() as unknown as {
      gate: { syncLaneEnabled: boolean; syncItemsAdvertised: boolean; unmetCodes: string[] }
    }
    expect(gate.syncLaneEnabled).toBe(true)
    expect(gate.syncItemsAdvertised).toBe(true)
    expect(gate.unmetCodes).toEqual([])
  })

  it('reports SYNC_ITEMS as unadvertised whenever the lane itself is down', () => {
    // SYNC_ITEMS cannot be offered over a socket that never opened, so a
    // transport failure must not leave it reading as advertised.
    syncGateDiagnostics.record({
      connectionTokenSecretPresent: true,
      webSocketSyncEnabled: true,
      redisBound: false,
      syncingServerGrpcBound: true,
      filesAdvertised: false,
    })
    const response = adminResponse()

    makeController().getSyncDiagnostics({} as Request, response)

    const { gate } = payload() as unknown as {
      gate: { syncLaneEnabled: boolean; syncItemsAdvertised: boolean; unmetCodes: string[] }
    }
    expect(gate.syncLaneEnabled).toBe(false)
    expect(gate.syncItemsAdvertised).toBe(false)
    expect(gate.unmetCodes).toEqual(['REDIS_UNBOUND'])
  })

  it('reports every unmet condition, not just the first', () => {
    syncGateDiagnostics.record({
      connectionTokenSecretPresent: false,
      webSocketSyncEnabled: false,
      redisBound: false,
      syncingServerGrpcBound: false,
      filesAdvertised: false,
    })
    const response = adminResponse()

    makeController().getSyncDiagnostics({} as Request, response)

    const { gate } = payload() as unknown as { gate: { gatewayAttached: boolean; unmetCodes: string[] } }
    expect(gate.gatewayAttached).toBe(false)
    expect(gate.unmetCodes).toEqual([
      'WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING',
      'WEBSOCKET_SYNC_DISABLED_BY_CONFIGURATION',
      'REDIS_UNBOUND',
      'SYNCING_SERVER_GRPC_UNBOUND',
    ])
  })

  it('distinguishes a gate that has not run from a gate that passed', () => {
    // An empty unmet list must not be rendered as four green ticks when the
    // evidence for them was never recorded.
    const response = adminResponse()

    makeController().getSyncDiagnostics({} as Request, response)

    const { gate } = payload() as unknown as { gate: { recorded: boolean; syncLaneEnabled: boolean } }
    expect(gate.recorded).toBe(false)
    expect(gate.syncLaneEnabled).toBe(false)
  })

  it('carries the FILES_V1 sub-gate separately from the sync gate', () => {
    syncGateDiagnostics.record({
      connectionTokenSecretPresent: true,
      webSocketSyncEnabled: true,
      redisBound: true,
      syncingServerGrpcBound: true,
      filesAdvertised: false,
      filesUnmetCondition: 'VALET_TOKEN_SECRET',
    })
    const response = adminResponse()

    makeController().getSyncDiagnostics({} as Request, response)

    const { gate } = payload() as unknown as {
      gate: { syncLaneEnabled: boolean; files: { advertised: boolean; unmetCondition: string; remedy: string } }
    }
    // The sync lane is up; only files is waived.
    expect(gate.syncLaneEnabled).toBe(true)
    expect(gate.files.advertised).toBe(false)
    expect(gate.files.unmetCondition).toBe('VALET_TOKEN_SECRET')
    expect(gate.files.remedy).toContain('VALET_TOKEN_SECRET')
  })

  it('reports the live refusal reasons and that no ticket can be issued', () => {
    const response = adminResponse()

    makeController().getSyncDiagnostics({} as Request, response)

    const { live } = payload() as unknown as {
      live: { capabilities: unknown[]; unavailabilityReasons: string[]; ticketAvailable: boolean }
    }
    expect(live.capabilities).toEqual([])
    expect(live.unavailabilityReasons).toEqual(['sync-not-configured'])
    expect(live.ticketAvailable).toBe(false)
  })

  it('reports ticketAvailable once the gateway advertises and stops refusing', () => {
    syncWebSocketAccessService.setProvider({
      capabilities: () => ({ capabilities: [{ id: 'ws-sync', version: 1, endpoint: '/sockets/sync' }] }),
      issueTicket: jest.fn(),
      unavailabilityReasons: () => [],
    } as never)
    const response = adminResponse()

    makeController().getSyncDiagnostics({} as Request, response)

    const { live } = payload() as unknown as { live: { ticketAvailable: boolean } }
    expect(live.ticketAvailable).toBe(true)
  })

  /**
   * The single-container trap, pinned.
   *
   * In the home-server topology `ApiGateway_ServiceProxy` is a
   * `DirectCallServiceProxy` that resolves handlers by NAME out of the auth
   * package's `controllerContainer`. An endpoint that reaches the proxy without a
   * matching registration answers `500 "Method not found"` at runtime while the
   * build, the decorator and every unit test stay green — nine invite endpoints
   * shipped dead exactly that way.
   *
   * This endpoint is gateway-LOCAL and must never touch the proxy, so no
   * registration is required. Rather than assert that from reading the code, the
   * proxy and the endpoint resolver are made to THROW on any use: if a future
   * edit routes this handler through either of them, this test fails instead of
   * the single-container deployment.
   */
  it('answers without touching the service proxy, so it needs no controllerContainer registration', () => {
    const explode = (name: string) => () => {
      throw new Error(`Method not found: getSyncDiagnostics must not reach ${name} — it is gateway-local.`)
    }
    const throwingProxy = new Proxy({} as ServiceProxyInterface, {
      get: (_target, key) => explode(`serviceProxy.${String(key)}`),
    })
    const throwingResolver = new Proxy({} as EndpointResolverInterface, {
      get: (_target, key) => explode(`endpointResolver.${String(key)}`),
    })
    syncGateDiagnostics.record({
      connectionTokenSecretPresent: true,
      webSocketSyncEnabled: true,
      redisBound: false,
      syncingServerGrpcBound: true,
      filesAdvertised: false,
    })
    const response = adminResponse()

    new AdminController(throwingProxy, throwingResolver).getSyncDiagnostics({} as Request, response)

    // A real answer, not a 500 and not a 403.
    expect(statusMock).not.toHaveBeenCalled()
    const { gate } = payload() as unknown as { gate: { unmetCodes: string[] } }
    expect(gate.unmetCodes).toEqual(['REDIS_UNBOUND'])
  })

  it('advertises the server protocol operations including FILES_V1', () => {
    const response = adminResponse()

    makeController().getSyncDiagnostics({} as Request, response)

    const { protocol } = payload() as unknown as { protocol: { version: number; serverOperations: string[] } }
    expect(protocol.version).toBe(1)
    expect(protocol.serverOperations).toContain('FILES_V1')
    expect(protocol.serverOperations).toContain('SYNC_ITEMS')
  })

  /**
   * The topology block is what makes a remedy safe to print. Without it the panel
   * can only repeat the gate's generic advice, which is wrong in home-server mode
   * (no gRPC proxy is ever constructed there, so SYNCING_SERVER_GRPC_URL is never
   * read). `recorded: false` is therefore not a cosmetic default — it is the flag
   * that suppresses every topology-conditional remedy.
   */
  it('reports the deployment topology as not recorded until the container records it', () => {
    const response = adminResponse()

    makeController().getSyncDiagnostics({} as Request, response)

    expect((payload() as Record<string, { recorded: boolean }>).deployment.recorded).toBe(false)
  })

  it('carries the recorded topology, the branch that ran, and configuration presence', () => {
    deploymentDiagnostics.record(
      observeDeployment((key) => ({ MODE: 'home-server', SYNCING_SERVER_GRPC_URL: '0.0.0.0:50052' })[key], {
        boundServiceProxy: 'direct-call',
        grpcSyncingProxyBound: false,
        redisBound: true,
      }),
    )
    const response = adminResponse()

    makeController().getSyncDiagnostics({} as Request, response)

    const deployment = (payload() as Record<string, Record<string, unknown>>).deployment
    expect(deployment.recorded).toBe(true)
    expect(deployment.mode).toBe('home-server')
    expect(deployment.boundServiceProxy).toBe('direct-call')
    // The load-bearing pair: the URL IS set, and it still cannot bind anything
    // here. A panel that saw only the first half would tell the operator to set
    // a variable they have already set.
    expect((deployment.presence as Record<string, boolean>).SYNCING_SERVER_GRPC_URL).toBe(true)
    expect(deployment.grpcProxyBindableInThisMode).toBe(false)
  })

  /**
   * The security boundary, held end-to-end rather than by reading the code.
   * Every value below is planted in the environment the gate observes; none of
   * them may appear anywhere in the serialized response, at any nesting depth,
   * in any casing, whole or in part.
   */
  it('never leaks a configured value, secret or host into the payload', () => {
    const planted = {
      WEB_SOCKET_CONNECTION_TOKEN_SECRET: 'ws-token-secret-must-not-appear',
      AUTH_JWT_SECRET: 'auth-jwt-secret-must-not-appear',
      VALET_TOKEN_SECRET: 'valet-secret-must-not-appear',
      REDIS_URL: 'redis://someuser:somepassword@redis.internal.example:6379/2',
      SYNCING_SERVER_GRPC_URL: 'syncing.internal.example:50051',
      WEBSOCKET_SYNC_FILES_URL: 'http://files.internal.example:3104',
    }
    const previous: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(planted)) {
      previous[key] = process.env[key]
      process.env[key] = value
    }

    try {
      // Fully configured AND fully unconfigured are both exercised: the unmet
      // path is the one that carries remedy copy naming env vars, which is where
      // a value would most plausibly be interpolated by mistake.
      for (const bound of [true, false]) {
        // The topology block reads those same planted variables, so it travels
        // through this scan too — it is the newest and therefore likeliest place
        // for a value-carrying field to be introduced.
        deploymentDiagnostics.record(
          observeDeployment((key) => process.env[key], {
            boundServiceProxy: bound ? 'grpc' : 'http',
            grpcSyncingProxyBound: bound,
            redisBound: bound,
          }),
        )
        syncGateDiagnostics.record({
          connectionTokenSecretPresent: bound,
          webSocketSyncEnabled: bound,
          redisBound: bound,
          syncingServerGrpcBound: bound,
          filesAdvertised: bound,
          ...(bound ? {} : { filesUnmetCondition: 'FILES_INTERNAL_URL' as const }),
        })
        const response = adminResponse()

        makeController().getSyncDiagnostics({} as Request, response)

        const serialized = JSON.stringify(payload()).toLowerCase()
        for (const value of Object.values(planted)) {
          expect(serialized).not.toContain(value.toLowerCase())
        }
        // The distinctive substrings of those values, in case a payload ever
        // carries a host or a credential without the surrounding scheme.
        for (const fragment of ['somepassword', 'someuser', 'internal.example', '50051', '3104']) {
          expect(serialized).not.toContain(fragment)
        }
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })
})
