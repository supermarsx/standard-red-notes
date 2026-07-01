import { WebApplication } from '@/Application/WebApplication'
import { NoteViewController } from '@/Components/NoteView/Controller/NoteViewController'
import { useEffect } from 'react'

/**
 * Standard Red Notes (last-edit-loss fix): true iff any open note editor has a
 * serialize mid-debounce — an edit that exists ONLY in the editor's 350ms timer
 * closure and is NOT yet dirty, so getDirtyItems/syncInProgress below cannot see it.
 * Without this, a tab closed mid-debounce would close with NO warning and lose the
 * edit. Read-only and synchronous, safe to call from beforeunload.
 */
const hasPendingEditorDebounce = (application: WebApplication): boolean => {
  try {
    return application.itemControllerGroup.itemControllers.some(
      (controller) => controller instanceof NoteViewController && controller.editorHasPendingChanges(),
    )
  } catch {
    return false
  }
}

/**
 * Standard Red Notes (last-edit-loss fix): synchronously flush every open note
 * editor's pending serialize, with the sync debounce bypassed, so the edit is
 * dirtied and its local IDB save is INITIATED before the tab tears down. beforeunload
 * cannot await the async write, but this maximizes the chance it persists and makes
 * the warning below accurate. Best-effort; never throws.
 */
const flushPendingEditorDebounces = (application: WebApplication): void => {
  try {
    for (const controller of application.itemControllerGroup.itemControllers) {
      if (controller instanceof NoteViewController) {
        controller.flushEditorSerialize()
      }
    }
  } catch {
    // best-effort
  }
}

/**
 * Returns true iff there is data at risk of being lost if the tab closed *right
 * now*: either there are dirty items that have not yet been persisted/pushed, a
 * sync (which, with no account, is a local IndexedDB save) is mid-flight, or an
 * edit is sitting in the Super editor's serialize debounce (not yet dirty).
 *
 * The accessors are READ-ONLY, synchronous reflections of current state:
 *  - `application.items.getDirtyItems()` — items flagged needing-sync that have
 *    not yet been persisted to the local DB and/or pushed to the server.
 *  - `application.sync.getSyncStatus().syncInProgress` — a sync/local-save is
 *    actively running (so even already-clean-looking items may be in transit).
 *  - `hasPendingEditorDebounce` — an edit lives only in the editor's debounce timer
 *    (Standard Red Notes last-edit-loss fix), invisible to the two checks above.
 *
 * This is deliberately CONSERVATIVE: when all are clear we return false and the
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

    if (application.items.getDirtyItems().length > 0) {
      return true
    }

    return hasPendingEditorDebounce(application)
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
      /**
       * Standard Red Notes (last-edit-loss fix — beforeunload best-effort): FIRST
       * synchronously flush any editor serialize sitting in the 350ms debounce, with
       * the sync debounce bypassed. This dirties the item and initiates its local IDB
       * save synchronously (maximizing the chance it persists before the tab dies) AND
       * makes the warning below accurate — after the flush the edit is a dirty item, so
       * hasPendingUnsavedChanges sees it via getDirtyItems even if the editor's own
       * beforeunload handler has not run yet. (We cannot await the async IDB write, so a
       * truly last-instant edit may still not finish — a large improvement over the
       * prior silent no-warning loss.)
       */
      flushPendingEditorDebounces(application)

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
