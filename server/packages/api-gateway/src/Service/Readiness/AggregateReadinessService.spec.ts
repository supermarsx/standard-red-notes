import {
  DEFAULT_CONTROLLABLE_PROGRAMS,
  ServiceControlService,
  SupervisorctlRunner,
} from '../ServiceControl/ServiceControlService'
import { AggregateReadinessService, ReadinessFetch } from './AggregateReadinessService'
import { ReadinessState } from './ReadinessState'

describe('AggregateReadinessService', () => {
  const serviceUrls = {
    auth: 'http://auth:3000',
    'syncing-server': 'http://sync:3000',
    files: 'http://files:3000',
    revisions: 'http://revisions:3000',
  }

  const supervisor = (overrides: Record<string, string> = {}): ServiceControlService => {
    const runner: SupervisorctlRunner = async () => ({
      stdout: DEFAULT_CONTROLLABLE_PROGRAMS.map(
        (program) => `${program} ${overrides[program] ?? 'RUNNING'} pid 42`,
      ).join('\n'),
      stderr: '',
      code: Object.keys(overrides).length > 0 ? 3 : 0,
    })

    return new ServiceControlService({ runner })
  }

  const readyState = (): ReadinessState => new ReadinessState(true)
  const okFetch = jest.fn(async () => ({ status: 200 })) as jest.MockedFunction<ReadinessFetch>

  beforeEach(() => {
    okFetch.mockClear()
  })

  it('reports ready only when gateway, every backend, and every supervised worker are ready', async () => {
    const service = new AggregateReadinessService({
      homeServer: false,
      state: readyState(),
      redis: { ping: jest.fn().mockResolvedValue('PONG') },
      serviceProbeUrls: serviceUrls,
      serviceControlService: supervisor(),
      fetchFn: okFetch,
      cacheTtlMs: 0,
    })

    const report = await service.check()

    expect(report.status).toBe('ready')
    expect(report.deployment).toEqual({ revision: null, version: null })
    expect(report.checks.services).toEqual({
      auth: true,
      'syncing-server': true,
      files: true,
      revisions: true,
    })
    expect(report.checks.programs).toEqual(
      Object.fromEntries(DEFAULT_CONTROLLABLE_PROGRAMS.map((program) => [program, true])),
    )
    expect(okFetch.mock.calls.map(([url]) => url).sort()).toEqual(
      Object.values(serviceUrls)
        .map((url) => `${url}/healthcheck/readiness`)
        .sort(),
    )
  })

  it('fails closed when a required worker is not RUNNING', async () => {
    const service = new AggregateReadinessService({
      homeServer: false,
      state: readyState(),
      serviceProbeUrls: serviceUrls,
      serviceControlService: supervisor({ 'files-worker': 'FATAL' }),
      fetchFn: okFetch,
      cacheTtlMs: 0,
    })

    const report = await service.check()

    expect(report.status).toBe('unavailable')
    expect(report.checks.programs?.['files-worker']).toBe(false)
  })

  it('fails closed on an unavailable supervisor or missing required program', async () => {
    const unavailableRunner: SupervisorctlRunner = async () => ({
      stdout: '',
      stderr: 'refused connection',
      code: 2,
    })
    const missingRunner: SupervisorctlRunner = async () => ({
      stdout: DEFAULT_CONTROLLABLE_PROGRAMS.filter((program) => program !== 'auth-worker')
        .map((program) => `${program} RUNNING pid 42`)
        .join('\n'),
      stderr: '',
      code: 0,
    })

    for (const runner of [unavailableRunner, missingRunner]) {
      const report = await new AggregateReadinessService({
        homeServer: false,
        state: readyState(),
        serviceProbeUrls: serviceUrls,
        serviceControlService: new ServiceControlService({ runner }),
        fetchFn: okFetch,
        cacheTtlMs: 0,
      }).check()

      expect(report.status).toBe('unavailable')
      expect(report.checks.programs?.['auth-worker']).toBe(false)
    }
  })

  it.each([503, 404, 500])('does not fall back to liveness when backend readiness returns %s', async (status) => {
    const fetchFn: ReadinessFetch = async (url) => ({ status: url.startsWith(serviceUrls.auth) ? status : 200 })
    const report = await new AggregateReadinessService({
      homeServer: false,
      state: readyState(),
      serviceProbeUrls: serviceUrls,
      serviceControlService: supervisor(),
      fetchFn,
      cacheTtlMs: 0,
    }).check()

    expect(report.status).toBe('unavailable')
    expect(report.checks.services.auth).toBe(false)
  })

  it('uses only in-process checks in home-server mode and gates readiness on completed runtime startup', async () => {
    const state = new ReadinessState()
    const serviceControlService = supervisor()
    const controlSpy = jest.spyOn(serviceControlService, 'getProgramStatuses')
    const inProcessChecks = {
      auth: jest.fn().mockResolvedValue(undefined),
      'syncing-server': jest.fn().mockResolvedValue(undefined),
      files: jest.fn().mockResolvedValue(undefined),
      revisions: jest.fn().mockResolvedValue(undefined),
    }
    const service = new AggregateReadinessService({
      homeServer: true,
      state,
      serviceProbeUrls: serviceUrls,
      serviceControlService,
      inProcessChecks,
      fetchFn: okFetch,
      cacheTtlMs: 0,
      deploymentRevision: '0123456789abcdef0123456789abcdef01234567',
      deploymentVersion: 'v26.8.11-rc.1+linux.x64',
      deploymentMarker: {
        revision: '0123456789abcdef0123456789abcdef01234567',
        version: 'v26.8.11-rc.1+linux.x64',
      },
    })

    expect((await service.check()).status).toBe('unavailable')

    state.markReady()
    const report = await service.check()

    expect(report.status).toBe('ready')
    expect(report.deployment).toEqual({
      revision: '0123456789abcdef0123456789abcdef01234567',
      version: 'v26.8.11-rc.1+linux.x64',
    })
    expect(report.checks.programs).toBeUndefined()
    expect(okFetch).not.toHaveBeenCalled()
    expect(controlSpy).not.toHaveBeenCalled()
    expect(Object.values(inProcessChecks).every((check) => check.mock.calls.length === 2)).toBe(true)
  })

  it('fails closed when an in-process dependency check rejects', async () => {
    const report = await new AggregateReadinessService({
      homeServer: true,
      state: readyState(),
      inProcessChecks: {
        auth: async () => undefined,
        'syncing-server': async () => undefined,
        files: async () => {
          throw new Error('upload directory unavailable')
        },
        revisions: async () => undefined,
      },
      cacheTtlMs: 0,
    }).check()

    expect(report.status).toBe('unavailable')
    expect(report.checks.services.files).toBe(false)
  })

  it.each([
    ['uppercase revision', '0123456789ABCDEF0123456789abcdef01234567', '1.2.3'],
    ['short revision', '0123456789abcdef', '1.2.3'],
    ['version whitespace', '0123456789abcdef0123456789abcdef01234567', '1.2.3 release'],
    ['version control characters', '0123456789abcdef0123456789abcdef01234567', '1.2.3\nother=value'],
    ['overlong version', '0123456789abcdef0123456789abcdef01234567', `v${'1'.repeat(128)}`],
  ])('nulls invalid deployment identity: %s', async (_case, revision, version) => {
    const report = await new AggregateReadinessService({
      homeServer: true,
      state: readyState(),
      inProcessChecks: {
        auth: async () => undefined,
        'syncing-server': async () => undefined,
        files: async () => undefined,
        revisions: async () => undefined,
      },
      deploymentRevision: revision,
      deploymentVersion: version,
      deploymentMarker: {
        revision: '0123456789abcdef0123456789abcdef01234567',
        version: version === '1.2.3' ? version : null,
      },
      cacheTtlMs: 0,
    }).check()

    expect(report.status).toBe('ready')
    expect(report.deployment).toEqual({ revision: null, version: null })
  })

  it('accepts the maximum safe deployment version length in multi-process mode', async () => {
    const version = `v${'1'.repeat(127)}`
    const report = await new AggregateReadinessService({
      homeServer: false,
      state: readyState(),
      serviceProbeUrls: serviceUrls,
      serviceControlService: supervisor(),
      fetchFn: okFetch,
      deploymentRevision: 'fedcba9876543210fedcba9876543210fedcba98',
      deploymentVersion: version,
      deploymentMarker: {
        revision: 'fedcba9876543210fedcba9876543210fedcba98',
        version,
      },
      cacheTtlMs: 0,
    }).check()

    expect(report.status).toBe('ready')
    expect(report.deployment).toEqual({
      revision: 'fedcba9876543210fedcba9876543210fedcba98',
      version,
    })
  })

  it.each([
    ['missing marker', undefined],
    ['stale revision', { revision: 'fedcba9876543210fedcba9876543210fedcba98', version: 'v26.8.11' }],
    ['stale version', { revision: '0123456789abcdef0123456789abcdef01234567', version: 'v26.8.10' }],
  ])('does not report runtime deployment identity with a %s', async (_case, deploymentMarker) => {
    const report = await new AggregateReadinessService({
      homeServer: true,
      state: readyState(),
      inProcessChecks: {
        auth: async () => undefined,
        'syncing-server': async () => undefined,
        files: async () => undefined,
        revisions: async () => undefined,
      },
      deploymentRevision: '0123456789abcdef0123456789abcdef01234567',
      deploymentVersion: 'v26.8.11',
      deploymentMarker,
      cacheTtlMs: 0,
    }).check()

    expect(report.status).toBe('ready')
    expect(report.deployment).toEqual({ revision: null, version: null })
  })

  it('fails closed when a required in-process dependency check is missing', async () => {
    const report = await new AggregateReadinessService({
      homeServer: true,
      state: readyState(),
      inProcessChecks: {
        auth: async () => undefined,
        'syncing-server': async () => undefined,
        files: async () => undefined,
      },
      cacheTtlMs: 0,
    }).check()

    expect(report.status).toBe('unavailable')
    expect(report.checks.services.revisions).toBe(false)
  })

  it('fails closed when a backend readiness probe stalls', async () => {
    const fetchFn: ReadinessFetch = async (url) => {
      return url.startsWith(serviceUrls.files) ? new Promise(() => undefined) : { status: 200 }
    }
    const report = await new AggregateReadinessService({
      homeServer: false,
      state: readyState(),
      serviceProbeUrls: serviceUrls,
      serviceControlService: supervisor(),
      fetchFn,
      timeoutMs: 10,
      cacheTtlMs: 0,
    }).check()

    expect(report.status).toBe('unavailable')
    expect(report.checks.services.files).toBe(false)
  })

  it('does not cache or complete a ready report across a runtime drain transition', async () => {
    let resolveFetch!: () => void
    const pending = new Promise<void>((resolve) => {
      resolveFetch = resolve
    })
    const fetchFn = jest.fn(async () => {
      await pending
      return { status: 200 }
    }) as jest.MockedFunction<ReadinessFetch>
    const state = readyState()
    const service = new AggregateReadinessService({
      homeServer: false,
      state,
      serviceProbeUrls: serviceUrls,
      serviceControlService: supervisor(),
      fetchFn,
      cacheTtlMs: 5_000,
    })

    const inFlight = service.check()
    state.markUnavailable()
    resolveFetch()

    expect((await inFlight).status).toBe('unavailable')

    state.markReady()
    expect((await service.check()).status).toBe('ready')
    state.markUnavailable()
    expect((await service.check()).status).toBe('unavailable')
    expect(fetchFn).toHaveBeenCalledTimes(12)
  })

  it('coalesces concurrent public probes instead of amplifying internal requests', async () => {
    let resolveFetch!: () => void
    const pending = new Promise<void>((resolve) => {
      resolveFetch = resolve
    })
    const fetchFn = jest.fn(async () => {
      await pending
      return { status: 200 }
    }) as jest.MockedFunction<ReadinessFetch>
    const service = new AggregateReadinessService({
      homeServer: false,
      state: readyState(),
      serviceProbeUrls: serviceUrls,
      serviceControlService: supervisor(),
      fetchFn,
      cacheTtlMs: 0,
    })

    const first = service.check()
    const second = service.check()
    resolveFetch()
    await Promise.all([first, second])

    expect(fetchFn).toHaveBeenCalledTimes(4)
  })
})
