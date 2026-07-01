import { WebApplication } from '@/Application/WebApplication'
import { ApplicationEvent } from '@standardnotes/snjs'
import { reaction } from 'mobx'
import { useEffect, useRef, useState } from 'react'

export type ConnectionStatusKind = 'online' | 'offline' | 'reconnecting' | 'login-needed' | 'local-only'

export type ConnectionStatus = {
  kind: ConnectionStatusKind
  /** Last successful sync time, if known. */
  lastSyncDate?: Date
  /** True when the active account has no server session (purely local). */
  signedOut: boolean
}

/**
 * Whether the footer should surface the "Login needed" state. This is true when
 * the account session became involuntarily invalid (a 401/498 re-auth prompt)
 * and the user dismissed the re-login prompt, recorded on the account menu
 * controller. A *deliberate* full sign-out clears local data and never sets this
 * flag, so it reads as normal `local-only`/`offline`, not a nag.
 */
function isLoginNeeded(application: WebApplication): boolean {
  return application.accountMenuController.reloginPromptDismissed === true
}

/**
 * Discrete connectivity signals sampled from the app. These are the *raw*
 * inputs to `resolveConnectionStatus`; resolving them into a displayable
 * status (with debouncing) is done separately so the resolver can be unit
 * tested in isolation.
 */
export type ConnectionSignals = {
  /** `navigator.onLine` — browser-level reachability. */
  browserOnline: boolean
  /**
   * Whether the realtime websocket is currently open. `undefined` when the
   * websocket isn't in use (e.g. signed out, or no websocket URL configured),
   * in which case it is ignored as a connectivity signal.
   */
  socketOpen: boolean | undefined
  /** The sync system has entered (and not exited) an out-of-sync state. */
  outOfSync: boolean
  /** A genuine, persisting sync failure (not a single transient retry). */
  syncFailing: boolean
  /**
   * The active account has no server session (purely local, no account/server
   * sync). When true the status resolves to `local-only` — never a misleading
   * "Connected".
   */
  signedOut: boolean
  /**
   * True when there is a *recent* successful server sync (last-successful-sync
   * within `RECENT_SYNC_THRESHOLD_MS`). This is the positive evidence of server
   * reachability that "Connected" now requires when signed in: a signed-in user
   * who has neither a recent successful sync nor an open realtime socket has no
   * proof the server is reachable and reads as `reconnecting`, not `online`.
   */
  recentSuccessfulSync: boolean
}

/**
 * Grace period a "down" condition must persist before we visually flip away
 * from `online`. This is what kills the flapping: brief blips during normal
 * sync activity (a websocket reconnect, a single failed request) clear well
 * within this window and never reach the UI. Recovery back to `online` is not
 * debounced — we want to show "connected" promptly.
 */
export const CONNECTION_DOWN_GRACE_MS = 3_000

/**
 * How recent a successful sync must be to count as live evidence of server
 * reachability. Generous relative to the 30s autosync interval (tolerates a
 * missed/slow sync) so a healthy, idle, signed-in client never falsely reads
 * `reconnecting`. Prompt server-down detection does not depend on this ageing
 * out — it comes from `syncFailing`/socket-down plus the active probe below —
 * so a generous threshold here is purely a false-positive guard.
 */
export const RECENT_SYNC_THRESHOLD_MS = 90_000

/**
 * Minimum spacing between active reachability probes (see
 * `maybeProbeReachability`). A floor, not a poll period: probes are only fired
 * from discrete triggers (sync events, window focus/visibility, the 30s
 * heartbeat) and only while the connection is uncertain, so this simply caps
 * bursts when several triggers fire close together. While idle-and-down the
 * effective cadence is heartbeat-bound (~30s), not this floor.
 */
export const REACHABILITY_MIN_PROBE_INTERVAL_MS = 5_000

/**
 * Slow fallback heartbeat. It (a) samples the websocket open/closed state, which
 * the WebSocketsService does not surface as a discrete event, and (b) drives the
 * active reachability probe while the connection is uncertain. This is a safety
 * net only — the status is otherwise event-driven — so it is deliberately slow
 * to avoid being a "spammy" poll.
 */
export const CONNECTION_HEARTBEAT_MS = 30_000

/**
 * Pure resolver: maps the current raw signals to a displayable status kind.
 *
 *  - `local-only`   — signed out: no account/server relationship at all. Data is
 *                     stored on this device only. This is NOT a false
 *                     "Connected" and NOT an error — a neutral, expected state.
 *  - `offline`      — the browser reports it is offline. Genuine connectivity loss.
 *  - `reconnecting` — online at the browser level but we lack proof the server is
 *                     reachable: the sync system is out of sync / persistently
 *                     failing, OR there is neither a recent successful sync nor an
 *                     open realtime socket (a degraded, recovering state).
 *  - `online`       — signed in AND recently reached the server (recent successful
 *                     sync or an open realtime socket) with no failing/out-of-sync
 *                     condition.
 *
 * "Connected" (`online`) therefore requires RECENT SERVER REACHABILITY, not just
 * `navigator.onLine`: a server that is down while the browser is online no longer
 * reads as connected.
 *
 * Note: `login-needed` is intentionally NOT produced here. It is not a
 * connectivity signal — it is a session/re-auth state (the account session
 * became invalid and the user dismissed the re-login prompt) layered on top of
 * the connectivity status inside the hook. Keeping it out of this pure resolver
 * preserves the resolver's single responsibility (signals → connectivity kind).
 *
 * A closed/closing realtime socket is not on its own treated as "offline": HTTP
 * sync remains the source of truth for catch-up, so a down socket degrades to
 * `reconnecting` (not `offline`) and only when there is also no recent successful
 * sync to vouch for reachability. A sync merely being *in progress* is likewise
 * NOT an input: routine sync activity must never read as a connection problem.
 */
