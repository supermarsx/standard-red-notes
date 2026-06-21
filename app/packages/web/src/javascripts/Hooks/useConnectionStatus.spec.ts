import { resolveConnectionStatus, ConnectionSignals } from './useConnectionStatus'

const baseSignals: ConnectionSignals = {
  browserOnline: true,
  socketOpen: true,
  outOfSync: false,
  syncFailing: false,
}

describe('resolveConnectionStatus', () => {
  it('reports online when reachable and healthy', () => {
    expect(resolveConnectionStatus(baseSignals)).toBe('online')
  })

  it('reports offline when the browser is offline, regardless of other signals', () => {
    expect(resolveConnectionStatus({ ...baseSignals, browserOnline: false })).toBe('offline')
    expect(
      resolveConnectionStatus({
        browserOnline: false,
        socketOpen: true,
        outOfSync: true,
        syncFailing: true,
      }),
    ).toBe('offline')
  })

  it('stays online when only the realtime websocket is closed (HTTP sync is the source of truth)', () => {
    // A down live-push socket is a silent degradation, not connectivity loss:
    // HTTP sync/polling continues, so the app must not flip to "offline".
    expect(resolveConnectionStatus({ ...baseSignals, socketOpen: false })).toBe('online')
  })

  it('ignores the websocket signal when it is not in use (undefined)', () => {
    expect(resolveConnectionStatus({ ...baseSignals, socketOpen: undefined })).toBe('online')
  })

  it('reports reconnecting when out of sync but still reachable', () => {
    expect(resolveConnectionStatus({ ...baseSignals, outOfSync: true })).toBe('reconnecting')
  })

  it('reports reconnecting when sync is persistently failing but still reachable', () => {
    expect(resolveConnectionStatus({ ...baseSignals, syncFailing: true })).toBe('reconnecting')
  })

  it('reports reconnecting (not offline) for a degraded sync state even if the socket is closed', () => {
    expect(
      resolveConnectionStatus({
        browserOnline: true,
        socketOpen: false,
        outOfSync: true,
        syncFailing: true,
      }),
    ).toBe('reconnecting')
  })

  describe('flapping suppression (no transient state changes from routine sync activity)', () => {
    it('does not change state across a healthy sync round-trip', () => {
      // A sync merely being in progress is not an input to the resolver, so a
      // series of routine sync ticks all resolve to the same `online` status —
      // the chip never flaps online -> reconnecting -> online.
      const ticks: ConnectionSignals[] = [
        { ...baseSignals }, // before sync
        { ...baseSignals }, // sync in progress (no dedicated signal)
        { ...baseSignals }, // sync completed
      ]
      const resolved = ticks.map(resolveConnectionStatus)
      expect(new Set(resolved).size).toBe(1)
      expect(resolved[0]).toBe('online')
    })
  })
})
