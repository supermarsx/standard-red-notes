import { WebApplication } from '@/Application/WebApplication'
import { ContentType, PayloadEmitSource, SNNote } from '@standardnotes/snjs'
import { addToast, dismissToast, ToastType } from '@standardnotes/toast'
import { useEffect } from 'react'

/**
 * App-wide watcher that surfaces a real-time warning whenever a NEW sync
 * conflict appears.
 *
 * Standard Notes resolves conflicts non-destructively: when the server detects
 * that an item diverged it creates a "conflicted copy" (a duplicate note that
 * carries `conflictOf === original.uuid`). The user's data is never lost, but
 * this happens silently — a duplicate quietly appears and the user may never
 * realize their edit diverged. This hook adds a visible toast on top of that
 * behavior (it does NOT change the conflict resolution itself).
 *
 * Detection: we stream Note items and look for a freshly-appeared conflicted
 * copy. We reuse the exact predicate the Conflicts preferences pane uses (a
 * note with `conflictOf` set whose original still exists), so the warning never
 * drifts from what that pane lists.
 *
 * Dedupe / no-spam:
 *  - We skip the initial observer push and local-database load sources, so
 *    pre-existing conflicted copies are NOT warned about on app launch.
 *  - We track which conflicted-copy uuids we've already warned about in a Set,
 *    so a given conflict only produces one toast even if its payload is emitted
 *    multiple times across syncs.
 */
export const useConflictWarnings = (application: WebApplication): void => {
  useEffect(() => {
    const warnedConflictUuids = new Set<string>()

    return application.items.streamItems<SNNote>(
      ContentType.TYPES.Note,
      ({ changed, inserted, source }) => {
        // Ignore the synchronous push of existing items when the observer is
        // first registered and the local DB load — those represent conflicts
        // that already existed before this session, which we don't re-warn for.
        if (
          source === PayloadEmitSource.InitialObserverRegistrationPush ||
          source === PayloadEmitSource.LocalDatabaseLoaded
        ) {
          for (const note of changed.concat(inserted)) {
            if (note.conflictOf) {
              warnedConflictUuids.add(note.uuid)
            }
          }
          return
        }

        for (const note of changed.concat(inserted)) {
          if (!note.conflictOf || warnedConflictUuids.has(note.uuid)) {
            continue
          }

          // Match the Conflicts pane predicate exactly: only surface a conflict
          // when the original item it diverged from still exists.
          const original = application.items.findItem(note.conflictOf)
          if (!original) {
            continue
          }

          warnedConflictUuids.add(note.uuid)

          addToast({
            type: ToastType.Error,
            title: 'Sync conflict',
            message:
              'A sync conflict occurred — your edit and the server’s version were both kept as separate copies. Review them in Preferences → Conflicts.',
            actions: [
              {
                label: 'Review',
                handler: (toastId) => {
                  application.preferencesController.openPreferences('conflicts')
                  dismissToast(toastId)
                },
              },
            ],
          })
        }
      },
    )
  }, [application])
}
