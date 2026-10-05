export interface MagicLinkTokenProps {
  userIdentifier: string
  code: string
  expiresAt: Date
  consumed: boolean
  /**
   * Standard Red Notes: wrong guesses charged to THIS code (see MagicLinkToken).
   * Persisted on the token row, not in a second store, so the cap survives a
   * restart and cannot be reset by anything short of issuing a new code.
   */
  failedAttempts: number
  createdAt: Date
}
