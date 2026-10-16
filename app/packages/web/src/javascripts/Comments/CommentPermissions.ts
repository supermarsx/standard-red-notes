import type { SNNote } from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'

/** Ownership comes from this account's vault metadata, never from a comment. */
export function noteCommentOwner(application: WebApplication, note: SNNote): string | undefined {
  try {
    const current = application.items.findItem<SNNote>(note.uuid)
    if (!current || !application.isAuthorizedToRenderItem(current)) {
      return undefined
    }
    const vault = application.vaults.getItemVault(current)
    if (current.shared_vault_uuid) {
      return vault?.isSharedVaultListing() && vault.sharing.sharedVaultUuid === current.shared_vault_uuid
        ? vault.sharing.ownerUserUuid
        : undefined
    }
    if (vault?.isSharedVaultListing()) {
      return undefined
    }
    return current.user_uuid ?? application.sessions.getUser()?.uuid
  } catch {
    return undefined
  }
}

export function canPurgeAllNoteComments(application: WebApplication, note: SNNote): boolean {
  const user = application.sessions.getUser()
  const current = application.items.findItem<SNNote>(note.uuid)
  return Boolean(
    user &&
    current &&
    noteCommentOwner(application, current) === user.uuid &&
    !current.locked &&
    !current.trashed &&
    !application.sessions.isCurrentSessionReadOnly(),
  )
}
