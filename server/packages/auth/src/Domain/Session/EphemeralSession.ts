import { Session } from './Session'

export class EphemeralSession extends Session {}

export function parseEphemeralCleanupSession(value: string): EphemeralSession | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const session = parsed as EphemeralSession
      if (
        typeof session.uuid === 'string' &&
        session.uuid &&
        typeof session.userUuid === 'string' &&
        session.userUuid
      ) {
        return session
      }
    }
  } catch {
    // A malformed cache entry must not block cleanup of other sessions.
  }
  return undefined
}
