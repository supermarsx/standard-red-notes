import 'reflect-metadata'

import { Request, Response } from 'express'
import { verify } from 'jsonwebtoken'

import { CollaborationController } from './CollaborationController'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'

const SECRET = 'collab-secret'
const TTL = 300

describe('CollaborationController', () => {
  let serviceProxy: jest.Mocked<ServiceProxyInterface>
  let endpointResolver: jest.Mocked<EndpointResolverInterface>
  let logger: { error: jest.Mock }
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  const makeController = (secret = SECRET) =>
    new CollaborationController(
      serviceProxy as unknown as ServiceProxyInterface,
      endpointResolver as unknown as EndpointResolverInterface,
      secret,
      TTL,
      logger as never,
    )

  const responseWith = (userUuid?: string): Response => {
    jsonMock = jest.fn()
    statusMock = jest.fn(() => ({ json: jsonMock }))
    return {
      locals: userUuid ? { user: { uuid: userUuid } } : {},
      status: statusMock,
      json: jsonMock,
    } as unknown as Response
  }

  const requestWith = (noteUuid?: unknown): Request => ({ body: { noteUuid } }) as unknown as Request

  // Make the proxy "syncing server" return a given authorization result by writing
  // it onto the capture-shim response the controller passes in.
  const proxyReturning = (body: unknown, status = 200) =>
    jest.fn().mockImplementation(async (_req, captureResponse: Response) => {
      ;(captureResponse as unknown as { status: (c: number) => unknown }).status(status)
      ;(captureResponse as unknown as { json: (b: unknown) => unknown }).json(body)
    })

  beforeEach(() => {
    serviceProxy = {} as jest.Mocked<ServiceProxyInterface>
    serviceProxy.callSyncingServer = proxyReturning({ authorized: true })

    endpointResolver = {
      resolveEndpointOrMethodIdentifier: jest.fn().mockReturnValue('items/collaboration-authorization'),
    } as unknown as jest.Mocked<EndpointResolverInterface>

    logger = { error: jest.fn() }
  })

  it('mints a valid capability (right user + room + purpose) when the syncing-server authorizes', async () => {
    const response = responseWith('user-1')
    await makeController().authorize(requestWith('note-1'), response)

    expect(statusMock).toHaveBeenCalledWith(200)
    const body = jsonMock.mock.calls[0][0] as { capability: string; room: string }
    expect(body.room).toBe('note-1')

    const decoded = verify(body.capability, SECRET) as Record<string, unknown>
    expect(decoded.purpose).toBe('collab-room')
    expect(decoded.userUuid).toBe('user-1')
    expect(decoded.room).toBe('note-1')
  })

  it('accepts the home-server wrapped { data: { authorized } } shape', async () => {
    serviceProxy.callSyncingServer = proxyReturning({ data: { authorized: true } })
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

  it('DENIES (403) when the access-check call THROWS', async () => {
    serviceProxy.callSyncingServer = jest.fn().mockRejectedValue(new Error('syncing down'))
    const response = responseWith('user-1')
    await makeController().authorize(requestWith('note-1'), response)
    expect(statusMock).toHaveBeenCalledWith(403)
  })

  it('DENIES (403) when no signing secret is configured', async () => {
    const response = responseWith('user-1')
    await makeController('').authorize(requestWith('note-1'), response)
    expect(statusMock).toHaveBeenCalledWith(403)
    expect(serviceProxy.callSyncingServer).not.toHaveBeenCalled()
  })

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
})
