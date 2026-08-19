import { addToast, ToastType } from '@standardnotes/toast'
import type { CollaborationPresenceActivity } from './EphemeralRoomPresence'

/** Render one memory-only in-app activity notification. No item is persisted. */
export function showCollaborationPresenceActivity(
  activity: Pick<CollaborationPresenceActivity, 'action' | 'label'>,
): void {
  try {
    addToast({
      type: ToastType.Regular,
      message: `${activity.label} ${activity.action === 'joined' ? 'joined' : 'left'} this note.`,
    })
  } catch {
    // A transient notification failure cannot affect collaboration state.
  }
}
