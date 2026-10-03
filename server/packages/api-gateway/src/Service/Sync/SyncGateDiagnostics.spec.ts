import {
  SYNC_HOST_REMEDIES,
  SYNC_ITEMS_CAUSE_REMEDIES,
  SyncGateDiagnosticsRecorder,
  type SyncItemsHandshakeProbe,
} from './SyncGateDiagnostics'
import type { SyncPreconditionState } from './SyncWebSocketPreconditions'

const MET: SyncPreconditionState = {
  connectionTokenSecretPresent: true,
  webSocketSyncEnabled: true,
  redisBound: true,
  syncingServerGrpcBound: true,
}

/**
 * A sync lane whose `backend.ready()` answers as a real one would. This is the
 * ENTIRE predicate `syncCommandHandler` uses to decide whether to put
 * SYNC_ITEMS in the AUTHENTICATED operation list, which is why the gate reads
 * it rather than inferring from a bound proxy.
 */
const laneWhose = (ready: () => boolean): SyncItemsHandshakeProbe => ({
  backend: { ready, execute: jest.fn(), status: jest.fn() },
})

describe('SyncGateDiagnosticsRecorder', () => {
  it('reports nothing as attached before the gate has run', () => {
    const report = new SyncGateDiagnosticsRecorder().report()

    expect(report.recorded).toBe(false)
    expect(report.gatewayAttached).toBe(false)
    expect(report.host).toEqual({ unmetCondition: null, remedy: null })
  })

  // A host condition (the home server's invalid WEBSOCKET_REDIS_NAMESPACE)
  // used to leave the record silent: the panel showed the lane enabled, the
  // gateway unattached and an EMPTY unmet list — the same misreport that
  // misled the original review. It must close the lane AND be named.
  it('closes the lane and names a host-added condition in the unmet list and its own sub-report', () => {
    const recorder = new SyncGateDiagnosticsRecorder()
    recorder.record({
      ...MET,
      filesAdvertised: false,
      gatewayAttached: false,
      hostUnmetCondition: 'WEBSOCKET_REDIS_NAMESPACE_INVALID',
    })

    const report = recorder.report()
    expect(report.syncLaneEnabled).toBe(false)
    expect(report.syncItemsAdvertised).toBe(false)
    expect(report.unmetCodes).toEqual(['WEBSOCKET_REDIS_NAMESPACE_INVALID'])
    expect(report.unmetPreconditions).toEqual([
      { code: 'WEBSOCKET_REDIS_NAMESPACE_INVALID', remedy: SYNC_HOST_REMEDIES.WEBSOCKET_REDIS_NAMESPACE_INVALID },
    ])
    expect(report.host).toEqual({
      unmetCondition: 'WEBSOCKET_REDIS_NAMESPACE_INVALID',
      remedy: SYNC_HOST_REMEDIES.WEBSOCKET_REDIS_NAMESPACE_INVALID,
    })
    expect(report.host.remedy).toContain('WEBSOCKET_REDIS_NAMESPACE')
  })

  it('lists the host condition after the shared ones and leaves the host sub-report empty when none was recorded', () => {
    const recorder = new SyncGateDiagnosticsRecorder()
    recorder.record({
      ...MET,
      connectionTokenSecretPresent: false,
      filesAdvertised: false,
      hostUnmetCondition: 'WEBSOCKET_REDIS_NAMESPACE_INVALID',
    })
    expect(recorder.report().unmetCodes).toEqual([
      'WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING',
      'WEBSOCKET_REDIS_NAMESPACE_INVALID',
    ])

    recorder.record({ ...MET, filesAdvertised: false, gatewayAttached: true })
    expect(recorder.report()).toMatchObject({
      syncLaneEnabled: true,
      unmetCodes: [],
      host: { unmetCondition: null, remedy: null },
    })
  })

  // N22: `gatewayAttached` used to be derived from the secret's presence, so a
  // single container that attached NO gateway (no Redis) reported `true`, and a
  // compose stack whose legacy lane was up on a short secret reported `false`.
  it('takes gatewayAttached from the recorded attach outcome, not from the secret', () => {
    const recorder = new SyncGateDiagnosticsRecorder()

    recorder.record({ ...MET, filesAdvertised: false, gatewayAttached: false })
    expect(recorder.report().gatewayAttached).toBe(false)

    recorder.record({ ...MET, connectionTokenSecretPresent: false, filesAdvertised: false, gatewayAttached: true })
    expect(recorder.report().gatewayAttached).toBe(true)
  })

  it('reads a record with no attach outcome as not attached', () => {
    const recorder = new SyncGateDiagnosticsRecorder()
    recorder.record({ ...MET, filesAdvertised: false })

    expect(recorder.report()).toMatchObject({ recorded: true, gatewayAttached: false, syncLaneEnabled: true })
  })

  it('keeps the files sub-report and the unmet list independent of the attach outcome', () => {
    const recorder = new SyncGateDiagnosticsRecorder()
    recorder.record({
      ...MET,
      syncingServerGrpcBound: false,
      filesAdvertised: false,
      filesUnmetCondition: 'VALET_TOKEN_SECRET',
      gatewayAttached: true,
    })

    const report = recorder.report()
    expect(report.unmetCodes).toEqual(['SYNCING_SERVER_GRPC_UNBOUND'])
    expect(report.syncItemsAdvertised).toBe(false)
    expect(report.files.unmetCondition).toBe('VALET_TOKEN_SECRET')
    expect(report.files.remedy).toContain('VALET_TOKEN_SECRET')
  })

  // ---------------------------------------------------------------------------
  // SYNC_ITEMS: the gate must report what the HANDSHAKE does.
  //
  // The divergence these tests pin: the gate recorded that the gRPC syncing
  // proxy was BOUND (a proxy object exists) and reported SYNC_ITEMS available,
  // while the socket offers the operation only when `backend.ready()` holds --
  // which additionally needs AUTH_JWT_SECRET and, for the gRPC port, a
  // SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET of at least 32 bytes. A compose
  // stack missing that secret therefore bound the proxy, passed the gate, and
  // was refused by every handshake: the admin pane said "available" for days
  // while every client synced items over HTTP.
  // ---------------------------------------------------------------------------
  describe('the SYNC_ITEMS verdict comes from the handshake predicate', () => {
    it('reports WITHHELD for a BOUND durable port whose readiness check refuses', () => {
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.record({ ...MET, filesAdvertised: true, gatewayAttached: true })
      recorder.observeSyncItems(laneWhose(() => false))

      const report = recorder.report()
      // The lane itself is untouched: collaboration, API RPC, invite events and
      // files still negotiate. Only the one operation is withheld.
      expect(report.syncLaneEnabled).toBe(true)
      expect(report.syncItemsAdvertised).toBe(false)
      expect(report.syncItems.state).toBe('WITHHELD')
      expect(report.syncItems.cause).toBe('DURABLE_BACKEND_NOT_READY')
      expect(report.syncItems.probe).toBe('NOT_READY')
      // The remedy names the variables and never a length, a value or which
      // term of the predicate failed.
      expect(report.syncItems.remedy).toBe(SYNC_ITEMS_CAUSE_REMEDIES.DURABLE_BACKEND_NOT_READY)
      expect(report.syncItems.remedy).toContain('SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET')
      // ...and the condition list still shows nothing unmet, which is exactly
      // why the verdict could not be derived from it.
      expect(report.unmetCodes).toEqual([])
    })

    it('reports ADVERTISED only from a probe that returned ready', () => {
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.record({ ...MET, filesAdvertised: true, gatewayAttached: true })
      recorder.observeSyncItems(laneWhose(() => true))

      const report = recorder.report()
      expect(report.syncItemsAdvertised).toBe(true)
      expect(report.syncItems).toEqual({ state: 'ADVERTISED', cause: null, remedy: null, probe: 'READY' })
    })

    it('cannot be told SYNC_ITEMS is available: an unprobed record reads as NOT OBSERVED, not as available', () => {
      // `SyncGateObservation` has no field for this verdict, so the strongest
      // claim a host can make by recording alone is "unknown". `isBound` being
      // true is what used to read as available here.
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.record({ ...MET, filesAdvertised: true, gatewayAttached: true })

      const report = recorder.report()
      expect(report.syncItems.state).toBe('NOT_OBSERVED')
      expect(report.syncItems.cause).toBe('NEVER_PROBED')
      // ABSENT, not false: the panel's guard is `!== undefined`, so omitting it
      // renders as no claim rather than as a withheld operation. Reporting
      // `false` here would tell a single-container operator their notes are on
      // HTTP when they are not -- the same error in the other direction.
      expect('syncItemsAdvertised' in report).toBe(false)
      expect(report.syncItemsAdvertised).toBeUndefined()
    })

    it('still withholds without a probe when the durable port is not bound at all', () => {
      // The one inference allowed from the weaker signal, and only because it
      // can only subtract: `ready()` requires a port to exist. The remedy is
      // the shared module's own, never a second copy.
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.record({ ...MET, syncingServerGrpcBound: false, filesAdvertised: true, gatewayAttached: true })

      const report = recorder.report()
      expect(report.syncItemsAdvertised).toBe(false)
      expect(report.syncItems.state).toBe('WITHHELD')
      expect(report.syncItems.cause).toBe('DURABLE_BACKEND_UNBOUND')
      expect(report.syncItems.remedy).toBe(
        report.unmetPreconditions.find(({ code }) => code === 'SYNCING_SERVER_GRPC_UNBOUND')?.remedy,
      )
      expect(report.syncItems.remedy).toContain('SERVICE_PROXY_TYPE=grpc')
    })

    // -----------------------------------------------------------------------
    // t108. The live defect: once the probe ran at every attach, EVERY negative
    // reading became `DURABLE_BACKEND_NOT_READY`, so a deployment with no
    // durable port bound was told "the durable command port IS BOUND but failed
    // its readiness check" and sent after the internal gRPC secret — in the SAME
    // response that carried `unmetCodes: ['SYNCING_SERVER_GRPC_UNBOUND']`.
    // Reproduced live three ways, including with no plant at all (an unset
    // SERVICE_PROXY_TYPE is enough). `DURABLE_BACKEND_UNBOUND` existed and was
    // reachable only from `NEVER_PROBED`, i.e. never for an attached gateway.
    // -----------------------------------------------------------------------
    it('names an UNBOUND durable port as unbound, not as a bound port that failed its check', () => {
      const recorder = new SyncGateDiagnosticsRecorder()
      // Exactly the live configuration: the transport gate is satisfied, the
      // lane is up and serving its other five operations, and no durable
      // command port is bound — so the adapter's `ready()` is false because
      // `durableSync === undefined`, not because a secret is short.
      recorder.record({ ...MET, syncingServerGrpcBound: false, filesAdvertised: true, gatewayAttached: true })
      recorder.observeSyncItems(laneWhose(() => false))

      const report = recorder.report()
      expect(report.syncLaneEnabled).toBe(true)
      expect(report.syncItemsAdvertised).toBe(false)
      expect(report.syncItems.state).toBe('WITHHELD')
      expect(report.syncItems.probe).toBe('NOT_READY')
      expect(report.syncItems.cause).toBe('DURABLE_BACKEND_UNBOUND')
      // The remedy is the shared module's own SYNCING_SERVER_GRPC_UNBOUND copy,
      // reused verbatim so the cause and the condition list cannot drift.
      expect(report.syncItems.remedy).toBe(
        report.unmetPreconditions.find(({ code }) => code === 'SYNCING_SERVER_GRPC_UNBOUND')?.remedy,
      )
      expect(report.syncItems.remedy).toContain('SERVICE_PROXY_TYPE=grpc')
      // ...and it does NOT send the operator after the secret length, which is
      // the wrong variable for this state.
      expect(report.syncItems.remedy).not.toContain('SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET')
      // The response no longer contradicts itself: the cause and the named
      // condition describe the same fault.
      expect(report.unmetCodes).toEqual(['SYNCING_SERVER_GRPC_UNBOUND'])
    })

    it('keeps the two durable causes apart on the SAME probe reading, differing only in bound-ness', () => {
      // One assertion that the discriminator is the gate's own
      // `syncingServerGrpcBound` and nothing else: same refusing backend, same
      // NOT_READY probe, two causes and two different remedies.
      const read = (syncingServerGrpcBound: boolean) => {
        const recorder = new SyncGateDiagnosticsRecorder()
        recorder.record({ ...MET, syncingServerGrpcBound, filesAdvertised: true, gatewayAttached: true })
        recorder.observeSyncItems(laneWhose(() => false))

        return recorder.report().syncItems
      }

      const bound = read(true)
      const unbound = read(false)

      expect(bound.probe).toBe(unbound.probe)
      expect(bound.state).toBe('WITHHELD')
      expect(unbound.state).toBe('WITHHELD')
      expect(bound.cause).toBe('DURABLE_BACKEND_NOT_READY')
      expect(unbound.cause).toBe('DURABLE_BACKEND_UNBOUND')
      expect(bound.remedy).not.toBe(unbound.remedy)
      // Each remedy names the variable that is actually its own fix.
      expect(bound.remedy).toContain('SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET')
      expect(unbound.remedy).toContain('SERVICE_PROXY_TYPE=grpc')
    })

    /**
     * t108 / defect 2. The remedy named TWO causes of an unready bound backend:
     * an internal gRPC secret under 32 bytes, and an empty `AUTH_JWT_SECRET`.
     * The second cannot occur on any host that could serve this report —
     * `Bootstrap/Container.ts` reads `AUTH_JWT_SECRET` non-optionally and
     * `AbstractEnv.get` throws on a falsy value, so an empty one is a fatal
     * startup (measured live: FATAL startup, supervisord restart loop, readiness
     * 502). Advice an operator cannot act on, for a state in which there is no
     * gateway left to print it.
     */
    it('does not send the operator after AUTH_JWT_SECRET, whose absence would have stopped the server', () => {
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.record({ ...MET, filesAdvertised: true, gatewayAttached: true })
      recorder.observeSyncItems(laneWhose(() => false))

      const report = recorder.report()
      expect(report.syncItems.cause).toBe('DURABLE_BACKEND_NOT_READY')
      expect(report.syncItems.remedy).not.toContain('AUTH_JWT_SECRET')
      // The actionable term is still named, so the clause was removed and not
      // the whole remedy.
      expect(report.syncItems.remedy).toContain('SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET')
      expect(report.syncItems.remedy).toContain('32 bytes')
      // No remedy this module can emit mentions it, on any configuration.
      for (const remedy of Object.values(SYNC_ITEMS_CAUSE_REMEDIES)) {
        expect(remedy ?? '').not.toContain('AUTH_JWT_SECRET')
      }
    })

    it('reaches DURABLE_BACKEND_UNBOUND from an unprobed gate too, so neither route is dead', () => {
      // `NEVER_PROBED` is still reachable — `observeSyncItems` runs AFTER
      // `attachGateway` returns, so a composition whose attach threw records the
      // gate and leaves the probe unread — and an unbound port withholds there
      // as well. What changed is that this is no longer the ONLY route to the
      // cause, which is what made it dead for every attached gateway.
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.record({ ...MET, syncingServerGrpcBound: false, filesAdvertised: true, gatewayAttached: false })

      expect(recorder.report().syncItems).toMatchObject({
        state: 'WITHHELD',
        cause: 'DURABLE_BACKEND_UNBOUND',
        probe: 'NEVER_PROBED',
      })

      // ...and a BOUND port with no probe still claims nothing at all.
      recorder.record({ ...MET, filesAdvertised: true, gatewayAttached: false })
      expect(recorder.report().syncItems).toMatchObject({ state: 'NOT_OBSERVED', cause: 'NEVER_PROBED' })
    })

    it('will not claim a port is unbound from a gate that recorded nothing', () => {
      // The unrecorded path used to pass `durableBackendBound: false`, which was
      // a fabrication that cost nothing while every negative probe shared one
      // cause. Now that `false` NAMES a configuration fault, an absent reading
      // has to stay absent: `WITHHELD` is still correct (the backend refused),
      // but "this deployment binds no durable port" is not something an
      // unrecorded gate observed.
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.observeSyncItems(laneWhose(() => false))

      const report = recorder.report()
      expect(report.recorded).toBe(false)
      expect(report.syncItemsAdvertised).toBe(false)
      expect(report.syncItems.state).toBe('WITHHELD')
      expect(report.syncItems.cause).toBe('DURABLE_BACKEND_NOT_READY')
      expect(report.syncItems.cause).not.toBe('DURABLE_BACKEND_UNBOUND')
    })

    it('records a lane that was never built as an answer, not as an unknown', () => {
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.record({ ...MET, filesAdvertised: false, gatewayAttached: true })
      expect(recorder.observeSyncItems(undefined)).toBeUndefined()

      const report = recorder.report()
      expect(report.syncItemsAdvertised).toBe(false)
      expect(report.syncItems.state).toBe('WITHHELD')
      expect(report.syncItems.cause).toBe('SYNC_LANE_NOT_BUILT')
      expect(report.syncItems.probe).toBe('NO_LANE')
    })

    it('treats a predicate that throws as unknown, never as available', () => {
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.record({ ...MET, filesAdvertised: true, gatewayAttached: true })
      recorder.observeSyncItems(
        laneWhose(() => {
          throw new Error('grpc://syncing.internal.example:50051 unreachable')
        }),
      )

      const report = recorder.report()
      expect(report.syncItems.state).toBe('NOT_OBSERVED')
      expect(report.syncItems.cause).toBe('PROBE_FAILED')
      expect('syncItemsAdvertised' in report).toBe(false)
      // The thrown value is dropped rather than carried: it can embed a
      // resolved service address.
      expect(JSON.stringify(report)).not.toContain('internal.example')
    })

    it('withholds SYNC_ITEMS over a lane the gate closed, however ready the backend is', () => {
      // Nothing is negotiated over a socket that never opens, so the lane's own
      // conditions outrank the backend reading and are the cause reported.
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.record({ ...MET, redisBound: false, sharedState: 'none', filesAdvertised: false })
      recorder.observeSyncItems(laneWhose(() => true))

      const report = recorder.report()
      expect(report.syncLaneEnabled).toBe(false)
      expect(report.syncItemsAdvertised).toBe(false)
      expect(report.syncItems.state).toBe('WITHHELD')
      expect(report.syncItems.cause).toBe('LANE_PRECONDITION_UNMET')
      expect(report.syncItems.probe).toBe('READY')
    })

    it('keeps the probed verdict through every later whole-record patch', () => {
      // Both composition roots re-record the ENTIRE observation as boot
      // proceeds (files, then the attach outcome). A verdict living inside that
      // object would be erased by whichever patch landed next, which is why the
      // probe has its own slot that `record()` never touches.
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.record({ ...MET, filesAdvertised: false })
      recorder.observeSyncItems(laneWhose(() => true))
      recorder.record({ ...MET, filesAdvertised: true })
      recorder.record({ ...MET, filesAdvertised: true, gatewayAttached: true })

      expect(recorder.report().syncItems.state).toBe('ADVERTISED')
      expect(recorder.report().syncItemsAdvertised).toBe(true)
    })

    it('hands back the very lane it probed, so the gateway cannot be given a different one', () => {
      const recorder = new SyncGateDiagnosticsRecorder()
      const lane = laneWhose(() => true)

      expect(recorder.observeSyncItems(lane)).toBe(lane)
    })

    it('reads a given lane ONCE: a second observation cannot change or weaken the verdict', () => {
      // The probe is called from the shared attach seam; a host (or a future
      // one) that also probes must be harmless. Re-reading cannot help --
      // every input to `ready()` is fixed at process start -- and it can harm:
      // a second call that threw would replace a definite answer with
      // "unknown", which the panel renders as no claim at all.
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.record({ ...MET, filesAdvertised: true, gatewayAttached: true })
      let reads = 0
      const lane = laneWhose(() => {
        if (reads++ > 0) {
          throw new Error('grpc://syncing.internal.example:50051 unreachable')
        }
        return true
      })

      expect(recorder.observeSyncItems(lane)).toBe(lane)
      const first = recorder.report()
      // Same lane, twice more, including the call that would throw.
      expect(recorder.observeSyncItems(lane)).toBe(lane)
      expect(recorder.observeSyncItems(lane)).toBe(lane)

      expect(reads).toBe(1)
      expect(recorder.report()).toEqual(first)
      expect(recorder.report().syncItems).toEqual({
        state: 'ADVERTISED',
        cause: null,
        remedy: null,
        probe: 'READY',
      })
    })

    it('reads a DIFFERENT lane afresh, so no verdict outlives the lane it was taken from', () => {
      // Scoped per lane, not "already probed at all". A blanket first-wins
      // flag would let a reading survive its lane: an in-process host that
      // stops and restarts its gateway (HomeServer is a library, not only a
      // process) would keep the previous boot's verdict, and a boot that built
      // no lane would still read READY -- a false ADVERTISED, which is the one
      // failure direction this whole block exists to rule out.
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.record({ ...MET, filesAdvertised: true, gatewayAttached: true })

      recorder.observeSyncItems(laneWhose(() => true))
      expect(recorder.report().syncItems.state).toBe('ADVERTISED')

      recorder.observeSyncItems(laneWhose(() => false))
      expect(recorder.report().syncItems).toMatchObject({
        state: 'WITHHELD',
        cause: 'DURABLE_BACKEND_NOT_READY',
        probe: 'NOT_READY',
      })

      // ...and a restart that builds no lane at all withdraws the claim too.
      recorder.observeSyncItems(undefined)
      expect(recorder.report().syncItems).toMatchObject({ state: 'WITHHELD', cause: 'SYNC_LANE_NOT_BUILT' })
    })

    it('forgets which lanes it read on clear(), leaving a recorder indistinguishable from a fresh one', () => {
      const recorder = new SyncGateDiagnosticsRecorder()
      const lane = laneWhose(() => true)
      recorder.record({ ...MET, filesAdvertised: true, gatewayAttached: true })

      recorder.observeSyncItems(lane)
      recorder.clear()
      expect(recorder.report().syncItems.probe).toBe('NEVER_PROBED')

      // The SAME lane is readable again: `clear()` resets the reading and the
      // record of having read it, or a spec (and a restarted embedded host)
      // could never take a second one.
      recorder.record({ ...MET, filesAdvertised: true, gatewayAttached: true })
      recorder.observeSyncItems(lane)
      expect(recorder.report().syncItems.state).toBe('ADVERTISED')
    })

    it('answers an unrecorded gate as unknown, and clear() forgets the probe', () => {
      const recorder = new SyncGateDiagnosticsRecorder()

      // A request that landed during boot: nothing recorded, nothing probed.
      expect(recorder.report().syncItems).toEqual({
        state: 'NOT_OBSERVED',
        cause: 'GATE_NOT_RECORDED',
        remedy: SYNC_ITEMS_CAUSE_REMEDIES.GATE_NOT_RECORDED,
        probe: 'NEVER_PROBED',
      })
      expect('syncItemsAdvertised' in recorder.report()).toBe(false)

      // A probe can still settle it negatively before the gate is recorded: a
      // backend that refuses offers nothing whatever the gate would have said.
      recorder.observeSyncItems(laneWhose(() => false))
      expect(recorder.report()).toMatchObject({
        recorded: false,
        syncItemsAdvertised: false,
        syncItems: { state: 'WITHHELD', cause: 'DURABLE_BACKEND_NOT_READY' },
      })

      recorder.clear()
      expect(recorder.report().syncItems.probe).toBe('NEVER_PROBED')
    })

    it('carries only closed-enum states and constant copy, never a configured value', () => {
      // The security boundary for the new block, held structurally: every
      // remedy it can emit is one of the frozen constants (or the shared
      // precondition module's own), and every state is from the closed set.
      const recorder = new SyncGateDiagnosticsRecorder()
      const constants = new Set<string | null>([...Object.values(SYNC_ITEMS_CAUSE_REMEDIES), null])
      for (const bound of [true, false]) {
        for (const probe of [undefined, laneWhose(() => true), laneWhose(() => false)]) {
          recorder.clear()
          recorder.record({ ...MET, syncingServerGrpcBound: bound, filesAdvertised: bound })
          if (probe !== undefined) {
            recorder.observeSyncItems(probe)
          }
          const { syncItems, unmetPreconditions } = recorder.report()
          expect(['ADVERTISED', 'WITHHELD', 'NOT_OBSERVED']).toContain(syncItems.state)
          const shared = unmetPreconditions.map(({ remedy }) => remedy)
          expect(constants.has(syncItems.remedy) || shared.includes(syncItems.remedy as string)).toBe(true)
        }
      }
    })
  })
})
