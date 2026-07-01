import { resolveSyncStatus, SyncConnectionKind } from './syncStatus'

describe('resolveSyncStatus', () => {
  describe('no account (local only)', () => {
    it('resolves to Local only with no last-sync line and no account, from signedOut', () => {
      const view = resolveSyncStatus({ signedOut: true, connectionKind: 'local-only' })
      expect(view.status).toBe('local-only')
      expect(view.label).toBe('Local only (no account)')
      expect(view.icon).toBe('cloud-off')
      expect(view.showLastSync).toBe(false)
      expect(view.hasAccount).toBe(false)
    })

    it('treats signedOut as local-only even if the connection kind disagrees', () => {
      // Defensive: a stale/racy connection kind must never override signedOut.
      const view = resolveSyncStatus({ signedOut: true, connectionKind: 'online' })
      expect(view.status).toBe('local-only')
      expect(view.hasAccount).toBe(false)
      expect(view.showLastSync).toBe(false)
    })

    it('resolves local-only kind (not signedOut flag) to no account too', () => {
      const view = resolveSyncStatus({ signedOut: false, connectionKind: 'local-only' })
      expect(view.hasAccount).toBe(false)
      expect(view.showLastSync).toBe(false)
    })
  })

  describe('signed in (has account)', () => {
    it('online => Connected, keeps last-sync line and account', () => {
      const view = resolveSyncStatus({ signedOut: false, connectionKind: 'online' })
      expect(view.status).toBe('online')
      expect(view.label).toBe('Connected')
      expect(view.icon).toBe('sync')
      expect(view.showLastSync).toBe(true)
      expect(view.hasAccount).toBe(true)
    })

    it('offline => online account currently offline (NOT local-only), keeps last-sync', () => {
      const view = resolveSyncStatus({ signedOut: false, connectionKind: 'offline' })
      expect(view.status).toBe('offline')
      expect(view.label).toBe('Online account (currently offline)')
      expect(view.icon).toBe('cloud-off')
      expect(view.showLastSync).toBe(true)
      expect(view.hasAccount).toBe(true)
    })

    it('reconnecting => online account reconnecting, keeps account + last-sync', () => {
      const view = resolveSyncStatus({ signedOut: false, connectionKind: 'reconnecting' })
      expect(view.status).toBe('reconnecting')
      expect(view.label).toBe('Online account (reconnecting…)')
      expect(view.hasAccount).toBe(true)
      expect(view.showLastSync).toBe(true)
    })

    it('login-needed => sign-in required, still an account', () => {
      const view = resolveSyncStatus({ signedOut: false, connectionKind: 'login-needed' })
      expect(view.status).toBe('login-needed')
      expect(view.label).toBe('Sign-in required')
      expect(view.icon).toBe('warning')
      expect(view.hasAccount).toBe(true)
      expect(view.showLastSync).toBe(true)
    })
  })

  it('never shows a last-sync line unless it also has an account (internal consistency)', () => {
    const kinds: SyncConnectionKind[] = ['online', 'offline', 'reconnecting', 'login-needed', 'local-only']
    for (const connectionKind of kinds) {
      for (const signedOut of [true, false]) {
        const view = resolveSyncStatus({ signedOut, connectionKind })
        // The invariant that kills the reported contradiction:
        // last-sync line is shown IFF there is an account.
        expect(view.showLastSync).toBe(view.hasAccount)
        // And "local only" is claimed IFF there is no account.
        expect(view.status === 'local-only').toBe(!view.hasAccount)
      }
    }
  })
})
