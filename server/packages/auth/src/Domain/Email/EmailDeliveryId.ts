import { createHash } from 'crypto'

const MAX_SCOPE_LENGTH = 32

/**
 * Builds a non-secret, Redis-safe id from stable domain identifiers. Length
 * framing prevents ambiguous concatenation while the digest keeps user data
 * and one-time tokens out of queue keys and logs.
 */
export function createEmailDeliveryId(scope: string, ...stableParts: Array<string | number>): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(scope) || scope.length > MAX_SCOPE_LENGTH || stableParts.length === 0) {
    throw new Error('Email delivery id inputs are invalid.')
  }

  const digest = createHash('sha256')
  for (const part of stableParts) {
    if (
      (typeof part !== 'string' && typeof part !== 'number') ||
      (typeof part === 'number' && !Number.isSafeInteger(part)) ||
      String(part).length === 0
    ) {
      throw new Error('Email delivery id inputs are invalid.')
    }
    const value = String(part)
    digest.update(`${Buffer.byteLength(value, 'utf8')}:`, 'utf8')
    digest.update(value, 'utf8')
  }

  return `${scope}-${digest.digest('hex')}`
}

/** A check-in changes the deadline, creating a fresh durable occurrence. */
export function createDeadManSwitchEmailDeliveryId(switchId: string, deadline: number): string {
  return createEmailDeliveryId('dead-man-switch', switchId, deadline)
}

export function createEmailReminderDeliveryId(reminderId: string): string {
  return createEmailDeliveryId('reminder', reminderId)
}
