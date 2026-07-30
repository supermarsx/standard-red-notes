import { useEffect, useState } from 'react'
import { PresenceRegistry, PresentPeer } from './PresenceRegistry'
import { getSuperCollaborationAvailability } from './CollaborationAvailability'

export type PresenceState = {
  /**
   * The peers GENUINELY present in this room right now (excludes the local
   * user). An entry exists only while that peer has the same note open and
   * their awareness state is live on the relay — it is never derived from
   * stale timestamps.
   */
  peers: PresentPeer[]
  /** Whether live presence is available through the security-gated collaboration channel. */
  liveEnabled: boolean
}

/**
 * Runtime flags cannot enable presence. It is available only when the same
 * client-only-key security gate as the collaboration provider is open.
 */
export function isLivePresenceEnabled(): boolean {
  return getSuperCollaborationAvailability().available
}

/**
 * Subscribe to live collaborator presence for a single note "room" (keyed by
 * the note uuid). This is a thin read-only adapter over the app-wide
 * PresenceRegistry, which is fed by the existing yjs awareness channel — it adds
 * NO new socket traffic, it only mirrors data already on the wire.
 *
 * Returns the current present peers plus whether live presence is even enabled,
 * so consumers can honestly distinguish "nobody is here" from "we can't know".
 */
export function usePresence(room: string): PresenceState {
  const [peers, setPeers] = useState<PresentPeer[]>(() => PresenceRegistry.getPeers(room))

  useEffect(() => {
    setPeers(PresenceRegistry.getPeers(room))
    return PresenceRegistry.subscribe(room, setPeers)
  }, [room])

  return { peers, liveEnabled: isLivePresenceEnabled() }
}
