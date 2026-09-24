import { WebApplication } from '@/Application/WebApplication'
import { ContentType, PayloadEmitSource, SNNote } from '@standardnotes/snjs'
import { addToast, dismissToast, ToastType } from '@standardnotes/toast'
import { useEffect } from 'react'

export type ConflictWarning = { title: string; message: string }

/**
 * The toast copy for a newly-appeared conflicted copy.
 *
 * When the original survives, both versions are on hand and the framing is a
 * straightforward "two copies were kept". When it does not, talking about "the
 * server's version" would be false — that note is gone — and the useful message is
 * that the unsaved work was recovered into a new note and is not lost.
 */
export const describeConflictWarning = (originalExists: boolean): ConflictWarning => {
  if (originalExists) {
    return {
      title: 'Sync conflict',
      message:
        'A sync conflict occurred — your edit and the server’s version were both kept as separate copies. Review them in Preferences → Sync.',
    }
  }

  return {
    title: 'Note recovered from a conflict',
    message:
      'A note you were editing no longer exists, but your unsaved changes were kept as a new copy — nothing was lost. Find it in Preferences → Sync.',
  }
}

/**
 * Whether a streamed note should raise a warning, and what it should say.
 *
 * A missing original is deliberately NOT a reason to stay quiet. It means the copy is
 * the only surviving version of the user's content, so the warning matters more, not
 * less — it only changes the wording.
 */
export const conflictWarningForNote = (
  note: { uuid: string; conflictOf?: string },
  originalExists: boolean,
  alreadyWarned: boolean,
): ConflictWarning | undefined => {
  if (!note.conflictOf || alreadyWarned) {
    return undefined
  }

  return describeConflictWarning(originalExists)
}

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
 * copy. We reuse the exact predicate the Conflicts preferences pane uses (a note
 * with `conflictOf` set), so the warning never drifts from what that pane lists.
 * That includes copies whose original no longer exists — the case where the copy
 * holds the only surviving version, and so the case the user most needs told.
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

    return application.items.streamItems<SNNote>(ContentType.TYPES.Note, ({ changed, inserted, source }) => {
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
        const originalExists = note.conflictOf ? application.items.findItem(note.conflictOf) !== undefined : false

        const warning = conflictWarningForNote(note, originalExists, warnedConflictUuids.has(note.uuid))
        if (!warning) {
          continue
        }

        warnedConflictUuids.add(note.uuid)

        addToast({
          type: ToastType.Error,
          title: warning.title,
          message: warning.message,
          actions: [
            {
              label: 'Review',
              handler: (toastId) => {
                application.preferencesController.openPreferences('sync')
                dismissToast(toastId)
              },
            },
          ],
        })
      }
    })
  }, [application])
}
