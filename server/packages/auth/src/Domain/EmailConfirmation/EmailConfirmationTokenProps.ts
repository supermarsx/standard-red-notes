export interface EmailConfirmationTokenProps {
  /** The uuid of the user this confirmation token belongs to. */
  userUuid: string
  /** The user's email at the time the token was issued (for the resend/audit path). */
  email: string
  /**
   * The SHA-256 hex digest of the raw token. The raw token is only ever present
   * in the verification link emailed to the user; it is NEVER persisted or
   * logged. Lookup is by this hash.
   */
  hashedToken: string
  expiresAt: Date
  consumed: boolean
  createdAt: Date
}
