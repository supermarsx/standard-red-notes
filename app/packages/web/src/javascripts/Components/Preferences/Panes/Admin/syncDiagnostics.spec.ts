import {
  BOOT_GATE_HEADER,
  buildCapabilityRows,
  CLIENT_RECOGNIZED_ONLY_OPERATIONS,
  CLIENT_SYNC_OPERATIONS,
  describeDeployment,
  describeRealtimeHealth,
  describeTransport,
  diagnose,
  REALTIME_UNATTACHED_NOTE,
  sanitizeServerCopy,
  summarizeTestRun,
  type SyncDiagnosticsPayload,
  type TransportStatusInput,
} from './syncDiagnostics'

/**
 * The redactor is the second line behind the server's presence-only contract. It
 * is tested from both directions, because over-redaction is a real cost too: it
 * would quietly mangle the variable names and version tokens that are the whole
 * point of the panel.
 */
describe('sanitizeServerCopy', () => {
  it.each([
    ['redis://admin:hunter2@redis.internal.example:6379', 'a connection URL with credentials'],
    ['https://notes.internal.example/v1/sockets', 'an https URL'],
    ['syncing.internal.example:50051', 'a host and port'],
    ['files.internal:3104', 'a two-label host with a port'],
    ['10.4.2.9', 'a bare IPv4 address'],
    ['10.4.2.9:6379', 'an IPv4 address with a port'],
  ])('redacts %s (%s)', (value) => {
    const output = sanitizeServerCopy(`the backend at ${value} refused`)

    expect(output).not.toContain(value)
    expect(output).toContain('[address withheld]')
  })

  it.each([
    'set SYNCING_SERVER_GRPC_URL so realtime commands have a durable backend',
    'WEBSOCKET_SYNC_ENABLED is set to the exact string "false"',
    'running revision 4f0e788e2b1c9d0a5e6f7a8b9c0d1e2f3a4b5c6d',
    'version src-4f0e788e2b1c',
    'version 1.2.3',
    'REDIS_URL (or REDIS_HOST/REDIS_PORT)',
    'e.g. the port is 6379',
  ])('leaves ordinary diagnostic copy alone: %s', (copy) => {
    expect(sanitizeServerCopy(copy)).toBe(copy)
  })
})

/**
 * The wording of a diagnosis is the product here, so it is tested directly.
 * These cases are drawn from the states this deployment has actually been in —
 * an empty capability list with no stated reason, a 503 SYNC_DISABLED, a blank
 * deployment marker — because those are the ones the panel exists to explain.
 */
