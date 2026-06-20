export interface TrustedDeviceProps {
  userUuid: string
  // bcrypt hash of the high-entropy device token. The plaintext token is held
  // only by the client (browser localStorage) and presented during the
  // login-params (2FA-gate) request. We never store the plaintext, exactly like
  // app passwords.
  hashedToken: string
  // Human-readable label so the user can recognise the device in the list
  // (derived from the user agent at trust time, e.g. "Chrome on macOS").
  label: string
  createdAt: Date
  lastUsedAt: Date | null
  // Hard expiry. After this instant the trust no longer bypasses the second
  // factor even if the row still exists. Enforced in the bypass use case AND
  // honoured at read time.
  expiresAt: Date
}
