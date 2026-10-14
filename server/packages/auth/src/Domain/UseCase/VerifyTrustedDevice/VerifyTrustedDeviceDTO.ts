export interface VerifyTrustedDeviceDTO {
  email: string
  resolvedUserUuid?: string | null
  // Plaintext device token presented by the client during the login-params
  // (2FA-gate) request. May be undefined/empty when no token is presented.
  deviceToken?: string
}
