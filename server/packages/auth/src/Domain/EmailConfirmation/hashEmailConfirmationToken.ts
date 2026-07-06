import * as crypto from 'crypto'

/**
 * Standard Red Notes: derive the at-rest lookup hash for an email-confirmation
 * token. The raw token is high-entropy (32 random bytes), so a fast SHA-256 is
 * sufficient (unlike a low-entropy password, no salt/KDF is needed): the raw
 * value is never stored, and lookup is an indexed equality on this digest rather
 * than a per-record JS comparison, so there is no timing oracle. The raw token
 * MUST NEVER be logged or persisted — only this digest is.
 */
export const hashEmailConfirmationToken = (rawToken: string): string =>
  crypto.createHash('sha256').update(rawToken).digest('hex')

/** Generates a new high-entropy raw confirmation token (URL-safe hex). */
export const generateRawEmailConfirmationToken = (): string => crypto.randomBytes(32).toString('hex')
