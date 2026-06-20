/**
 * Standard Red Notes: client-side storage for the trusted-device token.
 *
 * The plaintext device token is returned exactly once by the server when a
 * device is marked trusted. We persist it in localStorage so the sign-in flow
 * on this device can present it (as `trusted_device_token`) during the
 * login-params request to skip the interactive second factor.
 *
 * SECURITY: this token only bypasses the SECOND factor. The account password is
 * still required to sign in, and the token never unlocks encrypted data. Storing
 * it client-side is the same trust model as a "remember this device" checkbox.
 * Clearing browser storage, revoking the device, or letting it expire all
 * invalidate the bypass.
 */
const STORAGE_KEY = 'sn_trusted_device_token'

export const persistTrustedDeviceToken = (token: string): void => {
  try {
    localStorage.setItem(STORAGE_KEY, token)
  } catch {
    // localStorage may be unavailable (private mode); the device simply won't be
    // remembered, which fails safe (the user is prompted for 2FA next time).
  }
}

export const getTrustedDeviceToken = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export const clearTrustedDeviceToken = (): void => {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // No-op.
  }
}