describe('sync diagnostics model', () => {
  const gateSatisfied: SyncDiagnosticsPayload = {
    gate: { recorded: true, gatewayAttached: true, syncLaneEnabled: true, unmetPreconditions: [], unmetCodes: [] },
    live: { capabilities: [{ id: 'ws-sync' }], unavailabilityReasons: [], ticketAvailable: true },
    protocol: { version: 1, serverOperations: [...CLIENT_SYNC_OPERATIONS] },
  }

  describe('describeTransport', () => {
    it('reports HTTP when no transport is installed at all', () => {
      const verdict = describeTransport(undefined)

      expect(verdict.label).toBe('HTTP')
      expect(verdict.tone).toBe('warn')
      expect(verdict.detail).toContain('nothing to fall back FROM')
    })

    it('distinguishes never-attempted HTTP from a fallback', () => {
      expect(describeTransport({ state: 'HTTP_ONLY', operations: [] }).detail).toContain('never entered')
      expect(describeTransport({ state: 'HTTP_FALLBACK', operations: [] }).detail).toContain('attempted and abandoned')
    })

    /**
     * This case used to assert on `'ticket-refused'` — a code the transport has
     * never been able to emit. While `fallbackReason` was typed `string`,
     * neither the compiler nor a green run could tell, so the panel was pinned
     * to a fiction. The field is now `SyncFallbackReason`, which is what makes
     * a made-up code here a compile error rather than a passing test.
     */
    it('appends the transport’s own fallback reason when it has one', () => {
      const verdict = describeTransport({ state: 'HTTP_FALLBACK', fallbackReason: 'ticket-expired', operations: [] })

      expect(verdict.detail).toContain('ticket-expired')
      expect(verdict.detail).toContain('aged out')
    })

    it('explains what a fallback code MEANS, so the operator is not left holding a token', () => {
      const verdict = describeTransport({ state: 'HTTP_ONLY', fallbackReason: 'live-sync-disabled', operations: [] })

      // The one reason that is a deliberate administrative decision rather than
      // a fault. Naming the flag is what connects it to the switch that set it.
      expect(verdict.detail).toContain('live-sync-disabled')
      expect(verdict.detail).toContain('LIVE_SYNC_ENABLED')
      expect(verdict.detail).toContain('administrator')
    })

    it('says nothing extra when the transport reported no reason', () => {
      expect(describeTransport({ state: 'HTTP_ONLY', operations: [] }).detail).not.toContain('Reported reason')
    })

    it('reports a live socket as good', () => {
      expect(describeTransport({ state: 'READY', operations: ['SYNC_ITEMS'] }).tone).toBe('good')
    })
  })

  /**
   * N32. The header is the first sentence an operator reads on the Boot gate
   * section, and it said "All four must hold; a single unmet condition turns the
   * whole lane off" long after that stopped being true — directly above a chip
   * reading "Lane up". A panel that contradicts itself in adjacent elements is
   * not a panel anyone acts on.
   */
  describe('BOOT_GATE_HEADER', () => {
    it('states the split gate: three conditions close the lane, the fourth withholds SYNC_ITEMS', () => {
      expect(BOOT_GATE_HEADER).toContain('THREE')
      expect(BOOT_GATE_HEADER).toContain('SYNC_ITEMS ONLY')
      expect(BOOT_GATE_HEADER).toContain('falls back to HTTP')
    })

    it('no longer claims one unmet condition turns the whole lane off', () => {
      expect(BOOT_GATE_HEADER).not.toContain('All four must hold')
      expect(BOOT_GATE_HEADER).not.toContain('turns the whole lane off')
    })
  })

  describe('diagnose', () => {
    it('names the specific missing configuration item, not the category', () => {
      const diagnosis = diagnose(
        {
          gate: {
            recorded: true,
            unmetPreconditions: [
              {
                code: 'SYNCING_SERVER_GRPC_UNBOUND',
                remedy: 'configure SYNCING_SERVER_GRPC_URL so realtime commands have a durable backend',
              },
            ],
            unmetCodes: ['SYNCING_SERVER_GRPC_UNBOUND'],
          },
          live: { capabilities: [], unavailabilityReasons: ['sync-not-configured'], ticketAvailable: false },
          protocol: { version: 1, serverOperations: [...CLIENT_SYNC_OPERATIONS] },
        },
        { state: 'HTTP_ONLY', operations: [] },
      )

      expect(diagnosis.tone).toBe('bad')
      expect(diagnosis.headline).toContain('running over HTTP')
      expect(diagnosis.findings).toHaveLength(1)
      expect(diagnosis.findings[0].title).toBe('SYNCING_SERVER_GRPC_UNBOUND')
      expect(diagnosis.findings[0].detail).toContain('SYNCING_SERVER_GRPC_URL')
    })

    it('lists every unmet condition, so fixing one does not reveal the next on the next restart', () => {
      const diagnosis = diagnose(
        {
          gate: {
            recorded: true,
            unmetPreconditions: [
              { code: 'REDIS_UNBOUND', remedy: 'configure REDIS_URL' },
              { code: 'SYNCING_SERVER_GRPC_UNBOUND', remedy: 'configure SYNCING_SERVER_GRPC_URL' },
            ],
            unmetCodes: ['REDIS_UNBOUND', 'SYNCING_SERVER_GRPC_UNBOUND'],
          },
          live: { unavailabilityReasons: ['sync-not-configured'], ticketAvailable: false },
          protocol: { serverOperations: [...CLIENT_SYNC_OPERATIONS] },
        },
        { state: 'HTTP_ONLY', operations: [] },
      )

      expect(diagnosis.findings.map((finding) => finding.title)).toEqual([
        'REDIS_UNBOUND',
        'SYNCING_SERVER_GRPC_UNBOUND',
      ])
    })

    it('suppresses live refusal reasons that merely restate an unmet boot condition', () => {
      const diagnosis = diagnose(
        {
          gate: { recorded: true, unmetPreconditions: [{ code: 'REDIS_UNBOUND', remedy: 'configure REDIS_URL' }] },
          live: {
            unavailabilityReasons: ['sync-not-configured', 'durable-backend-unavailable'],
            ticketAvailable: false,
          },
          protocol: { serverOperations: [...CLIENT_SYNC_OPERATIONS] },
        },
        { state: 'HTTP_ONLY', operations: [] },
      )

      expect(diagnosis.findings.map((finding) => finding.title)).toEqual(['REDIS_UNBOUND'])
    })

    it('surfaces live refusal reasons once the boot gate itself is satisfied', () => {
      const diagnosis = diagnose(
        {
          ...gateSatisfied,
          live: { capabilities: [], unavailabilityReasons: ['no-allowed-origins'], ticketAvailable: false },
        },
        { state: 'HTTP_FALLBACK', operations: [] },
      )

      expect(diagnosis.findings[0].title).toBe('no-allowed-origins')
      expect(diagnosis.findings[0].detail).toContain('WEBSOCKET_SYNC_ALLOWED_ORIGINS')
    })

    /**
     * The screen an invalid WEBSOCKET_REDIS_NAMESPACE produced: the host refuses
     * to attach and closes the push bridge, and the panel reported the lane
     * ENABLED, the gateway UNATTACHED and an EMPTY condition list — wrong in
     * every field at once, with nothing for the operator to search for.
     */
    it('names a host-recorded condition the shared list left out', () => {
      const diagnosis = diagnose(
        {
          gate: {
            recorded: true,
            gatewayAttached: false,
            syncLaneEnabled: false,
            unmetPreconditions: [],
            unmetCodes: [],
            host: {
              unmetCondition: 'WEBSOCKET_REDIS_NAMESPACE_INVALID',
              remedy: 'WEBSOCKET_REDIS_NAMESPACE is set but does not match the allowed pattern; fix or unset it',
            },
          },
          live: { unavailabilityReasons: [], ticketAvailable: false },
          protocol: { serverOperations: [...CLIENT_SYNC_OPERATIONS] },
        },
        { state: 'HTTP_ONLY', operations: [] },
      )

      expect(diagnosis.findings.map((finding) => finding.title)).toContain('WEBSOCKET_REDIS_NAMESPACE_INVALID')
      expect(diagnosis.tone).toBe('bad')
    })

    it('does not print a host condition twice when the server already merged it in', () => {
      const code = 'WEBSOCKET_REDIS_NAMESPACE_INVALID'
      const diagnosis = diagnose(
        {
          gate: {
            recorded: true,
            gatewayAttached: false,
            syncLaneEnabled: false,
            unmetPreconditions: [{ code, remedy: 'fix or unset it' }],
            unmetCodes: [code],
            host: { unmetCondition: code, remedy: 'fix or unset it' },
          },
          live: { unavailabilityReasons: [], ticketAvailable: false },
          protocol: { serverOperations: [...CLIENT_SYNC_OPERATIONS] },
        },
        { state: 'HTTP_ONLY', operations: [] },
      )

      expect(diagnosis.findings.filter((finding) => finding.title === code)).toHaveLength(1)
    })

    it('reports a lane called enabled over a gateway that never attached', () => {
      const diagnosis = diagnose(
        { ...gateSatisfied, gate: { ...gateSatisfied.gate, gatewayAttached: false } },
        { state: 'HTTP_ONLY', operations: [] },
      )

      const finding = diagnosis.findings.find((entry) => entry.title.includes('no attached gateway'))
      expect(finding).toBeDefined()
      // True on an older server too, where the outcome was simply never recorded.
      expect(finding?.detail).toContain('never set')
    })

    it('says nothing about the attach outcome while the gate is unrecorded', () => {
      const diagnosis = diagnose(
        { gate: { recorded: false, gatewayAttached: false, syncLaneEnabled: true } },
        undefined,
      )

      expect(diagnosis.findings.some((entry) => entry.title.includes('no attached gateway'))).toBe(false)
    })

    it('reports an attached gateway with no push bridge, which every other row calls healthy', () => {
      const diagnosis = diagnose(
        {
          ...gateSatisfied,
          live: {
            ...gateSatisfied.live,
            realtime: { attached: true, pushBridge: 'none', syncLane: 'up', pushesDispatched: 0 },
          },
        },
        { state: 'READY', operations: [...CLIENT_SYNC_OPERATIONS] },
      )

      const finding = diagnosis.findings.find((entry) => entry.title.includes('no push bridge'))
      expect(finding).toBeDefined()
      expect(finding?.detail).toContain('never reaches another')
      // `'none'` is a misconfiguration, not a topology — since the in-process
      // plane landed, a deployment without Redis reports `'in-process'` and is
      // healthy. Telling that operator they have no Redis would send them to
      // install one they do not need.
      expect(finding?.detail).toContain('misconfiguration rather than a topology')
      expect(finding?.detail).toContain('in-process bridge instead and is healthy')
      expect(finding?.detail).not.toContain('what a deployment with no Redis reports')
    })

    it('raises no push-bridge finding for the in-process plane, which is a healthy single process', () => {
      const diagnosis = diagnose(
        {
          ...gateSatisfied,
          live: {
            ...gateSatisfied.live,
            realtime: { attached: true, pushBridge: 'in-process', pushBridgeReady: true, syncLane: 'up' },
          },
        },
        { state: 'READY', operations: [...CLIENT_SYNC_OPERATIONS] },
      )

      expect(diagnosis.findings).toHaveLength(0)
      expect(diagnosis.tone).toBe('good')
    })

    it('adds no push-bridge finding when a bridge is bound', () => {
      const diagnosis = diagnose(
        {
          ...gateSatisfied,
          live: {
            ...gateSatisfied.live,
            realtime: { attached: true, pushBridge: 'redis', pushBridgeReady: true, syncLane: 'up' },
          },
        },
        { state: 'READY', operations: [...CLIENT_SYNC_OPERATIONS] },
      )

      expect(diagnosis.findings).toHaveLength(0)
      expect(diagnosis.tone).toBe('good')
    })

    it('refuses to present an unrecorded gate as a healthy one', () => {
      const diagnosis = diagnose({ gate: { recorded: false }, live: {}, protocol: {} }, undefined)

      expect(diagnosis.tone).not.toBe('good')
      expect(diagnosis.findings[0].title).toContain('not been recorded')
    })

    it('reports the FILES_V1 sub-gate with its own remedy', () => {
      const diagnosis = diagnose(
        {
          ...gateSatisfied,
          gate: {
            ...gateSatisfied.gate,
            files: { advertised: false, unmetCondition: 'VALET_TOKEN_SECRET', remedy: 'VALET_TOKEN_SECRET is not set' },
          },
        },
        { state: 'READY', operations: ['SYNC_ITEMS'] },
      )

      const finding = diagnosis.findings.find((entry) => entry.title.includes('FILES_V1'))
      expect(finding?.detail).toContain('VALET_TOKEN_SECRET')
      // Files being waived does not make the sync lane unavailable.
      expect(diagnosis.tone).toBe('warn')
    })

    it('flags an operation the server supports and this client does not implement', () => {
      const diagnosis = diagnose(
        { ...gateSatisfied, protocol: { version: 1, serverOperations: [...CLIENT_SYNC_OPERATIONS, 'FUTURE_LANE'] } },
        { state: 'READY', operations: [...CLIENT_SYNC_OPERATIONS] },
      )

      const finding = diagnosis.findings.find((entry) => entry.title.includes('FUTURE_LANE'))
      expect(finding).toBeDefined()
      expect(finding?.detail).toContain('needs a client change')
    })

    it('no longer reports FILES_V1 as advertised-but-inert now that downloads consume it', () => {
      const diagnosis = diagnose(
        { ...gateSatisfied, protocol: { version: 1, serverOperations: [...CLIENT_SYNC_OPERATIONS, 'FILES_V1'] } },
        { state: 'READY', operations: [...CLIENT_SYNC_OPERATIONS, 'FILES_V1'] },
      )

      // Telling an operator that a working file lane carries nothing is the same
      // class of false report as the false failure this screen just shed.
      expect(diagnosis.findings.some((entry) => entry.title.includes('carries nothing'))).toBe(false)
      expect(diagnosis.findings.some((entry) => entry.title.includes('does not implement'))).toBe(false)
      expect(diagnosis.findings).toHaveLength(0)
    })

    it('reports a fully configured deployment as healthy with no findings', () => {
      const diagnosis = diagnose(gateSatisfied, { state: 'READY', operations: [...CLIENT_SYNC_OPERATIONS] })

      expect(diagnosis.tone).toBe('good')
      expect(diagnosis.findings).toHaveLength(0)
    })

    it('explains an unreachable endpoint instead of rendering an empty screen', () => {
      const diagnosis = diagnose(undefined, undefined)

      expect(diagnosis.tone).toBe('bad')
      expect(diagnosis.findings[0].detail).toContain('admin role')
    })
  })

  describe('buildCapabilityRows', () => {
    const socketDown: TransportStatusInput = { state: 'HTTP_ONLY', operations: [] }

    it('marks a genuinely unimplemented server operation as a client gap', () => {
      const rows = buildCapabilityRows([...CLIENT_SYNC_OPERATIONS, 'FUTURE_LANE'], [], false)
      const future = rows.find((row) => row.operation === 'FUTURE_LANE')

      expect(future?.status).toBe('client-gap')
      expect(future?.serverSupported).toBe(true)
      expect(future?.clientImplemented).toBe(false)
      expect(future?.explanation).toContain('not a misconfiguration')
    })

    it('reports a negotiated FILES_V1 as active now that the download lane consumes it', () => {
      // The mirror of the row this panel used to get wrong: while FILES_V1 had no
      // client consumer, calling it active was a confident lie. Now that downloads
      // stream over it, calling it "carries nothing" would be the same lie inverted.
      const rows = buildCapabilityRows(
        [...CLIENT_SYNC_OPERATIONS, 'FILES_V1'],
        [...CLIENT_SYNC_OPERATIONS, 'FILES_V1'],
        true,
      )
      const files = rows.find((row) => row.operation === 'FILES_V1')

      expect(files?.status).toBe('active')
      expect(files?.negotiated).toBe(true)
      expect(files?.clientImplemented).toBe(true)
      expect(files?.explanation).toContain('carrying traffic')
    })

    it('does not claim FILES_V1 is broken when no socket is negotiated at all', () => {
      const rows = buildCapabilityRows([...CLIENT_SYNC_OPERATIONS], [], false)
      const files = rows.find((row) => row.operation === 'FILES_V1')

      expect(files?.clientImplemented).toBe(true)
      expect(files?.status).not.toBe('not-negotiated')
      expect(files?.status).not.toBe('client-gap')
    })

    it('classifies every protocol operation, leaving nothing recognized-only today', () => {
      // An empty recognized-only list is a real state, not a placeholder: it means
      // every operation this build accepts at the handshake also carries traffic.
      // The next server-side lane will land in that bucket and this asserts the
      // panel still has somewhere honest to put it.
      expect([...CLIENT_RECOGNIZED_ONLY_OPERATIONS]).toEqual([])
      expect([...CLIENT_SYNC_OPERATIONS]).toContain('FILES_V1')
    })

    it('never drops an operation that only one side knows about', () => {
      const rows = buildCapabilityRows(['SYNC_ITEMS', 'FILES_V1'], [], false)

      // Every client operation is still listed even though the server reported
      // a shorter list — a row that vanishes is the failure mode this replaces.
      for (const operation of CLIENT_SYNC_OPERATIONS) {
        expect(rows.some((row) => row.operation === operation)).toBe(true)
      }
      expect(rows.some((row) => row.operation === 'FILES_V1')).toBe(true)
    })

    it('does not claim an operation is broken when no socket is negotiated at all', () => {
      const rows = buildCapabilityRows([...CLIENT_SYNC_OPERATIONS], socketDown.operations, false)

      expect(rows.every((row) => row.status !== 'not-negotiated')).toBe(true)
      expect(rows.find((row) => row.operation === 'SYNC_ITEMS')?.explanation).toContain('falls back to HTTP')
    })

    it('does call an operation broken when a socket IS live and it was not offered', () => {
      const rows = buildCapabilityRows([...CLIENT_SYNC_OPERATIONS], ['SYNC_ITEMS'], true)

      expect(rows.find((row) => row.operation === 'SYNC_ITEMS')?.status).toBe('active')
      expect(rows.find((row) => row.operation === 'INVITE_EVENTS')?.status).toBe('not-negotiated')
    })

    it('reports a client-newer-than-server mismatch', () => {
      const rows = buildCapabilityRows(['SYNC_ITEMS'], [], false)

      expect(rows.find((row) => row.operation === 'INVITE_EVENTS')?.explanation).toContain('older than the client')
    })
  })

  /**
   * R38/C9. The health snapshot is reported INFORMATIONALLY — readiness is not
   * gated on it, because a container that restarts itself on a Redis blip turns
   * a ten-second degradation into an outage. These cases pin that the rows say
   * what is degraded AND, just as importantly, when a bad-looking value is
   * normal: an operator who restarts on a "not running" row that was never
   * going to run has been actively misled.
   */
  describe('describeRealtimeHealth', () => {
    it('renders nothing at all when the server reported no snapshot', () => {
      expect(describeRealtimeHealth(undefined)).toEqual([])
      expect(REALTIME_UNATTACHED_NOTE).toContain('predates')
    })

    it('reports a fully healthy gateway as good on every verdict row', () => {
      const rows = describeRealtimeHealth({
        attached: true,
        pushBridge: 'redis',
        pushBridgeReady: true,
        sqsConsumerRunning: true,
        collaborationRelayHealthy: true,
        syncLane: 'up',
        pushesDispatched: 12,
      })

      expect(rows.map((row) => row.label)).toEqual([
        'Gateway',
        'Push bridge',
        'Queue consumer',
        'Collaboration relay',
        'Sync lane',
        'Pushes dispatched',
      ])
      expect(rows.filter((row) => row.tone === 'bad')).toHaveLength(0)
      expect(rows.find((row) => row.label === 'Push bridge')?.value).toBe('redis (ready)')
      expect(rows.find((row) => row.label === 'Pushes dispatched')?.value).toBe('12')
    })

    it('calls an absent push bridge down, and names it a misconfiguration rather than a topology', () => {
      const rows = describeRealtimeHealth({ attached: true, pushBridge: 'none', syncLane: 'up' })
      const bridge = rows.find((row) => row.label === 'Push bridge')

      expect(bridge?.value).toBe('none')
      expect(bridge?.tone).toBe('bad')
      expect(bridge?.note).toContain('never pushed')
      expect(bridge?.note).toContain('misconfiguration rather than a topology')
      // The row and the Overview finding have to agree; they used to both say
      // "a deployment with no Redis reports this", which stopped being true
      // when the in-process plane landed.
      expect(bridge?.note).toContain('in-process bridge instead and is healthy')
      expect(bridge?.note).not.toContain('A deployment with no Redis reports this')
    })

    /**
     * The row this correction exists for. A single container reports
     * `'in-process'`, and the panel must call it healthy — the operator has no
     * Redis and needs none, because delivery is a function call into the
     * registry holding their sockets.
     */
    it('reports an in-process bridge as bound and healthy, not as a missing Redis', () => {
      const rows = describeRealtimeHealth({ attached: true, pushBridge: 'in-process', pushBridgeReady: true })
      const bridge = rows.find((row) => row.label === 'Push bridge')

      expect(bridge?.value).toBe('in-process (ready)')
      expect(bridge?.tone).toBe('good')
      expect(bridge?.note).toContain('no Redis is needed')
      // And it still says what the operator loses by scaling out, because the
      // in-process plane only reaches sockets THIS process holds.
      expect(bridge?.note).toContain('second replica')
      expect(bridge?.note).not.toContain('misconfiguration')
    })

    it('tells a Redis bridge apart from an in-process one, since only one of them crosses replicas', () => {
      const redis = describeRealtimeHealth({ attached: true, pushBridge: 'redis', pushBridgeReady: true })
      const inProcess = describeRealtimeHealth({ attached: true, pushBridge: 'in-process', pushBridgeReady: true })

      const noteOf = (rows: ReturnType<typeof describeRealtimeHealth>) =>
        rows.find((row) => row.label === 'Push bridge')?.note

      expect(noteOf(redis)).toContain('another replica')
      expect(noteOf(redis)).not.toBe(noteOf(inProcess))
    })

    it('treats a bound-but-unready bridge as a reconnect window rather than a fault to act on', () => {
      const rows = describeRealtimeHealth({ attached: true, pushBridge: 'redis', pushBridgeReady: false })
      const bridge = rows.find((row) => row.label === 'Push bridge')

      expect(bridge?.tone).toBe('warn')
      expect(bridge?.note).toContain('nothing here needs a restart')
    })

    it('does not call a stopped queue consumer a failure, because most topologies never start one', () => {
      const rows = describeRealtimeHealth({ attached: true, pushBridge: 'redis', sqsConsumerRunning: false })
      const consumer = rows.find((row) => row.label === 'Queue consumer')

      expect(consumer?.tone).toBe('neutral')
      expect(consumer?.note).toContain('Expected')
    })

    it('names the quiet failure mode of an unhealthy relay: same replica works, so nobody notices', () => {
      const rows = describeRealtimeHealth({ attached: true, collaborationRelayHealthy: false })
      const relay = rows.find((row) => row.label === 'Collaboration relay')

      expect(relay?.tone).toBe('warn')
      expect(relay?.note).toContain('SAME replica')
    })

    it('reports an unattached gateway as down whatever else the snapshot claims', () => {
      const rows = describeRealtimeHealth({ attached: false, pushBridge: 'redis', pushBridgeReady: true })

      expect(rows[0].tone).toBe('bad')
      expect(rows[0].note).toContain('regardless of what the boot gate decided')
    })

    it('reports a down sync lane', () => {
      const rows = describeRealtimeHealth({ attached: true, syncLane: 'down' })
      const lane = rows.find((row) => row.label === 'Sync lane')

      expect(lane?.value).toBe('down')
      expect(lane?.tone).toBe('bad')
    })
  })

  describe('describeDeployment', () => {
    it('reports the explicit unstamped sentinel as a stated fact', () => {
      const view = describeDeployment({ revision: 'unstamped', version: 'unstamped' })

      expect(view.unstamped).toBe(true)
      expect(view.tone).toBe('warn')
      expect(view.note).toContain('did not record a revision')
    })

    it('reports a blank marker as the older, ambiguous form it is', () => {
      const view = describeDeployment({ revision: '', version: '' })

      expect(view.unstamped).toBe(true)
      expect(view.tone).toBe('bad')
      expect(view.note).toContain('predates the deployment-marker fix')
    })

    it('reports a real revision', () => {
      const view = describeDeployment({ revision: 'a'.repeat(40), version: '1.2.3' })

      expect(view.unstamped).toBe(false)
      expect(view.revision).toBe('a'.repeat(40))
      expect(view.note).toBeNull()
    })

    it('survives a missing or malformed marker', () => {
      expect(describeDeployment(undefined).unstamped).toBe(true)
      expect(describeDeployment({ revision: 42 }).unstamped).toBe(true)
    })
  })

  it('summarizes a test run', () => {
    expect(summarizeTestRun([])).toContain('No tests')
    expect(
      summarizeTestRun([
        { name: 'a', passed: true, detail: '', reportDetail: '' },
        { name: 'b', passed: false, detail: '', reportDetail: '' },
      ]),
    ).toBe('1 of 2 checks passed.')
  })
})
