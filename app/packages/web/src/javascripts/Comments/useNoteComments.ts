import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ContentType, SNNote } from '@standardnotes/snjs'
import { useApplication } from '@/Components/ApplicationProvider'
import { generateCommentId, NoteComment, normalizeComment } from './comments'
import { extractMentionedUuids } from './mentions'
import { useCollaborationRoomAccess } from '@/Components/SuperEditor/Collaboration/useCollaborationRoomAccess'
import { CommentRelay, CommentRelayEvent } from './CommentRelay'
import {
  type NoteEncryptionIdentity,
  resolveNoteEncryptionIdentity,
} from '@/Components/SuperEditor/Collaboration/CollaborationKeyDerivation'
import { DisplayNoteComment, readDisplayNoteComments } from './CommentAuthorship'

function sameEncryptionIdentity(
  left: NoteEncryptionIdentity | undefined,
  right: NoteEncryptionIdentity | undefined,
): boolean {
  return (
    left === right ||
    Boolean(
      left &&
      right &&
      left.noteUuid === right.noteUuid &&
      left.userUuid === right.userUuid &&
      left.sessionUser === right.sessionUser &&
      left.sourceId === right.sourceId &&
      left.keySystemIdentifier === right.keySystemIdentifier &&
      left.sharedVaultUuid === right.sharedVaultUuid,
    )
  )
}

export type CommentsApi = {
  comments: DisplayNoteComment[]
  quarantinedCount: number
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
  const [commentState, setCommentState] = useState(() => readDisplayNoteComments(application, note))
  const relayRef = useRef<CommentRelay | null>(null)
  const collaborationAccess = useCollaborationRoomAccess(application, note)
  const collaborationStatus = collaborationAccess.status
  const collaborationRoomKey = collaborationAccess.status === 'ready' ? collaborationAccess.roomKey : undefined
  const collaborationCapability = collaborationAccess.status === 'ready' ? collaborationAccess.capability : undefined

  let resolvedCommentIdentity: NoteEncryptionIdentity | undefined
  try {
    resolvedCommentIdentity = resolveNoteEncryptionIdentity(application, note)
  } catch {
    resolvedCommentIdentity = undefined
  }
  const commentIdentityRef = useRef<NoteEncryptionIdentity | undefined>(undefined)
  if (!sameEncryptionIdentity(commentIdentityRef.current, resolvedCommentIdentity)) {
    commentIdentityRef.current = resolvedCommentIdentity
  }
  const commentIdentity = commentIdentityRef.current

  const accessSourceId = collaborationAccess.status === 'ready' ? collaborationAccess.sourceId : undefined
  const accessUserUuid = collaborationAccess.status === 'ready' ? collaborationAccess.userUuid : undefined
  const accessSessionUser = collaborationAccess.status === 'ready' ? collaborationAccess.sessionUser : undefined
  const relayIdentity = useMemo<NoteEncryptionIdentity | undefined>(() => {
    if (!accessSourceId || !accessUserUuid || !accessSessionUser) {
      return undefined
    }
    return {
      noteUuid: note.uuid,
      userUuid: accessUserUuid,
      sessionUser: accessSessionUser,
      sourceId: accessSourceId,
      keySystemIdentifier: note.key_system_identifier ?? null,
      sharedVaultUuid: note.shared_vault_uuid ?? null,
    }
  }, [accessSessionUser, accessSourceId, accessUserUuid, note.key_system_identifier, note.shared_vault_uuid, note.uuid])

  const selfUuid = application.sessions.getUser()?.uuid
  const selfEmail = application.sessions.getUser()?.email
  const noteUuid = note.uuid

  useEffect(() => {
    if (collaborationStatus !== 'ready' || !collaborationRoomKey || !collaborationCapability || !relayIdentity) {
      relayRef.current = null
      return
    }

    // Bind every asynchronous relay operation to the exact session user object,
    // root-key source, note, and vault identity that prepared this room access.
    // Never resolve identity after decrypt, when a replacement same-UUID session
    // could otherwise inherit plaintext queued by the previous session.
    const handleRemoteEvent = async (event: CommentRelayEvent): Promise<boolean> => {
      const persisted = await application.notesController.applyRemoteCommentMutation(noteUuid, event, relayIdentity)
      if (!persisted) {
        return false
      }
      const currentNote = application.items.findItem<SNNote>(noteUuid)
      if (currentNote) {
        setCommentState(readDisplayNoteComments(application, currentNote))
      }
      return true
    }
    let relay: CommentRelay
    try {
      relay = new CommentRelay(
        application,
        noteUuid,
        collaborationRoomKey,
        collaborationCapability,
        handleRemoteEvent,
        relayIdentity,
      )
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
  }, [application, collaborationCapability, collaborationRoomKey, collaborationStatus, noteUuid, relayIdentity])

  // Re-read comments whenever this note changes on disk (local edit or HTTP sync
  // from a collaborator). Uses the same streamItems pattern as useItemVaultInfo.
  useEffect(() => {
    setCommentState(readDisplayNoteComments(application, note))
    const stopNotes = application.items.streamItems(ContentType.TYPES.Note, ({ changed }) => {
      const updated = changed.find((item) => item.uuid === noteUuid)
      if (updated) {
        setCommentState(readDisplayNoteComments(application, updated as SNNote))
      }
    })
    const stopContacts = application.items.streamItems(ContentType.TYPES.TrustedContact, () => {
      const currentNote = application.items.findItem<SNNote>(noteUuid)
      if (currentNote) {
        setCommentState(readDisplayNoteComments(application, currentNote))
      }
    })
    return () => {
      stopNotes()
      stopContacts()
    }
  }, [application, application.items, note, noteUuid])

  const addComment = useCallback<CommentsApi['addComment']>(
    async ({ text, parentId, anchor }) => {
      const trimmed = text.trim()
      if (!trimmed || !selfUuid) {
        return undefined
      }
      const mentions = extractMentionedUuids(trimmed)
      const comment: NoteComment = {
        id: generateCommentId(selfUuid),
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
      const normalizedComment = normalizeComment(comment)
      if (!normalizedComment) {
        return undefined
      }
      const relay = relayRef.current
      if (!commentIdentity) {
        return undefined
      }
      const result = await application.notesController.upsertNoteComment(note, normalizedComment, commentIdentity)
      if (result && relay && relayRef.current === relay) {
        await relay.broadcastUpsert(result.comment, result.mutation)
      }
      return result?.comment
    },
    [application.notesController, commentIdentity, note, selfUuid, selfEmail],
  )

  const removeComment = useCallback(
    async (id: string) => {
      const relay = relayRef.current
      if (!commentIdentity) {
        return
      }
      const mutation = await application.notesController.removeNoteComment(note, id, commentIdentity)
      if (mutation && relay && relayRef.current === relay) {
        await relay.broadcastRemove(id, mutation)
      }
    },
    [application.notesController, commentIdentity, note],
  )

  const setResolved = useCallback(
    async (id: string, resolved: boolean) => {
      const relay = relayRef.current
      if (!commentIdentity) {
        return
      }
      const result = await application.notesController.setNoteCommentResolved(note, id, resolved, commentIdentity)
      if (result && relay && relayRef.current === relay) {
        await relay.broadcastResolve(id, resolved, result.mutation)
      }
    },
    [application.notesController, commentIdentity, note],
  )

  return {
    comments: commentState.comments,
    quarantinedCount: commentState.quarantinedCount,
    addComment,
    removeComment,
    setResolved,
    selfUuid,
  }
}
