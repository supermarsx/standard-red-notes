import { useCallback, useEffect, useState } from 'react'
import { ContentType, SNNote } from '@standardnotes/snjs'
import { useApplication } from '@/Components/ApplicationProvider'
import { generateCommentId, getNoteComments, NoteComment } from './comments'
import { extractMentionedUuids } from './mentions'

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
 * through normal encrypted HTTP sync. Realtime comment relay is deliberately
 * disabled until the app can supply a non-extractable room key derived from
 * client-only vault key material; public vault identifiers are not secrets.
 */
export function useNoteComments(note: SNNote): CommentsApi {
  const application = useApplication()
  const [comments, setComments] = useState<NoteComment[]>(() => getNoteComments(note))

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
    },
    [application.notesController, note],
  )

  return { comments, addComment, removeComment, setResolved, selfUuid }
}
