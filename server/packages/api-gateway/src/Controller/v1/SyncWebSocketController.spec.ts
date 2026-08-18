import { Request, Response } from 'express'
import type { SyncGatewayAccess } from '@standard-red-notes/websocket-gateway'

import { SyncWebSocketController } from './SyncWebSocketController'
import { SyncWebSocketAccessService, syncWebSocketAccessService } from '../../Service/Sync/SyncWebSocketAccessService'

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
