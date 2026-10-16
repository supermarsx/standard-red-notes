import { useEffect, useMemo, useState } from 'react'
import { SNNote, SharedVaultUserServerHash } from '@standardnotes/snjs'
import { useApplication } from '@/Components/ApplicationProvider'
import { useItemVaultInfo } from '@/Hooks/useItemVaultInfo'
import { MentionCandidate } from './mentions'

const NO_MEMBERS: SharedVaultUserServerHash[] = []

/**
 * Source the @mention autocomplete from the note's shared-vault membership — the
 * SAME source the title bar collaborators popup (`useVaultRoster`) uses: the server-backed member list
 * (`vaultUsers.getSharedVaultUsersFromServer`) with display names resolved via
 * trusted contacts (`contacts.findContactForServerUser`). The server hash only
 * carries `user_uuid`, so a member with no trusted contact falls back to showing
 * their uuid. The current account is available through the explicit @self alias.
 *
 * Solo notes offer @self without requesting any shared-vault membership.
 */
export function useMentionCandidates(note: SNNote): MentionCandidate[] {
  const application = useApplication()
  const { vault } = useItemVaultInfo(note)
  const user = application.sessions.getUser()
  const selfUuid = user?.uuid
  const scope = JSON.stringify([
    note.uuid,
    note.shared_vault_uuid,
    note.key_system_identifier,
    vault?.uuid,
    vault?.isSharedVaultListing() ? vault.sharing.sharedVaultUuid : undefined,
  ])
  const [fetched, setFetched] = useState<{
    scope: string
    user: typeof user
    members: SharedVaultUserServerHash[]
  }>()
  // A note can move between vaults without changing its UUID or remounting this
  // hook. Hide the previous scope before the new request/effect even starts.
  const members = fetched?.scope === scope && fetched.user === user ? fetched.members : NO_MEMBERS

  useEffect(() => {
    let cancelled = false
    if (!user || !vault || !vault.isSharedVaultListing()) {
      return
    }
    const publish = (members: SharedVaultUserServerHash[]) => {
      if (!cancelled && application.sessions.getUser() === user) {
        setFetched({ scope, user, members })
      }
    }
    void application.vaultUsers
      .getSharedVaultUsersFromServer(vault)
      .then((users) => publish(users ?? NO_MEMBERS))
      .catch(() => publish(NO_MEMBERS))
    return () => {
      cancelled = true
    }
  }, [application.sessions, application.vaultUsers, scope, user, vault])

  return useMemo<MentionCandidate[]>(() => {
    return [
      ...(selfUuid ? [{ userUuid: selfUuid, name: 'self' }] : []),
      ...members
        .filter((member) => member.user_uuid !== selfUuid)
        .map((member) => {
          const contact = application.contacts.findContactForServerUser(member)
          return {
            userUuid: member.user_uuid,
            name: contact?.name || member.user_uuid,
          }
        }),
    ]
  }, [members, application.contacts, selfUuid])
}
