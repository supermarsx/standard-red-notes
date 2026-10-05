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

/**
 * A reader that poisons EVERY key it is asked for, and records which keys those
 * were.
 *
 * The secrecy sweep used to plant a value per `DIAGNOSTIC_ENV_KEYS` entry plus
 * three enum sources listed by hand. That is an unpoisoned-field leak waiting to
 * happen: a field reading a variable nobody remembered to add to the list would
 * be tested against `undefined` and pass. Poisoning by key, rather than from a
 * list, means a newly read variable is covered the moment it is read.
 */
const poisonedReader = (): { read: (key: string) => string; requested: Set<string> } => {
  const requested = new Set<string>()

  return {
    requested,
    read: (key: string): string => {
      requested.add(key)

      return `PLANTED-SECRET-${key}`
    },
  }
}

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

  /**
   * t108. `['grpc']` was the whole allow-list, so the two OTHER documented
   * values both read as `other (unrecognised)` — indistinguishable from a typo.
   * One of them, `auto`, is what `scripts/setup.sh` and `.env.example` WRITE by
   * default, so the most common deliberate setting in the fleet was reported as
   * a mistake; the other, `http`, is an explicit pin the container's own
   * resolver passes through verbatim.
   */
  it.each([
    ['grpc', 'the one token the binding branch tests for'],
    ['http', 'an explicit pin to the HTTP proxies'],
    ['auto', 'the value the setup script writes by default'],
  ])('reports SERVICE_PROXY_TYPE=%s as itself rather than as unrecognised (%s)', (value) => {
    const report = observeDeployment(readerFor({ SERVICE_PROXY_TYPE: value }), bindings())

    expect(report.serviceProxySetting).toBe(value)
    expect(report.serviceProxySetting).not.toBe('other')
  })

  it('still collapses a genuinely unknown proxy token, and does not case-fold', () => {
    // The allow-list widened; it did not become permissive. `Container.ts:121`
    // is an exact `===` with no trim and no case folding, so `GRPC` really does
    // select the HTTP proxies and must not be reported as if it had worked.
    expect(observeDeployment(readerFor({ SERVICE_PROXY_TYPE: 'GRPC' }), bindings()).serviceProxySetting).toBe('other')
    expect(observeDeployment(readerFor({ SERVICE_PROXY_TYPE: 'grpc ' }), bindings()).serviceProxySetting).toBe('other')
    expect(observeDeployment(readerFor({ SERVICE_PROXY_TYPE: 'direct' }), bindings()).serviceProxySetting).toBe('other')
  })

  it('treats only the exact strings as the kill switch and the memory cache', () => {
    const report = observeDeployment(readerFor({ WEBSOCKET_SYNC_ENABLED: 'false', CACHE_TYPE: 'memory' }), bindings())

    expect(report.syncSwitchSetting).toBe('false')
    expect(report.cacheSetting).toBe('memory')
    expect(observeDeployment(readerFor({ WEBSOCKET_SYNC_ENABLED: 'FALSE' }), bindings()).syncSwitchSetting).toBe(
      'other',
    )
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
    // EVERY key this module reads is poisoned, not a hand-maintained list of
    // them, because the panel is designed to be pasted into an issue. A future
    // field typed `string` fails here, and so does a future field reading a
    // variable nobody added to a list.
    const poisoned = poisonedReader()

    const report = observeDeployment(poisoned.read, bindings())
    const serialized = JSON.stringify(report)

    expect(serialized).not.toContain('PLANTED-SECRET')

    // Not vacuous: the sweep only means anything if the module actually asked
    // for the keys whose secrecy it claims to prove.
    for (const key of DIAGNOSTIC_ENV_KEYS) {
      expect(poisoned.requested.has(key)).toBe(true)
    }
    for (const key of [
      'MODE',
      'SERVICE_PROXY_TYPE',
      'CACHE_TYPE',
      'WEBSOCKET_SYNC_ENABLED',
      'SRN_SERVICE_PROXY_TYPE_DECISION',
      'SRN_INTERNAL_GRPC_SECRET_STATE',
    ]) {
      expect(poisoned.requested.has(key)).toBe(true)
    }

    // And the fields are ABSENT-by-collapse, not absent by omission: each
    // env-derived field read its poisoned value and refused it. A new field
    // that passed a value through would be a string that is neither, and would
    // fail here even if the planted marker were renamed. `boundServiceProxy` is
    // the one string this module does not read from the environment — it is the
    // branch the container took, handed in through `bindings`.
    for (const [field, value] of Object.entries(report)) {
      if (field === 'presence' || field === 'boundServiceProxy' || typeof value === 'boolean') {
        continue
      }
      expect({ field, value }).toEqual({ field, value: 'other' })
    }
  })

  /**
   * A queue URL can embed an account id, an endpoint and sometimes a
   * credential. The separation question is answered from two booleans and no
   * address: `API_GATEWAY_SQS_QUEUE_URL` present alongside the bare name means
   * the gateway's queue came from its OWN prefixed projection; the bare name
   * alone means it did not.
   */
  it('publishes the queue keys as presence only, never an address', () => {
    const report = observeDeployment(
      readerFor({
        SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/srn-queue?secret=abc',
        API_GATEWAY_SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/000000000000/srn-gateway-queue',
      }),
      bindings(),
    )

    expect(report.presence.SQS_QUEUE_URL).toBe(true)
    expect(report.presence.API_GATEWAY_SQS_QUEUE_URL).toBe(true)
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('amazonaws')
    expect(serialized).not.toContain('000000000000')
    expect(serialized).not.toContain('secret=abc')
  })

  /**
   * t113. The "Queue separation" row could not be derived at all: the presence
   * map carried `SQS_QUEUE_URL` and no prefixed counterpart, so a gateway that
   * configured its own queue and one reading the workers' queue produced an
   * IDENTICAL presence map. That is the state that once cost roughly four in
   * five realtime pushes plus revision and e-mail events, undetected, because a
   * queue delivers each message once and both consumers succeeded on different
   * messages.
   *
   * This asserts the discrimination itself rather than a derived label: the two
   * configurations must no longer produce the same booleans.
   */
  it('distinguishes a queue the gateway owns from one it inherited', () => {
    const own = observeDeployment(
      readerFor({ SQS_QUEUE_URL: 'projected-from-the-prefix', API_GATEWAY_SQS_QUEUE_URL: 'the-gateway-queue' }),
      bindings(),
    )
    const inherited = observeDeployment(readerFor({ SQS_QUEUE_URL: 'the-workers-queue' }), bindings())
    const noQueue = observeDeployment(readerFor({}), bindings())

    expect(own.presence).not.toEqual(inherited.presence)

    expect([own.presence.SQS_QUEUE_URL, own.presence.API_GATEWAY_SQS_QUEUE_URL]).toEqual([true, true])
    expect([inherited.presence.SQS_QUEUE_URL, inherited.presence.API_GATEWAY_SQS_QUEUE_URL]).toEqual([true, false])
    expect([noQueue.presence.SQS_QUEUE_URL, noQueue.presence.API_GATEWAY_SQS_QUEUE_URL]).toEqual([false, false])
  })

  /**
   * t113. `srn_resolve_service_proxy_type` recorded the reason the container is
   * on the transport it is on and never exported it, so it reached no process
   * environment and this module had nothing to read. Both halves were needed:
   * the export, and a field that reads it.
   */
  it.each([
    ['operator', 'an explicit setting was supplied and left alone'],
    ['grpc-default', 'every condition held and gRPC was taken'],
    ['not-colocated', 'there is no co-located syncing-server to speak gRPC to'],
    ['no-grpc-urls', 'a dial target is missing'],
    ['no-secret', 'the durable-command secret is unusable, so the lane stays closed anyway'],
    ['auth-grpc-unreachable', 'the auth listener did not answer'],
    ['syncing-grpc-unreachable', 'the syncing listener did not answer'],
  ])('reports the launcher decision %s as itself (%s)', (value) => {
    const report = observeDeployment(readerFor({ SRN_SERVICE_PROXY_TYPE_DECISION: value }), bindings())

    expect(report.serviceProxyDecision).toBe(value)
    expect(report.serviceProxyDecision).not.toBe('other')
  })

  it('separates a launcher that recorded nothing from one that recorded something unknown', () => {
    // These are different facts and the panel renders them differently: `unset`
    // is an image older than the export, or a gateway started outside
    // `supervisor-server.sh`. `other` is a token this build does not know.
    expect(observeDeployment(readerFor({}), bindings()).serviceProxyDecision).toBe('unset')
    expect(
      observeDeployment(readerFor({ SRN_SERVICE_PROXY_TYPE_DECISION: '   ' }), bindings()).serviceProxyDecision,
    ).toBe('unset')
    expect(
      observeDeployment(readerFor({ SRN_SERVICE_PROXY_TYPE_DECISION: 'GRPC-DEFAULT' }), bindings())
        .serviceProxyDecision,
    ).toBe('other')
    expect(
      observeDeployment(readerFor({ SRN_SERVICE_PROXY_TYPE_DECISION: 'invented' }), bindings()).serviceProxyDecision,
    ).toBe('other')
  })

  /**
   * The sibling with the same unexported-assignment bug. It hid better:
   * `docker-entrypoint.sh` reads it in the same shell that sourced the helper,
   * so the boot log was right while no child process could see the variable.
   */
  it.each([
    ['supplied', "the operator's own value, left untouched"],
    ['persisted', 'a previously minted value, reloaded from the volume'],
    ['minted-persisted', 'freshly minted and written to the volume'],
    ['minted-ephemeral', 'minted but not persisted — it changes on the next start'],
    ['not-colocated', 'refused to mint, because the halves are in different containers'],
    ['mint-failed', 'no randomness source produced 32 bytes'],
  ])('reports the durable-command secret state %s as itself (%s)', (value) => {
    const report = observeDeployment(readerFor({ SRN_INTERNAL_GRPC_SECRET_STATE: value }), bindings())

    expect(report.internalGrpcSecretState).toBe(value)
    expect(report.internalGrpcSecretState).not.toBe('other')
  })

  it('collapses an unknown secret state and reports an absent one as unset', () => {
    expect(observeDeployment(readerFor({}), bindings()).internalGrpcSecretState).toBe('unset')
    expect(
      observeDeployment(readerFor({ SRN_INTERNAL_GRPC_SECRET_STATE: 'MINTED-PERSISTED' }), bindings())
        .internalGrpcSecretState,
    ).toBe('other')
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
