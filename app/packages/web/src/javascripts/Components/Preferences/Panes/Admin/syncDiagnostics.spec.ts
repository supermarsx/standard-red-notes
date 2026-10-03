import {
  BOOT_GATE_HEADER,
  buildCapabilityRows,
  CLIENT_KNOWN_OPERATIONS,
  CLIENT_RECOGNIZED_ONLY_OPERATIONS,
  CLIENT_SYNC_OPERATIONS,
  describeDeployment,
  describeRealtimeHealth,
  describeSyncItems,
  describeTransport,
  diagnose,
  REALTIME_FIELD_NOT_REPORTED,
  REALTIME_UNATTACHED_NOTE,
  sanitizeServerCopy,
  summarizeTestRun,
  SYNC_ITEMS_CAUSE_COPY,
  SYNC_ITEMS_CAUSES,
  SYNC_ITEMS_STATE_CHIP,
  SYNC_ITEMS_STATE_REPORT,
  SYNC_ITEMS_STATES,
  TONES,
  UNRECOGNISED_OPERATION,
  type SyncDiagnosticsPayload,
  type SyncItemsCause,
  type TransportStatusInput,
} from './syncDiagnostics'

/**
 * A planted operation name with NO structure for a denylist to match — the class
 * of secret `sanitizeServerCopy` says in its own comment that it cannot catch,
 * and the one a live probe watched print verbatim on the Overview, in the
 * WebSocket capability block and in the copyable report.
 *
 * Built from markers rather than plausible prose, so no fragment can collide with
 * the build's own copy, and asserted by head, middle AND tail: the tail sits past
 * 60 characters, which is where a peer's planted fragments all silently landed
 * earlier tonight behind a truncation.
 */
