import {
  remedyForClientGap,
  remedyForLiveReason,
  remedyForPrecondition,
  remedyForUnstampedDeployment,
  type DeploymentTopology,
} from './diagnosticRemedies'

/**
 * The remedies are the part of the panel that can do damage. A wrong instruction
 * here costs an operator a restart and points their suspicion at the wrong
 * subsystem — which is the exact failure the panel was built to end — so these
 * tests are written around the cases where the OBVIOUS advice is wrong.
 */

const topology = (overrides: Partial<DeploymentTopology> = {}): DeploymentTopology => ({
  recorded: true,
  mode: 'unset',
  serviceProxySetting: 'unset',
  boundServiceProxy: 'http',
  cacheSetting: 'unset',
  syncSwitchSetting: 'unset',
  grpcSyncingProxyBound: false,
  grpcProxyBindableInThisMode: true,
  redisBound: false,
  presence: {},
  ...overrides,
})

const STOCK_GRPC_REMEDY =
  'the gRPC syncing-server proxy is not bound; configure SYNCING_SERVER_GRPC_URL so realtime commands have a durable backend'

describe('remedyForPrecondition — no topology reported', () => {
  it('falls back to the server copy and says it is generic', () => {
    const remedy = remedyForPrecondition('SYNCING_SERVER_GRPC_UNBOUND', STOCK_GRPC_REMEDY, undefined)

    expect(remedy.basis).toBe('generic')
    expect(remedy.summary).toBe(STOCK_GRPC_REMEDY)
    expect(remedy.because.join(' ')).toContain('may not apply here')
  })

  it('treats an unrecorded topology exactly like an absent one, rather than as a set of falses', () => {
    const remedy = remedyForPrecondition('REDIS_UNBOUND', 'configure REDIS_URL', {
      recorded: false,
      mode: 'home-server',
    })

    expect(remedy.basis).toBe('generic')
  })

  it('passes an unrecognised code straight through instead of dropping it', () => {
    const remedy = remedyForPrecondition('SOME_FUTURE_CONDITION', 'do the future thing', topology())

    expect(remedy.summary).toBe('do the future thing')
    expect(remedy.basis).toBe('generic')
  })
})

describe('remedyForPrecondition — SYNCING_SERVER_GRPC_UNBOUND', () => {
  it('refuses to recommend the variable in home-server mode, where nothing can bind the proxy', () => {
    const remedy = remedyForPrecondition(
      'SYNCING_SERVER_GRPC_UNBOUND',
      STOCK_GRPC_REMEDY,
      topology({ mode: 'home-server', boundServiceProxy: 'direct-call', grpcProxyBindableInThisMode: false }),
    )

    expect(remedy.effort).toBe('none')
    expect(remedy.basis).toBe('verified')
    expect(remedy.steps).toHaveLength(0)
    expect(remedy.summary).toContain('Do not set SYNCING_SERVER_GRPC_URL')
    expect(remedy.because.join(' ')).toContain('in-process')
  })

  it('says plainly that the already-set URL is being ignored, rather than telling the operator to set it again', () => {
    const remedy = remedyForPrecondition(
      'SYNCING_SERVER_GRPC_UNBOUND',
      STOCK_GRPC_REMEDY,
      topology({ mode: 'self-hosted', presence: { SYNCING_SERVER_GRPC_URL: true } }),
    )

    expect(remedy.effort).toBe('restart')
    expect(remedy.summary).toContain('SERVICE_PROXY_TYPE')
    expect(remedy.steps[0]).toContain('SERVICE_PROXY_TYPE=grpc')
    expect(remedy.steps[1]).toContain('already set')
    expect(remedy.because.join(' ')).toContain('would have led nowhere')
  })

  it('warns that turning on the gRPC branch without AUTH_SERVER_GRPC_URL stops the gateway starting', () => {
    const remedy = remedyForPrecondition(
      'SYNCING_SERVER_GRPC_UNBOUND',
      STOCK_GRPC_REMEDY,
      topology({ mode: 'self-hosted', presence: { AUTH_SERVER_GRPC_URL: false } }),
    )

    expect(remedy.steps.join(' ')).toContain('fail to start')
  })

  it('names the 32-byte floor on the internal auth secret, which silently closes the lane', () => {
    const remedy = remedyForPrecondition('SYNCING_SERVER_GRPC_UNBOUND', STOCK_GRPC_REMEDY, topology())

    expect(remedy.steps.join(' ')).toContain('32 bytes')
  })

  it('offers the bundled-image restart path only on a self-hosted deployment', () => {
    const bundled = remedyForPrecondition(
      'SYNCING_SERVER_GRPC_UNBOUND',
      STOCK_GRPC_REMEDY,
      topology({ mode: 'self-hosted' }),
    )
    const distributed = remedyForPrecondition(
      'SYNCING_SERVER_GRPC_UNBOUND',
      STOCK_GRPC_REMEDY,
      topology({ mode: 'unset' }),
    )

    expect(bundled.steps.join(' ')).toContain('API_GATEWAY_SERVICE_PROXY_TYPE=grpc')
    expect(bundled.steps.join(' ')).toContain('does not have to be rebuilt')
    expect(distributed.steps.join(' ')).not.toContain('API_GATEWAY_SERVICE_PROXY_TYPE')
  })

  it('does not invent a fix when the branch is selected but the proxy is still unbound', () => {
    const remedy = remedyForPrecondition(
      'SYNCING_SERVER_GRPC_UNBOUND',
      STOCK_GRPC_REMEDY,
      topology({ serviceProxySetting: 'grpc' }),
    )

    expect(remedy.effort).toBe('wait')
    expect(remedy.steps).toHaveLength(0)
    expect(remedy.summary).toContain('Do not change configuration')
  })
})

