import type { AttachedGateway, AttachOptions, SyncGatewayAccess } from '@standard-red-notes/websocket-gateway'

import { SyncWebSocketAccessService } from './SyncWebSocketAccessService'
import { SyncWebSocketRuntime, WebSocketGatewayAccessService } from './SyncWebSocketRuntime'

describe('SyncWebSocketRuntime', () => {
  const provider = (): SyncGatewayAccess => ({
    capabilities: () => ({ capabilities: [] }),
    issueTicket: jest.fn(),
  })

  it('publishes the provider only after attach succeeds', () => {
    const access = new SyncWebSocketAccessService()
    const expected = provider()
    const attach = jest.fn(
      () => ({ sync: expected, stop: jest.fn(), handleMintToken: jest.fn() }) as unknown as AttachedGateway,
    )
    const gatewayAccess = new WebSocketGatewayAccessService()
    const runtime = new SyncWebSocketRuntime(access, attach, gatewayAccess)

    runtime.attach({} as AttachOptions)

    expect(access.capabilities()).toEqual(expected.capabilities())
    expect(runtime.isActive()).toBe(true)
    expect(gatewayAccess.mintConnectionToken({} as never, {} as never)).toBe(true)
  })

  it('does not publish a provider when attach fails', () => {
    const access = new SyncWebSocketAccessService()
    const runtime = new SyncWebSocketRuntime(
      access,
      () => {
        throw new Error('attach failed')
      },
      new WebSocketGatewayAccessService(),
    )

    expect(() => runtime.attach({} as AttachOptions)).toThrow('attach failed')
    expect(access.capabilities()).toEqual({ capabilities: [] })
    expect(runtime.isActive()).toBe(false)
  })

  it('clears capability access before awaiting gateway drain and coalesces stop', async () => {
    const access = new SyncWebSocketAccessService()
    const expected = provider()
    let finish!: () => void
    const stop = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const gatewayAccess = new WebSocketGatewayAccessService()
    const runtime = new SyncWebSocketRuntime(
      access,
      () => ({ sync: expected, stop }) as unknown as AttachedGateway,
      gatewayAccess,
    )
    runtime.attach({} as AttachOptions)

    const first = runtime.stop()
    const second = runtime.stop()
    expect(access.capabilities()).toEqual({ capabilities: [] })
    expect(gatewayAccess.mintConnectionToken({} as never, {} as never)).toBe(false)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(runtime.isActive()).toBe(true)

    finish()
    await Promise.all([first, second])
    expect(runtime.isActive()).toBe(false)
  })
})

describe('WebSocketGatewayAccessService in-process mint and health', () => {
  const authenticated = { user: { uuid: 'u-1' }, session: { uuid: 's-1' }, authToken: 'signed-auth' }

  it('returns undefined when no gateway is attached', () => {
    const service = new WebSocketGatewayAccessService()

    expect(service.mintConnectionTokenFor(authenticated)).toBeUndefined()
    expect(service.health()).toBeUndefined()
  })

  // R4: the synthetic request carries ONLY the forwarded cross-service token;
  // nothing from the inbound client request reaches the mint handler.
  it('mints through the attached gateway with the forwarded x-auth-token and captures the answer', () => {
    const handleMintToken = jest.fn((request, response) => {
      expect(request.headers).toEqual({ 'x-auth-token': 'signed-auth' })
      expect(request.body).toEqual({ userUuid: 'u-1', sessionUuid: 's-1' })
      response.writeHead(200).end(JSON.stringify({ token: 'ws-token' }))
    })
    const service = new WebSocketGatewayAccessService()
    service.setProvider({ handleMintToken } as unknown as AttachedGateway)

    expect(service.mintConnectionTokenFor(authenticated)).toEqual({ statusCode: 200, json: { token: 'ws-token' } })
  })

  it.each([
    ['no user', { session: { uuid: 's-1' }, authToken: 't' }],
    ['no session', { user: { uuid: 'u-1' }, authToken: 't' }],
    ['no cross-service token', { user: { uuid: 'u-1' }, session: { uuid: 's-1' } }],
  ])('declines to mint with %s so the caller can fall back', (_label, locals) => {
    const handleMintToken = jest.fn()
    const service = new WebSocketGatewayAccessService()
    service.setProvider({ handleMintToken } as unknown as AttachedGateway)

    expect(service.mintConnectionTokenFor(locals)).toBeUndefined()
    expect(handleMintToken).not.toHaveBeenCalled()
  })

  it('reports a non-JSON gateway body as 502 and an empty body as an empty object', () => {
    const service = new WebSocketGatewayAccessService()
    service.setProvider({
      handleMintToken: (_request: unknown, response: { writeHead(s: number): unknown; end(b?: string): void }) => {
        response.writeHead(200)
        response.end('not json')
      },
    } as unknown as AttachedGateway)
    expect(service.mintConnectionTokenFor(authenticated)).toEqual({ statusCode: 502, json: expect.anything() })

    service.setProvider({
      handleMintToken: (_request: unknown, response: { writeHead(s: number): unknown; end(b?: string): void }) => {
        response.writeHead(204)
        response.end()
      },
    } as unknown as AttachedGateway)
    expect(service.mintConnectionTokenFor(authenticated)).toEqual({ statusCode: 204, json: {} })
  })

  // C9: readiness and the admin diagnostics read the gateway's health through
  // this late-bound seam; a gateway build without health() reads as unattached.
  it('passes the attached gateway health through and tolerates a gateway without health()', () => {
    const health = {
      attached: true as const,
      pushBridge: 'redis' as const,
      pushBridgeReady: true,
      sqsConsumerRunning: false,
      collaborationRelayHealthy: true,
      syncLane: 'up' as const,
      pushesDispatched: 7,
    }
    const service = new WebSocketGatewayAccessService()
    service.setProvider({ health: () => health } as unknown as AttachedGateway)
    expect(service.health()).toEqual(health)

    service.setProvider({} as unknown as AttachedGateway)
    expect(service.health()).toBeUndefined()
  })
})
