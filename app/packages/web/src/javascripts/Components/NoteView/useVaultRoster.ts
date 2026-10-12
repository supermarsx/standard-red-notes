import { useEffect, useMemo, useState } from 'react'
import { SharedVaultUserServerHash, SNNote } from '@standardnotes/snjs'
import { useApplication } from '@/Components/ApplicationProvider'
import { useItemVaultInfo } from '@/Hooks/useItemVaultInfo'
import { roleFromPermission, RosterMember } from './collaborators'

type VaultRoster = {
  /** Everyone the note's shared vault is shared with; empty for a note in no shared vault. */
  members: RosterMember[]
  selfUuid: string | undefined
  selfEmail: string | undefined
}

type FetchedUsers = {
  sharedVaultUuid: string
  users: SharedVaultUserServerHash[]
}

const NO_USERS: SharedVaultUserServerHash[] = []

/**
 * The members of the note's shared vault, named the way the rest of the app
 * names them: by trusted-contact name where there is one.
 *
 * This is one server read per vault, repeated only when `refreshKey` changes —
 * the caller bumps it when its popup opens, so the list is current when it is
 * looked at. A failed read keeps the last list instead of emptying it, and a
 * list is only ever shown for the vault it was read from.
 *
 * It deliberately does NOT mount `useCollaborationRoomAccess`: that hook
 * authorizes the room and drives awaited syncs, and whether live collaboration
 * is running is already published in `CollaborationStatusRegistry` by the one
 * editor that owns the room.
 */
export function useVaultRoster(note: SNNote, refreshKey: number): VaultRoster {
  const application = useApplication()
  const { vault } = useItemVaultInfo(note)
  const [fetched, setFetched] = useState<FetchedUsers>()

  const sharedVaultUuid = vault && vault.isSharedVaultListing() ? vault.sharing.sharedVaultUuid : undefined

  useEffect(() => {
    if (!vault || !vault.isSharedVaultListing()) {
      return
    }
    let cancelled = false
    const readFrom = vault.sharing.sharedVaultUuid
    application.vaultUsers
      .getSharedVaultUsersFromServer(vault)
      .then((users) => {
        if (!cancelled && users) {
          setFetched({ sharedVaultUuid: readFrom, users })
        }
      })
      // The roster is a courtesy: without it the popup still reports the session and whoever is live.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [application.vaultUsers, vault, refreshKey])

  const users = fetched && fetched.sharedVaultUuid === sharedVaultUuid ? fetched.users : NO_USERS

  const user = application.sessions.getUser()
  const selfUuid = user?.uuid
  const selfEmail = user?.email

  const members = useMemo<RosterMember[]>(() => {
    return users.map((member) => {
      const contactName =
        member.user_uuid === selfUuid ? undefined : application.contacts.findContactForServerUser(member)?.name
      const role = roleFromPermission(member.permission)
      return {
        userUuid: member.user_uuid,
        ...(contactName ? { contactName } : {}),
        ...(role ? { role } : {}),
      }
    })
  }, [users, application.contacts, selfUuid])

  return { members, selfUuid, selfEmail }
}
