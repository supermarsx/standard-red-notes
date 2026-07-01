/**
 * Pure (React-free, app-free) resolver for the Sync pane's account-status card.
 *
 * The Sync pane previously derived its status string from a single `signedOut`
 * boolean and rendered "Offline account (local only)" for it — while STILL
 * showing a "Last successful sync" line and non-zero "synced" counts. Those
 * three facts contradict each other. This resolver is the single source of truth
 * that keeps them coherent: the status label, whether a last-sync line is
 * meaningful, and whether any item can be "synced" all fall out of the SAME
 * `hasAccount` decision.
 *
 * Inputs are the already-resolved connectivity signals from
 * `useConnectionStatus` (which does the real server-reachability work). We only
 * turn them into display text + gating flags here so this can be unit-tested
 * from plain values with no service mocks.
 */

/**
 * The connectivity kinds produced by `useConnectionStatus`. Duplicated as a
 * literal union (rather than imported) so this module stays free of any React /
 * app import and is trivially unit-testable. Must stay in sync with
 * `ConnectionStatusKind` in Hooks/useConnectionStatus.ts.
 */
export type SyncConnectionKind = 'online' | 'offline' | 'reconnecting' | 'login-needed' | 'local-only'

export type SyncStatusIcon = 'sync' | 'cloud-off' | 'warning'

export type SyncStatusView = {
  /** Machine-readable status, mirrors the connection kind but collapses the
   *  signed-out/local-only case into a single `local-only`. */
  status: SyncConnectionKind
  /** Human-readable status label for the card. */
  label: string
  icon: SyncStatusIcon
  /**
   * Whether a "Last successful sync" line is meaningful. FALSE when there is no
   * account (a purely-local install has no server sync to report), so the pane
   * must not render a last-sync timestamp next to a "Local only" status.
   */
  showLastSync: boolean
  /**
   * Whether this install can sync to a server at all (has an account/session).
   * Drives the synced-vs-local-only count gating: when false, EVERYTHING is
   * local-only and nothing is "synced". Also gates the "Sync now" action and the
   * selective-sync management list.
   */
  hasAccount: boolean
}

export type SyncStatusInputs = {
  /** `application.sessions.isSignedOut()` — no server session at all. */
  signedOut: boolean
  /** The resolved connectivity kind from `useConnectionStatus`. */
  connectionKind: SyncConnectionKind
}

/**
 * Resolve the account-status card from real session + connectivity state.
 *
 * The cardinal rule: "Local only" (and no last-sync line, and zero synced) is
 * shown ONLY when there is genuinely no account. A signed-in account that merely
 * can't reach the server right now reads as "Online account (currently
 * offline)" / "Reconnecting…" — an online account, temporarily unreachable — and
 * keeps its last-sync line and synced counts.
 */
export function resolveSyncStatus({ signedOut, connectionKind }: SyncStatusInputs): SyncStatusView {
  // No account/session => purely local. This is the ONLY state that may claim
  // "local only", and it forbids a last-sync line and any synced count.
  if (signedOut || connectionKind === 'local-only') {
    return {
      status: 'local-only',
      label: 'Local only (no account)',
      icon: 'cloud-off',
      showLastSync: false,
      hasAccount: false,
    }
  }

  // From here on there IS an account: every branch keeps `hasAccount: true` and
  // `showLastSync: true`, so status <=> last-sync line <=> counts stay coherent.
  switch (connectionKind) {
    case 'online':
      return { status: 'online', label: 'Connected', icon: 'sync', showLastSync: true, hasAccount: true }
    case 'login-needed':
      return {
        status: 'login-needed',
        label: 'Sign-in required',
        icon: 'warning',
        showLastSync: true,
        hasAccount: true,
      }
    case 'reconnecting':
      return {
        status: 'reconnecting',
        label: 'Online account (reconnecting…)',
        icon: 'cloud-off',
        showLastSync: true,
        hasAccount: true,
      }
    case 'offline':
    default:
      return {
        status: 'offline',
        label: 'Online account (currently offline)',
        icon: 'cloud-off',
        showLastSync: true,
        hasAccount: true,
      }
  }
}
