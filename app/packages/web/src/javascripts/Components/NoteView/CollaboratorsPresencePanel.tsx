import { FunctionComponent, useEffect, useMemo, useState } from 'react'
import { DecryptedItemInterface, SharedVaultUserServerHash } from '@standardnotes/snjs'
import { useApplication } from '@/Components/ApplicationProvider'
import { useItemVaultInfo } from '@/Hooks/useItemVaultInfo'
import { collaboratorColor, collaboratorInitials } from '../SuperEditor/Collaboration/collaboratorColor'
import { PresenceRegistry, PresentPeer } from '../SuperEditor/Collaboration/PresenceRegistry'
import { getSuperCollaborationAvailability } from '../SuperEditor/Collaboration/CollaborationAvailability'

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
 * Sidebar panel listing the other members of the current note's shared vault and
 * indicating who is genuinely online (has this same note open right now).
 *
 * "Online" is a REAL signal: it comes from the live yjs awareness channel via
 * PresenceRegistry, which only holds a peer while their cursor is live on the
 * relay for this note. It is NOT derived from stale timestamps. When live
 * presence is unavailable, the panel still lists vault members but labels the
 * feature as security-gated instead of inventing online state.
 *
 * Renders nothing unless the note belongs to a shared vault with >1 member, so
 * solo notes are completely unaffected.
 */
const CollaboratorsPresencePanel: FunctionComponent<Props> = ({ item }) => {
  const application = useApplication()
  const { vault } = useItemVaultInfo(item)

  const [members, setMembers] = useState<SharedVaultUserServerHash[]>([])
  const [presentPeers, setPresentPeers] = useState<PresentPeer[]>([])

  const collaborationAvailability = getSuperCollaborationAvailability()
  const liveEnabled = collaborationAvailability.available
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
    <div className="border-border bg-default rounded border p-2.5">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-passive-0 text-xs font-semibold tracking-wide uppercase">Collaborators</div>
        {liveEnabled ? (
          <div className="text-passive-1 text-xs">{onlineCount} online</div>
        ) : (
          <div
            className="text-passive-2 text-xs"
            title={collaborationAvailability.available ? undefined : collaborationAvailability.reason}
          >
            collaboration unavailable
          </div>
        )}
      </div>
      {!collaborationAvailability.available && (
        <div className="text-passive-2 mb-2 text-xs">{collaborationAvailability.reason}</div>
      )}
      <div className="max-h-44 space-y-1.5 overflow-y-auto overscroll-contain md:max-h-none md:overflow-visible">
        {displayMembers.map((member) => {
          const online = isOnline(member)
          return (
            <div key={member.userUuid} className="flex items-center gap-2">
              <div className="relative">
                <div
                  className="flex h-6 w-6 items-center justify-center rounded-full text-[0.6rem] font-bold text-white select-none"
                  style={{ backgroundColor: member.color }}
                  aria-hidden
                >
                  {collaboratorInitials(member.name)}
                </div>
                {liveEnabled && online && (
                  <span
                    className="border-default bg-success absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2"
                    title="Online — editing this note now"
                  />
                )}
              </div>
              <div className="flex min-w-0 flex-col">
                <span className="text-text truncate text-sm font-medium">{member.name}</span>
                {liveEnabled && (
                  <span className={online ? 'text-success text-xs' : 'text-passive-2 text-xs'}>
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
