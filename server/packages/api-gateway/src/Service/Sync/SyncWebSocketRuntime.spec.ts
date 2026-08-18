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
