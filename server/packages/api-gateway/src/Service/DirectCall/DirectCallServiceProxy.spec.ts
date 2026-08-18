import 'reflect-metadata'

import { Request, Response } from 'express'
import { ServiceContainerInterface, ServiceIdentifier } from '@standardnotes/domain-core'
import type { AttachedGateway } from '@standard-red-notes/websocket-gateway'

import { DirectCallServiceProxy } from './DirectCallServiceProxy'
import { webSocketGatewayAccessService } from '../Sync/SyncWebSocketRuntime'

describe('DirectCallServiceProxy', () => {
  let serviceContainer: ServiceContainerInterface
  let services: Record<string, { handleRequest: jest.Mock }>

  let send: jest.Mock
  let status: jest.Mock

  const buildProxy = () => new DirectCallServiceProxy(serviceContainer, 'http://files')

  const buildResponse = (locals: Record<string, unknown> = {}): Response =>
    ({ locals, status, send }) as unknown as Response

  const buildRequest = (): Request => ({ headers: {}, query: {} }) as unknown as Request

  beforeEach(() => {
    services = {
      [ServiceIdentifier.NAMES.Auth]: {
        handleRequest: jest.fn().mockResolvedValue({ statusCode: 200, json: { ok: true } }),
      },
      [ServiceIdentifier.NAMES.Revisions]: {
        handleRequest: jest.fn().mockResolvedValue({ statusCode: 200, json: { revisions: [] } }),
      },
      [ServiceIdentifier.NAMES.SyncingServer]: {
        handleRequest: jest.fn().mockResolvedValue({ statusCode: 200, json: { retrieved_items: [] } }),
      },
    }

    serviceContainer = {
      get: jest.fn((identifier: { value: string }) => services[identifier.value]),
    } as unknown as ServiceContainerInterface

    send = jest.fn()
    status = jest.fn().mockReturnValue({ send })
  })

  describe('validateSession', () => {
    const dto = (overrides: Record<string, unknown> = {}) => ({
      headers: { authorization: 'token' },
      ...overrides,
    })

    it('dispatches to the in-process auth service under the sessions.validate identifier', async () => {
      await buildProxy().validateSession(dto())

      const call = services[ServiceIdentifier.NAMES.Auth].handleRequest.mock.calls[0]
      expect(call[2]).toBe('auth.sessions.validate')
      expect(call[0].body).toEqual({ authTokenFromHeaders: 'token', sharedVaultOwnerContext: undefined })
    })

    it('returns the in-process status and body as an HTTP-shaped result', async () => {
      services[ServiceIdentifier.NAMES.Auth].handleRequest.mockResolvedValue({
        statusCode: 401,
        json: { error: { tag: 'invalid-auth' } },
      })

      const result = await buildProxy().validateSession(dto())

      expect(result).toEqual({
        status: 401,
        data: { error: { tag: 'invalid-auth' } },
        headers: { contentType: 'application/json' },
      })
    })

    it('serializes the cookie map into a single trimmed cookie header', async () => {
      await buildProxy().validateSession(
        dto({
          cookies: new Map([
            ['a', ['1', '3']],
            ['b', ['2']],
          ]),
        }),
      )

      expect(services[ServiceIdentifier.NAMES.Auth].handleRequest.mock.calls[0][0].headers.cookie).toBe(
        'a=1; a=3; b=2;',
      )
    })

    it('forwards the client version metadata and the shared vault owner context', async () => {
      await buildProxy().validateSession(
        dto({
          headers: { authorization: 'token', sharedVaultOwnerContext: 'owner-1' },
          requestMetadata: { snjs: '2.1.0', application: '3.4.5' },
        }),
      )

      const sent = services[ServiceIdentifier.NAMES.Auth].handleRequest.mock.calls[0][0]
      expect(sent.headers['x-snjs-version']).toBe('2.1.0')
      expect(sent.headers['x-application-version']).toBe('3.4.5')
      expect(sent.body.sharedVaultOwnerContext).toBe('owner-1')
    })

    it('throws when the auth service is not registered in the container', async () => {
      delete services[ServiceIdentifier.NAMES.Auth]

      await expect(buildProxy().validateSession(dto())).rejects.toThrow('Auth service not found')
    })
  })

  describe('in-process dispatch', () => {
    const cases: [string, string][] = [
      ['callAuthServer', ServiceIdentifier.NAMES.Auth],
      ['callRevisionsServer', ServiceIdentifier.NAMES.Revisions],
      ['callSyncingServer', ServiceIdentifier.NAMES.SyncingServer],
    ]

    it.each(cases)('%s dispatches to the %s service with the method identifier', async (method, serviceName) => {
      const proxy = buildProxy() as unknown as Record<string, (...args: unknown[]) => Promise<void>>

      await proxy[method](buildRequest(), buildResponse(), 'some.method')

      expect(services[serviceName].handleRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'some.method',
      )
    })

    it.each(cases)('%s throws when the %s service is missing', async (method, serviceName) => {
      delete services[serviceName]
      const proxy = buildProxy() as unknown as Record<string, (...args: unknown[]) => Promise<void>>

      await expect(proxy[method](buildRequest(), buildResponse(), 'some.method')).rejects.toThrow('not found')
    })

    it('decorates the in-process response with auth and server metadata', async () => {
      await buildProxy().callAuthServer(
        buildRequest() as never,
        buildResponse({ user: { uuid: 'u-1' }, roles: [{ name: 'CORE_USER' }] }) as never,
        'auth.users.get',
      )

      expect(status).toHaveBeenCalledWith(200)
      expect(send).toHaveBeenCalledWith({
        meta: {
          auth: { userUuid: 'u-1', roles: [{ name: 'CORE_USER' }] },
          server: { filesServerUrl: 'http://files' },
        },
        data: { ok: true },
      })
    })

    it('propagates the status the in-process service returned', async () => {
      services[ServiceIdentifier.NAMES.SyncingServer].handleRequest.mockResolvedValue({
        statusCode: 409,
        json: { conflicts: [] },
      })

      await buildProxy().callSyncingServer(buildRequest() as never, buildResponse() as never, 'sync')

      expect(status).toHaveBeenCalledWith(409)
    })
  })

  describe('endpoints unavailable in the single-container deployment', () => {
    it.each([
      ['callEmailServer', 'Email server is not available.'],
      ['callAuthServerWithLegacyFormat', 'Legacy auth endpoints are no longer available.'],
      ['callLegacySyncingServer', 'Legacy syncing server endpoints are no longer available.'],
      ['callPaymentsServer', 'Payments server is not available.'],
    ])('%s responds 400 with an explanatory message', async (method, message) => {
      const proxy = buildProxy() as unknown as Record<string, (...args: unknown[]) => Promise<void>>

      await proxy[method](buildRequest(), buildResponse(), 'anything')

      expect(status).toHaveBeenCalledWith(400)
      expect(send).toHaveBeenCalledWith({ error: { message } })
    })
  })

  describe('callWebSocketServer', () => {
    const authenticated = { user: { uuid: 'u-1' }, session: { uuid: 's-1' }, authToken: 'signed-auth' }
    let handleMintToken: jest.Mock

    beforeEach(() => {
      handleMintToken = jest.fn((request, response) => {
        expect(request.headers['x-auth-token']).toBe('signed-auth')
        response.writeHead(200)
        response.end(JSON.stringify({ token: 'ws-token' }))
      })
      webSocketGatewayAccessService.setProvider({ handleMintToken } as unknown as AttachedGateway)
    })

    afterEach(() => {
      webSocketGatewayAccessService.clearProvider()
    })

    it('mints a connection token against the attached in-process gateway', async () => {
      await buildProxy().callWebSocketServer(buildRequest(), buildResponse(authenticated), 'sockets.tokens.create')

      expect(handleMintToken).toHaveBeenCalledTimes(1)
      expect(status).toHaveBeenCalledWith(200)
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: { token: 'ws-token' } }))
    })

    it('refuses to mint a token for an unauthenticated caller', async () => {
      await buildProxy().callWebSocketServer(buildRequest(), buildResponse({}), 'sockets.tokens.create')

      expect(handleMintToken).not.toHaveBeenCalled()
      expect(status).toHaveBeenCalledWith(400)
      expect(send).toHaveBeenCalledWith({ error: { message: 'Websockets server is not available.' } })
    })

    it('refuses to mint a token for a caller with a user but no session', async () => {
      await buildProxy().callWebSocketServer(
        buildRequest(),
        buildResponse({ user: { uuid: 'u-1' } }),
        'sockets.tokens.create',
      )

      expect(handleMintToken).not.toHaveBeenCalled()
      expect(status).toHaveBeenCalledWith(400)
    })

    it('rejects any method identifier that is not a token request', async () => {
      await buildProxy().callWebSocketServer(buildRequest(), buildResponse(authenticated), 'sockets.connect')

      expect(handleMintToken).not.toHaveBeenCalled()
      expect(status).toHaveBeenCalledWith(400)
    })

    it('returns retryable unavailability when no in-process gateway is attached', async () => {
      webSocketGatewayAccessService.clearProvider()

      await buildProxy().callWebSocketServer(buildRequest(), buildResponse(authenticated), 'sockets.tokens.create')

      expect(handleMintToken).not.toHaveBeenCalled()
      expect(status).toHaveBeenCalledWith(503)
      expect(send).toHaveBeenCalledWith({ error: { message: 'Websockets server is not available.' } })
    })

    it('propagates a failure status from the websocket gateway', async () => {
      handleMintToken.mockImplementationOnce((_request, response) => {
        response.writeHead(403)
        response.end(JSON.stringify({ error: 'forbidden' }))
      })

      await buildProxy().callWebSocketServer(buildRequest(), buildResponse(authenticated), 'sockets.tokens.create')

      expect(status).toHaveBeenCalledWith(403)
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ data: { error: 'forbidden' } }))
    })
  })
})
