import { useCallback, useEffect, useRef, useState } from 'react'
import { ContentType, SNNote } from '@standardnotes/snjs'
import { useApplication } from '@/Components/ApplicationProvider'
import {
  generateCommentId,
  getNoteComments,
  NoteComment,
  removeComment as removeCommentFromList,
  setCommentResolved as setCommentResolvedInList,
  upsertComment,
} from './comments'
import { extractMentionedUuids } from './mentions'
import { useCollaborationRoomAccess } from '@/Components/SuperEditor/Collaboration/useCollaborationRoomAccess'
import { CommentRelay, CommentRelayEvent } from './CommentRelay'

export type CommentsApi = {
  comments: NoteComment[]
  /** Add a new top-level comment or reply. Returns the created comment. */
  addComment: (input: {
    text: string
    parentId?: string
    anchor?: NoteComment['anchor']
  }) => Promise<NoteComment | undefined>
  removeComment: (id: string) => Promise<void>
  setResolved: (id: string, resolved: boolean) => Promise<void>
  /** The local account uuid, so the UI can distinguish "your" comments. */
  selfUuid?: string
}

/**
 * Loads + manages a note's comment thread.
 *
 * Storage is E2E (note appData via NotesController) and reaches collaborators
 * through normal encrypted HTTP sync. When exact-note collaboration access is
 * ready, the best-effort realtime relay uses the same non-extractable room key;
 * ordinary encrypted note persistence remains the durable fallback.
 */
export function useNoteComments(note: SNNote): CommentsApi {
  const application = useApplication()
  const [comments, setComments] = useState<NoteComment[]>(() => getNoteComments(note))
  const commentsRef = useRef(comments)
  commentsRef.current = comments
  const relayRef = useRef<CommentRelay | null>(null)
  const collaborationAccess = useCollaborationRoomAccess(application, note)
  const collaborationRoomKey = collaborationAccess.status === 'ready' ? collaborationAccess.roomKey : undefined
  const collaborationCapability = collaborationAccess.status === 'ready' ? collaborationAccess.capability : undefined

  const selfUuid = application.sessions.getUser()?.uuid
  const selfEmail = application.sessions.getUser()?.email
  const noteUuid = note.uuid

  useEffect(() => {
    if (!collaborationRoomKey || !collaborationCapability) {
      relayRef.current = null
      return
    }

    const handleRemoteEvent = (event: CommentRelayEvent): void => {
      setComments((current) => {
        return event.operation === 'upsert'
          ? upsertComment(current, event.comment)
          : removeCommentFromList(current, event.commentId)
      })
    }
    let relay: CommentRelay
    try {
      relay = new CommentRelay(application, noteUuid, collaborationRoomKey, collaborationCapability, handleRemoteEvent)
    } catch {
      // Realtime comments are optional. A socket-close race must fall back to
      // durable encrypted note sync instead of throwing from this React effect.
      relayRef.current = null
      return
    }
    relayRef.current = relay

    return () => {
      if (relayRef.current === relay) {
        relayRef.current = null
      }
      relay.destroy()
    }
  }, [application, collaborationCapability, collaborationRoomKey, noteUuid])

  // Re-read comments whenever this note changes on disk (local edit or HTTP sync
  // from a collaborator). Uses the same streamItems pattern as useItemVaultInfo.
  useEffect(() => {
    setComments(getNoteComments(note))
    return application.items.streamItems(ContentType.TYPES.Note, ({ changed }) => {
      const updated = changed.find((item) => item.uuid === noteUuid)
      if (updated) {
        setComments(getNoteComments(updated as SNNote))
      }
    })
  }, [application.items, note, noteUuid])

  const addComment = useCallback<CommentsApi['addComment']>(
    async ({ text, parentId, anchor }) => {
      const trimmed = text.trim()
      if (!trimmed || !selfUuid) {
        return undefined
      }
      const mentions = extractMentionedUuids(trimmed)
      const comment: NoteComment = {
        id: generateCommentId(),
        authorUuid: selfUuid,
        authorName: selfEmail ?? 'You',
        text: trimmed,
        createdAt: new Date().toISOString(),
      }
      if (anchor) {
        comment.anchor = anchor
      }
      if (parentId) {
        comment.parentId = parentId
      }
      if (mentions.length > 0) {
        comment.mentions = mentions
      }
      await application.notesController.upsertNoteComment(note, comment)
      await relayRef.current?.broadcastUpsert(comment)
      return comment
    },
    [application.notesController, note, selfUuid, selfEmail],
  )

  const removeComment = useCallback(
    async (id: string) => {
      await application.notesController.removeNoteComment(note, id)
      await relayRef.current?.broadcastRemove(id)
    },
    [application.notesController, note],
  )

  const setResolved = useCallback(
    async (id: string, resolved: boolean) => {
      await application.notesController.setNoteCommentResolved(note, id, resolved)
      const updated = setCommentResolvedInList(commentsRef.current, id, resolved).find((comment) => comment.id === id)
      if (updated) {
        await relayRef.current?.broadcastUpsert(updated)
      }
    },
    [application.notesController, note],
  )

  return { comments, addComment, removeComment, setResolved, selfUuid }
}
