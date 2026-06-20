import { FunctionComponent, useEffect, useMemo, useState } from 'react'
import { DecryptedItemInterface, SharedVaultUserServerHash } from '@standardnotes/snjs'
import { useApplication } from '@/Components/ApplicationProvider'
import { useItemVaultInfo } from '@/Hooks/useItemVaultInfo'
import {
  collaboratorColor,
  collaboratorInitials,
} from '../SuperEditor/Collaboration/collaboratorColor'
import { PresenceRegistry, PresentPeer } from '../SuperEditor/Collaboration/PresenceRegistry'

type Props = {
  item: DecryptedItemInterface
}

type DisplayMember = {
  userUuid: string
  name: string
  color: string
  isSelf: boolean
}

/**
 * Whether the live-presence signal is even possible for this client. Remote
 * presence rides the Super editor's yjs awareness channel, which is opt-in
 * behind window.enableSuperCollaboration (see SuperEditor.tsx). When that flag
 * is off there is NO real online signal, so we say so rather than faking dots.
 */
function isLivePresenceEnabled(): boolean {
  return Boolean((window as { enableSuperCollaboration?: boolean }).enableSuperCollaboration)
}

/**
 * Sidebar panel listing the other members of the current note's shared vault and
 * indicating who is genuinely online (has this same note open right now).
 *
 * "Online" is a REAL signal: it comes from the live yjs awareness channel via
 * PresenceRegistry, which only holds a peer while their cursor is live on the
 * relay for this note. It is NOT derived from stale timestamps. When live
 * presence is unavailable (collaboration flag off), the panel still lists vault
 * members but labels their status as unavailable instead of inventing it.
 *
 * Renders nothing unless the note belongs to a shared vault with >1 member, so
 * solo notes are completely unaffected.
 */
const CollaboratorsPresencePanel: FunctionComponent<Props> = ({ item }) => {
  const application = useApplication()
  const { vault } = useItemVaultInfo(item)

  const [members, setMembers] = useState<SharedVaultUserServerHash[]>([])
  const [presentPeers, setPresentPeers] = useState<PresentPeer[]>([])

  const liveEnabled = isLivePresenceEnabled()
  const room = item.uuid

  // Load the shared-vault member list (server-backed, cached by the service).
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

  // Subscribe to live presence for this note's room.
  useEffect(() => {
    setPresentPeers(PresenceRegistry.getPeers(room))
    return PresenceRegistry.subscribe(room, setPresentPeers)
  }, [room])

  const selfUuid = application.sessions.getUser()?.uuid

  // Map server members to display rows (resolve name via trusted contacts).
  const displayMembers = useMemo<DisplayMember[]>(() => {
    return members.map((member) => {
      const contact = application.contacts.findContactForServerUser(member)
      const isSelf = member.user_uuid === selfUuid
      const name = contact?.name || (isSelf ? 'You' : member.user_uuid)
      return {
        userUuid: member.user_uuid,
        name,
        color: collaboratorColor(member.user_uuid),
        isSelf,
      }
    })
  }, [members, application.contacts, selfUuid])

  // A member is online iff a live peer published their uuid. Peers without a
  // uuid (older clients) are matched best-effort by display name.
  const onlineUuids = useMemo(() => {
    const byUuid = new Set<string>()
    const byName = new Set<string>()
    for (const peer of presentPeers) {
      if (peer.userUuid) {
        byUuid.add(peer.userUuid)
      } else if (peer.name) {
        byName.add(peer.name)
      }
    }
    return { byUuid, byName }
  }, [presentPeers])

  const isOnline = (member: DisplayMember): boolean => {
    if (member.isSelf) {
      return false
    }
    return onlineUuids.byUuid.has(member.userUuid) || onlineUuids.byName.has(member.name)
  }

  // Only meaningful for an actually-shared vault with more than just yourself.
  if (!vault || !vault.isSharedVaultListing() || displayMembers.length < 2) {
    return null
  }

  const onlineCount = displayMembers.filter(isOnline).length

  return (
    <div className="rounded border border-border bg-default p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-passive-0">Collaborators</div>
        {liveEnabled ? (
          <div className="text-xs text-passive-1">{onlineCount} online</div>
        ) : (
          <div className="text-xs text-passive-2" title="Live presence requires collaboration to be enabled">
            live status unavailable
          </div>
        )}
      </div>
      <div className="space-y-1.5">
        {displayMembers.map((member) => {
          const online = isOnline(member)
          return (
            <div key={member.userUuid} className="flex items-center gap-2">
              <div className="relative">
                <div
                  className="flex h-6 w-6 select-none items-center justify-center rounded-full text-[0.6rem] font-bold text-white"
                  style={{ backgroundColor: member.color }}
                  aria-hidden
                >
                  {collaboratorInitials(member.name)}
                </div>
                {liveEnabled && online && (
                  <span
                    className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-default bg-success"
                    title="Online — editing this note now"
                  />
                )}
              </div>
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-text">{member.name}</span>
                {liveEnabled && (
                  <span className={online ? 'text-xs text-success' : 'text-xs text-passive-2'}>
                    {member.isSelf ? 'You' : online ? 'Online now' : 'Offline'}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default CollaboratorsPresencePanel
