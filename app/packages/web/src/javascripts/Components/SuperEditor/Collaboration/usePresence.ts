import { useEffect, useState } from 'react'
import { PresenceRegistry, PresentPeer } from './PresenceRegistry'

export type PresenceState = {
  /**
   * The peers GENUINELY present in this room right now (excludes the local
   * user). An entry exists only while that peer has the same note open and
   * their awareness state is live on the relay — it is never derived from
   * stale timestamps.
   */
  peers: PresentPeer[]
  /** Whether live presence is even possible on this client (collab flag on). */
  liveEnabled: boolean
}

/**
 * Whether the live-presence signal is possible at all. Remote presence rides
 * the Super editor's yjs awareness channel, which is opt-in behind
 * window.enableSuperCollaboration (see SuperEditor.tsx / CollaboratorsPresencePanel).
 * When the flag is off there is NO real online signal.
 */
export function isLivePresenceEnabled(): boolean {
  return Boolean((window as { enableSuperCollaboration?: boolean }).enableSuperCollaboration)
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
