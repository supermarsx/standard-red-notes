/**
 * In-memory, app-wide registry of who is CURRENTLY present in each collaborative
 * note "room". This is the bridge between the live yjs awareness channel (owned
 * by the Super editor's collaboration plugin) and the presence sidebar (rendered
 * elsewhere in the NoteView tree). It carries only lightweight identity — the
 * actual cursor rendering stays inside @lexical/yjs.
 *
 * The signal here is GENUINE real-time presence: an entry exists for a peer only
 * while that peer has the same note open and their awareness state is live on
 * the relay. When the collaboration plugin is not mounted (solo notes, or the
 * collaboration flag is off) the registry is simply empty for that room, and the
 * sidebar reflects that honestly rather than inventing activity.
 */

export type PresentPeer = {
  /** Stable account id (from awarenessData), when the peer published one. */
  userUuid?: string
  /** Display name the peer broadcast (their email/contact name). */
  name: string
  /** Cursor/presence color the peer chose. */
  color: string
  /** yjs awareness clientID — unique per open editor instance. */
  clientId: number
}

type RoomListener = (peers: PresentPeer[]) => void

class PresenceRegistryImpl {
  /** room (note uuid) -> present peers, keyed by yjs clientID. */
  private readonly rooms = new Map<string, Map<number, PresentPeer>>()
  private readonly listeners = new Map<string, Set<RoomListener>>()

  /** Returns the peers currently present in a room (empty if none/unknown). */
  getPeers(room: string): PresentPeer[] {
    const peers = this.rooms.get(room)
    return peers ? [...peers.values()] : []
  }

  /**
   * Replace the full set of present peers for a room. The collaboration plugin
   * calls this whenever the yjs awareness states change, passing the complete
   * current snapshot (excluding the local user). Empty array clears the room.
   */
  setPeers(room: string, peers: PresentPeer[]): void {
    if (peers.length === 0) {
      this.rooms.delete(room)
    } else {
      const map = new Map<number, PresentPeer>()
      for (const peer of peers) {
        map.set(peer.clientId, peer)
      }
      this.rooms.set(room, map)
    }
    this.emit(room)
  }

  /** Drop all state for a room (called when the plugin unmounts/disconnects). */
  clearRoom(room: string): void {
    if (this.rooms.delete(room)) {
      this.emit(room)
    }
  }

  /** Subscribe to presence changes for a single room. Returns an unsubscribe. */
  subscribe(room: string, listener: RoomListener): () => void {
    let set = this.listeners.get(room)
    if (!set) {
      set = new Set<RoomListener>()
      this.listeners.set(room, set)
    }
    set.add(listener)
    return () => {
      const current = this.listeners.get(room)
      current?.delete(listener)
      if (current && current.size === 0) {
        this.listeners.delete(room)
      }
    }
  }

  private emit(room: string): void {
    const peers = this.getPeers(room)
    this.listeners.get(room)?.forEach((listener) => listener(peers))
  }
}

/** App-wide singleton. */
export const PresenceRegistry = new PresenceRegistryImpl()
