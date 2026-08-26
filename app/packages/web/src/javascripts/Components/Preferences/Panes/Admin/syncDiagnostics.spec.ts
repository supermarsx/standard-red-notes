import {
  buildCapabilityRows,
  CLIENT_SYNC_OPERATIONS,
  describeDeployment,
  describeTransport,
  diagnose,
  summarizeTestRun,
  type SyncDiagnosticsPayload,
  type TransportStatusInput,
} from './syncDiagnostics'

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

    it('appends the transport’s own fallback reason when it has one', () => {
      const verdict = describeTransport({ state: 'HTTP_FALLBACK', fallbackReason: 'ticket-refused', operations: [] })

      expect(verdict.detail).toContain('ticket-refused')
    })

    it('reports a live socket as good', () => {
      expect(describeTransport({ state: 'READY', operations: ['SYNC_ITEMS'] }).tone).toBe('good')
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

    it('reports an advertised-but-inert operation separately from an outright gap', () => {
      const diagnosis = diagnose(
        { ...gateSatisfied, protocol: { version: 1, serverOperations: [...CLIENT_SYNC_OPERATIONS, 'FILES_V1'] } },
        { state: 'READY', operations: [...CLIENT_SYNC_OPERATIONS, 'FILES_V1'] },
      )

      const finding = diagnosis.findings.find((entry) => entry.title.includes('carries nothing'))
      expect(finding?.title).toContain('FILES_V1')
      expect(finding?.detail).toContain('stays on HTTP')
      // It must NOT also be reported as a flat client gap — one honest finding.
      expect(diagnosis.findings.some((entry) => entry.title.includes('does not implement'))).toBe(false)
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

    it('does not report a recognized-only operation as active just because it was negotiated', () => {
      // FILES_V1 appears in a healthy handshake and still carries nothing. Calling
      // it active because it was negotiated would be a confident lie, and it is
      // the row an operator is most likely to misread.
      const rows = buildCapabilityRows(
        [...CLIENT_SYNC_OPERATIONS, 'FILES_V1'],
        [...CLIENT_SYNC_OPERATIONS, 'FILES_V1'],
        true,
      )
      const files = rows.find((row) => row.operation === 'FILES_V1')

      expect(files?.status).toBe('recognized-only')
      expect(files?.negotiated).toBe(true)
      expect(files?.clientImplemented).toBe(false)
      expect(files?.explanation).toContain('carries nothing')
      expect(files?.explanation).toContain('dropping the whole socket')
    })

    it('still lists a recognized-only operation when the server does not advertise it', () => {
      const rows = buildCapabilityRows([...CLIENT_SYNC_OPERATIONS], [], false)

      expect(rows.find((row) => row.operation === 'FILES_V1')?.status).toBe('recognized-only')
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
        { name: 'a', passed: true, detail: '' },
        { name: 'b', passed: false, detail: '' },
      ]),
    ).toBe('1 of 2 checks passed.')
  })
})
