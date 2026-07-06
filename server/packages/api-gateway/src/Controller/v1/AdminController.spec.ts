import 'reflect-metadata'

import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Request, Response } from 'express'
import { RoleName } from '@standardnotes/domain-core'

import { AdminController, ReadinessFetchLike, ServiceStatusEntry } from './AdminController'
import { AssistantProviderConfig } from '../../Service/Assistant/providers/factory'
import { ServiceProxyInterface } from '../../Service/Proxy/ServiceProxyInterface'
import { EndpointResolverInterface } from '../../Service/Resolver/EndpointResolverInterface'
import { UpdateCheckService } from '../../Service/Updates/UpdateCheckService'
import { AdminLogsService } from '../../Service/AdminLogs/AdminLogsService'
import {
  DEFAULT_EMAIL_CONFIRMATION_BODY,
  DEFAULT_EMAIL_CONFIRMATION_SUBJECT,
  ServerSettingsResolver,
} from '../../Service/ServerSettings/ServerSettingsResolver'
import { ServerSettingsStore } from '../../Service/ServerSettings/ServerSettingsStore'

const confirmationDefaults = {
  emailConfirmationEnabled: false,
  emailConfirmationGating: 'block_signin' as const,
  emailConfirmationSubject: DEFAULT_EMAIL_CONFIRMATION_SUBJECT,
  emailConfirmationBody: DEFAULT_EMAIL_CONFIRMATION_BODY,
  emailConfirmationBaseUrl: '',
}

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

  const makeController = (
    options: {
      withRedis?: boolean
      adminLogsService?: AdminLogsService
      filesServerUrl?: string
      serviceProbeUrls?: Record<string, string>
      serverSettingsResolver?: ServerSettingsResolver
      logger?: { info: jest.Mock }
    } = {},
  ) =>
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
      options.filesServerUrl,
      undefined,
      undefined,
      options.adminLogsService,
      options.serviceProbeUrls,
      options.serverSettingsResolver,
      options.logger,
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
    const response = responseWith([{ name: RoleName.NAMES.AdminUser }])

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
    const response = responseWith([{ name: RoleName.NAMES.AdminUser }])

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
    const response = responseWith([{ name: RoleName.NAMES.AdminUser }])

    await makeController({ withRedis: false }).getServerStatus({} as Request, response)

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ health: expect.objectContaining({ gateway: { redis: null } }) }),
    )
  })

  it('reports gateway redis as unhealthy when the ping fails', async () => {
    redis.ping = jest.fn().mockRejectedValue(new Error('down'))
    const response = responseWith([{ name: RoleName.NAMES.AdminUser }])

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
    const response = responseWith([{ name: RoleName.NAMES.AdminUser }])

    await makeController().getLogs({ query: {} } as unknown as Request, response)

    expect(jsonMock).toHaveBeenCalledWith({ entries: [], truncated: false })
  })

  it('clamps the logs limit to the 500 max and forwards the service/level filters', async () => {
    const tail = jest.fn().mockResolvedValue({ entries: [{ message: 'x' }], truncated: true })
    const response = responseWith([{ name: RoleName.NAMES.AdminUser }])

    await makeController({ adminLogsService: { tail } as unknown as AdminLogsService }).getLogs(
      { query: { limit: '9999', service: 'auth', level: 'error' } } as unknown as Request,
      response,
    )

    expect(tail).toHaveBeenCalledWith({ limit: 500, service: 'auth', level: 'error' })
    expect(jsonMock).toHaveBeenCalledWith({ entries: [{ message: 'x' }], truncated: true })
  })

  describe('service probe URL resolution', () => {
    type ProbeSpyTarget = {
      probeServiceReadiness: (name: string, url?: string, fetchFn?: ReadinessFetchLike) => Promise<ServiceStatusEntry>
      probeAuthReadiness: (fetchFn?: ReadinessFetchLike) => Promise<{ reachable: boolean }>
    }

    const singleContainerProbeUrls = {
      'syncing-server': 'http://localhost:3101',
      auth: 'http://localhost:3103',
      files: 'http://localhost:3104',
      revisions: 'http://localhost:3105',
    }

    it('probes each service at its internal probe URL — the map WINS over the (public) files URL', async () => {
      const controller = makeController({
        serviceProbeUrls: singleContainerProbeUrls,
        // The env FILES_SERVER_URL is the PUBLIC files URL in this fork's
        // entrypoint; it must NOT be used as the probe target.
        filesServerUrl: 'http://localhost:3001/files',
      })
      const probeSpy = jest
        .spyOn(controller as unknown as ProbeSpyTarget, 'probeServiceReadiness')
        .mockImplementation(async (name: string) => ({ name, reachable: true, status: 'ok' }))
      jest
        .spyOn(controller as unknown as ProbeSpyTarget, 'probeAuthReadiness')
        .mockResolvedValue({ reachable: true })

      await controller.getServerStatus({} as Request, responseWith([{ name: RoleName.NAMES.AdminUser }]))

      const probed = Object.fromEntries(probeSpy.mock.calls.map((call) => [call[0], call[1]]))
      expect(probed).toEqual({
        'syncing-server': 'http://localhost:3101',
        files: 'http://localhost:3104',
        revisions: 'http://localhost:3105',
        // Not in the map and no env URL => stays unset (reports 'unknown').
        'websocket-gateway': undefined,
      })
    })

    it('probes the auth readiness at the mapped internal URL even when AUTH_SERVER_URL is unset', async () => {
      const controller = makeController({ serviceProbeUrls: singleContainerProbeUrls })
      const fetchFn = jest
        .fn()
        .mockResolvedValue({ status: 200, json: async () => ({ status: 'ready', checks: { db: true } }) })

      const result = await (controller as unknown as ProbeSpyTarget).probeAuthReadiness(fetchFn)

      expect(fetchFn).toHaveBeenCalledWith('http://localhost:3103/healthcheck/readiness', expect.anything())
      expect(result).toEqual({ reachable: true, status: 'ready', checks: { db: true }, responseTimeMs: expect.any(Number) })
    })

    it('treats a 404 readiness as "fall back to liveness": /healthcheck 200 => ok (liveness only)', async () => {
      const controller = makeController()
      const fetchFn = jest
        .fn()
        .mockResolvedValueOnce({ status: 404, json: async () => ({}) })
        .mockResolvedValueOnce({ status: 200, json: async () => ({}) })

      const entry = await (controller as unknown as ProbeSpyTarget).probeServiceReadiness(
        'revisions',
        'http://localhost:3105',
        fetchFn,
      )

      expect(fetchFn).toHaveBeenNthCalledWith(1, 'http://localhost:3105/healthcheck/readiness', expect.anything())
      expect(fetchFn).toHaveBeenNthCalledWith(2, 'http://localhost:3105/healthcheck', expect.anything())
      expect(entry).toEqual({
        name: 'revisions',
        reachable: true,
        status: 'ok',
        detail: 'liveness only',
        responseTimeMs: expect.any(Number),
      })
    })

    it('still reports down when both readiness (404) and liveness fail', async () => {
      const controller = makeController()
      const fetchFn = jest
        .fn()
        .mockResolvedValueOnce({ status: 404, json: async () => ({}) })
        .mockResolvedValueOnce({ status: 500, json: async () => ({}) })

      const entry = await (controller as unknown as ProbeSpyTarget).probeServiceReadiness(
        'revisions',
        'http://localhost:3105',
        fetchFn,
      )

      expect(entry).toMatchObject({ name: 'revisions', reachable: true, status: 'down' })
    })

    it('includes a per-service response time (ms) on the readiness entry (task #66)', async () => {
      const controller = makeController()
      const fetchFn = jest.fn().mockResolvedValue({ status: 200, json: async () => ({}) })

      const entry = await (controller as unknown as ProbeSpyTarget).probeServiceReadiness(
        'syncing-server',
        'http://localhost:3101',
        fetchFn,
      )

      expect(entry).toMatchObject({ name: 'syncing-server', reachable: true, status: 'ok' })
      expect(typeof (entry as { responseTimeMs?: number }).responseTimeMs).toBe('number')
      expect((entry as { responseTimeMs: number }).responseTimeMs).toBeGreaterThanOrEqual(0)
    })

    it('omits response time for a "not configured" service (no probe ran)', async () => {
      const controller = makeController()
      const entry = await (controller as unknown as ProbeSpyTarget).probeServiceReadiness('files', undefined)
      expect(entry).toEqual({ name: 'files', reachable: false, status: 'unknown', detail: 'not configured' })
      expect((entry as { responseTimeMs?: number }).responseTimeMs).toBeUndefined()
    })

    it('times the auth readiness probe too', async () => {
      const controller = makeController({ serviceProbeUrls: singleContainerProbeUrls })
      const fetchFn = jest.fn().mockResolvedValue({ status: 200, json: async () => ({ status: 'ready', checks: {} }) })

      const result = await (controller as unknown as ProbeSpyTarget).probeAuthReadiness(fetchFn)

      expect(typeof (result as { responseTimeMs?: number }).responseTimeMs).toBe('number')
    })
  })

  describe('server-settings routes', () => {
    let dir: string
    let resolver: ServerSettingsResolver
    let logger: { info: jest.Mock }

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-admin-settings-'))
      resolver = new ServerSettingsResolver(new ServerSettingsStore(path.join(dir, 'server-settings.json')), {
        assistant: { openaiApiKey: 'env-openai-key' },
        updateCheckUrl: 'https://env.update.example.com',
      })
      logger = { info: jest.fn() }
    })

    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true })
    })

    const settingsController = () => makeController({ serverSettingsResolver: resolver, logger })

    it('rejects a non-admin requestor with 403 on both GET and PUT', async () => {
      await settingsController().getServerSettings({} as Request, responseWith([{ name: RoleName.NAMES.CoreUser }]))
      expect(statusMock).toHaveBeenCalledWith(403)

      await settingsController().setServerSettings(
        { body: { ai: { anthropicApiKey: 'x' } } } as unknown as Request,
        responseWith([{ name: RoleName.NAMES.CoreUser }]),
      )
      expect(statusMock).toHaveBeenCalledWith(403)
      expect((await resolver.resolveAssistantConfig()).anthropicApiKey).toBeUndefined()
    })

    it('degrades to 503 when the resolver is not wired', async () => {
      await makeController().getServerSettings({} as Request, responseWith([{ name: RoleName.NAMES.AdminUser }]))
      expect(statusMock).toHaveBeenCalledWith(503)
    })

    it('GET returns the masked view (configured booleans, NEVER key material) with sources', async () => {
      await resolver.applyPatch({ ai: { anthropicApiKey: 'persisted-secret' } })

      await settingsController().getServerSettings({} as Request, responseWith([{ name: RoleName.NAMES.AdminUser }]))

      const payload = jsonMock.mock.calls[0][0]
      expect(JSON.stringify(payload)).not.toContain('persisted-secret')
      expect(JSON.stringify(payload)).not.toContain('env-openai-key')
      expect(payload.settings.ai).toMatchObject({ anthropicConfigured: true, openaiConfigured: true })
      expect(payload.sources).toMatchObject({
        'ai.anthropicApiKey': 'persisted',
        'ai.openaiApiKey': 'env',
        'updateCheck.url': 'env',
        'nextcloudBackups.enabled': 'default',
      })
    })

    it('PUT validates: bad URL, negative limit, empty key and empty body are 400s that persist nothing', async () => {
      const cases = [
        { updateCheck: { url: 'not-a-url' } },
        { ai: { openaiBaseUrl: 'ftp://nope.example.com' } },
        { ai: { dailyRequestLimit: -1 } },
        { ai: { dailyRequestLimit: 1.5 } },
        { ai: { anthropicApiKey: '' } },
        { nextcloudBackups: { enabled: 'yes' } },
        {},
      ]
      for (const body of cases) {
        await settingsController().setServerSettings(
          { body } as unknown as Request,
          responseWith([{ name: RoleName.NAMES.AdminUser }]),
        )
        expect(statusMock).toHaveBeenCalledWith(400)
      }
      expect(await resolver.resolveUpdateCheckUrl()).toEqual('https://env.update.example.com')
      expect(logger.info).not.toHaveBeenCalled()
    })

    it('PUT persists a partial patch (persisted WINS over env), audit-logs NAMES only, and returns the view', async () => {
      await settingsController().setServerSettings(
        {
          body: {
            ai: { anthropicApiKey: 'sk-new-secret', dailyRequestLimit: 25 },
            updateCheck: { url: 'https://persisted.update.example.com' },
            nextcloudBackups: { enabled: true },
          },
        } as unknown as Request,
        responseWith([{ name: RoleName.NAMES.AdminUser }]),
      )

      // Precedence: the persisted values now win over env on the next resolve.
      expect((await resolver.resolveAssistantConfig()).anthropicApiKey).toEqual('sk-new-secret')
      expect(await resolver.resolveUpdateCheckUrl()).toEqual('https://persisted.update.example.com')
      expect(await resolver.resolveNextcloudBackupsEnabled()).toBe(true)

      // Audit line: setting NAMES only — never values.
      expect(logger.info).toHaveBeenCalledWith(
        'admin server-settings updated',
        expect.objectContaining({
          audit: 'admin.server-settings.update',
          adminUuid: 'admin-1',
          changedSettings: ['ai.anthropicApiKey', 'ai.dailyRequestLimit', 'updateCheck.url', 'nextcloudBackups.enabled'],
        }),
      )
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain('sk-new-secret')

      // The response is the masked GET view.
      const payload = jsonMock.mock.calls[0][0]
      expect(JSON.stringify(payload)).not.toContain('sk-new-secret')
      expect(payload.settings.ai).toMatchObject({ anthropicConfigured: true, dailyRequestLimit: 25 })
      expect(payload.settings.updateCheck).toEqual({ url: 'https://persisted.update.example.com' })
      expect(payload.settings.nextcloudBackups).toEqual({ enabled: true })
    })

    it('PUT validates the registration policy: bad role, bad mode and bad list are 400s that persist nothing', async () => {
      const cases = [
        { registration: { defaultRole: 'ADMIN_USER' } },
        { registration: { defaultRole: 'NOT_A_ROLE' } },
        { registration: { domainMode: 'sometimes' } },
        { registration: { domainList: 'example.com' } },
        { registration: { domainList: [1, 2] } },
      ]
      for (const body of cases) {
        await settingsController().setServerSettings(
          { body } as unknown as Request,
          responseWith([{ name: RoleName.NAMES.AdminUser }]),
        )
        expect(statusMock).toHaveBeenCalledWith(400)
      }
      expect((await resolver.resolveRegistrationConfig()).defaultRole).toEqual('CORE_USER')
    })

    it('PUT persists the registration policy (normalizing the domain list) and auth resolves it', async () => {
      await settingsController().setServerSettings(
        {
          body: {
            registration: {
              defaultRole: 'PRO_USER',
              domainMode: 'allowlist',
              domainList: ['Company.com', 'company.com', '@partner.com'],
            },
          },
        } as unknown as Request,
        responseWith([{ name: RoleName.NAMES.AdminUser }]),
      )

      expect(await resolver.resolveRegistrationConfig()).toEqual({
        defaultRole: 'PRO_USER',
        domainMode: 'allowlist',
        domainList: ['company.com', 'partner.com'],
        ...confirmationDefaults,
      })
      expect(logger.info).toHaveBeenCalledWith(
        'admin server-settings updated',
        expect.objectContaining({
          changedSettings: ['registration.defaultRole', 'registration.domainMode', 'registration.domainList'],
        }),
      )
    })

    it('PUT persists email confirmation settings and rejects a bad gating mode / base URL', async () => {
      // Bad gating + bad base URL must 400 and persist nothing.
      for (const bad of [
        { registration: { emailConfirmationGating: 'nope' } },
        { registration: { emailConfirmationBaseUrl: 'notaurl' } },
      ]) {
        statusMock.mockClear()
        await settingsController().setServerSettings(
          { body: bad } as unknown as Request,
          responseWith([{ name: RoleName.NAMES.AdminUser }]),
        )
        expect(statusMock).toHaveBeenCalledWith(400)
      }
      expect((await resolver.resolveRegistrationConfig()).emailConfirmationEnabled).toBe(false)

      // A valid payload persists and auth resolves it.
      await settingsController().setServerSettings(
        {
          body: {
            registration: {
              emailConfirmationEnabled: true,
              emailConfirmationGating: 'warn',
              emailConfirmationBaseUrl: 'https://notes.example.com',
              emailConfirmationSubject: 'Verify',
            },
          },
        } as unknown as Request,
        responseWith([{ name: RoleName.NAMES.AdminUser }]),
      )
      const resolved = await resolver.resolveRegistrationConfig()
      expect(resolved.emailConfirmationEnabled).toBe(true)
      expect(resolved.emailConfirmationGating).toBe('warn')
      expect(resolved.emailConfirmationBaseUrl).toBe('https://notes.example.com')
      expect(resolved.emailConfirmationSubject).toBe('Verify')
    })

    it('PUT with an explicit null CLEARS the persisted override (source falls back to env)', async () => {
      await resolver.applyPatch({ updateCheck: { url: 'https://persisted.update.example.com' } })

      await settingsController().setServerSettings(
        { body: { updateCheck: { url: null } } } as unknown as Request,
        responseWith([{ name: RoleName.NAMES.AdminUser }]),
      )

      expect(await resolver.resolveUpdateCheckUrl()).toEqual('https://env.update.example.com')
      const payload = jsonMock.mock.calls[0][0]
      expect(payload.sources['updateCheck.url']).toEqual('env')
    })

    it('PUT accepts valid proof-of-work settings, persists them, and audit-logs the NAMES', async () => {
      await settingsController().setServerSettings(
        {
          body: {
            security: {
              proofOfWork: {
                registerEnabled: true,
                registerDifficulty: 12,
                signInEnabled: true,
                signInMode: 'adaptive',
                signInDifficulty: 16,
                signInAdaptiveThreshold: 3,
              },
            },
          },
        } as unknown as Request,
        responseWith([{ name: RoleName.NAMES.AdminUser }]),
      )

      const config = await resolver.resolveProofOfWorkConfig()
      expect(config).toEqual({
        registerEnabled: true,
        registerDifficulty: 12,
        signInEnabled: true,
        signInMode: 'adaptive',
        signInDifficulty: 16,
        signInAdaptiveThreshold: 3,
      })
      expect(logger.info).toHaveBeenCalledWith(
        'admin server-settings updated',
        expect.objectContaining({
          audit: 'admin.server-settings.update',
          changedSettings: expect.arrayContaining([
            'security.proofOfWork.registerEnabled',
            'security.proofOfWork.registerDifficulty',
            'security.proofOfWork.signInMode',
            'security.proofOfWork.signInAdaptiveThreshold',
          ]),
        }),
      )
      const payload = jsonMock.mock.calls[0][0]
      expect(payload.settings.security.proofOfWork.signInDifficulty).toBe(16)
      expect(payload.sources['security.proofOfWork.signInMode']).toBe('persisted')
    })

    it('PUT rejects out-of-range difficulty and a bad signInMode as 400s that persist nothing', async () => {
      const cases = [
        { security: { proofOfWork: { registerDifficulty: 33 } } },
        { security: { proofOfWork: { signInDifficulty: -1 } } },
        { security: { proofOfWork: { signInAdaptiveThreshold: 101 } } },
        { security: { proofOfWork: { registerDifficulty: 4.5 } } },
        { security: { proofOfWork: { signInMode: 'sometimes' } } },
        { security: { proofOfWork: { registerEnabled: 'yes' } } },
      ]
      for (const body of cases) {
        await settingsController().setServerSettings(
          { body } as unknown as Request,
          responseWith([{ name: RoleName.NAMES.AdminUser }]),
        )
        expect(statusMock).toHaveBeenCalledWith(400)
      }
      // Nothing persisted — the resolver still returns the hardcoded defaults.
      expect(await resolver.resolveProofOfWorkConfig()).toMatchObject({ registerDifficulty: 12, signInMode: 'adaptive' })
      expect(logger.info).not.toHaveBeenCalled()
    })
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

