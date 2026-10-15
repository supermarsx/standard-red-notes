import { useEffect, useState } from 'react'
import { ApplicationEvent, ContentType, SNNote } from '@standardnotes/snjs'
import { useApplication } from '@/Components/ApplicationProvider'
import { CommentsApi } from './useNoteComments'
import { generateCommentId, removeComment, setCommentResolved, upsertComment, normalizeComment } from './comments'
import { mutatePrivateNoteComments, readPrivateNoteComments } from './PrivateNoteComments'

export function usePrivateNoteComments(note: SNNote): CommentsApi {
  const application = useApplication()
  const user = application.sessions.getUser()
  const [, refresh] = useState(0)
  useEffect(() => {
    const changed = () => refresh((value) => value + 1)
    const stop = application.items.streamItems([ContentType.TYPES.UserPrefs, ContentType.TYPES.Note], changed)
    const stopPreferences = application.addEventObserver(async () => changed(), ApplicationEvent.PreferencesChanged)
    return () => {
      stop()
      stopPreferences()
    }
  }, [application, note.uuid, user])
  const current = () => application.sessions.getUser() === user
  return {
    selfUuid: user?.uuid,
    quarantinedCount: 0,
    comments: readPrivateNoteComments(application, note.uuid).map((comment) => ({
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
    setResolved: async (id, resolved) => {
      if (current()) {
        await mutatePrivateNoteComments(application, note.uuid, (comments) =>
          setCommentResolved(comments, id, resolved),
        )
      }
    },
  }
}
