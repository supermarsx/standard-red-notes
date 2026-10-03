import type {
  AttachedGateway,
  AttachOptions,
  SyncGatewayAccess,
  SyncGatewayOptions,
} from '@standard-red-notes/websocket-gateway'

import {
  SYNC_ITEMS_CAUSE_REMEDIES,
  SyncGateDiagnosticsRecorder,
  syncGateDiagnostics,
  type SyncGateObservation,
} from './SyncGateDiagnostics'
import { SyncWebSocketAccessService } from './SyncWebSocketAccessService'
import { SyncWebSocketRuntime, WebSocketGatewayAccessService } from './SyncWebSocketRuntime'

/**
 * A sync lane as a composition root builds one, typed as the gateway's own
 * option shape so the probed member cannot drift from the one the handshake
 * reads. `backend.ready()` is the WHOLE of what syncCommandHandler consults
 * before putting SYNC_ITEMS in the AUTHENTICATED operation list.
 */
const laneWhose = (ready: () => boolean): SyncGatewayOptions => ({
  isEnabled: () => true,
  allowedOrigins: [],
  authorization: { ready: () => true, authorize: async () => ({ authorized: true }) },
  backend: { ready, execute: jest.fn(), status: jest.fn() },
})

/** Only `sync` is load-bearing here; the attach itself is a double. */
const attachOptions = (sync: SyncGatewayOptions | undefined): AttachOptions => ({ sync }) as unknown as AttachOptions

/** Everything the shared gate asks for, satisfied, with the attach recorded. */
const GATE_MET: SyncGateObservation = {
  connectionTokenSecretPresent: true,
  webSocketSyncEnabled: true,
  redisBound: true,
  syncingServerGrpcBound: true,
  filesAdvertised: true,
  gatewayAttached: true,
}

