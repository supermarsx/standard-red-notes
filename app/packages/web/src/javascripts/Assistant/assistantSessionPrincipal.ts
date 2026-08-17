import type { SessionsClientInterface } from '@standardnotes/snjs'

export type AssistantSessionPrincipal = {
  valid: boolean
  signedIn: boolean
  userUuid?: string
}

/** Stable account identity for work that may outlive a React view transition. */
export function captureAssistantSessionPrincipal(
  sessions: Pick<SessionsClientInterface, 'isSignedIn' | 'getUser'>,
): AssistantSessionPrincipal {
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

export function assistantSessionPrincipalMatches(
  expected: AssistantSessionPrincipal,
  current: AssistantSessionPrincipal,
): boolean {
  if (!expected.valid || !current.valid || expected.signedIn !== current.signedIn) {
    return false
  }
  return !expected.signedIn || expected.userUuid === current.userUuid
}
