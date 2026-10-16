import { SNNote } from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'
import { readDisplayNoteComments, DisplayNoteComment } from '@/Comments/CommentAuthorship'
import { ALL_NOTE_MEMBERS_RECIPIENT } from '@/Comments/CommentPreferences'
import type { AppNotification } from '@/Controllers/NotificationsController'

/** Only signed recipients on authorized shared notes can raise an in-app alert.
 * The content remains in the encrypted note; no email or server notification is sent.
 */
export class CommentNotificationReader {
  private verified = new WeakMap<SNNote, DisplayNoteComment[]>()

  invalidate(): void {
    this.verified = new WeakMap()
  }

  read(application: WebApplication, note: SNNote, selfUuid: string): AppNotification[] {
    if (!note.shared_vault_uuid || note.trashed || note.locked || !application.isAuthorizedToRenderItem(note)) {
      return []
    }
    let comments = this.verified.get(note)
    if (!comments) {
      comments = readDisplayNoteComments(application, note).comments
      this.verified.set(note, comments)
    }
    return comments
      .filter(
        (comment) =>
          comment.authorshipStatus === 'verified' &&
          Boolean(comment.verifiedAuthorUuid) &&
          comment.verifiedAuthorUuid !== selfUuid &&
          !comment.resolved &&
          (comment.mentions?.includes(ALL_NOTE_MEMBERS_RECIPIENT) || comment.mentions?.includes(selfUuid)),
      )
      .map((comment) => ({
        id: `comment:${selfUuid}:${note.uuid}:${comment.id}`,
        title: 'New comment',
        subtitle: note.title || 'Untitled note',
        message: `${comment.displayAuthorName} added ${comment.parentId ? 'a reply' : 'a comment'}.`,
        level: 'info',
        dismissable: true,
        action: {
          label: 'Open note',
          run: () => {
            const current = application.items.findItem<SNNote>(note.uuid)
            if (!current || current.trashed || current.locked || !application.isAuthorizedToRenderItem(current)) {
              return
            }
            void application.itemListController.openNote(current.uuid).catch(() => {
              void application.alerts.alert('The commented note could not be opened. Try opening it from your notes.')
            })
          },
        },
      }))
  }
}
