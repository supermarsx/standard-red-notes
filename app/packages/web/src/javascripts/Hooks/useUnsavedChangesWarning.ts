import { WebApplication } from '@/Application/WebApplication'
import { useEffect } from 'react'

/**
 * Returns true iff there is data at risk of being lost if the tab closed *right
 * now*: either there are dirty items that have not yet been persisted/pushed, or
 * a sync (which, with no account, is a local IndexedDB save) is mid-flight.
 *
 * Both accessors are READ-ONLY, synchronous reflections of current sync state:
 *  - `application.items.getDirtyItems()` — items flagged needing-sync that have
 *    not yet been persisted to the local DB and/or pushed to the server.
 *  - `application.sync.getSyncStatus().syncInProgress` — a sync/local-save is
 *    actively running (so even already-clean-looking items may be in transit).
 *
 * This is deliberately CONSERVATIVE: when both are clear we return false and the
 * caller fires no beforeunload prompt, so the user is never nagged when there is
 * genuinely nothing pending.
 */
export const hasPendingUnsavedChanges = (application: WebApplication): boolean => {
  try {
    if (!application.isLaunched()) {
      return false
    }

    if (application.sync.getSyncStatus().syncInProgress) {
      return true
    }

    return application.items.getDirtyItems().length > 0
  } catch {
    // If state can't be read for any reason, don't block the user from leaving.
    return false
  }
}

/**
 * App-wide guard: warn the user (via the browser's native "Leave site? Changes
 * may not be saved" confirmation) when they try to close/reload the tab while
 * there are un-synced/dirty changes or a sync/local-save is in progress.
 *
 * The handler is silent when everything is clean/idle — `preventDefault()` is
 * only ever called when `hasPendingUnsavedChanges` is true, so a clean tab
 * closes without any prompt.
 */
export const useUnsavedChangesWarning = (application: WebApplication): void => {
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!hasPendingUnsavedChanges(application)) {
        return
      }

      // Trigger the browser's native unsaved-changes confirmation. Both the
      // preventDefault() and a non-undefined returnValue are required for
      // cross-browser support; the string is ignored by modern browsers, which
      // show their own generic message.
      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [application])
}