describe('remedyForPrecondition — REDIS_UNBOUND', () => {
  it('names CACHE_TYPE, not REDIS_URL, when the memory cache is what suppresses the binding', () => {
    const remedy = remedyForPrecondition(
      'REDIS_UNBOUND',
      'configure REDIS_URL',
      topology({ cacheSetting: 'memory', presence: { REDIS_URL: true } }),
    )

    expect(remedy.summary).toContain('CACHE_TYPE')
    expect(remedy.steps[0]).toContain('CACHE_TYPE')
    expect(remedy.steps[1]).toContain('already set')
  })

  it('sends a home-server deployment to REDIS_HOST and warns off CACHE_TYPE', () => {
    const remedy = remedyForPrecondition('REDIS_UNBOUND', 'configure REDIS_URL', topology({ mode: 'home-server' }))

    expect(remedy.summary).toContain('REDIS_HOST')
    expect(remedy.because.join(' ')).toContain('forces CACHE_TYPE=memory')
  })

  it('catches the REDIS_HOST-set-but-REDIS_URL-missing trap in a distributed deployment', () => {
    const remedy = remedyForPrecondition(
      'REDIS_UNBOUND',
      'configure REDIS_URL',
      topology({ presence: { REDIS_HOST: true, REDIS_URL: false } }),
    )

    expect(remedy.steps.join(' ')).toContain('REDIS_URL only')
    expect(remedy.because.join(' ')).toContain('without realising it')
  })
})

describe('remedyForPrecondition — the remaining conditions', () => {
  it('explains a kill switch as deliberate rather than as a fault', () => {
    const remedy = remedyForPrecondition(
      'WEBSOCKET_SYNC_DISABLED_BY_CONFIGURATION',
      'unset it',
      topology({ syncSwitchSetting: 'false' }),
    )

    expect(remedy.because.join(' ')).toContain('deliberate kill switch')
    expect(remedy.effort).toBe('restart')
  })

  it('tells a multi-replica deployment the connection token must match across replicas', () => {
    const remedy = remedyForPrecondition('WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING', 'set it', topology())

    expect(remedy.steps.join(' ')).toContain('SAME value on every gateway replica')
  })

  it('notices when the token secret is present now but was absent at boot', () => {
    const remedy = remedyForPrecondition(
      'WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING',
      'set it',
      topology({ presence: { WEB_SOCKET_CONNECTION_TOKEN_SECRET: true } }),
    )

    expect(remedy.because.join(' ')).toContain('arrived after boot')
  })
})

describe('remedyForLiveReason', () => {
  it('does not treat an unreachable Redis as a missing setting', () => {
    const remedy = remedyForLiveReason('ticket-store-unavailable', topology())

    expect(remedy?.effort).toBe('wait')
    expect(remedy?.summary).toContain('infrastructure fault')
  })

  it('points sync-not-configured back at the gate instead of restating it as its own problem', () => {
    const remedy = remedyForLiveReason('sync-not-configured', topology())

    expect(remedy?.effort).toBe('none')
  })

  it('distinguishes an unset origin list from one that resolved to nothing', () => {
    const set = remedyForLiveReason(
      'no-allowed-origins',
      topology({ presence: { WEBSOCKET_SYNC_ALLOWED_ORIGINS: true } }),
    )
    const unset = remedyForLiveReason('no-allowed-origins', topology())

    expect(set?.because.join(' ')).toContain('resolved to nothing usable')
    expect(unset?.because.join(' ')).toContain('is not set')
  })

  it('returns nothing for a reason it has no guidance for, so the UI can say so', () => {
    expect(remedyForLiveReason('some-future-reason', topology())).toBeUndefined()
  })
})

describe('the remedies that are not config changes', () => {
  it('states that an unstamped build cannot be stamped at runtime', () => {
    const remedy = remedyForUnstampedDeployment()

    expect(remedy.effort).toBe('rebuild')
    expect(remedy.steps.join(' ')).toContain('--build-arg SRN_DEPLOY_REVISION=$(git rev-parse HEAD)')
    expect(remedy.steps.join(' ')).toContain('does NOT stamp it')
  })

  it('states that a client gap has no server-side fix', () => {
    const remedy = remedyForClientGap(['FILES_V1'])

    expect(remedy.effort).toBe('client-update')
    expect(remedy.summary).toContain('FILES_V1')
  })
})

describe('secrecy', () => {
  it('never emits a value, because it is never given one', () => {
    // The topology type carries booleans and closed enums only. This asserts the
    // consequence end-to-end: feed every presence flag as true and every enum at
    // its most "configured" setting, and the output is still only names.
    const everything = topology({
      mode: 'self-hosted',
      serviceProxySetting: 'unset',
      presence: Object.fromEntries(
        [
          'SYNCING_SERVER_GRPC_URL',
          'AUTH_SERVER_GRPC_URL',
          'SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET',
          'REDIS_URL',
          'REDIS_HOST',
          'WEB_SOCKET_CONNECTION_TOKEN_SECRET',
          'WEBSOCKET_SYNC_ALLOWED_ORIGINS',
          'PUBLIC_URL',
        ].map((key) => [key, true]),
      ),
    })

    const text = [
      ...['SYNCING_SERVER_GRPC_UNBOUND', 'REDIS_UNBOUND', 'WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING'].map((code) =>
        remedyForPrecondition(code, 'server copy', everything),
      ),
      remedyForLiveReason('no-allowed-origins', everything),
      remedyForUnstampedDeployment(),
    ]
      .map((remedy) => JSON.stringify(remedy))
      .join(' ')

    expect(text).not.toMatch(/https?:\/\//)
    expect(text).not.toMatch(/redis:\/\//)
    expect(text).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/)
  })
})
