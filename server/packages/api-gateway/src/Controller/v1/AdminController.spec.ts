import 'reflect-metadata'

import { Request, Response } from 'express'
import { RoleName } from '@standardnotes/domain-core'

import { AdminController } from './AdminController'
import { AssistantProviderConfig } from '../../Service/Assistant/providers/factory'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'
import { UpdateCheckService } from '../../Service/Updates/UpdateCheckService'

// Only which providers are configured matters for the server-status payload.
jest.mock('../../Service/Assistant/providers/factory', () => ({
  configuredProviders: jest.fn().mockReturnValue(['anthropic']),
}))

/**
 * Standard Red Notes: the gateway-LOCAL /v1/admin/server-status endpoint. The
 * proxied /v1/admin routes are pass-throughs gated inside the auth server (see
 * BaseAdminController.spec.ts); this endpoint is the one gateway-side admin op,
 * so its role gate and degraded-fields behaviour are covered here.
 */
describe('AdminController server-status', () => {
  let serviceProxy: ServiceProxyInterface
  let endpointResolver: EndpointResolverInterface
  let updateCheckService: UpdateCheckService
  let redis: { ping: jest.Mock }
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  const makeController = (options: { withRedis?: boolean } = {}) =>
    new AdminController(
      serviceProxy,
      endpointResolver,
      true,
      false,
      updateCheckService,
      {} as AssistantProviderConfig,
      // No auth server url in the unit test => auth readiness degrades to
      // { reachable: false } without any network I/O.
      '',
      options.withRedis === false ? undefined : (redis as never),
    )

  const responseWith = (roles: Array<{ name: string }>): Response => {
    jsonMock = jest.fn()
    statusMock = jest.fn(() => ({ json: jsonMock }))
    return {
      locals: { user: { uuid: 'admin-1' }, roles },
      status: statusMock,
      json: jsonMock,
    } as unknown as Response
  }

  beforeEach(() => {
    serviceProxy = {} as jest.Mocked<ServiceProxyInterface>
    endpointResolver = {} as jest.Mocked<EndpointResolverInterface>

    updateCheckService = {
      getStatus: jest.fn().mockResolvedValue({ configured: true, currentVersion: '1.2.3' }),
    } as unknown as UpdateCheckService

    redis = { ping: jest.fn().mockResolvedValue('PONG') }
  })

  it('rejects a non-admin requestor with 403 — NOT 401, which clients treat as an invalid session', async () => {
    const response = responseWith([{ name: RoleName.NAMES.CoreUser }])

    await makeController().getServerStatus({} as Request, response)

    expect(statusMock).toHaveBeenCalledWith(403)
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ error: expect.anything() }))
    expect(redis.ping).not.toHaveBeenCalled()
  })

  it('returns master switches and health states for an admin requestor', async () => {
    const response = responseWith([{ name: RoleName.NAMES.InternalTeamUser }])

    await makeController().getServerStatus({} as Request, response)

    expect(jsonMock).toHaveBeenCalledWith({
      masterSwitches: {
        ocrServerEnabled: true,
        workflowsEnabled: false,
        assistantConfigured: true,
        assistantProviders: ['anthropic'],
        updateCheckConfigured: true,
        currentVersion: '1.2.3',
      },
      health: {
        gateway: { redis: true },
        auth: { reachable: false },
      },
    })
  })

  it('reports gateway redis as null (not configured) when no redis is bound', async () => {
    const response = responseWith([{ name: RoleName.NAMES.InternalTeamUser }])

    await makeController({ withRedis: false }).getServerStatus({} as Request, response)

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ health: expect.objectContaining({ gateway: { redis: null } }) }),
    )
  })

  it('reports gateway redis as unhealthy when the ping fails', async () => {
    redis.ping = jest.fn().mockRejectedValue(new Error('down'))
    const response = responseWith([{ name: RoleName.NAMES.InternalTeamUser }])

    await makeController().getServerStatus({} as Request, response)

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ health: expect.objectContaining({ gateway: { redis: false } }) }),
    )
  })
})
