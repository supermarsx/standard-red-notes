import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ContentType, SNNote } from '@standardnotes/snjs'
import { addToast, ToastType } from '@standardnotes/toast'
import { useApplication } from '@/Components/ApplicationProvider'
import {
  generateCommentId,
  getNoteComments,
  NoteComment,
  sortCommentsByCreatedAt,
} from './comments'
import { extractMentionedUuids, textMentionsUser } from './mentions'
import { CommentRelay } from './CommentRelay'

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
 * Storage is E2E (note appData via NotesController). On top of that, when the
 * note belongs to a shared vault, this hook opens a CommentRelay so new comments
 * are pushed live to collaborators who have the note open — and surfaces a toast
 * when an incoming comment @mentions the local user. Everything degrades to plain
 * HTTP sync when the socket is closed.
 */
export function useNoteComments(note: SNNote): CommentsApi {
  const application = useApplication()
  const [comments, setComments] = useState<NoteComment[]>(() => getNoteComments(note))
  const relayRef = useRef<CommentRelay | null>(null)

  const selfUuid = application.sessions.getUser()?.uuid
  const selfEmail = application.sessions.getUser()?.email
  const noteUuid = note.uuid

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

  // Resolve the shared-vault secret (same derivation the Super collab editor uses)
  // so the relay encrypts comments with the per-room key. Undefined for solo notes
  // — then there is no relay, only E2E persistence + HTTP sync.
  const sharedSecret = useMemo(() => {
    const vault = application.vaults.getItemVault(note)
    if (!vault || !vault.isSharedVaultListing()) {
      return undefined
    }
    return String(vault.systemIdentifier)
  }, [application.vaults, note])

  // Open/refresh the realtime relay for this room. The handler merges incoming
  // comments into local state immediately (HTTP sync is the durable backstop) and
  // raises a toast if the local user was @mentioned by someone else.
  useEffect(() => {
    if (!sharedSecret) {
      return
    }
    const relay = new CommentRelay(application, noteUuid, sharedSecret, (incoming) => {
      setComments((current) => {
        const next = current.filter((c) => c.id !== incoming.id)
        next.push(incoming)
        return sortCommentsByCreatedAt(next)
      })
      if (selfUuid && incoming.authorUuid !== selfUuid && textMentionsUser(incoming.text, selfUuid)) {
        addToast({
          type: ToastType.Regular,
          message: `${incoming.authorName} mentioned you in a comment`,
        })
      }
    })
    relayRef.current = relay
    return () => {
      relay.destroy()
      relayRef.current = null
    }
  }, [application, noteUuid, sharedSecret, selfUuid])

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
      void relayRef.current?.broadcast(comment)
      return comment
    },
    [application.notesController, note, selfUuid, selfEmail],
  )

  const removeComment = useCallback(
    async (id: string) => {
      await application.notesController.removeNoteComment(note, id)
    },
    [application.notesController, note],
  )

  const setResolved = useCallback(
    async (id: string, resolved: boolean) => {
      await application.notesController.setNoteCommentResolved(note, id, resolved)
      // Broadcast the resolved state so peers' threads update live too.
      const updated = getNoteComments(note).find((c) => c.id === id)
      if (updated) {
        void relayRef.current?.broadcast({ ...updated, resolved })
      }
    },
    [application.notesController, note],
  )

  return { comments, addComment, removeComment, setResolved, selfUuid }
}
