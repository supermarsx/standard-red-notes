import { SYNC_HOST_REMEDIES, SyncGateDiagnosticsRecorder } from './SyncGateDiagnostics'
import type { SyncPreconditionState } from './SyncWebSocketPreconditions'

const MET: SyncPreconditionState = {
  connectionTokenSecretPresent: true,
  webSocketSyncEnabled: true,
  redisBound: true,
  syncingServerGrpcBound: true,
}

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
})