describe('SyncWebSocketRuntime', () => {
  const provider = (): SyncGatewayAccess => ({
    capabilities: () => ({ capabilities: [] }),
    issueTicket: jest.fn(),
  })

  // Every attach through this runtime takes a SYNC_ITEMS reading, including the
  // ones above that attach no lane, so the process-global recorder is reset
  // around each test rather than carrying one test's verdict into the next.
  beforeEach(() => {
    syncGateDiagnostics.clear()
  })

  afterEach(() => {
    syncGateDiagnostics.clear()
  })

  it('publishes the provider only after attach succeeds', () => {
    const access = new SyncWebSocketAccessService()
    const expected = provider()
    const attach = jest.fn(
      () => ({ sync: expected, stop: jest.fn(), handleMintToken: jest.fn() }) as unknown as AttachedGateway,
    )
    const gatewayAccess = new WebSocketGatewayAccessService()
    const runtime = new SyncWebSocketRuntime(access, attach, gatewayAccess)

    runtime.attach({} as AttachOptions)

    expect(access.capabilities()).toEqual(expected.capabilities())
    expect(runtime.isActive()).toBe(true)
    expect(gatewayAccess.mintConnectionToken({} as never, {} as never)).toBe(true)
  })

  it('does not publish a provider when attach fails', () => {
    const access = new SyncWebSocketAccessService()
    const runtime = new SyncWebSocketRuntime(
      access,
      () => {
        throw new Error('attach failed')
      },
      new WebSocketGatewayAccessService(),
    )

    expect(() => runtime.attach({} as AttachOptions)).toThrow('attach failed')
    expect(access.capabilities()).toEqual({ capabilities: [] })
    expect(runtime.isActive()).toBe(false)
  })

  it('clears capability access before awaiting gateway drain and coalesces stop', async () => {
    const access = new SyncWebSocketAccessService()
    const expected = provider()
    let finish!: () => void
    const stop = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const gatewayAccess = new WebSocketGatewayAccessService()
    const runtime = new SyncWebSocketRuntime(
      access,
      () => ({ sync: expected, stop }) as unknown as AttachedGateway,
      gatewayAccess,
    )
    runtime.attach({} as AttachOptions)

    const first = runtime.stop()
    const second = runtime.stop()
    expect(access.capabilities()).toEqual({ capabilities: [] })
    expect(gatewayAccess.mintConnectionToken({} as never, {} as never)).toBe(false)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(runtime.isActive()).toBe(true)

    finish()
    await Promise.all([first, second])
    expect(runtime.isActive()).toBe(false)
  })

  // -------------------------------------------------------------------------
  // The admin gate's SYNC_ITEMS verdict is measured HERE, at the one seam
  // every host's lane must pass through to exist.
  //
  // It was first wired in the api-gateway's composition root, which had two
  // holes: the bundled home server attaches through its own boot path and so
  // reported a verdict it had never measured (it recorded "the durable backend
  // is in-process, satisfied by construction" and the pane showed green over a
  // lane that withholds SYNC_ITEMS whenever AUTH_JWT_SECRET is empty), and
  // `bin/server.ts` has no spec, so deleting the call was invisible to every
  // gate. Both close here: no host code is involved, and the mutations below
  // each fail a test.
  // -------------------------------------------------------------------------
  describe('the SYNC_ITEMS verdict is measured at the attach seam', () => {
    const attached = (): AttachedGateway =>
      ({ sync: provider(), stop: jest.fn(), handleMintToken: jest.fn() }) as unknown as AttachedGateway

    const runtimeWith = (
      recorder: SyncGateDiagnosticsRecorder,
      attach: () => AttachedGateway = attached,
    ): SyncWebSocketRuntime =>
      new SyncWebSocketRuntime(new SyncWebSocketAccessService(), attach, new WebSocketGatewayAccessService(), recorder)

    it('reads the handshake predicate off the lane it hands the gateway', () => {
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.record(GATE_MET)

      runtimeWith(recorder).attach(attachOptions(laneWhose(() => true)))

      expect(recorder.report().syncItems).toEqual({
        state: 'ADVERTISED',
        cause: null,
        remedy: null,
        probe: 'READY',
      })
      expect(recorder.report().syncItemsAdvertised).toBe(true)
    })

    it('withholds SYNC_ITEMS when the backend behind the lane refuses, lane and gate otherwise green', () => {
      // The original bug, from the host that never probed: everything the gate
      // can see is satisfied — including the BOUND durable proxy — and the
      // handshake still offers nothing, so clients sync items over HTTP.
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.record(GATE_MET)

      runtimeWith(recorder).attach(attachOptions(laneWhose(() => false)))

      const report = recorder.report()
      expect(report.syncLaneEnabled).toBe(true)
      expect(report.unmetCodes).toEqual([])
      expect(report.syncItemsAdvertised).toBe(false)
      expect(report.syncItems.state).toBe('WITHHELD')
      expect(report.syncItems.cause).toBe('DURABLE_BACKEND_NOT_READY')
      expect(report.syncItems.probe).toBe('NOT_READY')
    })

    it('attributes the SAME refusal to the unbound port when the gate saw none bound', () => {
      // t108. This is the state the live stack reaches with SERVICE_PROXY_TYPE
      // unset, or with the gRPC listener unreachable: the adapter's `ready()`
      // is false because `durableSync === undefined`, the probe reads NOT_READY,
      // and the cause has to be the unbound port rather than "bound but failed
      // its readiness check" — the pane was sending operators after the internal
      // gRPC secret for a deployment that had no port for a secret to protect.
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.record({ ...GATE_MET, syncingServerGrpcBound: false })

      runtimeWith(recorder).attach(attachOptions(laneWhose(() => false)))

      const report = recorder.report()
      // The lane is up — five other operations negotiate — and the condition
      // list names the real fault, which the cause now agrees with.
      expect(report.syncLaneEnabled).toBe(true)
      expect(report.unmetCodes).toEqual(['SYNCING_SERVER_GRPC_UNBOUND'])
      expect(report.syncItemsAdvertised).toBe(false)
      expect(report.syncItems.probe).toBe('NOT_READY')
      expect(report.syncItems.cause).toBe('DURABLE_BACKEND_UNBOUND')
      expect(report.syncItems.remedy).toContain('SERVICE_PROXY_TYPE=grpc')
      expect(report.syncItems.remedy).not.toContain('SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET')
      // ...and the same attach with the port bound still reports the other
      // cause, so the reading is attributable to bound-ness alone.
      expect(SYNC_ITEMS_CAUSE_REMEDIES.DURABLE_BACKEND_NOT_READY).not.toBe(report.syncItems.remedy)
    })

    it('records a lane-less attach as an answer, not as an unknown', () => {
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.record({ ...GATE_MET, filesAdvertised: false })

      runtimeWith(recorder).attach(attachOptions(undefined))

      expect(recorder.report().syncItems).toMatchObject({
        state: 'WITHHELD',
        cause: 'SYNC_LANE_NOT_BUILT',
        probe: 'NO_LANE',
      })
    })

    it('makes no claim at all when the attach itself fails', () => {
      // The reading is taken AFTER the gateway attached, so a composition whose
      // attach threw cannot report SYNC_ITEMS as advertised over a socket that
      // never opened. Probing before the attach is exactly what the previous
      // wiring did.
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.record(GATE_MET)
      const runtime = runtimeWith(recorder, () => {
        throw new Error('attach failed')
      })

      expect(() => runtime.attach(attachOptions(laneWhose(() => true)))).toThrow('attach failed')

      const report = recorder.report()
      expect(report.syncItems).toEqual({
        state: 'NOT_OBSERVED',
        cause: 'NEVER_PROBED',
        remedy: SYNC_ITEMS_CAUSE_REMEDIES.NEVER_PROBED,
        probe: 'NEVER_PROBED',
      })
      // ABSENT, not false: "could not determine" must not render as "withheld".
      expect('syncItemsAdvertised' in report).toBe(false)
    })

    it('treats a predicate that throws as unknown, never as available, and drops the thrown value', () => {
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.record(GATE_MET)
      const runtime = runtimeWith(recorder)

      expect(() =>
        runtime.attach(
          attachOptions(
            laneWhose(() => {
              throw new Error('grpc://syncing.internal.example:50051 unreachable')
            }),
          ),
        ),
      ).not.toThrow()

      const report = recorder.report()
      expect(report.syncItems.state).toBe('NOT_OBSERVED')
      expect(report.syncItems.cause).toBe('PROBE_FAILED')
      expect('syncItemsAdvertised' in report).toBe(false)
      expect(JSON.stringify(report)).not.toContain('internal.example')
      // The gateway is still attached and owned: a diagnostic that could not
      // read its own probe must not take the realtime lane down with it.
      expect(runtime.isActive()).toBe(true)
    })

    it('writes the reading to the process-global recorder the admin endpoint reads', () => {
      // Both composition roots construct this runtime with no arguments, so
      // the default-bound recorder is the one that has to receive the reading;
      // an injected-only probe would be green here and dead in production.
      syncGateDiagnostics.record(GATE_MET)

      new SyncWebSocketRuntime(new SyncWebSocketAccessService(), attached, new WebSocketGatewayAccessService()).attach(
        attachOptions(laneWhose(() => true)),
      )

      expect(syncGateDiagnostics.report().syncItemsAdvertised).toBe(true)
      expect(syncGateDiagnostics.report().syncItems.probe).toBe('READY')
    })

    it('keeps the first reading when the same lane is attached again', async () => {
      // Idempotent at the seam: a host that also probes, or one that re-attaches
      // the same lane, must not be able to move the verdict — least of all
      // downgrade a definite reading to "unknown" because the second call threw.
      const recorder = new SyncGateDiagnosticsRecorder()
      recorder.record(GATE_MET)
      let reads = 0
      const lane = laneWhose(() => {
        if (reads++ > 0) {
          throw new Error('grpc://syncing.internal.example:50051 unreachable')
        }
        return true
      })
      const runtime = runtimeWith(recorder)

      runtime.attach(attachOptions(lane))
      expect(recorder.report().syncItems.state).toBe('ADVERTISED')

      await runtime.stop()
      runtime.attach(attachOptions(lane))

      expect(reads).toBe(1)
      expect(recorder.report().syncItems).toEqual({
        state: 'ADVERTISED',
        cause: null,
        remedy: null,
        probe: 'READY',
      })
    })
  })
})

