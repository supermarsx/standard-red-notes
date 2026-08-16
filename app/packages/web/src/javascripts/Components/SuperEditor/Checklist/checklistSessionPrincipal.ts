import type { SessionsClientInterface } from '@standardnotes/snjs'
import type { NoteEncryptionIdentity } from '../Collaboration/CollaborationKeyDerivation'

export type ChecklistSessionPrincipal = {
  valid: boolean
  signedIn: boolean
  userUuid?: string
}

/**
 * Capture account identity by its stable server UUID, not by the replaceable
 * User response object held by SessionManager. Missing or unreadable signed-in
 * identity is invalid and therefore never authorizes an editor owner.
 */
export function captureChecklistSessionPrincipal(
  sessions: Pick<SessionsClientInterface, 'isSignedIn' | 'getUser'>,
): ChecklistSessionPrincipal {
  try {
    const signedIn = sessions.isSignedIn()
    if (!signedIn) {
      return { valid: true, signedIn: false }
    }

    const userUuid = sessions.getUser()?.uuid
    return userUuid ? { valid: true, signedIn: true, userUuid } : { valid: false, signedIn: true }
  } catch {
    return { valid: false, signedIn: false }
  }
}

export function checklistSessionPrincipalMatches(
  expected: ChecklistSessionPrincipal,
  current: ChecklistSessionPrincipal,
): boolean {
  if (!expected.valid || !current.valid || expected.signedIn !== current.signedIn) {
    return false
  }

  return !expected.signedIn || expected.userUuid === current.userUuid
}

/**
 * The collaboration identity intentionally treats the User response object as
 * a sign-in epoch. Checklist ownership observes sign-in/sign-out/key events
 * separately, so retaining that object-identity check here would reject a
 * harmless same-account User projection refresh. Keep every durable account,
 * note, vault, and root-key identity field authoritative while allowing only
 * the response object itself to be replaced.
 */
export function checklistEncryptionIdentityMatches(
  expected: NoteEncryptionIdentity,
  current: NoteEncryptionIdentity | undefined,
): boolean {
  return Boolean(
    current &&
    current.noteUuid === expected.noteUuid &&
    current.userUuid === expected.userUuid &&
    current.sourceId === expected.sourceId &&
    current.keySystemIdentifier === expected.keySystemIdentifier &&
    current.sharedVaultUuid === expected.sharedVaultUuid,
  )
}
