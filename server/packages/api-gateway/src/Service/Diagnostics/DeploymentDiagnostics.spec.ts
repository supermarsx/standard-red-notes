import {
  DIAGNOSTIC_ENV_KEYS,
  DeploymentDiagnosticsRecorder,
  observeDeployment,
  type DeploymentBindings,
} from './DeploymentDiagnostics'

const bindings = (overrides: Partial<DeploymentBindings> = {}): DeploymentBindings => ({
  boundServiceProxy: 'http',
  grpcSyncingProxyBound: false,
  redisBound: false,
  ...overrides,
})

const readerFor =
  (values: Record<string, string>) =>
  (key: string): string | undefined =>
    values[key]

describe('observeDeployment', () => {
  it('reports the mode, the proxy setting and the branch that actually ran', () => {
    const report = observeDeployment(readerFor({ MODE: 'self-hosted', SERVICE_PROXY_TYPE: 'grpc' }), {
      boundServiceProxy: 'grpc',
      grpcSyncingProxyBound: true,
      redisBound: true,
    })

    expect(report.recorded).toBe(true)
    expect(report.mode).toBe('self-hosted')
    expect(report.serviceProxySetting).toBe('grpc')
    expect(report.boundServiceProxy).toBe('grpc')
    expect(report.grpcSyncingProxyBound).toBe(true)
    expect(report.redisBound).toBe(true)
  })

  it('marks the gRPC proxy as unbindable in home-server mode', () => {
    const report = observeDeployment(readerFor({ MODE: 'home-server' }), bindings({ boundServiceProxy: 'direct-call' }))

    expect(report.grpcProxyBindableInThisMode).toBe(false)
  })

  it('marks the gRPC proxy as bindable in every other mode', () => {
    for (const mode of ['self-hosted', '', 'something-else']) {
      const report = observeDeployment(readerFor(mode ? { MODE: mode } : {}), bindings())

      expect(report.grpcProxyBindableInThisMode).toBe(true)
    }
  })

  it('distinguishes unset from unrecognised for every enum', () => {
    const unset = observeDeployment(readerFor({}), bindings())
    expect(unset.mode).toBe('unset')
    expect(unset.serviceProxySetting).toBe('unset')
    expect(unset.cacheSetting).toBe('unset')
    expect(unset.syncSwitchSetting).toBe('unset')

    const other = observeDeployment(
      readerFor({ MODE: 'weird', SERVICE_PROXY_TYPE: 'weird', CACHE_TYPE: 'weird', WEBSOCKET_SYNC_ENABLED: 'weird' }),
      bindings(),
    )
    expect(other.mode).toBe('other')
    expect(other.serviceProxySetting).toBe('other')
    expect(other.cacheSetting).toBe('other')
    expect(other.syncSwitchSetting).toBe('other')
  })

  it('treats only the exact strings as the kill switch and the memory cache', () => {
    const report = observeDeployment(readerFor({ WEBSOCKET_SYNC_ENABLED: 'false', CACHE_TYPE: 'memory' }), bindings())

    expect(report.syncSwitchSetting).toBe('false')
    expect(report.cacheSetting).toBe('memory')
    expect(observeDeployment(readerFor({ WEBSOCKET_SYNC_ENABLED: 'FALSE' }), bindings()).syncSwitchSetting).toBe('other')
  })

  it('reports presence for every diagnostic key, and only presence', () => {
    const report = observeDeployment(
      readerFor({ SYNCING_SERVER_GRPC_URL: '0.0.0.0:50052', AUTH_JWT_SECRET: 'hunter2' }),
      bindings(),
    )

    expect(Object.keys(report.presence).sort()).toEqual([...DIAGNOSTIC_ENV_KEYS].sort())
    expect(report.presence.SYNCING_SERVER_GRPC_URL).toBe(true)
    expect(report.presence.AUTH_JWT_SECRET).toBe(true)
    expect(report.presence.VALET_TOKEN_SECRET).toBe(false)
    for (const value of Object.values(report.presence)) {
      expect(typeof value).toBe('boolean')
    }
  })

  it('treats a whitespace-only value as absent', () => {
    const report = observeDeployment(readerFor({ REDIS_URL: '   ' }), bindings())

    expect(report.presence.REDIS_URL).toBe(false)
  })

  it('never carries a configured value anywhere in the serialized report', () => {
    // Every variable is set to a distinctive planted secret; not one of them may
    // appear in the payload, because the panel is designed to be pasted into an
    // issue. A future field typed `string` would fail here.
    const planted: Record<string, string> = { MODE: 'self-hosted' }
    for (const key of DIAGNOSTIC_ENV_KEYS) {
      planted[key] = `PLANTED-SECRET-${key}`
    }
    planted.SERVICE_PROXY_TYPE = 'PLANTED-SECRET-SERVICE_PROXY_TYPE'
    planted.CACHE_TYPE = 'PLANTED-SECRET-CACHE_TYPE'
    planted.WEBSOCKET_SYNC_ENABLED = 'PLANTED-SECRET-WEBSOCKET_SYNC_ENABLED'

    const serialized = JSON.stringify(observeDeployment(readerFor(planted), bindings()))

    expect(serialized).not.toContain('PLANTED-SECRET')
  })
})

describe('DeploymentDiagnosticsRecorder', () => {
  it('reports not-recorded before anything is recorded', () => {
    const recorder = new DeploymentDiagnosticsRecorder()

    const report = recorder.report()

    expect(report.recorded).toBe(false)
    expect(report.presence).toEqual({})
    // The panel must not be able to read a confident "false" for a topology it
    // has not observed: recorded:false is what suppresses every remedy.
    expect(report.grpcProxyBindableInThisMode).toBe(false)
  })

  it('returns a fresh presence object each time so a caller cannot mutate the frozen default', () => {
    const recorder = new DeploymentDiagnosticsRecorder()

    const first = recorder.report()
    first.presence.INJECTED = true

    expect(recorder.report().presence).toEqual({})
  })

  it('records and clears', () => {
    const recorder = new DeploymentDiagnosticsRecorder()
    recorder.record(observeDeployment(readerFor({ MODE: 'home-server' }), bindings()))

    expect(recorder.report().mode).toBe('home-server')

    recorder.clear()

    expect(recorder.report().recorded).toBe(false)
  })
})