describe('WebSocketGatewayAccessService in-process mint and health', () => {
  const authenticated = { user: { uuid: 'u-1' }, session: { uuid: 's-1' }, authToken: 'signed-auth' }

  it('returns undefined when no gateway is attached', () => {
    const service = new WebSocketGatewayAccessService()

    expect(service.mintConnectionTokenFor(authenticated)).toBeUndefined()
    expect(service.health()).toBeUndefined()
  })

  // R4: the synthetic request carries ONLY the forwarded cross-service token;
  // nothing from the inbound client request reaches the mint handler.
  it('mints through the attached gateway with the forwarded x-auth-token and captures the answer', () => {
    const handleMintToken = jest.fn((request, response) => {
      expect(request.headers).toEqual({ 'x-auth-token': 'signed-auth' })
      expect(request.body).toEqual({ userUuid: 'u-1', sessionUuid: 's-1' })
      response.writeHead(200).end(JSON.stringify({ token: 'ws-token' }))
    })
    const service = new WebSocketGatewayAccessService()
    service.setProvider({ handleMintToken } as unknown as AttachedGateway)

    expect(service.mintConnectionTokenFor(authenticated)).toEqual({ statusCode: 200, json: { token: 'ws-token' } })
  })

  it.each([
    ['no user', { session: { uuid: 's-1' }, authToken: 't' }],
    ['no session', { user: { uuid: 'u-1' }, authToken: 't' }],
    ['no cross-service token', { user: { uuid: 'u-1' }, session: { uuid: 's-1' } }],
  ])('declines to mint with %s so the caller can fall back', (_label, locals) => {
    const handleMintToken = jest.fn()
    const service = new WebSocketGatewayAccessService()
    service.setProvider({ handleMintToken } as unknown as AttachedGateway)

    expect(service.mintConnectionTokenFor(locals)).toBeUndefined()
    expect(handleMintToken).not.toHaveBeenCalled()
  })

  it('reports a non-JSON gateway body as 502 and an empty body as an empty object', () => {
    const service = new WebSocketGatewayAccessService()
    service.setProvider({
      handleMintToken: (_request: unknown, response: { writeHead(s: number): unknown; end(b?: string): void }) => {
        response.writeHead(200)
        response.end('not json')
      },
    } as unknown as AttachedGateway)
    expect(service.mintConnectionTokenFor(authenticated)).toEqual({ statusCode: 502, json: expect.anything() })

    service.setProvider({
      handleMintToken: (_request: unknown, response: { writeHead(s: number): unknown; end(b?: string): void }) => {
        response.writeHead(204)
        response.end()
      },
    } as unknown as AttachedGateway)
    expect(service.mintConnectionTokenFor(authenticated)).toEqual({ statusCode: 204, json: {} })
  })

  // C9: readiness and the admin diagnostics read the gateway's health through
  // this late-bound seam; a gateway build without health() reads as unattached.
  it('passes the attached gateway health through and tolerates a gateway without health()', () => {
    const health = {
      attached: true as const,
      pushBridge: 'redis' as const,
      pushBridgeReady: true,
      sqsConsumerRunning: false,
      collaborationRelayHealthy: true,
      syncLane: 'up' as const,
      pushesDispatched: 7,
    }
    const service = new WebSocketGatewayAccessService()
    service.setProvider({ health: () => health } as unknown as AttachedGateway)
    expect(service.health()).toEqual(health)

    service.setProvider({} as unknown as AttachedGateway)
    expect(service.health()).toBeUndefined()
  })
})