/**
 * Standard Red Notes: the gateway-LOCAL anti-abuse admin surface — the live view
 * plus the four IP-list mutations. Admin-gated + audited on mutations, validated
 * (only a valid IP/CIDR is ever stored), and degrading to 503 when the Redis-
 * backed store is not bound.
 */
describe('AdminController anti-abuse', () => {
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  const buildController = (
    ipAccessListStore?: unknown,
    rateLimitMetricsStore?: unknown,
    serverSettingsResolver?: ServerSettingsResolver,
    logger?: { info: jest.Mock },
  ): AdminController =>
    new AdminController(
      {} as ServiceProxyInterface,
      {} as EndpointResolverInterface,
      undefined,
      undefined,
      undefined,
      undefined,
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      serverSettingsResolver,
      logger as never,
      undefined,
      ipAccessListStore as never,
      rateLimitMetricsStore as never,
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

  const admin = [{ name: RoleName.NAMES.AdminUser }]
  const nonAdmin = [{ name: RoleName.NAMES.CoreUser }]

  it('rejects a non-admin with 403 on the view', async () => {
    await buildController().getAntiAbuse({} as Request, responseWith(nonAdmin))
    expect(statusMock).toHaveBeenCalledWith(403)
  })

  it('returns config + lists + metrics for an admin, degrading when the store is absent', async () => {
    const resolver = { resolveRateLimitConfig: jest.fn().mockResolvedValue({ enabled: true, loginMax: 10 }) }
    const response = responseWith(admin)
    await buildController(undefined, undefined, resolver as unknown as ServerSettingsResolver).getAntiAbuse(
      {} as Request,
      response,
    )
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        available: false,
        config: { enabled: true, loginMax: 10 },
        ipLists: { allow: [], block: [] },
        metrics: { tierHits: {}, blockHits: 0, recent: [] },
      }),
    )
  })

  it('blocks an IP, validates it, and audits the mutation', async () => {
    const store = {
      add: jest.fn().mockResolvedValue({ ok: true, value: '10.0.0.0/8' }),
      remove: jest.fn(),
      list: jest.fn().mockResolvedValue([]),
    }
    const logger = { info: jest.fn() }
    const response = responseWith(admin)
    const request = { body: { entry: ' 10.0.0.0/8 ' } } as unknown as Request
    await buildController(store, undefined, undefined, logger).blockIp(request, response)

    expect(store.add).toHaveBeenCalledWith('block', ' 10.0.0.0/8 ')
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ list: 'block', action: 'add', entry: '10.0.0.0/8' }),
    )
    expect(logger.info).toHaveBeenCalledWith(
      'admin anti-abuse ip-list update',
      expect.objectContaining({ audit: 'admin.anti-abuse.ip-list', list: 'block', action: 'add', entry: '10.0.0.0/8' }),
    )
  })

  it('rejects an invalid IP entry with 400', async () => {
    const store = {
      add: jest.fn().mockResolvedValue({ ok: false, error: '"bad" is not a valid IP or CIDR.' }),
      remove: jest.fn(),
      list: jest.fn().mockResolvedValue([]),
    }
    const response = responseWith(admin)
    await buildController(store).blockIp({ body: { entry: 'bad' } } as unknown as Request, response)
    expect(statusMock).toHaveBeenCalledWith(400)
  })

  it('requires a non-empty entry', async () => {
    const store = { add: jest.fn(), remove: jest.fn(), list: jest.fn() }
    const response = responseWith(admin)
    await buildController(store).allowIp({ body: {} } as unknown as Request, response)
    expect(statusMock).toHaveBeenCalledWith(400)
    expect(store.add).not.toHaveBeenCalled()
  })

  it('returns 503 for a mutation when the store is not bound', async () => {
    const response = responseWith(admin)
    await buildController().unblockIp({ body: { entry: '1.2.3.4' } } as unknown as Request, response)
    expect(statusMock).toHaveBeenCalledWith(503)
  })
})

