import { SyncGateDiagnosticsRecorder } from './SyncGateDiagnostics'
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
