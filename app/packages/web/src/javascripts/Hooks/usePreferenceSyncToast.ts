import { WebApplication } from '@/Application/WebApplication'
import { ContentType, DecryptedItemInterface, PayloadEmitSource } from '@standardnotes/snjs'
import { addToast, ToastType } from '@standardnotes/toast'
import { useEffect } from 'react'

/**
 * App-wide watcher that shows a single, debounced success toast confirming a
 * user-initiated preference change was saved and synced to the server.
 *
 * ## How preferences are saved/synced
 * `application.setPreference(key, value)` -> `PreferencesService.setValue`
 * (packages/snjs/lib/Services/Preferences/PreferencesService.ts:108) which
 * dirties the single encrypted, synced `SN|UserPreferences` item and kicks off
 * a sync. The sync then uploads that item. Because preferences live in one
 * dedicated item, we can watch *that item's* payload lifecycle directly instead
 * of inferring from app-wide sync events — this is what lets us scope strictly
 * to preference changes and avoid false positives from note edits etc.
 *
 * ## Signal used
 * We `streamItems(ContentType.TYPES.UserPrefs)` and read the emit `source`
 * (packages/models/dist/Domain/Abstract/Payload/Types/EmitSource):
 *  - `LocalChanged`     -> the user dirtied the prefs item (a real pref change).
 *  - `RemoteSaved`      -> that prefs item was saved to the server (synced).
 *  - `OfflineSyncSaved` -> the prefs item was persisted locally only (offline /
 *                          signed out): saved, but not yet synced.
 *  - hydration sources (`InitialObserverRegistrationPush`, `LocalDatabaseLoaded`,
 *    `LocalRetrieved`, `RemoteRetrieved`, `PreSyncSave`, `ComponentRetrieved`,
 *    ...) are ignored so app launch / background reloads never toast.
 *
 * ## Debounce
 * A `LocalChanged` marks a change "pending". Toggling several settings quickly
 * produces several `LocalChanged` emits but they collapse into a single pending
 * flag, so the eventual `RemoteSaved`/`OfflineSyncSaved` yields exactly one
 * toast. A short timer (`DEBOUNCE_MS`) additionally coalesces a burst of
 * save-confirmations that may arrive close together within one sync round-trip.
 *
 * ## Honesty
 * We only claim "saved and synced" on a genuine `RemoteSaved` of the prefs
 * item. When the change is only persisted locally (`OfflineSyncSaved`, e.g. the
 * user is signed out or offline) we show the honest "saved locally, will sync
 * when online" variant instead. We never claim "synced" for a local-only save.
 */

export const PREFERENCE_SYNC_TOAST_DEBOUNCE_MS = 1_000

export type PreferenceSyncOutcome = 'synced' | 'saved-locally'

/**
 * Pure decision/debounce state machine for the preference-sync toast. Kept free
 * of React/timers so it can be unit tested in isolation.
 *
 * Feed it the emit `source` of each `SN|UserPreferences` payload (plus whether
 * the item is still dirty for the local-save case). It returns the running
 * state plus, when a toast should fire, the `emit` outcome. The hook turns
 * `emit` into an actual `addToast` (debounced via a timer).
 */
export type PreferenceSyncState = {
  /** A user pref change has happened and not yet been confirmed saved. */
  pendingChange: boolean
}

export const initialPreferenceSyncState: PreferenceSyncState = {
  pendingChange: false,
}

export type PreferenceSyncStepResult = {
  state: PreferenceSyncState
  /** Defined when a toast of this outcome should be shown. */
  emit?: PreferenceSyncOutcome
}

/**
 * Advance the state machine for a single prefs-item payload emit.
 *
 * @param state    current state
 * @param source   the `PayloadEmitSource` of the prefs item payload
 * @param stillDirty whether the prefs item is still dirty after this emit
 *                   (used to decide synced vs. saved-locally on a save event)
 */
export function reducePreferenceSync(
  state: PreferenceSyncState,
  source: PayloadEmitSource,
  stillDirty: boolean,
): PreferenceSyncStepResult {
  switch (source) {
    // The user changed a preference -> the prefs item became dirty. Collapse a
    // burst of changes into a single pending flag (idempotent).
    case PayloadEmitSource.LocalChanged:
      return { state: { pendingChange: true } }

    // The prefs item was saved to the server. Only confirm "synced" if this
    // corresponds to a change the user actually made (pendingChange) and the
    // item is no longer dirty (its changes truly made it up).
    case PayloadEmitSource.RemoteSaved:
      if (state.pendingChange && !stillDirty) {
        return { state: { pendingChange: false }, emit: 'synced' }
      }
      // A RemoteSaved with no pending user change (e.g. a server-side prefs
      // reconciliation) must not toast.
      return { state }

    // The prefs item was persisted to local storage only (offline / signed
    // out). Honest "saved locally" outcome — do NOT claim it synced.
    case PayloadEmitSource.OfflineSyncSaved:
      if (state.pendingChange) {
        return { state: { pendingChange: false }, emit: 'saved-locally' }
      }
      return { state }

    // Everything else (hydration, retrievals, pre-sync save, component pushes)
    // is not a user-driven save confirmation and is ignored.
    default:
      return { state }
  }
}

const TOAST_MESSAGES: Record<PreferenceSyncOutcome, string> = {
  synced: 'Settings saved and synced',
  'saved-locally': 'Settings saved locally (will sync when online)',
}

const TOAST_TYPES: Record<PreferenceSyncOutcome, ToastType> = {
  synced: ToastType.Success,
  'saved-locally': ToastType.Regular,
}

export const usePreferenceSyncToast = (application: WebApplication): void => {
  useEffect(() => {
    let state = initialPreferenceSyncState
    let debounceTimer: ReturnType<typeof setTimeout> | undefined
    let pendingOutcome: PreferenceSyncOutcome | undefined

    const flush = () => {
      debounceTimer = undefined
      if (!pendingOutcome) {
        return
      }
      const outcome = pendingOutcome
      pendingOutcome = undefined
      addToast({
        type: TOAST_TYPES[outcome],
        message: TOAST_MESSAGES[outcome],
      })
    }

    const scheduleToast = (outcome: PreferenceSyncOutcome) => {
      // A genuine "synced" confirmation supersedes a queued "saved-locally"
      // (e.g. an offline save that then reached the server in the same window).
      if (pendingOutcome !== 'synced') {
        pendingOutcome = outcome
      }
      if (!debounceTimer) {
        debounceTimer = setTimeout(flush, PREFERENCE_SYNC_TOAST_DEBOUNCE_MS)
      }
    }

    const removeObserver = application.items.streamItems<DecryptedItemInterface>(
      ContentType.TYPES.UserPrefs,
      ({ changed, inserted, source }) => {
        // The prefs singleton is the only item of this type; inspect it for its
        // dirty state when deciding synced vs. saved-locally.
        const prefsItem = changed.concat(inserted)[0]
        const stillDirty = prefsItem?.dirty ?? false

        const result = reducePreferenceSync(state, source, stillDirty)
        state = result.state
        if (result.emit) {
          scheduleToast(result.emit)
        }
      },
    )

    return () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer)
      }
      removeObserver()
    }
  }, [application])
}
