export interface CreateTrustedDeviceResult {
  uuid: string
  label: string
  // Plaintext device token. Returned EXACTLY ONCE at creation time; only its
  // bcrypt hash is persisted. The client stores this and presents it during the
  // login-params (2FA-gate) request to bypass the interactive second factor.
  token: string
  createdAt: number
  expiresAt: number
}
