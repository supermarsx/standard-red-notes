import { FunctionComponent, useMemo } from 'react'
import { DecryptedItemInterface } from '@standardnotes/snjs'
import { usePresence } from '../SuperEditor/Collaboration/usePresence'
import { PresentPeer } from '../SuperEditor/Collaboration/PresenceRegistry'
import {
  collaboratorColor,
  collaboratorInitials,
} from '../SuperEditor/Collaboration/collaboratorColor'

type Props = {
  item: DecryptedItemInterface
  /** Maximum avatars to render before collapsing into a "+N" chip. */
  maxAvatars?: number
}

/** Dedupe live peers by published userUuid (falling back to clientId). */
function dedupePeers(peers: PresentPeer[]): PresentPeer[] {
  const seen = new Set<string>()
  const result: PresentPeer[] = []
  for (const peer of peers) {
    const key = peer.userUuid || `client:${peer.clientId}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(peer)
    }
  }
  return result
}

/**
 * Compact presence badge shown next to the note title: a small stack of
 * collaborator avatars (plus a "+N" overflow chip) indicating who is editing
 * this note RIGHT NOW.
 *
 * The signal is GENUINE — it comes from the live yjs awareness channel via
 * PresenceRegistry (reused, no new socket traffic). The badge renders nothing
 * unless at least one other peer is actually present, so solo notes and notes
 * with no live collaborators are completely unaffected. When live presence is
 * unavailable (collaboration flag off) the registry is empty, so the badge also
 * stays hidden rather than inventing activity.
 */
const PresenceBadge: FunctionComponent<Props> = ({ item, maxAvatars = 3 }) => {
  const { peers } = usePresence(item.uuid)

  const uniquePeers = useMemo(() => dedupePeers(peers), [peers])

  if (uniquePeers.length === 0) {
    return null
  }

  const shown = uniquePeers.slice(0, maxAvatars)
  const overflow = uniquePeers.length - shown.length
  const names = uniquePeers.map((peer) => peer.name).join(', ')
  const label = `${uniquePeers.length} ${uniquePeers.length === 1 ? 'collaborator' : 'collaborators'} editing now: ${names}`

  return (
    <div
      className="ml-2 flex flex-shrink-0 items-center"
      title={label}
      aria-label={label}
      role="img"
    >
      <div className="flex -space-x-1.5">
        {shown.map((peer) => (
          <div
            key={peer.userUuid || peer.clientId}
            className="flex h-6 w-6 select-none items-center justify-center rounded-full border-2 border-default text-[0.6rem] font-bold text-white"
            style={{ backgroundColor: peer.color || collaboratorColor(peer.userUuid || String(peer.clientId)) }}
            aria-hidden
          >
            {collaboratorInitials(peer.name)}
          </div>
        ))}
        {overflow > 0 && (
          <div
            className="flex h-6 w-6 select-none items-center justify-center rounded-full border-2 border-default bg-passive-1 text-[0.6rem] font-bold text-default"
            aria-hidden
          >
            +{overflow}
          </div>
        )}
      </div>
    </div>
  )
}

export default PresenceBadge
