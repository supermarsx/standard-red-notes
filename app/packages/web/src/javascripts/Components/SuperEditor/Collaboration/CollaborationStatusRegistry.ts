/**
 * In-memory, app-wide registry of the CURRENT encrypted-collaboration status of
 * each note "room", mirroring the shape and contract of PresenceRegistry.
 *
 * This exists so collaboration status can be shown in the note title bar without
 * mounting `useCollaborationRoomAccess` a second (third) time. That hook is not a
 * cheap read: it derives room keys, reserves editor leases and drives awaited
 * syncs. Mounting it again purely to colour an icon would double the very
 * authorize/sync traffic the editor is waiting on. Instead the ONE authoritative
 * consumer — the interactive SuperEditor mount that actually owns the room —
 * publishes what it already computed, and the indicator reads it.
 *
 * Consequently the registry is empty for notes that have no interactive Super
 * editor mounted (plain/component editors, background persistence-only mounts).
 * That is correct: collaboration is a Super-editor capability, so "no entry"
 * honestly means "not applicable here" rather than "unknown".
 */

export type CollaborationRoomStatus =
  /** The room is being derived/authorized; the editor is usable meanwhile. */
  | { kind: 'preparing' }
  /** A live encrypted room owns the editor right now. */
  | { kind: 'active' }
  /** Collaboration is not running. `reason` is the human-readable explanation. */
  | { kind: 'unavailable'; reason: string }

export type CollaborationRoomState = {
  status: CollaborationRoomStatus
  /**
   * True once this room has genuinely been live. It is what separates "this
   * deployment simply does not offer live collaboration" (never active, stay
   * quiet) from "you were collaborating and it dropped" (worth surfacing).
   */
  hasBeenActive: boolean
}

const MAX_REASON_LENGTH = 512

type RoomListener = (state: CollaborationRoomState | undefined) => void

class CollaborationStatusRegistryImpl {
  private readonly rooms = new Map<string, CollaborationRoomState>()
  private readonly listeners = new Map<string, Set<RoomListener>>()

  /** Current status for a room, or undefined when collaboration does not apply. */
  getState(room: string): CollaborationRoomState | undefined {
    return this.rooms.get(room)
  }

  /**
   * Publish the room's status. Called by the interactive SuperEditor mount on
   * every change of its own collaboration access. `hasBeenActive` is sticky for
   * as long as the room stays registered.
   */
  setStatus(room: string, status: CollaborationRoomStatus): void {
    const normalized: CollaborationRoomStatus =
      status.kind === 'unavailable'
        ? { kind: 'unavailable', reason: String(status.reason ?? '').slice(0, MAX_REASON_LENGTH) }
        : status
    const previous = this.rooms.get(room)
    const next: CollaborationRoomState = {
      status: normalized,
      hasBeenActive: (previous?.hasBeenActive ?? false) || normalized.kind === 'active',
    }
    if (
      previous &&
      previous.hasBeenActive === next.hasBeenActive &&
      previous.status.kind === next.status.kind &&
      (previous.status.kind !== 'unavailable' || previous.status.reason === (next.status as { reason: string }).reason)
    ) {
      return
    }
    this.rooms.set(room, next)
    this.emit(room)
  }

  /** Drop all state for a room (the owning editor unmounted or switched note). */
  clearRoom(room: string): void {
    if (this.rooms.delete(room)) {
      this.emit(room)
    }
  }

  /** Subscribe to status changes for a single room. Returns an unsubscribe. */
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
    const state = this.rooms.get(room)
    this.listeners.get(room)?.forEach((listener) => listener(state))
  }
}

/** App-wide singleton. */
export const CollaborationStatusRegistry = new CollaborationStatusRegistryImpl()
