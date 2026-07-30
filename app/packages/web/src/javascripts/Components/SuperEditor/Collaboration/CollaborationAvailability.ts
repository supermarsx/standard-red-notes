export const SUPER_COLLABORATION_UNAVAILABLE_REASON =
  'Live collaboration is unavailable while client-only end-to-end encryption is being hardened.'

export type SuperCollaborationAvailability =
  | {
      available: false
      reason: string
    }
  | {
      available: true
    }

const unavailable: SuperCollaborationAvailability = Object.freeze({
  available: false,
  reason: SUPER_COLLABORATION_UNAVAILABLE_REASON,
})

/**
 * Security release gate for live collaboration.
 *
 * This deliberately ignores all runtime/window flags. Collaboration may only
 * become available once the app can supply a non-extractable room key derived
 * from client-only vault key material that is never synced to the relay.
 */
export function getSuperCollaborationAvailability(): SuperCollaborationAvailability {
  return unavailable
}
