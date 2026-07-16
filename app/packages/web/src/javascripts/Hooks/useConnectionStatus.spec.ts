import { resolveConnectionStatus, ConnectionSignals } from './useConnectionStatus'

// Base = signed in, browser online, healthy: an open socket AND a recent
// successful sync, no failing/out-of-sync condition.
const baseSignals: ConnectionSignals = {
  browserOnline: true,
  socketOpen: true,
  outOfSync: false,
  syncFailing: false,
  signedOut: false,
  recentSuccessfulSync: true,
}

describe('resolveConnectionStatus', () => {
  it('reports online when signed in, reachable and healthy', () => {
    expect(resolveConnectionStatus(baseSignals)).toBe('online')
  })

  it('reports online with a recent successful sync even if the realtime socket is closed', () => {
    // A down live-push socket is a silent degradation, not connectivity loss:
    // HTTP sync recently succeeded, so the app stays "Connected".
    expect(resolveConnectionStatus({ ...baseSignals, socketOpen: false })).toBe('online')
  })

  it('reports online with an open socket even if there is no recent successful sync', () => {
    // An open realtime socket is live proof of reachability.
    expect(resolveConnectionStatus({ ...baseSignals, socketOpen: true, recentSuccessfulSync: false })).toBe('online')
  })

  it('ignores the websocket signal when it is not in use (undefined) as long as sync is recent', () => {
    expect(resolveConnectionStatus({ ...baseSignals, socketOpen: undefined })).toBe('online')
  })

  // (a) server-down while the browser is online must NOT read as "Connected".
  it('reports reconnecting (not online) when the server is unreachable while the browser is online', () => {
    // No recent successful sync AND the realtime socket is down => no proof the
    // server is reachable, even though navigator.onLine is true.
    expect(
      resolveConnectionStatus({
        browserOnline: true,
        socketOpen: false,
        outOfSync: false,
        syncFailing: false,
        signedOut: false,
        recentSuccessfulSync: false,
      }),
    ).toBe('reconnecting')
  })

  it('reports reconnecting when signed in with no recent sync and no socket in use (undefined)', () => {
    expect(resolveConnectionStatus({ ...baseSignals, socketOpen: undefined, recentSuccessfulSync: false })).toBe(
      'reconnecting',
    )
  })

  // (b) a recent successful sync resolves to online.
  it('reports online purely on the strength of a recent successful sync', () => {
    expect(resolveConnectionStatus({ ...baseSignals, socketOpen: undefined, recentSuccessfulSync: true })).toBe(
      'online',
    )
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
        ...baseSignals,
        socketOpen: false,
        outOfSync: true,
        syncFailing: true,
        recentSuccessfulSync: false,
      }),
    ).toBe('reconnecting')
  })

  // (c) signed-out resolves to the local-only kind, never a false "Connected".
  it('reports local-only when signed out (no account/server sync), never a false Connected', () => {
    expect(resolveConnectionStatus({ ...baseSignals, signedOut: true })).toBe('local-only')
    // Signed-out takes precedence over every connectivity permutation: it is a
    // stable "no server relationship" state, not connectivity loss.
    expect(
      resolveConnectionStatus({
        browserOnline: false,
        socketOpen: undefined,
        outOfSync: true,
        syncFailing: true,
        signedOut: true,
        recentSuccessfulSync: false,
      }),
    ).toBe('local-only')
    expect(resolveConnectionStatus({ ...baseSignals, signedOut: true, recentSuccessfulSync: true })).toBe('local-only')
  })

  // (d) browser offline resolves to offline.
  it('reports offline when the browser is offline (signed in), regardless of other signals', () => {
    expect(resolveConnectionStatus({ ...baseSignals, browserOnline: false })).toBe('offline')
    expect(
      resolveConnectionStatus({
        browserOnline: false,
        socketOpen: true,
        outOfSync: true,
        syncFailing: true,
        signedOut: false,
        recentSuccessfulSync: true,
      }),
    ).toBe('offline')
  })

  // (e) login-needed precedence is layered in the hook, not the resolver.
  it('never produces login-needed from connectivity signals alone', () => {
    // `login-needed` is a session/re-auth state layered on top of connectivity
    // by the hook (driven by the account-menu controller's dismissed flag), not
    // a product of the pure resolver. No combination of raw signals should make
    // the resolver return it.
    const permutations: ConnectionSignals[] = [
      baseSignals,
      { ...baseSignals, browserOnline: false },
      { ...baseSignals, outOfSync: true },
      { ...baseSignals, syncFailing: true },
      { ...baseSignals, socketOpen: false },
      { ...baseSignals, socketOpen: undefined, recentSuccessfulSync: false },
      { ...baseSignals, signedOut: true },
      {
        browserOnline: false,
        socketOpen: false,
        outOfSync: true,
        syncFailing: true,
        signedOut: false,
        recentSuccessfulSync: false,
      },
    ]
    for (const signals of permutations) {
      expect(resolveConnectionStatus(signals)).not.toBe('login-needed')
    }
  })

  // (f) recovery is prompt: a fresh successful sync flips reconnecting -> online.
  describe('prompt recovery', () => {
    it('flips back to online as soon as a successful sync makes reachability recent again', () => {
      const down: ConnectionSignals = {
        browserOnline: true,
        socketOpen: false,
        outOfSync: false,
        syncFailing: false,
        signedOut: false,
        recentSuccessfulSync: false,
      }
      expect(resolveConnectionStatus(down)).toBe('reconnecting')
      // A single successful sync round-trip (recentSuccessfulSync becomes true)
      // is sufficient to resolve back to online — no other signal needs to change.
      expect(resolveConnectionStatus({ ...down, recentSuccessfulSync: true })).toBe('online')
    })
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
