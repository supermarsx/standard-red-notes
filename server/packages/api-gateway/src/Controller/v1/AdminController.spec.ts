import 'reflect-metadata'

import { Request, Response } from 'express'
import { RoleName } from '@standardnotes/domain-core'

import { AdminController } from './AdminController'
import { AssistantProviderConfig } from '../../Service/Assistant/providers/factory'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'
import { UpdateCheckService } from '../../Service/Updates/UpdateCheckService'
import { AdminLogsService } from '../../Service/AdminLogs/AdminLogsService'

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

  const makeController = (options: { withRedis?: boolean; adminLogsService?: AdminLogsService } = {}) =>
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
      // No backend service URLs in the unit test => each service degrades to
      // { reachable: false, status: 'unknown', detail: 'not configured' }.
      undefined,
      undefined,
      undefined,
      undefined,
      options.adminLogsService,
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

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
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
      }),
    )
  })

  it('reports a services array covering EVERY service, degrading per field (never 5xx)', async () => {
    const response = responseWith([{ name: RoleName.NAMES.InternalTeamUser }])

    await makeController().getServerStatus({} as Request, response)

    const payload = jsonMock.mock.calls[0][0] as {
      services: Array<{ name: string; reachable: boolean; status: string; detail?: string }>
    }

    const byName = Object.fromEntries(payload.services.map((service) => [service.name, service]))

    // The gateway answers, so it is always ok.
    expect(byName['api-gateway']).toMatchObject({ reachable: true, status: 'ok' })
    // No auth URL wired in the unit test => auth is down (unreachable).
    expect(byName['auth']).toMatchObject({ reachable: false, status: 'down' })
    // No backend URLs wired => 'unknown' (not configured), never a throw/5xx.
    for (const name of ['syncing-server', 'files', 'revisions', 'websocket-gateway']) {
      expect(byName[name]).toMatchObject({ reachable: false, status: 'unknown', detail: 'not configured' })
    }
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

  it('rejects a non-admin requestor for logs with 403 and never reads any logs', async () => {
    const tail = jest.fn()
    const response = responseWith([{ name: RoleName.NAMES.CoreUser }])

    await makeController({ adminLogsService: { tail } as unknown as AdminLogsService }).getLogs(
      { query: {} } as unknown as Request,
      response,
    )

    expect(statusMock).toHaveBeenCalledWith(403)
    expect(tail).not.toHaveBeenCalled()
  })

  it('degrades to an empty result when the logs service is not wired', async () => {
    const response = responseWith([{ name: RoleName.NAMES.InternalTeamUser }])

    await makeController().getLogs({ query: {} } as unknown as Request, response)

    expect(jsonMock).toHaveBeenCalledWith({ entries: [], truncated: false })
  })

  it('clamps the logs limit to the 500 max and forwards the service/level filters', async () => {
    const tail = jest.fn().mockResolvedValue({ entries: [{ message: 'x' }], truncated: true })
    const response = responseWith([{ name: RoleName.NAMES.InternalTeamUser }])

    await makeController({ adminLogsService: { tail } as unknown as AdminLogsService }).getLogs(
      { query: { limit: '9999', service: 'auth', level: 'error' } } as unknown as Request,
      response,
    )

    expect(tail).toHaveBeenCalledWith({ limit: 500, service: 'auth', level: 'error' })
    expect(jsonMock).toHaveBeenCalledWith({ entries: [{ message: 'x' }], truncated: true })
  })
})

describe('AdminLogsService', () => {
  const makeService = (files: Record<string, string>) => {
    const fileSystem = {
      readdir: jest.fn().mockResolvedValue(Object.keys(files)),
      readFile: jest.fn((filePath: string) => {
        const name = filePath.split(/[/\\]/).pop() as string

        return Promise.resolve(files[name])
      }),
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AdminLogsService: Service } = require('../../Service/AdminLogs/AdminLogsService')

    return new Service('/var/lib/server/logs', fileSystem)
  }

  it('parses winston JSON lines and infers service from the file name for plain lines', async () => {
    const service = makeService({
      'auth.log': '{"level":"info","message":"started","service":"auth","timestamp":"2026-07-02T10:00:00.000Z"}',
      'files.err': 'plain crash line',
    })

    const result = await service.tail({ limit: 100 })

    const auth = result.entries.find((entry: { service: string | null }) => entry.service === 'auth')
    expect(auth).toMatchObject({ level: 'info', message: 'started', service: 'auth' })

    const files = result.entries.find((entry: { message: string }) => entry.message === 'plain crash line')
    expect(files).toMatchObject({ timestamp: null, level: null, service: 'files', message: 'plain crash line' })
  })

  it('filters by level and caps at the limit, reporting truncated', async () => {
    const lines = Array.from({ length: 5 }, (_unused, index) =>
      JSON.stringify({ level: index % 2 === 0 ? 'error' : 'info', message: `m${index}`, service: 'auth' }),
    ).join('\n')

    const service = makeService({ 'auth.log': lines })

    const result = await service.tail({ limit: 2, level: 'error' })

    expect(result.entries).toHaveLength(2)
    expect(result.entries.every((entry: { level: string }) => entry.level === 'error')).toBe(true)
    expect(result.truncated).toBe(true)
  })

  it('degrades to an empty result when the log directory cannot be read', async () => {
    const fileSystem = {
      readdir: jest.fn().mockRejectedValue(new Error('ENOENT')),
      readFile: jest.fn(),
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AdminLogsService: Service } = require('../../Service/AdminLogs/AdminLogsService')

    const result = await new Service('/nope', fileSystem).tail({ limit: 10 })

    expect(result).toEqual({ entries: [], truncated: false })
  })
})
