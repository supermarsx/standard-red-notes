import type { WebApplication } from '@/Application/WebApplication'
import { isLitePayload, isNote, type SNNote } from '@standardnotes/snjs'
import type { CommentAnchor } from './comments'
import {
  matchesNoteEncryptionIdentity,
  resolveNoteEncryptionIdentity,
} from '@/Components/SuperEditor/Collaboration/CollaborationKeyDerivation'

export type CommentTarget = 'note' | 'selection' | 'section' | 'checklist'
export type CapturedCommentTarget = {
  anchor?: CommentAnchor
  assertCurrent(options?: { sharedMutation?: boolean }): void
}
type Bridge = { capture(target: CommentTarget, todoId?: string): CapturedCommentTarget }
const bridges = new WeakMap<WebApplication, Map<string, { id: symbol; bridge: Bridge }[]>>()

/** App-scoped lifetimes: an older editor can never unregister a replacement. */
export function registerCommentTargetBridge(application: WebApplication, noteUuid: string, bridge: Bridge): () => void {
  let notes = bridges.get(application)
  if (!notes) {
    notes = new Map()
    bridges.set(application, notes)
  }
  const entry = { id: Symbol(noteUuid), bridge }
  notes.set(noteUuid, [...(notes.get(noteUuid) ?? []), entry])
  return () => {
    const remaining = (notes!.get(noteUuid) ?? []).filter((candidate) => candidate.id !== entry.id)
    if (remaining.length) {
      notes!.set(noteUuid, remaining)
    } else {
      notes!.delete(noteUuid)
    }
  }
}

export function captureAssistantCommentTarget(
  application: WebApplication,
  noteUuid: string,
  target: CommentTarget,
  todoId?: string,
): CapturedCommentTarget {
  const user = application.sessions.getUser()
  const current = () => {
    const note = application.items.findItem<SNNote>(noteUuid)
    if (
      !user ||
      application.sessions.getUser() !== user ||
      !note ||
      !isNote(note) ||
      note.trashed ||
      note.locked ||
      isLitePayload(note.payload) ||
      !application.isAuthorizedToRenderItem(note)
    ) {
      throw new Error('The note or comment session changed. Reopen the note and retry.')
    }
    return note
  }
  const note = current()
  const binding = { sharedVault: note.shared_vault_uuid, keySystem: note.key_system_identifier }
  let encryptionIdentity: ReturnType<typeof resolveNoteEncryptionIdentity>
  try {
    encryptionIdentity = resolveNoteEncryptionIdentity(application, note)
  } catch {
    encryptionIdentity = undefined
  }
  const entry = bridges.get(application)?.get(noteUuid)?.at(-1)
  if (!entry && target !== 'note') {
    throw new Error('Open this note in the live editor and select the target before adding a comment.')
  }
  const capture = entry?.bridge.capture(target, todoId)
  return {
    anchor: capture?.anchor,
    assertCurrent(options) {
      const live = current()
      if (
        live.shared_vault_uuid !== binding.sharedVault ||
        live.key_system_identifier !== binding.keySystem ||
        (encryptionIdentity && !matchesNoteEncryptionIdentity(application, encryptionIdentity, live))
      ) {
        throw new Error('The note encryption identity changed. Reopen the note before commenting.')
      }
      if (entry && bridges.get(application)?.get(noteUuid)?.at(-1) !== entry) {
        throw new Error('The comment editor changed. Select the target again.')
      }
      capture?.assertCurrent(options)
    },
  }
}