export function resolveConnectionStatus(signals: ConnectionSignals): ConnectionStatusKind {
  if (signals.signedOut) {
    return 'local-only'
  }
  if (!signals.browserOnline) {
    return 'offline'
  }
  // Positive, recent evidence that the server is reachable. An open realtime
  // socket is live proof; a recent successful sync is recent proof. With neither,
  // we have no basis to claim "Connected".
  const hasRecentReachability = signals.recentSuccessfulSync || signals.socketOpen === true
  if (signals.outOfSync || signals.syncFailing || !hasRecentReachability) {
    return 'reconnecting'
  }
  return 'online'
}

/**
 * Derives a live, *quiet* server-connection status.
 *
 * Design notes (the previous implementation flapped because it recomputed on
 * every `WillSync`/`CompletedIncrementalSync` tick, toggling online↔reconnecting
 * on each sync):
 *  - Event-driven: we recompute on discrete ApplicationEvents (out-of-sync
 *    enter/exit, full-sync completion, failed sync, sign-in/out) and window
 *    online/offline/focus — never on a tight interval. A slow (30s) heartbeat
 *    only samples the websocket open state and drives the reachability probe.
 *  - Actively verified: when signed in and reachability is uncertain (the socket
 *    is known-down, or there is no recent successful sync) we fire a single
 *    guarded `sync()` probe so a server-down condition surfaces within a few
 *    seconds instead of waiting up to the 30s autosync interval. The probe is
 *    NOT a poll — it only fires from the discrete triggers above, only while
 *    uncertain, never while a sync is already in flight, and no more than once
 *    per `REACHABILITY_MIN_PROBE_INTERVAL_MS` — so it cannot spam.
 *  - Debounced: a transition to a down/degraded state must persist for
 *    `CONNECTION_DOWN_GRACE_MS` before it reaches the UI; recovery is immediate.
 *  - Memoized: `setStatus` is only called when the resolved status actually
 *    changes, so the chip does not re-render on every sync tick.
 */