/**
 * Standard Red Notes: the OPT-IN, OFF-BY-DEFAULT container-restart surface (Redis
 * cache + MariaDB via the locked-down docker-socket-proxy). Admin-gated + audited
 * + allowlisted; degrades to 503 when disabled/unreachable — never a 500.
 */
describe('AdminController container-restart (docker)', () => {
  let jsonMock: jest.Mock
  let statusMock: jest.Mock

  // The docker service is the LAST constructor arg; everything between is left
  // undefined so the controller degrades all other surfaces gracefully.
  const buildController = (
    docker?: unknown,
    logger?: { info: jest.Mock },
  ): AdminController =>
    new AdminController(
      {} as ServiceProxyInterface,
      {} as EndpointResolverInterface,
      undefined,
      undefined,
      undefined,
      undefined,
      '',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      logger as never,
      undefined,
      undefined,
      undefined,
      docker as never,
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

  const admin = [{ name: RoleName.NAMES.AdminUser }]
  const nonAdmin = [{ name: RoleName.NAMES.CoreUser }]

  const enabledDocker = (overrides: Record<string, unknown> = {}) => ({
    isEnabled: jest.fn().mockReturnValue(true),
    isAvailable: jest.fn().mockResolvedValue(true),
    isAllowed: jest.fn((name: string) => name === 'cache' || name === 'db'),
    getAllowedContainers: jest.fn().mockReturnValue(['cache', 'db']),
    restart: jest.fn().mockResolvedValue({ kind: 'ok', container: 'cache', name: 'srn-cache-1' }),
    ...overrides,
  })

  it('rejects a non-admin with 403 and never touches docker', async () => {
    const docker = enabledDocker()
    await buildController(docker).restartContainer({ params: { name: 'cache' } } as unknown as Request, responseWith(nonAdmin))
    expect(statusMock).toHaveBeenCalledWith(403)
    expect(docker.restart).not.toHaveBeenCalled()
  })

  it('returns 503 (disabled) when the capability is OFF by default (service unbound)', async () => {
    await buildController(undefined).restartContainer(
      { params: { name: 'cache' } } as unknown as Request,
      responseWith(admin),
    )
    expect(statusMock).toHaveBeenCalledWith(503)
  })

  it('returns 503 (disabled) when the service is bound but not enabled', async () => {
    const docker = enabledDocker({ isEnabled: jest.fn().mockReturnValue(false) })
    await buildController(docker).restartContainer(
      { params: { name: 'cache' } } as unknown as Request,
      responseWith(admin),
    )
    expect(statusMock).toHaveBeenCalledWith(503)
    expect(docker.restart).not.toHaveBeenCalled()
  })

  it('rejects a non-allowlisted container with 400 BEFORE any restart call (injection-safe)', async () => {
    const docker = enabledDocker()
    const logger = { info: jest.fn() }
    for (const evil of ['server', 'cache; rm -rf /', '$(whoami)']) {
      await buildController(docker, logger).restartContainer(
        { params: { name: evil } } as unknown as Request,
        responseWith(admin),
      )
      expect(statusMock).toHaveBeenCalledWith(400)
    }
    expect(docker.restart).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      'admin container-control',
      expect.objectContaining({ audit: 'admin.container-control', outcome: 'invalid-container', action: 'restart' }),
    )
  })

  it('restarts an allowlisted container and audits the attempt', async () => {
    const docker = enabledDocker()
    const logger = { info: jest.fn() }
    await buildController(docker, logger).restartContainer(
      { params: { name: 'cache' } } as unknown as Request,
      responseWith(admin),
    )
    expect(docker.restart).toHaveBeenCalledWith('cache')
    expect(jsonMock).toHaveBeenCalledWith({ container: 'cache', action: 'restart', status: 'restarting' })
    expect(logger.info).toHaveBeenCalledWith(
      'admin container-control',
      expect.objectContaining({ audit: 'admin.container-control', container: 'cache', outcome: 'ok' }),
    )
  })

  it('degrades to 503 when the proxy is unreachable (unavailable outcome)', async () => {
    const docker = enabledDocker({
      restart: jest.fn().mockResolvedValue({ kind: 'unavailable', message: 'proxy unreachable' }),
    })
    await buildController(docker).restartContainer(
      { params: { name: 'db' } } as unknown as Request,
      responseWith(admin),
    )
    expect(statusMock).toHaveBeenCalledWith(503)
  })

  it('surfaces a docker error (e.g. no such container) as 502', async () => {
    const docker = enabledDocker({
      restart: jest.fn().mockResolvedValue({ kind: 'error', container: 'db', message: 'No such container' }),
    })
    await buildController(docker).restartContainer(
      { params: { name: 'db' } } as unknown as Request,
      responseWith(admin),
    )
    expect(statusMock).toHaveBeenCalledWith(502)
  })

  it('reports the docker capability block in GET /services (enabled + available + allowlist)', async () => {
    const docker = enabledDocker()
    await buildController(docker).listControllableServices({} as Request, responseWith(admin))
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ docker: { enabled: true, available: true, containers: ['cache', 'db'] } }),
    )
  })

  it('reports docker disabled in GET /services when the capability is off (default)', async () => {
    await buildController(undefined).listControllableServices({} as Request, responseWith(admin))
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ docker: { enabled: false, available: false, containers: [] } }),
    )
  })
})
