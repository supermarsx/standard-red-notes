export const SUPER_COLLABORATION_CONDITIONAL_REASON =
  'Live collaboration is available to signed-in editors of notes in an unlocked shared vault.'
export const SUPER_COLLABORATION_CRYPTO_UNAVAILABLE_REASON =
  'Live collaboration is unavailable because this client does not support WebCrypto.'
export const SUPER_COLLABORATION_SIGN_IN_REASON = 'Sign in to use live collaboration.'
export const SUPER_COLLABORATION_SHARED_VAULT_REASON = 'Move this note to a shared vault to use live collaboration.'
export const SUPER_COLLABORATION_VAULT_KEY_REASON =
  'Unlock or sync a shared vault where you have edit permission to use live collaboration.'
export const SUPER_COLLABORATION_TRANSPORT_REASON =
  'Live collaboration is offline and will retry when the encrypted gateway reconnects.'

export type SuperCollaborationAvailability =
  | {
      available: false
      reason: string
    }
  | {
      available: true
    }

export type SuperCollaborationAvailabilityContext = {
  authenticated: boolean
  sharedVault: boolean
  vaultKeyAvailable: boolean
  transportConnected: boolean
}

/**
 * Central fail-closed availability decision.
 *
 * With no context this reports whether the runtime can perform the required
 * client-only cryptography. Note-level callers pass the full context so personal
 * notes, signed-out sessions, locked/missing vault keys, and disconnected
 * transports stay on ordinary encrypted note persistence.
 */
export function getSuperCollaborationAvailability(
  context?: SuperCollaborationAvailabilityContext,
): SuperCollaborationAvailability {
  if (!globalThis.crypto?.subtle) {
    return { available: false, reason: SUPER_COLLABORATION_CRYPTO_UNAVAILABLE_REASON }
  }

  if (!context) {
    return { available: true }
  }
  if (!context.authenticated) {
    return { available: false, reason: SUPER_COLLABORATION_SIGN_IN_REASON }
  }
  if (!context.sharedVault) {
    return { available: false, reason: SUPER_COLLABORATION_SHARED_VAULT_REASON }
  }
  if (!context.vaultKeyAvailable) {
    return { available: false, reason: SUPER_COLLABORATION_VAULT_KEY_REASON }
  }
  if (!context.transportConnected) {
    return { available: false, reason: SUPER_COLLABORATION_TRANSPORT_REASON }
  }

  return { available: true }
}
