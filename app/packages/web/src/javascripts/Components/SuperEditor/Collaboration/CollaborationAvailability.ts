export const SUPER_COLLABORATION_CONDITIONAL_REASON =
  'Live collaboration is available to signed-in note owners and write-authorized shared-vault editors.'
export const SUPER_COLLABORATION_CRYPTO_UNAVAILABLE_REASON =
  'Live collaboration is unavailable because this client does not support WebCrypto.'
export const SUPER_COLLABORATION_SIGN_IN_REASON = 'Sign in to use live collaboration.'
export const SUPER_COLLABORATION_VAULT_KEY_REASON = 'Unlock or sync the note encryption key to use live collaboration.'
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
  encryptionKeyAvailable: boolean
}

/**
 * Central fail-closed availability decision.
 *
 * With no context this reports whether the runtime can perform the required
 * client-only cryptography. Note-level callers pass the full context so
 * signed-out sessions and locked/missing keys stay on ordinary encrypted note
 * persistence. Transport liveness is deliberately handled by the provider: a
 * mounted Y.Doc must survive a transient disconnect so offline edits can merge
 * when the socket reconnects.
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
  if (!context.encryptionKeyAvailable) {
    return { available: false, reason: SUPER_COLLABORATION_VAULT_KEY_REASON }
  }

  return { available: true }
}
