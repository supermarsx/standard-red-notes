import 'reflect-metadata'

import { Request, Response } from 'express'

import { CollaborationController } from './CollaborationController'
import { ResponseLocals } from '../ResponseLocals'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'
import { CollaborationAuthorizationService } from '../../Service/Sync/CollaborationAuthorizationService'

// Undecidable checks remain fail-closed and retryable.
describe('socket audit: collaboration access-check outages', () => {
  const input = {
    noteUuid: 'audit-note',
    collaborationProtocolVersion: 3 as const,
    expectedRoomEpoch: 'room_epoch_0000000000000001',
  }
  const locals = {
    user: { uuid: 'audit-user' },
    collaborationEnabled: true,
    readOnlyAccess: false,
  } as ResponseLocals

  function harness() {
    const callSyncingServer = jest.fn().mockRejectedValue(new Error('temporary upstream timeout'))
    const proxy = { callSyncingServer } as unknown as ServiceProxyInterface
    const resolver = {
      resolveEndpointOrMethodIdentifier: jest.fn(() => 'items/collaboration-authorization'),
    } as EndpointResolverInterface
    const logger = { error: jest.fn(), info: jest.fn() }
    return { callSyncingServer, proxy, resolver, logger }
  }

  it('distinguishes an undecidable upstream failure from access denial', async () => {
    const { proxy, resolver, logger } = harness()
    const service = new CollaborationAuthorizationService(proxy, resolver, 'audit-secret', 300, logger)
    expect(await service.authorize({} as Request, locals, input)).toEqual({
      authorized: false,
      code: 'AUTHORIZATION_UNAVAILABLE',
    })
    expect(logger.error).toHaveBeenCalledWith(
      'Collaboration authorization could not be decided.',
      expect.objectContaining({ category: 'unreadable', reason: 'access-check-unreachable' }),
    )
  })

  it('returns retryable HTTP 503 for a timeout and succeeds on the next check', async () => {
    const { proxy, resolver, logger, callSyncingServer } = harness()
    const controller = new CollaborationController(proxy, resolver, 'audit-secret', 300, logger as never)
    const json = jest.fn()
    const response = { locals, status: jest.fn(() => ({ json })) } as unknown as Response
    const request = { body: input } as Request
    await controller.authorize(request, response)
    expect(response.status).toHaveBeenLastCalledWith(503)
    expect(json).toHaveBeenLastCalledWith({
      error: {
        tag: 'collaboration-authorization-unavailable',
        message: 'Live collaboration authorization is temporarily unavailable. Retry shortly.',
      },
    })

    callSyncingServer.mockImplementation(async (_request: Request, capture: Response) => {
      capture.status(200).json({
        authorized: true,
        serverUpdatedAtTimestamp: 1_700_000_000_000,
        collaborationSecurityEpoch: 'security_epoch_0000000000000001',
      })
    })
    await controller.authorize(request, response)
    expect(response.status).toHaveBeenLastCalledWith(200)
    expect(json).toHaveBeenLastCalledWith(expect.objectContaining({ capability: expect.any(String) }))
  })
})
