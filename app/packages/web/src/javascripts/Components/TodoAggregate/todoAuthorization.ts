import { FeatureStatus, isLitePayload, NativeFeatureIdentifier, NoteType, SNNote } from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'
import { collectAllTodos, NoteTodos } from './allTodos'

const SuperEditorFeatureId = NativeFeatureIdentifier.create(NativeFeatureIdentifier.TYPES.SuperEditor).getValue()

/** Fail-closed visibility gate applied before any note title/body is parsed. */
export function canDisplayTodoNote(application: WebApplication, note: SNNote): boolean {
  if (note.trashed || note.locked || isLitePayload(note.payload)) {
    return false
  }
  try {
    return application.isAuthorizedToRenderItem(note)
  } catch {
    return false
  }
}

/** Match the editor's account and shared-vault write restrictions. */
export function canMutateSuperChecklistNote(application: WebApplication, note: SNNote | undefined): note is SNNote {
  if (!note || note.noteType !== NoteType.Super || !canDisplayTodoNote(application, note)) {
    return false
  }
  try {
    const vault = application.vaults.getItemVault(note)
    return (
      !application.sessions.isCurrentSessionReadOnly() &&
      !(vault?.isSharedVaultListing() && application.vaultUsers.isCurrentUserReadonlyVaultMember(vault)) &&
      application.features.getFeatureStatus(SuperEditorFeatureId, { inContextOfItem: note }) === FeatureStatus.Entitled
    )
  } catch {
    return false
  }
}

/** Authorization happens before collectAllTodos can inspect plaintext or title. */
export function collectAuthorizedTodoGroups(application: WebApplication, notes: SNNote[]): NoteTodos[] {
  return collectAllTodos(notes.filter((note) => canDisplayTodoNote(application, note)))
}
