import { useEffect, useState } from 'react'
import { ApplicationEvent, ContentType, SNNote } from '@standardnotes/snjs'
import { useApplication } from '@/Components/ApplicationProvider'
import { CommentsApi } from './useNoteComments'
import { generateCommentId, removeComment, setCommentResolved, upsertComment, normalizeComment } from './comments'
import { mutatePrivateNoteComments, readPrivateNoteComments, privateCommentsReadError } from './PrivateNoteComments'
import { PRIVATE_COMMENT_CONTENT_TYPE, privateCommentItemTouchesNote } from './PrivateCommentOperations'

export function usePrivateNoteComments(note: SNNote): CommentsApi {
  const application = useApplication()
  const user = application.sessions.getUser()
  const [, refresh] = useState(0)
  useEffect(() => {
    const changed = () => refresh((value) => value + 1)
    // Read the current state during render. An initial stream push would repeat
    // that work, and unrelated note saves cannot change this private thread.
    const stop = application.items.addObserver(
      [ContentType.TYPES.UserPrefs, ContentType.TYPES.Note, PRIVATE_COMMENT_CONTENT_TYPE],
      ({ changed: updated, inserted, removed, unerrored }) => {
        if (
          [...updated, ...inserted, ...removed, ...unerrored].some(
            (item) =>
              item.uuid === note.uuid ||
              item.content_type === ContentType.TYPES.UserPrefs ||
              (item.content_type === PRIVATE_COMMENT_CONTENT_TYPE && privateCommentItemTouchesNote(item, note.uuid)),
          )
        ) {
          changed()
        }
      },
    )
    const stopPreferences = application.addEventObserver(async () => changed(), ApplicationEvent.PreferencesChanged)
    return () => {
      stop()
      stopPreferences()
    }
  }, [application, note.uuid, user])
  const current = () => application.sessions.getUser() === user
  const comments = readPrivateNoteComments(application, note.uuid)
  return {
    readError: privateCommentsReadError?.(application),
    selfUuid: user?.uuid,
    quarantinedCount: 0,
    comments: comments.map((comment) => ({
      ...comment,
      authorshipStatus: 'verified',
      verifiedAuthorUuid: comment.authorUuid,
      displayAuthorName: 'You',
    })),
    addComment: async ({ text, parentId, anchor }) => {
      if (!user || !current()) {
        return undefined
      }
      const comment = normalizeComment({
        id: generateCommentId(user.uuid),
        authorUuid: user.uuid,
        authorName: 'You',
        text: text.trim(),
        createdAt: new Date().toISOString(),
        parentId,
        anchor,
      })
      if (!comment) {
        return undefined
      }
      await mutatePrivateNoteComments(application, note.uuid, (comments) => {
        if (!current() || (parentId && !comments.some((parent) => parent.id === parentId))) {
          throw new Error('The private comment thread is no longer available.')
        }
        return upsertComment(comments, comment)
      })
      return current() ? comment : undefined
    },
    removeComment: async (id) => {
      if (current()) {
        await mutatePrivateNoteComments(application, note.uuid, (comments) => removeComment(comments, id))
      }
    },
    purgeComments: async () => {
      if (!user || !current()) {
        throw new Error('The private comment session is no longer available.')
      }
      await mutatePrivateNoteComments(application, note.uuid, () => {
        if (!current()) {
          throw new Error('The private comment session is no longer available.')
        }
        return []
      })
    },
    setResolved: async (id, resolved) => {
      if (current()) {
        await mutatePrivateNoteComments(application, note.uuid, (comments) =>
          setCommentResolved(comments, id, resolved),
        )
      }
    },
  }
}