export function useConnectionStatus(application: WebApplication): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(() => {
    const signedOut = application.sessions.isSignedOut()
    const kind: ConnectionStatusKind = signedOut
      ? 'local-only'
      : typeof navigator !== 'undefined' && !navigator.onLine
        ? 'offline'
        : 'online'
    return {
      kind,
      lastSyncDate: application.sync.getLastSyncDate() ?? undefined,
      signedOut,
    }
  })

  // Keep the latest status in a ref so effect callbacks can compare against it
  // without re-subscribing on every change.
  const statusRef = useRef(status)
  statusRef.current = status

  useEffect(() => {
    let disposed = false
    let graceTimeout: ReturnType<typeof setTimeout> | undefined
    // Timestamp of the last active reachability probe, to enforce the min spacing.
    let lastProbeAt = 0

    const sampleSignals = (): ConnectionSignals => {
      const signedOut = application.sessions.isSignedOut()
      const syncStatus = application.sync.getSyncStatus()
      const lastSyncDate = application.sync.getLastSyncDate()
      const recentSuccessfulSync =
        lastSyncDate !== undefined && Date.now() - lastSyncDate.getTime() <= RECENT_SYNC_THRESHOLD_MS
      return {
        browserOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
        // Only treat the socket as a signal when signed in; signed-out users
        // have no socket and should never be shown as "offline" for that.
        socketOpen: signedOut ? undefined : application.sockets.isWebSocketConnectionOpen(),
        outOfSync: application.sync.isOutOfSync(),
        syncFailing: syncStatus.hasError(),
        signedOut,
        recentSuccessfulSync,
      }
    }

    /**
     * Active reachability probe. Fires a single ordinary `sync()` (the cheapest
     * existing server round-trip) whose success/failure emits
     * `CompletedFullSync`/`FailedSync` and drives `recompute`, so a server that
     * went down is detected promptly instead of on the next 30s autosync.
     *
     * It CANNOT spam:
     *  - never when signed out or the browser is offline (nothing to reach);
     *  - only while *uncertain* — the socket is known-down, or there is no recent
     *    successful sync; a healthy client (open socket + recent sync) never probes;
     *  - never while a sync is already in flight;
     *  - at most once per `REACHABILITY_MIN_PROBE_INTERVAL_MS`;
     *  - and only from the discrete triggers that call `recompute` (sync events,
     *    online/focus/visibility, the 30s heartbeat) — there is no dedicated fast
     *    loop, so while idle-and-down the cadence is heartbeat-bound (~30s).
     */
    const maybeProbeReachability = (signals: ConnectionSignals): void => {
      if (disposed || signals.signedOut || !signals.browserOnline || !application.isLaunched()) {
        return
      }
      const uncertain = signals.socketOpen === false || !signals.recentSuccessfulSync
      if (!uncertain) {
        return
      }
      if (application.sync.getSyncStatus().syncInProgress) {
        return
      }
      const now = Date.now()
      if (now - lastProbeAt < REACHABILITY_MIN_PROBE_INTERVAL_MS) {
        return
      }
      lastProbeAt = now
      void application.sync.sync().catch(() => {
        /* failure surfaces via FailedSync → recompute; nothing to do here */
      })
    }

    const clearGrace = () => {
      if (graceTimeout) {
        clearTimeout(graceTimeout)
        graceTimeout = undefined
      }
    }

    const apply = (kind: ConnectionStatusKind) => {
      if (disposed) {
        return
      }
      const previous = statusRef.current
      const lastSyncDate = application.sync.getLastSyncDate() ?? previous.lastSyncDate
      const signedOut = application.sessions.isSignedOut()
      // `login-needed` is an actionable, user-dismissed re-auth state and takes
      // precedence over the connectivity kind: it must stay visible (and
      // clickable) regardless of the underlying reachability. It is not subject
      // to the down-grace because it isn't a flapping signal.
      const resolvedKind: ConnectionStatusKind = isLoginNeeded(application) ? 'login-needed' : kind
      // Memoize: only emit a new object when something the chip renders changed.
      if (
        previous.kind === resolvedKind &&
        previous.signedOut === signedOut &&
        previous.lastSyncDate?.getTime() === lastSyncDate?.getTime()
      ) {
        return
      }
      setStatus({ kind: resolvedKind, lastSyncDate, signedOut })
    }

    /**
     * Resolve the current signals and update the status, debouncing only the
     * transition *into* a down/degraded state so brief blips are swallowed.
     * `local-only` and `online` are resting states applied immediately.
     */
    const recompute = () => {
      if (disposed) {
        return
      }
      const signals = sampleSignals()
      // Actively verify reachability when uncertain (guarded; see above).
      maybeProbeReachability(signals)
      const resolved = resolveConnectionStatus(signals)

      if (resolved === 'online' || resolved === 'local-only') {
        // Resting/healthy state: apply immediately and cancel any pending
        // "go down" timer (prompt recovery, no flicker).
        clearGrace()
        apply(resolved)
        return
      }

      const restingHealthy = statusRef.current.kind === 'online' || statusRef.current.kind === 'local-only'
      if (!restingHealthy) {
        // Already in a down/degraded state — update immediately (e.g. moving
        // between reconnecting and offline) without a new grace period.
        clearGrace()
        apply(resolved)
        return
      }

      // Currently healthy, want to go down: require the condition to persist.
      if (graceTimeout) {
        return
      }
      graceTimeout = setTimeout(() => {
        graceTimeout = undefined
        if (disposed) {
          return
        }
        // Re-sample after the grace period and commit the current resolution
        // (a brief blip will have cleared back to online/local-only here).
        apply(resolveConnectionStatus(sampleSignals()))
      }, CONNECTION_DOWN_GRACE_MS)
    }

    recompute()

    const removeEventObserver = application.addEventObserver(async (event) => {
      switch (event) {
        // Discrete, non-per-tick signals only. Routine WillSync /
        // CompletedIncrementalSync are intentionally ignored so a sync in
        // progress never flips the chip.
        case ApplicationEvent.EnteredOutOfSync:
        case ApplicationEvent.ExitedOutOfSync:
        case ApplicationEvent.FailedSync:
        case ApplicationEvent.CompletedFullSync:
        case ApplicationEvent.SignedIn:
        case ApplicationEvent.SignedOut:
        case ApplicationEvent.LocalDataLoaded:
          recompute()
          break
        default:
          break
      }
    })

    const onOnline = () => recompute()
    const onOffline = () => recompute()
    // Returning focus / making the tab visible is a natural, user-driven moment
    // to re-verify reachability (the probe is still guarded, so this can't spam).
    const onFocus = () => recompute()
    const onVisibilityChange = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        recompute()
      }
    }

    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    window.addEventListener('focus', onFocus)
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }

    // React to the "re-login dismissed" flag flipping (set when the user closes
    // the invalid-session prompt, cleared on sign-in) so the chip flips to/from
    // `login-needed` immediately without waiting for the next sync event.
    const disposeReloginReaction = reaction(
      () => application.accountMenuController.reloginPromptDismissed,
      () => recompute(),
    )

    // Slow fallback heartbeat: samples the websocket open state (no discrete
    // event exists for it) and drives the reachability probe when uncertain,
    // without being a spammy poll.
    const heartbeat = setInterval(recompute, CONNECTION_HEARTBEAT_MS)

    return () => {
      disposed = true
      clearGrace()
      clearInterval(heartbeat)
      removeEventObserver()
      disposeReloginReaction()
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('focus', onFocus)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    }
  }, [application])

  return status
}
