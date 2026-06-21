import { WebApplication } from '@/Application/WebApplication'
import { ApplicationEvent } from '@standardnotes/snjs'
import { useEffect, useRef, useState } from 'react'

export type ConnectionStatusKind = 'online' | 'offline' | 'reconnecting'

export type ConnectionStatus = {
  kind: ConnectionStatusKind
  /** Last successful sync time, if known. */
  lastSyncDate?: Date
  /** True when the active account has no server session (purely local). */
  signedOut: boolean
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
 * Slow fallback heartbeat for sampling the websocket open/closed state, which
 * the WebSocketsService does not surface as a discrete event. This is a safety
 * net only — the status is otherwise event-driven — so it is deliberately slow
 * to avoid being a "spammy" poll.
 */
export const CONNECTION_HEARTBEAT_MS = 30_000

/**
 * Pure resolver: maps the current raw signals to a displayable status kind.
 *
 *  - `offline`      — the browser reports it is offline. This is genuine
 *                     connectivity loss.
 *  - `reconnecting` — online at the browser level but the sync system is out of
 *                     sync or persistently failing (a degraded, recovering state).
 *  - `online`       — reachable and healthy.
 *
 * The realtime websocket state is intentionally NOT an input. The websocket is a
 * live-push optimization layered on top of HTTP sync, which remains the source
 * of truth for connectivity and catch-up. Treating a closed/closing socket as
 * "offline" made the app flip to offline whenever the realtime connection wasn't
 * established (e.g. behind a proxy, or while it backs off and reconnects) even
 * though HTTP sync was perfectly healthy — and flicker as the socket retried.
 * A down socket now degrades silently (HTTP polling continues).
 *
 * A sync merely being *in progress* is also NOT an input here: routine sync
 * activity must never read as a connection problem.
 */
export function resolveConnectionStatus(signals: ConnectionSignals): ConnectionStatusKind {
  if (!signals.browserOnline) {
    return 'offline'
  }
  if (signals.outOfSync || signals.syncFailing) {
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
 *    enter/exit, full-sync completion, failed sync) and window online/offline —
 *    never on a tight interval. A slow (30s) heartbeat only samples the
 *    websocket open state as a fallback.
 *  - Debounced: a transition to a down/degraded state must persist for
 *    `CONNECTION_DOWN_GRACE_MS` before it reaches the UI; recovery is immediate.
 *  - Memoized: `setStatus` is only called when the resolved `kind` actually
 *    changes, so the chip does not re-render on every sync tick.
 */
export function useConnectionStatus(application: WebApplication): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(() => ({
    kind: typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'online',
    lastSyncDate: application.sync.getLastSyncDate() ?? undefined,
    signedOut: application.sessions.isSignedOut(),
  }))

  // Keep the latest status in a ref so effect callbacks can compare against it
  // without re-subscribing on every change.
  const statusRef = useRef(status)
  statusRef.current = status

  useEffect(() => {
    let disposed = false
    let graceTimeout: ReturnType<typeof setTimeout> | undefined

    const sampleSignals = (): ConnectionSignals => {
      const signedOut = application.sessions.isSignedOut()
      const syncStatus = application.sync.getSyncStatus()
      return {
        browserOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
        // Only treat the socket as a signal when signed in; signed-out users
        // have no socket and should never be shown as "offline" for that.
        socketOpen: signedOut ? undefined : application.sockets.isWebSocketConnectionOpen(),
        outOfSync: application.sync.isOutOfSync(),
        syncFailing: syncStatus.hasError(),
      }
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
      // Memoize: only emit a new object when something the chip renders changed.
      if (
        previous.kind === kind &&
        previous.signedOut === signedOut &&
        previous.lastSyncDate?.getTime() === lastSyncDate?.getTime()
      ) {
        return
      }
      setStatus({ kind, lastSyncDate, signedOut })
    }

    /**
     * Resolve the current signals and update the status, debouncing only the
     * transition *into* a non-online state so brief blips are swallowed.
     */
    const recompute = () => {
      if (disposed) {
        return
      }
      const resolved = resolveConnectionStatus(sampleSignals())

      if (resolved === 'online') {
        // Recover promptly; cancel any pending "go down" timer.
        clearGrace()
        apply('online')
        return
      }

      if (statusRef.current.kind !== 'online') {
        // Already in a down/degraded state — update immediately (e.g. moving
        // between reconnecting and offline) without a new grace period.
        clearGrace()
        apply(resolved)
        return
      }

      // Currently online, want to go down: require the condition to persist.
      if (graceTimeout) {
        return
      }
      graceTimeout = setTimeout(() => {
        graceTimeout = undefined
        if (disposed) {
          return
        }
        // Re-sample after the grace period; only commit if still not healthy.
        const stillResolved = resolveConnectionStatus(sampleSignals())
        if (stillResolved !== 'online') {
          apply(stillResolved)
        } else {
          apply('online')
        }
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

    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    // Slow fallback heartbeat: samples the websocket open state (no discrete
    // event exists for it) without being a spammy poll.
    const heartbeat = setInterval(recompute, CONNECTION_HEARTBEAT_MS)

    return () => {
      disposed = true
      clearGrace()
      clearInterval(heartbeat)
      removeEventObserver()
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [application])

  return status
}
