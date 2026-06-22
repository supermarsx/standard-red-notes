import { useEffect, useMemo, useState } from 'react'
import { SNNote, SharedVaultUserServerHash } from '@standardnotes/snjs'
import { useApplication } from '@/Components/ApplicationProvider'
import { useItemVaultInfo } from '@/Hooks/useItemVaultInfo'
import { MentionCandidate } from './mentions'

/**
 * Source the @mention autocomplete from the note's shared-vault membership — the
 * SAME source the CollaboratorsPresencePanel uses: the server-backed member list
 * (`vaultUsers.getSharedVaultUsersFromServer`) with display names resolved via
 * trusted contacts (`contacts.findContactForServerUser`). The server hash only
 * carries `user_uuid`, so a member with no trusted contact falls back to showing
 * their uuid. The local user is excluded (you can't @mention yourself).
 *
 * Returns an empty list for solo notes, so nothing changes there.
 */
export function useMentionCandidates(note: SNNote): MentionCandidate[] {
  const application = useApplication()
  const { vault } = useItemVaultInfo(note)
  const [members, setMembers] = useState<SharedVaultUserServerHash[]>([])

  const selfUuid = application.sessions.getUser()?.uuid

  useEffect(() => {
    let cancelled = false
    if (!vault || !vault.isSharedVaultListing()) {
      setMembers([])
      return
    }
    void application.vaultUsers.getSharedVaultUsersFromServer(vault).then((users) => {
      if (!cancelled && users) {
        setMembers(users)
      }
    })
    return () => {
      cancelled = true
    }
  }, [application.vaultUsers, vault])

  return useMemo<MentionCandidate[]>(() => {
    return members
      .filter((member) => member.user_uuid !== selfUuid)
      .map((member) => {
        const contact = application.contacts.findContactForServerUser(member)
        return {
          userUuid: member.user_uuid,
          name: contact?.name || member.user_uuid,
        }
      })
  }, [members, application.contacts, selfUuid])
}