const PLANTED_HEAD = 'SRNLEAKHEAD41'
const PLANTED_MIDDLE = 'SRNLEAKMIDDLE62'
const PLANTED_TAIL = 'SRNLEAKTAIL83'
const PLANTED_OPAQUE_OPERATION = `${PLANTED_HEAD}-wwwwwwwwwwwwwwwwwwwwwwww-${PLANTED_MIDDLE}-wwwwwwwwwwwwwwwwwwwwwwww-${PLANTED_TAIL}`
const PLANTED_FRAGMENTS = [PLANTED_HEAD, PLANTED_MIDDLE, PLANTED_TAIL, PLANTED_OPAQUE_OPERATION]

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
      // Name BOTH healthy values, not just the one this deployment has. An
      // operator who only reads "in-process is fine" cannot tell whether their
      // multi-container `redis` is the third state or the broken one.
      expect(finding?.detail).toContain('multi-container one reports redis')
      // `'none'` has a second cause with a completely different fix. Telling an
      // operator on an old build to check their Redis host sends them after a
      // setting that will not help.
      expect(finding?.detail).toContain('older than the in-process plane')
      expect(finding?.detail).toContain('upgrade')
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

      const finding = diagnosis.findings.find((entry) => entry.title.includes('does not implement'))
      expect(finding).toBeDefined()
      // Counted, with both halves of the comparison: how many, and out of how
      // many advertised. The name itself is the server's string and is withheld.
      expect(finding?.title).toContain(`1 of the ${CLIENT_SYNC_OPERATIONS.length + 1} operations`)
      expect(finding?.title).not.toContain('FUTURE_LANE')
      expect(finding?.detail).toContain('needs a client change')
    })

    /**
     * *** THE OVERVIEW HALF OF THE LEAK. ***
     *
     * `diagnose()` interpolated these names with no redaction at all, so the
     * Overview printed whatever the server put in `protocol.serverOperations`.
     * This plants a value with no shape for a denylist to match AND an
     * address-shaped one, and asserts neither the names nor a redaction of them
     * appears — the second half is what fails if `sanitizeServerCopy` is put back
     * as the defence instead of the closed set.
     */
    it('counts the operations it cannot name in the Overview, and names none of them', () => {
      const diagnosis = diagnose(
        {
          ...gateSatisfied,
          protocol: {
            version: 1,
            serverOperations: [...CLIENT_SYNC_OPERATIONS, PLANTED_OPAQUE_OPERATION, 'syncing.internal.example:50051'],
          },
        },
        { state: 'READY', operations: [...CLIENT_SYNC_OPERATIONS] },
      )
      const everything = `${diagnosis.headline} ${diagnosis.findings
        .map((finding) => `${finding.title} ${finding.detail}`)
        .join(' ')}`

      for (const fragment of PLANTED_FRAGMENTS) {
        expect(everything).not.toContain(fragment)
      }
      expect(everything).not.toContain('syncing.internal.example')
      expect(everything).not.toContain('[address withheld]')
      // It still reports the fact, and both numbers the operator needs.
      expect(everything).toContain(`2 of the ${CLIENT_SYNC_OPERATIONS.length + 2} operations`)
      // And it names what this build DOES declare, which is what turns a count
      // into a diagnosis: the gap is in the names outside this list.
      for (const operation of CLIENT_KNOWN_OPERATIONS) {
        expect(everything).toContain(operation)
      }
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

    /**
     * *** "I COULD NOT ASK" IS NOT "IT IS DOWN." ***
     *
     * The state these replace: `diagnose(undefined, …)` returned tone `'bad'`
     * with a headline about the sync lane, which the panel's chip row rendered as
     * "Unavailable" immediately beside a verdict chip reading "WebSocket" — read
     * from `application.syncTransportStatus`, which needs no server call and was
     * right. Two independent sources of truth, and the one that had read NOTHING
     * overwrote the one that had measured something.
     *
     * The old single remedy was also wrong about the cause: it told every failed
     * read to "check that your session carries the admin role", and a 401 is the
     * one status that rules that out — `AdminController.getSyncDiagnostics`
     * answers 403 for a missing admin role, and the 401 comes from the
     * cross-service-token middleware declared on the same route, which runs
     * BEFORE the role check.
     */
    describe('a diagnostics read that failed', () => {
      const live: TransportStatusInput = { state: 'READY', operations: [...CLIENT_SYNC_OPERATIONS] }

      it('does not report the socket as unavailable when it merely could not ask', () => {
        const diagnosis = diagnose(undefined, live, { status: 401 })

        expect(diagnosis.tone).toBe('neutral')
        expect(diagnosis.headline).not.toMatch(/unavailable|running over HTTP/i)
      })

      it('says the locally measured transport verdict still stands', () => {
        const diagnosis = diagnose(undefined, live, { status: 401 })

        expect(diagnosis.headline).toContain('WebSocket')
        expect(diagnosis.headline).toContain('measured by this client')
        expect(diagnosis.headline).toContain('not a finding about the socket')
      })

      it('stays neutral for every status, because none of them observed the socket', () => {
        for (const status of [401, 403, 404, 500, 502, undefined]) {
          expect(diagnose(undefined, live, { status }).tone).toBe('neutral')
        }
      })

      it('gives 401, 403 and 404 three different remedies rather than one catch-all', () => {
        const details = [401, 403, 404].map((status) => diagnose(undefined, live, { status }).findings[0].detail)

        expect(new Set(details).size).toBe(3)
        for (const detail of details) {
          expect(detail.length).toBeGreaterThan(0)
        }
      })

      it('never sends a 401 to audit the admin role — the status rules that cause out', () => {
        const [finding] = diagnose(undefined, live, { status: 401 }).findings

        expect(finding.title).toContain('401')
        expect(finding.detail).not.toContain('check that your session carries the admin role')
        expect(finding.detail).not.toContain('requires the admin role')
        // And it says WHY the role cannot be the cause: the role gate answers 403.
        expect(finding.detail).toContain('NOT an admin-role problem')
        expect(finding.detail).toContain('403')
      })

      /**
       * The lane mechanism is real — the API_RPC lane's session credential is
       * captured once at ticket mint (SyncWebSocketController) and never
       * refreshed, and LoopbackSyncApiRpcAdapter 401s without it — but the panel
       * cannot KNOW that is what happened here, so it is offered as a mechanism
       * to be aware of, not announced as the cause.
       */
      it('names the API_RPC-lane mechanism as a possibility, not as the diagnosis', () => {
        const detail = diagnose(undefined, live, { status: 401 }).findings[0].detail

        expect(detail).toContain('API_RPC')
        expect(detail).toContain('can be refused')
        expect(detail).not.toMatch(/the cause is|this happened because|the reason is/i)
      })

      it('points a 403 — and only a 403 — at the admin role', () => {
        expect(diagnose(undefined, live, { status: 403 }).findings[0].detail).toContain('requires the admin role')
        expect(diagnose(undefined, live, { status: 403 }).findings[0].title).toContain('403')
        expect(diagnose(undefined, live, { status: 404 }).findings[0].detail).not.toContain('admin role')
        expect(diagnose(undefined, live, { status: 500 }).findings[0].detail).not.toContain('admin role')
      })

      it('points a 404 — and only a 404 — at a build that predates the endpoint', () => {
        expect(diagnose(undefined, live, { status: 404 }).findings[0].detail).toContain('predates')
        expect(diagnose(undefined, live, { status: 404 }).findings[0].title).toContain('404')
        expect(diagnose(undefined, live, { status: 401 }).findings[0].detail).not.toContain('predates')
        expect(diagnose(undefined, live, { status: 403 }).findings[0].detail).not.toContain('predates')
      })

      it('distinguishes a request that never completed from any status at all', () => {
        const [finding] = diagnose(undefined, live, {}).findings

        expect(finding.title).toContain('could not be reached')
        expect(finding.detail).toContain('never completed')
        expect(finding.detail).not.toContain('admin role')
        expect(finding.detail).not.toContain('predates')
      })

      it('reports an unrecognised status by number instead of guessing a cause', () => {
        const [finding] = diagnose(undefined, live, { status: 502 }).findings

        expect(finding.title).toContain('502')
        expect(finding.detail).not.toContain('admin role')
        expect(finding.detail).not.toContain('predates')
        expect(finding.detail).toContain('not a report about the socket lane')
      })

      it('says diagnostics have not been read yet before any read has been attempted', () => {
        const diagnosis = diagnose(undefined, undefined)

        expect(diagnosis.tone).toBe('neutral')
        expect(diagnosis.headline).toContain('have not been read')
        expect(diagnosis.findings).toHaveLength(0)
      })
    })
  })

  /**
   * The SYNC_ITEMS verdict, which the server reports in full and this panel used
   * to read as one boolean.
   *
   * The fixtures are deliberately shaped like the states the live deployment can
   * be in, and two of them are shaped like nothing a correct server sends: a
   * payload whose `syncItemsAdvertised` CONTRADICTS `syncItems.state`, and a
   * payload with no `syncItems` block at all. Neither is realistic, and both are
   * the only fixtures that can prove WHICH field the panel is reading — a payload
   * where the two agree passes whichever one the code picks.
   */
  describe('describeSyncItems', () => {
    /**
     * Copied verbatim from the server's frozen `SYNC_ITEMS_CAUSE_REMEDIES`.
     *
     * t108 rewrote it twice over: it no longer OPENS with "is bound", because an
     * UNBOUND durable port now has its own cause and its own remedy, and it no
     * longer names `AUTH_JWT_SECRET`, because an empty one is a fatal startup on
     * the gateway and so can never be the answer an operator reads here.
     */
    const NOT_READY_REMEDY =
      'the durable command port FAILED the readiness check the handshake itself makes, so the socket will not offer SYNC_ITEMS and notes sync over HTTP while every other capability stays realtime. A deployment that binds NO durable command port is a DIFFERENT cause with a different fix (DURABLE_BACKEND_UNBOUND, which is about SERVICE_PROXY_TYPE and the dial target), so this one is about a port that exists and refuses: for the gRPC port the check needs SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET set to AT LEAST 32 bytes and identical on the syncing server. A bound proxy is not evidence of that'
    /** The shared precondition remedy the panel deliberately overrides. */
    const UNBOUND_REMEDY =
      'the gRPC syncing-server proxy is not bound; configure SYNCING_SERVER_GRPC_URL so realtime commands have a durable backend'

    type WireVerdict = NonNullable<NonNullable<SyncDiagnosticsPayload['gate']>['syncItems']>

    const withVerdict = (syncItems: WireVerdict, gate: Partial<NonNullable<SyncDiagnosticsPayload['gate']>> = {}) => ({
      ...gateSatisfied,
      gate: { ...gateSatisfied.gate, ...gate, syncItems },
    })

    it('reads ADVERTISED from the state, not from the boolean beside it', () => {
      // The boolean says the opposite. A current server derives it FROM the state
      // so the two cannot disagree in the field; this fixture exists only to pin
      // which of them the panel is actually reading.
      const verdict = describeSyncItems(
        withVerdict(
          { state: 'ADVERTISED', cause: null, remedy: null },
          {
            syncItemsAdvertised: false,
          },
        ),
      )

      expect(verdict.state).toBe('ADVERTISED')
      expect(verdict.label).toBe('Advertised')
      expect(verdict.tone).toBe('good')
      expect(verdict.cause).toBeNull()
      expect(verdict.remedy).toBeNull()
      // The copy has to be the advertised copy too — a verdict that reaches this
      // state down any other path carries the wrong explanation with it.
      expect(verdict.title).toContain('is advertised on the socket')
      expect(verdict.detail).toContain('answered ready')
      expect(verdict.unrecognisedCause).toBe(false)
    })

    it('reads WITHHELD from the state even when the boolean claims advertised', () => {
      const verdict = describeSyncItems(
        withVerdict(
          { state: 'WITHHELD', cause: 'DURABLE_BACKEND_NOT_READY', remedy: NOT_READY_REMEDY },
          {
            syncItemsAdvertised: true,
          },
        ),
      )

      expect(verdict.state).toBe('WITHHELD')
      expect(verdict.label).toBe('Withheld')
      expect(verdict.tone).toBe('warn')
    })

    /**
     * The actionable half. This cause is INVISIBLE in `unmetCodes` — the durable
     * port is bound, so nothing reads as unmet — and it is the one an operator can
     * fix, so the copy has to name the term of the readiness check they can hold.
     *
     * t108: it used to name TWO, and the second (`AUTH_JWT_SECRET`) cannot
     * occur — `Bootstrap/Container.ts` requires that variable, so an empty one
     * is a fatal startup and there is no server left to print the advice.
     * Advice an operator can never act on costs them a restart and the panel its
     * credibility, which is the one asset it has.
     */
    it('explains DURABLE_BACKEND_NOT_READY in terms of the one thing to check', () => {
      const verdict = describeSyncItems(
        withVerdict({ state: 'WITHHELD', cause: 'DURABLE_BACKEND_NOT_READY', remedy: NOT_READY_REMEDY }),
      )

      expect(verdict.cause).toBe('DURABLE_BACKEND_NOT_READY')
      expect(verdict.title).toContain('readiness check')
      expect(verdict.detail).toContain('SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET')
      expect(verdict.detail).toContain('32 bytes')
      // The unreachable half is gone, from this build's copy AND from the
      // server's own sentence beside it.
      expect(verdict.detail).not.toContain('AUTH_JWT_SECRET set')
      expect(verdict.remedy).not.toContain('AUTH_JWT_SECRET ')
      // ...and it points at the OTHER cause rather than absorbing it, so an
      // unbound deployment is not sent after a secret length.
      expect(verdict.detail).toContain('no durable port at all reports a different cause')
      // And it says why no condition list can show this, which is the whole
      // reason the old derivation produced a false green.
      expect(verdict.detail).toContain('nothing reads as unmet')
      // The server's own remedy survives the redactor intact — over-redaction
      // would quietly mangle the variable names that are the point of it.
      expect(verdict.remedy).toBe(NOT_READY_REMEDY)
    })

    /**
     * The other half of the t108 split, from the client's side. The server used
     * to report an UNBOUND durable port as `DURABLE_BACKEND_NOT_READY`; it now
     * reports `DURABLE_BACKEND_UNBOUND`, and this build's copy for that cause
     * must not repeat the secret-length advice, because there is no bound port
     * for a secret to protect.
     */
    it('keeps the unbound cause clear of the bound cause’s advice', () => {
      const unbound = describeSyncItems(
        withVerdict({ state: 'WITHHELD', cause: 'DURABLE_BACKEND_UNBOUND', remedy: UNBOUND_REMEDY }),
      )
      const notReady = describeSyncItems(
        withVerdict({ state: 'WITHHELD', cause: 'DURABLE_BACKEND_NOT_READY', remedy: NOT_READY_REMEDY }),
      )

      expect(unbound.cause).toBe('DURABLE_BACKEND_UNBOUND')
      expect(unbound.title).toContain('no durable command port is bound')
      expect(unbound.detail).toContain('nothing here is about SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET')
      expect(unbound.detail).not.toBe(notReady.detail)
      expect(unbound.title).not.toBe(notReady.title)
      // It still defers to the condition list, where the topology-conditional
      // SERVICE_PROXY_TYPE remedy lives — the one fix that actually applies.
      expect(unbound.remedy).toBeNull()
    })

    it('gives NOT_OBSERVED the neutral tone and a label of its own, never "Unavailable"', () => {
      const verdict = describeSyncItems(
        withVerdict({ state: 'NOT_OBSERVED', cause: 'PROBE_FAILED', remedy: 'the readiness check threw' }),
      )

      expect(verdict.state).toBe('NOT_OBSERVED')
      expect(verdict.tone).toBe('neutral')
      expect(verdict.label).toBe('Not observed')
      expect(verdict.label).not.toBe('Unavailable')
      expect(verdict.label).not.toBe('Withheld')
      // "Could not determine" must not borrow the words of "not available".
      expect(verdict.title).not.toContain('withheld')
      expect(verdict.detail).toContain('unknown rather than no')
    })

    it('keeps the three state labels and tones distinct from one another', () => {
      const labels = SYNC_ITEMS_STATES.map((state) => SYNC_ITEMS_STATE_CHIP[state].label)
      const tones = SYNC_ITEMS_STATES.map((state) => SYNC_ITEMS_STATE_CHIP[state].tone)

      expect(new Set(labels).size).toBe(SYNC_ITEMS_STATES.length)
      expect(new Set(tones).size).toBe(SYNC_ITEMS_STATES.length)
      expect(new Set(SYNC_ITEMS_STATES.map((state) => SYNC_ITEMS_STATE_REPORT[state])).size).toBe(
        SYNC_ITEMS_STATES.length,
      )
      for (const tone of tones) {
        expect([...TONES]).toContain(tone)
      }
      // The third state is the one that must not read as a verdict.
      expect(SYNC_ITEMS_STATE_CHIP.NOT_OBSERVED.tone).toBe('neutral')
      expect(SYNC_ITEMS_STATE_REPORT.NOT_OBSERVED).toContain('could not be determined')
    })

    /**
     * Every cause gets copy written in THIS build. Iterating the real list rather
     * than a copy of it is what catches a mapping that compiles and is still
     * wrong: a generic fall-through sentence shared by two causes would pass the
     * compiler and fail here.
     */
    it('maps all seven causes to distinct, specific copy', () => {
      expect(SYNC_ITEMS_CAUSES).toHaveLength(7)

      const titles = new Set<string>()
      const details = new Set<string>()
      for (const cause of SYNC_ITEMS_CAUSES) {
        const copy = SYNC_ITEMS_CAUSE_COPY[cause]

        expect(copy.title.length).toBeGreaterThan(20)
        expect(copy.detail.length).toBeGreaterThan(60)
        expect(copy.title).not.toContain('recognise')
        titles.add(copy.title)
        details.add(copy.detail)
      }

      expect(titles.size).toBe(SYNC_ITEMS_CAUSES.length)
      expect(details.size).toBe(SYNC_ITEMS_CAUSES.length)
    })

    it('renders every cause the server can send without falling through to one explanation', () => {
      const rendered = SYNC_ITEMS_CAUSES.map((cause) =>
        describeSyncItems(withVerdict({ state: 'WITHHELD', cause, remedy: null })),
      )

      for (const [index, verdict] of rendered.entries()) {
        expect(verdict.cause).toBe(SYNC_ITEMS_CAUSES[index])
        expect(verdict.unrecognisedCause).toBe(false)
        expect(verdict.title).toBe(SYNC_ITEMS_CAUSE_COPY[SYNC_ITEMS_CAUSES[index]].title)
      }
      expect(new Set(rendered.map((verdict) => verdict.title)).size).toBe(SYNC_ITEMS_CAUSES.length)
    })

    /**
     * These two causes are already named, with better advice, in the gate's
     * condition list. The server's remedy for them is a restatement of a
     * precondition remedy, and on this deployment the stock sentence sends the
     * reader after a variable that is already set — the exact text
     * `remedyForPrecondition` exists to replace.
     */
    it.each(['LANE_PRECONDITION_UNMET', 'DURABLE_BACKEND_UNBOUND'] as const satisfies readonly SyncItemsCause[])(
      'defers %s to the condition list instead of reprinting the stock remedy',
      (cause) => {
        const verdict = describeSyncItems(withVerdict({ state: 'WITHHELD', cause, remedy: UNBOUND_REMEDY }))

        expect(verdict.cause).toBe(cause)
        expect(verdict.remedy).toBeNull()
        expect(verdict.detail).not.toContain('so realtime commands have a durable backend')
        // It still tells the reader where the fix is.
        expect(verdict.detail).toContain('condition')
      },
    )

    it('keeps the state and refuses to paraphrase a cause this build does not know', () => {
      const verdict = describeSyncItems(
        withVerdict({ state: 'WITHHELD', cause: 'DURABLE_BACKEND_ON_FIRE', remedy: 'restart the kiln' }),
      )

      expect(verdict.state).toBe('WITHHELD')
      expect(verdict.cause).toBeNull()
      expect(verdict.unrecognisedCause).toBe(true)
      expect(verdict.title).toContain('does not recognise')
      // It must not have borrowed any known cause's explanation.
      for (const cause of SYNC_ITEMS_CAUSES) {
        expect(verdict.detail).not.toBe(SYNC_ITEMS_CAUSE_COPY[cause].detail)
      }
      // The newer server's own words are still offered, as the server's.
      expect(verdict.remedy).toBe('restart the kiln')
    })

    it('makes no verdict at all out of a state this build does not know', () => {
      const verdict = describeSyncItems(withVerdict({ state: 'PARTIALLY_ADVERTISED', cause: null, remedy: null }))

      expect(verdict.state).toBe('NOT_OBSERVED')
      expect(verdict.tone).toBe('neutral')
      expect(verdict.title).toContain('state this client build does not recognise')
    })

    it('says so when a state arrives with no cause attached', () => {
      const verdict = describeSyncItems(withVerdict({ state: 'WITHHELD', cause: null, remedy: null }))

      expect(verdict.state).toBe('WITHHELD')
      expect(verdict.cause).toBeNull()
      expect(verdict.unrecognisedCause).toBe(false)
      expect(verdict.title).toContain('without naming a cause')
    })

    /**
     * *** BACKWARD COMPATIBILITY. *** A server older than the verdict sends the
     * boolean and nothing else, and on those builds the boolean was derived from
     * whether a proxy OBJECT existed — not from the predicate the handshake asks —
     * so it read `true` over sockets that withheld the operation. The panel
     * therefore makes NO claim from it in either direction.
     */
    it('treats a payload with no syncItems block as no claim, not as the boolean', () => {
      const legacy = { ...gateSatisfied, gate: { ...gateSatisfied.gate, syncItemsAdvertised: true } }
      const verdict = describeSyncItems(legacy)

      expect(verdict.state).toBe('NOT_OBSERVED')
      expect(verdict.tone).toBe('neutral')
      expect(verdict.label).toBe('Not observed')
      expect(verdict.reported).toBe(false)
      expect(verdict.cause).toBeNull()
      expect(verdict.title).toContain('does not report the SYNC_ITEMS verdict')
      expect(verdict.detail).toContain('a proxy OBJECT had been constructed')
      // And it does not read as a fault either.
      expect(verdict.detail).toContain('cannot tell you')
    })

    it('says nothing was read when nothing was read', () => {
      const verdict = describeSyncItems(undefined)

      expect(verdict.state).toBe('NOT_OBSERVED')
      expect(verdict.reported).toBe(false)
      expect(verdict.title).toContain('was not read from the server')
      expect(verdict.detail).toContain('still stands')
    })

    it('reports a block the server sent as reported, even when it could not determine the state', () => {
      const verdict = describeSyncItems(withVerdict({ state: 'NOT_OBSERVED', cause: 'NEVER_PROBED', remedy: null }))

      expect(verdict.reported).toBe(true)
      expect(verdict.cause).toBe('NEVER_PROBED')
    })

    it('redacts an address a misbehaving server put in the remedy', () => {
      const verdict = describeSyncItems(
        withVerdict({
          state: 'WITHHELD',
          cause: 'DURABLE_BACKEND_NOT_READY',
          remedy: 'the backend at syncing.internal.example:50051 refused',
        }),
      )

      expect(verdict.remedy).not.toContain('syncing.internal.example')
      expect(verdict.remedy).toContain('[address withheld]')
    })
  })

  /**
   * The false green, in the one function that produced it. These are kept with
   * `diagnose` rather than with `describeSyncItems` because the defect was not in
   * reading the verdict — it was that a verdict nothing turned into a FINDING left
   * the finding list empty, and an empty finding list is this function's trigger
   * for "fully configured and available".
   */
  describe('diagnose and the SYNC_ITEMS verdict', () => {
    const laneUpWithheld: SyncDiagnosticsPayload = {
      ...gateSatisfied,
      gate: {
        ...gateSatisfied.gate,
        // EMPTY. The durable port is bound, so no condition is unmet — this is
        // exactly the payload that used to render as healthy.
        unmetPreconditions: [],
        unmetCodes: [],
        syncItemsAdvertised: false,
        syncItems: {
          state: 'WITHHELD',
          cause: 'DURABLE_BACKEND_NOT_READY',
          remedy: 'the durable command port is bound but FAILED the readiness check',
          probe: 'NOT_READY',
        },
      },
    }
    const socketReady: TransportStatusInput = { state: 'READY', operations: [...CLIENT_SYNC_OPERATIONS] }

    it('refuses to call a lane healthy while SYNC_ITEMS is withheld on an empty condition list', () => {
      const diagnosis = diagnose(laneUpWithheld, socketReady)

      expect(diagnosis.tone).toBe('warn')
      expect(diagnosis.headline).toContain('SYNC_ITEMS is not advertised')
      expect(diagnosis.headline).not.toContain('fully configured and available')
      expect(diagnosis.findings).toHaveLength(1)
      expect(diagnosis.findings[0].title).toContain('readiness check')
      expect(diagnosis.findings[0].detail).toContain('SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET')
      expect(diagnosis.findings[0].detail).toContain('The server reports:')
    })

    it('does not call the lane unavailable over a withheld operation', () => {
      const diagnosis = diagnose(laneUpWithheld, socketReady)

      expect(diagnosis.tone).not.toBe('bad')
      expect(diagnosis.headline).not.toContain('unavailable')
    })

    /**
     * `NOT_OBSERVED` adds nothing here ON PURPOSE. "The gate could not say" is not
     * a gap in the lane, and inventing a finding for it would make every server
     * build older than the verdict read as degraded on no evidence — the same
     * error as the false green, in the other direction. The dedicated chip and its
     * copy are where that state is reported.
     */
    it('leaves the global diagnosis alone when the verdict could not be determined', () => {
      const diagnosis = diagnose(
        {
          ...gateSatisfied,
          gate: { ...gateSatisfied.gate, syncItems: { state: 'NOT_OBSERVED', cause: 'NEVER_PROBED' } },
        },
        { state: 'READY', operations: [...CLIENT_SYNC_OPERATIONS] },
      )

      expect(diagnosis.tone).toBe('good')
      expect(diagnosis.findings).toHaveLength(0)
    })

    /**
     * An older server's boolean does not drive the headline either — but nothing
     * actionable is lost, because on those builds a `false` could only arise from
     * an unbound proxy, which IS listed as a condition with its own topology
     * remedy.
     */
    it('makes no withheld claim from an older build, and still names the condition', () => {
      const diagnosis = diagnose(
        {
          ...gateSatisfied,
          gate: {
            ...gateSatisfied.gate,
            syncItemsAdvertised: false,
            unmetPreconditions: [{ code: 'SYNCING_SERVER_GRPC_UNBOUND', remedy: 'configure SYNCING_SERVER_GRPC_URL' }],
            unmetCodes: ['SYNCING_SERVER_GRPC_UNBOUND'],
          },
        },
        socketReady,
      )

      expect(diagnosis.headline).not.toContain('SYNC_ITEMS is not advertised')
      expect(diagnosis.findings.map((finding) => finding.title)).toEqual(['SYNCING_SERVER_GRPC_UNBOUND'])
    })

    it('still reports a dead lane as dead when SYNC_ITEMS is withheld with it', () => {
      const diagnosis = diagnose(
        {
          ...gateSatisfied,
          gate: {
            ...gateSatisfied.gate,
            syncLaneEnabled: false,
            unmetPreconditions: [{ code: 'REDIS_UNBOUND', remedy: 'configure REDIS_URL' }],
            unmetCodes: ['REDIS_UNBOUND'],
            syncItems: { state: 'WITHHELD', cause: 'LANE_PRECONDITION_UNMET', remedy: null },
          },
          live: { capabilities: [], unavailabilityReasons: ['sync-not-configured'], ticketAvailable: false },
        },
        { state: 'HTTP_ONLY', operations: [] },
      )

      expect(diagnosis.tone).toBe('bad')
      expect(diagnosis.headline).toContain('running over HTTP')
      expect(diagnosis.findings.map((finding) => finding.title)).toContain('REDIS_UNBOUND')
      // The withheld operation is reported as a consequence, not as a second
      // independent problem, and does not reprint the precondition's remedy.
      const withheld = diagnosis.findings.find((finding) => finding.title.includes('did not come up'))
      expect(withheld).toBeDefined()
      expect(withheld?.detail).not.toContain('The server reports:')
    })
  })

  /**
   * `Tone` is derived from `TONES`, so this iterates the real union rather than a
   * copy of it. The panel's chip mapping is asserted against the same list in
   * AdminDiagnosticsTab.spec.tsx; a tone added here without a label there fails
   * that file to compile AND fails its test.
   */
  describe('TONES', () => {
    it('includes the no-verdict tone, which is not a spare slot', () => {
      expect([...TONES]).toContain('neutral')
      expect([...TONES]).toEqual(expect.arrayContaining(['good', 'warn', 'bad', 'neutral']))
      expect(TONES).toHaveLength(4)
    })

    it('is the tone every describe* helper actually emits', () => {
      const emitted = [
        describeTransport(undefined).tone,
        describeTransport({ state: 'CONNECTING', operations: [] }).tone,
        describeTransport({ state: 'READY', operations: [] }).tone,
        diagnose(undefined, undefined).tone,
        diagnose(undefined, undefined, { status: 401 }).tone,
      ]

      for (const tone of emitted) {
        expect([...TONES]).toContain(tone)
      }
    })
  })

  describe('buildCapabilityRows', () => {
    const socketDown: TransportStatusInput = { state: 'HTTP_ONLY', operations: [] }

    it('marks a genuinely unimplemented server operation as a client gap, without naming it', () => {
      const rows = buildCapabilityRows([...CLIENT_SYNC_OPERATIONS, 'FUTURE_LANE'], [], false)
      const future = rows.find((row) => row.operation === UNRECOGNISED_OPERATION)

      expect(future?.status).toBe('client-gap')
      expect(future?.serverSupported).toBe(true)
      expect(future?.clientImplemented).toBe(false)
      expect(future?.explanation).toContain('not a misconfiguration')
      // The row still EXISTS, which is what makes it countable. What it does not
      // do is carry the server's chosen string.
      expect(rows.map((row) => row.operation)).not.toContain('FUTURE_LANE')
    })

    /**
     * *** A ROW NAMES ONLY WHAT THIS BUILD DECLARES. ***
     *
     * `row.operation` reached the Overview, the WebSocket capability block and
     * the copyable report, through `sanitizeServerCopy` — a denylist. The probe
     * that settled it withheld `syncing.internal.example:50051` and printed
     * `hunter2` intact in all three places.
     *
     * The planted value here has no structure to match, and the assertion on
     * `[address withheld]` is what fails if the redactor is ever put back as the
     * defence: the correct output mentions neither the name nor a redaction of it.
     */
    it('will not name an operation off the wire, however little shape it has', () => {
      const rows = buildCapabilityRows(
        [...CLIENT_SYNC_OPERATIONS, PLANTED_OPAQUE_OPERATION, 'syncing.internal.example:50051'],
        [PLANTED_OPAQUE_OPERATION],
        true,
      )
      const printed = rows.map((row) => `${row.operation} ${row.explanation}`).join('\n')

      for (const fragment of PLANTED_FRAGMENTS) {
        expect(printed).not.toContain(fragment)
      }
      expect(printed).not.toContain('syncing.internal.example')
      expect(printed).not.toContain('[address withheld]')
      // Two rows arrived that this build cannot name, and both are still there to
      // be counted — a vanishing row is the other failure mode this panel has.
      expect(rows.filter((row) => row.operation === UNRECOGNISED_OPERATION)).toHaveLength(2)
      // And every name that IS printed is one of this build's own constants.
      for (const row of rows) {
        expect([...CLIENT_KNOWN_OPERATIONS, UNRECOGNISED_OPERATION]).toContain(row.operation)
      }
    })

    /**
     * Sorting the whole set would order the unnameable rows BY the strings this
     * change exists not to reveal — a comparison made public is a smaller leak of
     * the same thing. So this build's own names sort, and the rest keep the order
     * the wire listed them in.
     */
    it('does not sort the rows it cannot name, because a sort is a comparison made public', () => {
      const rows = buildCapabilityRows(['ZZZ_LAST_ALPHABETICALLY', 'AAA_FIRST_ALPHABETICALLY'], [], false)
      const named = rows.filter((row) => row.operation !== UNRECOGNISED_OPERATION).map((row) => row.operation)

      expect(named).toEqual([...named].sort())
      // The two unnameable rows are last, in neither alphabetical direction.
      expect(rows.slice(-2).map((row) => row.operation)).toEqual([UNRECOGNISED_OPERATION, UNRECOGNISED_OPERATION])
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
      expect(bridge?.note).toContain('multi-container one reports redis')
      expect(bridge?.note).toContain('older than the in-process plane')
    })

    /**
     * *** THE PUSH-BRIDGE VALUE IS A MEMBER, NOT A REDACTED FIELD. ***
     *
     * This value was built as `sanitizeServerCopy(realtime.pushBridge ?? …)` —
     * a denylist, in a value position. It happened to be unreachable, because
     * the interpolation already sat behind a two-member equality test, and no
     * consumer rendered this value either: `buildRealtimeBlock` takes only the
     * NOTES and re-derives every value through `safeEnum`. So nothing in the
     * tree failed if that guard were loosened, which is the state a latent leak
     * sits in until someone renders it.
     *
     * It is now the matched MEMBER that is interpolated, so the raw field cannot
     * be put there without a type error, and this pins the behaviour so that an
     * edit reaching for the field again fails here rather than in a report.
     */
    it('never echoes a push-bridge token outside its own two bound planes', () => {
      const opaque = 'srnbridgehead-9999999999-srnbridgemid-9999999999-srnbridgetail'
      const rows = describeRealtimeHealth({ attached: true, pushBridge: opaque, pushBridgeReady: true })
      const serialised = JSON.stringify(rows)

      for (const fragment of [opaque.slice(0, 20), opaque.slice(22, 42), opaque.slice(-20), opaque]) {
        expect(serialised).not.toContain(fragment)
      }
      // Refused because it is not a member, not because a pattern matched its
      // shape: the redactor's sentinel would mean the denylist was back.
      expect(serialised).not.toContain('[address withheld]')
      expect(rows.find((row) => row.label === 'Push bridge')?.value).toBe('none')
    })

    /**
     * The row and the Overview finding are written separately and have drifted
     * apart once already. This pins the facts they must BOTH carry, so the next
     * edit to either one cannot silently leave the other behind.
     */
    it('keeps the push-bridge row and the Overview finding telling the same story', () => {
      const realtime = { attached: true, pushBridge: 'none', syncLane: 'up', pushesDispatched: 0 }
      const note = describeRealtimeHealth(realtime).find((row) => row.label === 'Push bridge')?.note ?? ''
      const detail =
        diagnose(
          { ...gateSatisfied, live: { ...gateSatisfied.live, realtime } },
          { state: 'READY', operations: [...CLIENT_SYNC_OPERATIONS] },
        ).findings.find((entry) => entry.title.includes('no push bridge'))?.detail ?? ''

      for (const fact of [
        'misconfiguration rather than a topology',
        'in-process bridge instead and is healthy',
        'multi-container one reports redis',
        'older than the in-process plane',
      ]) {
        expect(note).toContain(fact)
        expect(detail).toContain(fact)
      }
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

    // -----------------------------------------------------------------------
    // t108. ABSENT IS NOT A READING. Every field on this snapshot is optional
    // and each was collapsed onto its negative arm: `String(pushesDispatched ??
    // 0)` printed a measured `0` for a server that never sent the counter —
    // and zero dispatched pushes is the headline signature of a delivery path
    // that never fires, so "did not ask" rendered as "badly broken". The same
    // shape sat on every sibling (`syncLane` absent read `down`, `attached`
    // absent read `not attached` in the `bad` tone). Mirrors the rule
    // `fc8b3cbc` applied to `transportFallback`: both readings are driven
    // through the SAME row, because a test that only exercises one arm cannot
    // tell a fixed row from a row that always says the same thing.
    // -----------------------------------------------------------------------
    describe('absent fields versus reported zeroes and falses', () => {
      /** The whole snapshot present, so each case below can remove ONE field. */
      const full = {
        attached: true,
        pushBridge: 'redis',
        pushBridgeReady: true,
        sqsConsumerRunning: true,
        collaborationRelayHealthy: true,
        syncLane: 'up',
        pushesDispatched: 12,
      }
      const rowOf = (realtime: Parameters<typeof describeRealtimeHealth>[0], label: string) =>
        describeRealtimeHealth(realtime)?.find((row) => row.label === label)

      it('reads an absent push counter as not reported, and a reported zero as a measurement', () => {
        const absent = rowOf({ ...full, pushesDispatched: undefined }, 'Pushes dispatched')
        const zero = rowOf({ ...full, pushesDispatched: 0 }, 'Pushes dispatched')

        expect(absent?.value).toBe(REALTIME_FIELD_NOT_REPORTED)
        expect(absent?.value).not.toBe('0')
        expect(absent?.tone).toBe('neutral')
        expect(absent?.note).toContain('did not report the field')
        expect(absent?.note).not.toContain('signature of a delivery path that never fires')

        // The reported zero keeps the reading AND the warning that makes it
        // useful — and stays `neutral`, never `good`: an idle gateway and a
        // healthy one produce the same counter, so a number is not good news.
        expect(zero?.value).toBe('0')
        expect(zero?.tone).toBe('neutral')
        expect(zero?.note).toContain('signature of a delivery path that never fires')
        expect(zero?.note).not.toContain('did not report the field')
      })

      it('refuses to render a malformed counter as a number', () => {
        // The floor `safeCount` applies elsewhere: a counter that arrives as a
        // non-integer, a negative or NaN is a fact about the server.
        for (const pushesDispatched of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
          expect(rowOf({ ...full, pushesDispatched }, 'Pushes dispatched')?.value).toBe(REALTIME_FIELD_NOT_REPORTED)
        }
      })

      it.each([
        ['Gateway', 'attached', 'not attached'],
        ['Queue consumer', 'sqsConsumerRunning', 'not running'],
        ['Collaboration relay', 'collaborationRelayHealthy', 'unhealthy'],
      ] as const)('tells an absent %s apart from a reported false', (label, field, negative) => {
        const absent = rowOf({ ...full, [field]: undefined }, label)
        const reported = rowOf({ ...full, [field]: false }, label)

        expect(absent?.value).toBe(REALTIME_FIELD_NOT_REPORTED)
        expect(absent?.tone).toBe('neutral')
        expect(absent?.note).toContain('did not report the field')

        // The reported negative still reads as the fault it is, with its own
        // tone and its own copy — the fix removes a guess, not a verdict.
        expect(reported?.value).toBe(negative)
        expect(reported?.note).not.toContain('did not report the field')
      })

      it('does not call an absent push bridge "none", which is a reading of its own', () => {
        const absent = rowOf({ ...full, pushBridge: undefined }, 'Push bridge')
        const none = rowOf({ ...full, pushBridge: 'none' }, 'Push bridge')

        expect(absent?.value).toBe(REALTIME_FIELD_NOT_REPORTED)
        expect(absent?.tone).toBe('neutral')
        expect(absent?.note).toContain('"none" is a reading this row makes only when the server sends it')

        expect(none?.value).toBe('none')
        expect(none?.tone).toBe('bad')
        expect(none?.note).toContain('misconfiguration rather than a topology')
      })

      it('does not call a bound bridge with unreported readiness a reconnect window', () => {
        // "Not ready" is a state an operator WAITS OUT. Waiting out a field
        // nobody sent is being misled quietly, so this takes the neutral tone
        // and says which half is missing.
        const absent = rowOf({ ...full, pushBridgeReady: undefined }, 'Push bridge')
        const reported = rowOf({ ...full, pushBridgeReady: false }, 'Push bridge')

        expect(absent?.value).toBe('redis (readiness not reported)')
        expect(absent?.tone).toBe('neutral')
        expect(absent?.note).toContain('readiness was not reported')
        expect(absent?.note).not.toContain('reconnect window')

        expect(reported?.value).toBe('redis (not ready)')
        expect(reported?.tone).toBe('warn')
        expect(reported?.note).toContain('reconnect window')
      })

      it('keeps an absent sync lane silent while a reported unknown state still reads as down', () => {
        // The one asymmetry, and it is deliberate: a state this build does not
        // recognise is NOT evidence that the gateway would admit a client, so a
        // reported-but-unknown token stays `down`. Only absence claims nothing.
        const absent = rowOf({ ...full, syncLane: undefined }, 'Sync lane')
        const unknown = rowOf({ ...full, syncLane: 'draining' }, 'Sync lane')

        expect(absent?.value).toBe(REALTIME_FIELD_NOT_REPORTED)
        expect(absent?.tone).toBe('neutral')
        expect(unknown?.value).toBe('down')
        expect(unknown?.tone).toBe('bad')
      })

      it('reports an entirely empty snapshot as six rows that claim nothing, rather than six faults', () => {
        // The shape an older server sends: the block exists (so the pane does
        // not fall back to REALTIME_UNATTACHED_NOTE) and carries no fields.
        const rows = describeRealtimeHealth({})

        expect(rows).toHaveLength(6)
        expect(rows.map((row) => row.value)).toEqual(Array(6).fill(REALTIME_FIELD_NOT_REPORTED))
        expect(rows.every((row) => row.tone === 'neutral')).toBe(true)
        expect(rows.filter((row) => row.tone === 'bad')).toHaveLength(0)
      })
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
