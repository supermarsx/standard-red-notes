import 'reflect-metadata'

import { Request, Response } from 'express'
import { verify } from 'jsonwebtoken'

import { CollaborationController } from './CollaborationController'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

const SECRET = 'collab-secret'
const TTL = 300
const SERVER_REVISION = 1_723_456_789_000_000
const SECURITY_EPOCH = 'security_epoch_0000000000000001'
const ROOM_EPOCH = 'room_epoch_0000000000000001'

describe('CollaborationController', () => {
  let serviceProxy: jest.Mocked<ServiceProxyInterface>
  let endpointResolver: jest.Mocked<EndpointResolverInterface>
  let logger: { error: jest.Mock }
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  const makeController = (secret = SECRET, ttl = TTL) =>
    new CollaborationController(
      serviceProxy as unknown as ServiceProxyInterface,
      endpointResolver as unknown as EndpointResolverInterface,
      secret,
      ttl,
      logger as never,
    )

  const responseWith = (userUuid?: string, additionalLocals: Record<string, unknown> = {}): Response => {
    jsonMock = jest.fn()
    statusMock = jest.fn(() => ({ json: jsonMock }))
    return {
      locals: {
        readOnlyAccess: false,
        collaborationEnabled: true,
        ...(userUuid ? { user: { uuid: userUuid } } : {}),
        ...additionalLocals,
      },
      status: statusMock,
      json: jsonMock,
    } as unknown as Response
  }

  const requestWith = (noteUuid?: unknown, body: Record<string, unknown> = {}): Request =>
    ({
      body: {
        noteUuid,
        collaborationProtocolVersion: 3,
        expectedRoomEpoch: ROOM_EPOCH,
        ...body,
      },
    }) as unknown as Request

  // Make the proxy "syncing server" return a given authorization result by writing
  // it onto the capture-shim response the controller passes in.
  const proxyReturning = (body: unknown, status = 200) =>
    jest.fn().mockImplementation(async (_req, captureResponse: Response) => {
      ;(captureResponse as unknown as { status: (c: number) => unknown }).status(status)
      ;(captureResponse as unknown as { json: (b: unknown) => unknown }).json(body)
    })

  beforeEach(() => {
    serviceProxy = {} as jest.Mocked<ServiceProxyInterface>
    serviceProxy.callSyncingServer = proxyReturning({
      authorized: true,
      serverUpdatedAtTimestamp: SERVER_REVISION,
      collaborationSecurityEpoch: SECURITY_EPOCH,
    })

    endpointResolver = {
      resolveEndpointOrMethodIdentifier: jest.fn().mockReturnValue('items/collaboration-authorization'),
    } as unknown as jest.Mocked<EndpointResolverInterface>

    logger = { error: jest.fn() }
  })

  it('mints a valid capability (right user + room + purpose) when the syncing-server authorizes', async () => {
    const response = responseWith('user-1')
    await makeController().authorize(
      requestWith('note-1', {
        leaseRequestId: 'lease-request-1',
        bootstrapChallenge: 'bootstrap-challenge-1',
      }),
      response,
    )

    expect(statusMock).toHaveBeenCalledWith(200)
    const body = jsonMock.mock.calls[0][0] as {
      capability: string
      room: string
      serverUpdatedAtTimestamp: number
      collaborationProtocolVersion: number
      leaseRequestId: string
      bootstrapChallenge: string
      roomEpoch: string
      collaborationSecurityEpoch: string
      epochDiscovery: boolean
    }
    expect(body.room).toBe('note-1')
    expect(body.serverUpdatedAtTimestamp).toBe(SERVER_REVISION)
    expect(body.collaborationProtocolVersion).toBe(3)
    expect(body.roomEpoch).toBe(ROOM_EPOCH)
    expect(body.collaborationSecurityEpoch).toBe(SECURITY_EPOCH)
    expect(body.epochDiscovery).toBe(false)
    expect(body.leaseRequestId).toBe('lease-request-1')
    expect(body.bootstrapChallenge).toBe('bootstrap-challenge-1')

    const decoded = verify(body.capability, SECRET) as Record<string, unknown>
    expect(decoded.purpose).toBe('collab-room')
    expect(decoded.userUuid).toBe('user-1')
    expect(decoded.room).toBe('note-1')
    expect(decoded.collaborationProtocolVersion).toBe(3)
    expect(decoded.collaborationAuthorizationIssuedAt).toEqual(expect.any(Number))
    expect(decoded.roomEpoch).toBe(body.roomEpoch)
    expect(decoded.collaborationSecurityEpoch).toBe(SECURITY_EPOCH)
    expect(decoded.serverUpdatedAtTimestamp).toBe(SERVER_REVISION)
    expect(decoded.leaseRequestId).toBe('lease-request-1')
    expect(decoded.bootstrapChallenge).toBe('bootstrap-challenge-1')
  })

  it('accepts the home-server wrapped { data: { authorized } } shape', async () => {
    serviceProxy.callSyncingServer = proxyReturning({
      data: {
        authorized: true,
        serverUpdatedAtTimestamp: SERVER_REVISION,
        collaborationSecurityEpoch: SECURITY_EPOCH,
      },
    })
    const response = responseWith('user-1')
    await makeController().authorize(requestWith('note-1'), response)
    expect(statusMock).toHaveBeenCalledWith(200)
  })

  // --- enumerated DENY paths (fail-closed) ---------------------------------

  it('DENIES (403) when the syncing-server says not authorized', async () => {
    serviceProxy.callSyncingServer = proxyReturning({ authorized: false })
    const response = responseWith('user-1')
    await makeController().authorize(requestWith('note-1'), response)
    expect(statusMock).toHaveBeenCalledWith(403)
    expect(jsonMock).not.toHaveBeenCalledWith(expect.objectContaining({ capability: expect.anything() }))
  })

  it.each([
    ['normalized read-only access', { readOnlyAccess: true }],
    ['a read-only account session', { session: { readonly_access: true } }],
    ['an MCP read scope', { mcpScope: { access: 'read' } }],
  ])('DENIES (403) for %s before asking the syncing-server', async (_description, locals) => {
    const response = responseWith('user-1', locals)

    await makeController().authorize(requestWith('note-1'), response)

    expect(statusMock).toHaveBeenCalledWith(403)
    expect(serviceProxy.callSyncingServer).not.toHaveBeenCalled()
    expect(jsonMock).not.toHaveBeenCalledWith(expect.objectContaining({ capability: expect.anything() }))
  })

  it('DENIES (403) on a non-2xx syncing-server response', async () => {
    serviceProxy.callSyncingServer = proxyReturning({ error: 'nope' }, 500)
    const response = responseWith('user-1')
    await makeController().authorize(requestWith('note-1'), response)
    expect(statusMock).toHaveBeenCalledWith(403)
  })

  it('DENIES (403) when the syncing-server response has no authorized flag', async () => {
    serviceProxy.callSyncingServer = proxyReturning({})
    const response = responseWith('user-1')
    await makeController().authorize(requestWith('note-1'), response)
    expect(statusMock).toHaveBeenCalledWith(403)
  })

  it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'DENIES (403) when the authorized response has invalid canonical revision %p',
    async (serverUpdatedAtTimestamp) => {
      serviceProxy.callSyncingServer = proxyReturning({ authorized: true, serverUpdatedAtTimestamp })
      const response = responseWith('user-1')
      await makeController().authorize(requestWith('note-1'), response)
      expect(statusMock).toHaveBeenCalledWith(403)
    },
  )

  it('DENIES (403) when the access-check call THROWS', async () => {
    serviceProxy.callSyncingServer = jest.fn().mockRejectedValue(new Error('collaboration-credential-sentinel'))
    const response = responseWith('user-1')
    await makeController().authorize(requestWith('note-1'), response)

    expect(statusMock).toHaveBeenCalledWith(403)
    expect(logger.error).toHaveBeenCalledWith(
      'Collaboration access check call failed.',
      expect.objectContaining({
        action: 'collaboration.access-check',
        endpoint: '/items/collaboration-authorization',
        method: 'POST',
        errorType: 'Error',
      }),
    )
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('collaboration-credential-sentinel')
  })

  it('DENIES (403) when no signing secret is configured', async () => {
    const response = responseWith('user-1')
    await makeController('').authorize(requestWith('note-1'), response)
    expect(statusMock).toHaveBeenCalledWith(403)
    expect(serviceProxy.callSyncingServer).not.toHaveBeenCalled()
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 29, 30.5, 901])(
    'DENIES (403) when capability TTL %p is invalid',
    async (ttl) => {
      const response = responseWith('user-1')
      await makeController(SECRET, ttl).authorize(requestWith('note-1'), response)
      expect(statusMock).toHaveBeenCalledWith(403)
      expect(serviceProxy.callSyncingServer).not.toHaveBeenCalled()
    },
  )

  it('DENIES (403) when the user is missing from locals', async () => {
    const response = responseWith(undefined)
    await makeController().authorize(requestWith('note-1'), response)
    expect(statusMock).toHaveBeenCalledWith(403)
  })

  it('DENIES (403) for a missing / non-string noteUuid', async () => {
    await makeController().authorize(requestWith(undefined), responseWith('user-1'))
    expect(statusMock).toHaveBeenCalledWith(403)

    statusMock.mockClear()
    await makeController().authorize(requestWith(123 as unknown), responseWith('user-1'))
    expect(statusMock).toHaveBeenCalledWith(403)
  })

  it.each([
    ['missing protocol version', { collaborationProtocolVersion: undefined }],
    ['legacy protocol version', { collaborationProtocolVersion: 1 }],
    ['missing expected room epoch', { expectedRoomEpoch: undefined }],
    ['challenge without a lease request', { bootstrapChallenge: 'challenge-1' }],
    ['empty lease request', { leaseRequestId: '' }],
    ['empty bootstrap challenge', { leaseRequestId: 'lease-1', bootstrapChallenge: '' }],
    ['invalid expected room epoch', { expectedRoomEpoch: 'bad epoch' }],
  ])('DENIES (403) for invalid v3 binding: %s', async (_description, body) => {
    const response = responseWith('user-1')

    await makeController().authorize(requestWith('note-1', body), response)

    expect(statusMock).toHaveBeenCalledWith(403)
    expect(serviceProxy.callSyncingServer).not.toHaveBeenCalled()
  })

  it('binds an exact expected room epoch in both the response and signed capability', async () => {
    const response = responseWith('user-1')

    await makeController().authorize(
      requestWith('note-1', {
        leaseRequestId: 'lease-1',
        expectedRoomEpoch: ROOM_EPOCH,
      }),
      response,
    )

    expect(statusMock).toHaveBeenCalledWith(200)
    const body = jsonMock.mock.calls[0][0] as { capability: string; roomEpoch: string }
    expect(body.roomEpoch).toBe(ROOM_EPOCH)
    expect(verify(body.capability, SECRET)).toEqual(expect.objectContaining({ roomEpoch: ROOM_EPOCH }))
  })

  it('DENIES when the syncing-server omits the collaboration security epoch', async () => {
    serviceProxy.callSyncingServer = proxyReturning({
      authorized: true,
      serverUpdatedAtTimestamp: SERVER_REVISION,
    })
    const response = responseWith('user-1')

    await makeController().authorize(requestWith('note-1'), response)

    expect(statusMock).toHaveBeenCalledWith(403)
  })

  it('discovers an opaque deterministic epoch without minting a join capability', async () => {
    const response = responseWith('user-1')

    await makeController().authorize(
      requestWith('note-1', {
        expectedRoomEpoch: undefined,
        epochDiscovery: true,
      }),
      response,
    )

    expect(statusMock).toHaveBeenCalledWith(200)
    const body = jsonMock.mock.calls[0][0] as Record<string, unknown>
    expect(body).toEqual(
      expect.objectContaining({
        epochDiscovery: true,
        room: 'note-1',
        roomEpoch: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        collaborationSecurityEpoch: SECURITY_EPOCH,
        collaborationProtocolVersion: 3,
        serverUpdatedAtTimestamp: SERVER_REVISION,
      }),
    )
    expect(body).not.toHaveProperty('capability')
    expect(body).not.toHaveProperty('expiresIn')
  })

  it.each([{ leaseRequestId: 'lease-1' }, { bootstrapChallenge: 'challenge-1' }, { expectedRoomEpoch: ROOM_EPOCH }])(
    'DENIES discovery requests carrying grant-only bindings: %p',
    async (grantBinding) => {
      const response = responseWith('user-1')

      await makeController().authorize(
        requestWith('note-1', {
          expectedRoomEpoch: undefined,
          epochDiscovery: true,
          ...grantBinding,
        }),
        response,
      )

      expect(statusMock).toHaveBeenCalledWith(403)
      expect(serviceProxy.callSyncingServer).not.toHaveBeenCalled()
    },
  )
})
