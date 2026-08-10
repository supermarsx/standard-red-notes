import 'reflect-metadata'

import {
  DEFAULT_CONTROLLABLE_PROGRAMS,
  ServiceControlService,
  SupervisorctlRunResult,
  SupervisorctlRunner,
} from './ServiceControlService'

/**
 * Standard Red Notes: unit coverage for the admin service-control service. The
 * four things that MUST hold: the allowlist is the only gate that spawns a
 * process, injection strings never reach the runner, the api-gateway program is
 * guarded, and an unusable supervisorctl fails soft (never throws / 500s).
 */
describe('ServiceControlService', () => {
  const okStatus = (program: string): SupervisorctlRunResult => ({
    stdout: `${program}                          RUNNING   pid 42, uptime 0:05:12`,
    stderr: '',
    code: 0,
  })

  const makeRunner = (): jest.MockedFunction<SupervisorctlRunner> =>
    jest.fn(async (args: string[]): Promise<SupervisorctlRunResult> => {
      // The action call resolves ok; the status read-back returns a RUNNING line.
      const program = args[args.length - 1]
      if (args.includes('status')) {
        return okStatus(program)
      }
      return { stdout: `${program}: stopped\n${program}: started`, stderr: '', code: 0 }
    })

  it('exposes the supervisord programs as its allowlist', () => {
    const service = new ServiceControlService({ runner: makeRunner() })
    expect(service.getControllablePrograms()).toEqual(DEFAULT_CONTROLLABLE_PROGRAMS)
    expect(service.isControllable('auth')).toBe(true)
    expect(service.isControllable('auth-worker')).toBe(true)
    expect(service.isControllable('nope')).toBe(false)
  })

  it('reads every allowlisted program status in one supervisorctl call', async () => {
    const stdout = DEFAULT_CONTROLLABLE_PROGRAMS.map(
      (program, index) => `${program} ${index === 1 ? 'STOPPED' : 'RUNNING'} pid 42`,
    ).join('\n')
    const runner = jest.fn(async (): Promise<SupervisorctlRunResult> => ({ stdout, stderr: '', code: 3 }))
    const service = new ServiceControlService({ runner })

    await expect(service.getProgramStatuses()).resolves.toEqual({
      available: true,
      statuses: Object.fromEntries(
        DEFAULT_CONTROLLABLE_PROGRAMS.map((program, index) => [program, index === 1 ? 'STOPPED' : 'RUNNING']),
      ),
    })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner).toHaveBeenCalledWith(['-c', '/etc/supervisord.conf', 'status'])
  })

  it('ignores non-allowlisted supervisor output and fails closed when no required status is parseable', async () => {
    const runner: SupervisorctlRunner = async () => ({
      stdout: 'unrelated RUNNING pid 99',
      stderr: '',
      code: 0,
    })

    await expect(new ServiceControlService({ runner }).getProgramStatuses()).resolves.toEqual({
      available: false,
      statuses: {},
    })
  })

  it('rejects a non-allowlisted program WITHOUT spawning anything (injection-safe)', async () => {
    const runner = makeRunner()
    const service = new ServiceControlService({ runner })

    for (const evil of ['auth; rm -rf /', 'auth && reboot', '$(whoami)', 'auth\nstop files', '']) {
      const outcome = await service.control(evil, 'restart')
      expect(outcome).toEqual({ kind: 'invalid-program', program: evil })
    }
    expect(runner).not.toHaveBeenCalled()
  })

  it('passes the program only as a discrete argv element (never a shell string)', async () => {
    const runner = makeRunner()
    const service = new ServiceControlService({ runner, configPath: '/etc/supervisord.conf' })

    await service.control('auth', 'restart')

    // First call is the action; args are an argv array with -c <config> prefixed.
    expect(runner).toHaveBeenNthCalledWith(1, ['-c', '/etc/supervisord.conf', 'restart', 'auth'])
    expect(runner).toHaveBeenNthCalledWith(2, ['-c', '/etc/supervisord.conf', 'status', 'auth'])
  })

  it('returns ok with the parsed new status on success', async () => {
    const service = new ServiceControlService({ runner: makeRunner() })
    const outcome = await service.control('auth', 'restart')
    expect(outcome).toEqual({ kind: 'ok', program: 'auth', action: 'restart', status: 'RUNNING' })
  })

  describe('api-gateway guard', () => {
    it('forbids stopping the api-gateway and never spawns', async () => {
      const runner = makeRunner()
      const service = new ServiceControlService({ runner })
      const outcome = await service.control('api-gateway', 'stop')
      expect(outcome.kind).toBe('forbidden')
      expect(runner).not.toHaveBeenCalled()
    })

    it('forbids restarting the api-gateway without confirmSelfInterrupt', async () => {
      const runner = makeRunner()
      const service = new ServiceControlService({ runner })
      const outcome = await service.control('api-gateway', 'restart')
      expect(outcome).toMatchObject({ kind: 'forbidden', requiresConfirmation: true })
      expect(runner).not.toHaveBeenCalled()
    })

    it('allows restarting the api-gateway WITH confirmSelfInterrupt', async () => {
      const runner = makeRunner()
      const service = new ServiceControlService({ runner })
      const outcome = await service.control('api-gateway', 'restart', { confirmSelfInterrupt: true })
      expect(outcome).toMatchObject({ kind: 'ok', program: 'api-gateway', action: 'restart' })
      expect(runner).toHaveBeenCalledWith(['-c', '/etc/supervisord.conf', 'restart', 'api-gateway'])
    })
  })

  describe('fail-soft when supervisorctl is unavailable', () => {
    it('degrades to unavailable when the conf lacks the supervisorctl section', async () => {
      const runner: SupervisorctlRunner = async () => ({
        stdout: '',
        stderr: 'error: .ini file does not include supervisorctl section',
        code: 2,
      })
      const service = new ServiceControlService({ runner })
      const outcome = await service.control('auth', 'restart')
      expect(outcome.kind).toBe('unavailable')
    })

    it('degrades to unavailable when the binary is missing (spawn throws ENOENT)', async () => {
      const runner: SupervisorctlRunner = async () => {
        const error = new Error('spawn supervisorctl ENOENT') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
      const service = new ServiceControlService({ runner })
      const outcome = await service.control('auth', 'restart')
      expect(outcome.kind).toBe('unavailable')

      expect(await service.isAvailable()).toBe(false)
      expect(await service.getProgramStatuses()).toEqual({ available: false, statuses: {} })
    })

    it('reports available when a plain status call succeeds', async () => {
      const service = new ServiceControlService({ runner: makeRunner() })
      expect(await service.isAvailable()).toBe(true)
    })

    it('surfaces a genuine action failure as error (not unavailable)', async () => {
      const runner: SupervisorctlRunner = async (args) => {
        if (args.includes('status')) {
          return { stdout: 'auth   FATAL   Exited too quickly', stderr: '', code: 0 }
        }
        return { stdout: '', stderr: 'auth: ERROR (abnormal termination)', code: 1 }
      }
      const service = new ServiceControlService({ runner })
      const outcome = await service.control('auth', 'start')
      expect(outcome.kind).toBe('error')
    })
  })
})
