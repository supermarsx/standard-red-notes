import 'reflect-metadata'

import {
  DEFAULT_DOCKER_RESTARTABLE_CONTAINERS,
  DockerFetchResult,
  DockerFetchRunner,
  DockerServiceControlService,
} from './DockerServiceControlService'

/**
 * Standard Red Notes: unit coverage for the OPT-IN, locked-down docker-restart
 * path. The four things that MUST hold: it is OFF BY DEFAULT (disabled without
 * the flag + proxy URL), the allowlist is the only gate that makes an HTTP call
 * (injection-safe), an unreachable proxy degrades soft (never throws / 500s),
 * and a successful restart maps the Engine API 204.
 */
describe('DockerServiceControlService', () => {
  const ok204: DockerFetchResult = { status: 204, text: async () => '' }

  const makeRunner = (result: DockerFetchResult = ok204): jest.MockedFunction<DockerFetchRunner> =>
    jest.fn<ReturnType<DockerFetchRunner>, Parameters<DockerFetchRunner>>(async () => result)

  const enabledOptions = { enabled: true, proxyUrl: 'http://docker-socket-proxy:2375' }

  it('is DISABLED by default (no flag, no proxy url) and makes no HTTP call', async () => {
    const runner = makeRunner()
    const service = new DockerServiceControlService({ runner })

    expect(service.isEnabled()).toBe(false)
    expect(await service.isAvailable()).toBe(false)
    expect(await service.restart('cache')).toEqual({ kind: 'disabled' })
    expect(runner).not.toHaveBeenCalled()
  })

  it('is DISABLED when the flag is set but the proxy url is missing', async () => {
    const service = new DockerServiceControlService({ enabled: true })
    expect(service.isEnabled()).toBe(false)
    expect(await service.restart('db')).toEqual({ kind: 'disabled' })
  })

  it('exposes {cache, db} as its allowlist', () => {
    const service = new DockerServiceControlService(enabledOptions)
    expect(service.getAllowedContainers()).toEqual(DEFAULT_DOCKER_RESTARTABLE_CONTAINERS)
    expect(service.isAllowed('cache')).toBe(true)
    expect(service.isAllowed('db')).toBe(true)
    expect(service.isAllowed('server')).toBe(false)
  })

  it('rejects a non-allowlisted container WITHOUT any HTTP call (injection-safe)', async () => {
    const runner = makeRunner()
    const service = new DockerServiceControlService({ ...enabledOptions, runner })

    for (const evil of ['server', 'cache; rm -rf /', '../../containers/all', '$(whoami)', '']) {
      const outcome = await service.restart(evil)
      expect(outcome).toEqual({ kind: 'invalid-container', container: evil })
    }
    expect(runner).not.toHaveBeenCalled()
  })

  it('resolves the compose container name and POSTs the Engine API restart path', async () => {
    const runner = makeRunner()
    const service = new DockerServiceControlService({ ...enabledOptions, project: 'standard-red-notes', runner })

    const outcome = await service.restart('cache')

    expect(runner).toHaveBeenCalledWith(
      'http://docker-socket-proxy:2375/containers/standard-red-notes-cache-1/restart',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(outcome).toEqual({ kind: 'ok', container: 'cache', name: 'standard-red-notes-cache-1' })
  })

  it('honours explicit container-name overrides', async () => {
    const runner = makeRunner()
    const service = new DockerServiceControlService({
      ...enabledOptions,
      containerNames: { db: 'my-mariadb' },
      runner,
    })

    await service.restart('db')

    expect(runner).toHaveBeenCalledWith(
      'http://docker-socket-proxy:2375/containers/my-mariadb/restart',
      expect.anything(),
    )
  })

  it('degrades to unavailable when the proxy cannot be reached (never throws)', async () => {
    const runner: DockerFetchRunner = async () => {
      throw new Error('ECONNREFUSED')
    }
    const service = new DockerServiceControlService({ ...enabledOptions, runner })

    expect(await service.isAvailable()).toBe(false)
    const outcome = await service.restart('cache')
    expect(outcome.kind).toBe('unavailable')
  })

  it('reports available when the proxy answers anything (even a denied 403)', async () => {
    const service = new DockerServiceControlService({
      ...enabledOptions,
      runner: makeRunner({ status: 403, text: async () => 'Forbidden' }),
    })
    expect(await service.isAvailable()).toBe(true)
  })

  it('maps a 404 (no such container) to a clear error, not unavailable', async () => {
    const service = new DockerServiceControlService({
      ...enabledOptions,
      runner: makeRunner({ status: 404, text: async () => 'no such container' }),
    })
    const outcome = await service.restart('db')
    expect(outcome).toMatchObject({ kind: 'error', container: 'db' })
  })

  it('maps a proxy 403 (restart not permitted) to a helpful error', async () => {
    const service = new DockerServiceControlService({
      ...enabledOptions,
      runner: makeRunner({ status: 403, text: async () => 'Forbidden' }),
    })
    const outcome = await service.restart('cache')
    expect(outcome).toMatchObject({ kind: 'error' })
    expect((outcome as { message: string }).message).toMatch(/denied/i)
  })
})
