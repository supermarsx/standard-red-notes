import { WebApplication } from '@/Application/WebApplication'
import { ApplicationEvent } from '@standardnotes/snjs'
import { useEffect, useState } from 'react'

export type ConnectionStatusKind = 'online' | 'offline' | 'reconnecting'

export type ConnectionStatus = {
  kind: ConnectionStatusKind
  /** Last successful sync time, if known. */
  lastSyncDate?: Date
  /** True when the active account has no server session (purely local). */
  signedOut: boolean
}

/**
 * Derives a live server-connection status from a combination of:
 *  - `navigator.onLine` + window `online`/`offline` events (browser-level reachability)
 *  - snjs sync ApplicationEvents (WillSync / CompletedFullSync / CompletedIncrementalSync /
 *    FailedSync / EnteredOutOfSync / ExitedOutOfSync) for the app's actual sync health
 *
 * Resulting states:
 *  - `offline`      — browser reports offline.
 *  - `reconnecting` — online, but a sync is in progress, recently failed, or out of sync (transient).
 *  - `online`       — online and the last sync completed successfully.
 */
export function useConnectionStatus(application: WebApplication): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(() =>
    deriveStatus(application, typeof navigator !== 'undefined' ? navigator.onLine : true, false, false),
  )

  useEffect(() => {
    let browserOnline = typeof navigator !== 'undefined' ? navigator.onLine : true
    let syncing = false
    let hadRecentFailure = application.sync.getSyncStatus().hasError() || application.sync.isOutOfSync()

    const recompute = () => {
      setStatus(deriveStatus(application, browserOnline, syncing, hadRecentFailure))
    }

    recompute()

    const removeEventObserver = application.addEventObserver(async (event) => {
      switch (event) {
        case ApplicationEvent.WillSync:
          syncing = true
          break
        case ApplicationEvent.CompletedFullSync:
        case ApplicationEvent.CompletedIncrementalSync:
          syncing = false
          hadRecentFailure = application.sync.getSyncStatus().hasError() || application.sync.isOutOfSync()
          break
        case ApplicationEvent.FailedSync:
          syncing = false
          hadRecentFailure = true
          break
        case ApplicationEvent.EnteredOutOfSync:
          hadRecentFailure = true
          break
        case ApplicationEvent.ExitedOutOfSync:
          hadRecentFailure = application.sync.getSyncStatus().hasError()
          break
        default:
          return
      }
      recompute()
    })

    const onOnline = () => {
      browserOnline = true
      recompute()
    }
    const onOffline = () => {
      browserOnline = false
      recompute()
    }

    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    return () => {
      removeEventObserver()
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [application])

  return status
}

function deriveStatus(
  application: WebApplication,
  browserOnline: boolean,
  syncing: boolean,
  hadRecentFailure: boolean,
): ConnectionStatus {
  const signedOut = application.sessions.isSignedOut()
  const lastSyncDate = application.sync.getLastSyncDate() ?? undefined

  let kind: ConnectionStatusKind
  if (!browserOnline) {
    kind = 'offline'
  } else if (syncing || hadRecentFailure) {
    kind = 'reconnecting'
  } else {
    kind = 'online'
  }

  return { kind, lastSyncDate, signedOut }
}
