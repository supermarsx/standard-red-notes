import { useEffect, useState } from 'react'
import { CollaborativeDocumentRegistry } from '../SuperEditor/Collaboration/CollaborativeDocumentRegistry'

export const COLLABORATION_ACTIVITY_PULSE_MS = 450

/** Visual activity follows document operations, never save acknowledgements or presence. */
export function useCollaborationActivity(room: string, active: boolean): boolean {
  const [pulsing, setPulsing] = useState(false)
  useEffect(() => {
    setPulsing(false)
    if (!active) {
      return
    }
    const document = CollaborativeDocumentRegistry.get(room)
    if (!document) {
      return
    }
    const signature = () => {
      const state = document.state()
      return state
        ? JSON.stringify([
            [...state.stateVector].sort(([a], [b]) => a - b),
            [...state.deleted].sort(([a], [b]) => a - b),
          ])
        : undefined
    }
    let previous = signature()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = document.subscribe(() => {
      const next = signature()
      if (next === undefined || next === previous) {
        return
      }
      const established = previous !== undefined
      previous = next
      if (!established) {
        return
      }
      setPulsing(true)
      clearTimeout(timeout)
      timeout = setTimeout(() => setPulsing(false), COLLABORATION_ACTIVITY_PULSE_MS)
    })
    return () => {
      unsubscribe()
      clearTimeout(timeout)
    }
  }, [room, active])
  return active && pulsing
}
