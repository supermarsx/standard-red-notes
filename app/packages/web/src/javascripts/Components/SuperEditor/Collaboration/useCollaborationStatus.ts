import { useEffect, useState } from 'react'
import { CollaborationRoomState, CollaborationStatusRegistry } from './CollaborationStatusRegistry'

/**
 * Subscribe to the encrypted-collaboration status of a single note "room".
 *
 * Thin read-only adapter over CollaborationStatusRegistry, mirroring usePresence.
 * It adds NO preparation, authorization or socket traffic of its own — it only
 * mirrors what the owning Super editor already computed. `undefined` means no
 * interactive Super editor owns this note, i.e. collaboration is not applicable.
 */
export function useCollaborationStatus(room: string): CollaborationRoomState | undefined {
  const [state, setState] = useState<CollaborationRoomState | undefined>(() =>
    CollaborationStatusRegistry.getState(room),
  )

  useEffect(() => {
    setState(CollaborationStatusRegistry.getState(room))
    return CollaborationStatusRegistry.subscribe(room, setState)
  }, [room])

  return state
}
