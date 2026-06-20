import { WebApplication } from '@/Application/WebApplication'
import { startRegistration, startAuthentication } from '@simplewebauthn/browser'
import {
  AppLockPasskeyCredential,
  AppLockPasskeyStorageKey,
  buildAppLockAuthenticationOptions,
  buildAppLockRegistrationOptions,
  hasRegisteredAppLockPasskey,
  normalizeAppLockPasskeyCredential,
  rpIdFromHostname,
} from './appLockPasskey'

/**
 * Standard Red Notes: Passkey app-lock — application-bound side effects.
 *
 * Impure counterpart to `appLockPasskey.ts`. Runs the browser WebAuthn ceremonies
 * (reusing the same `@simplewebauthn/browser` helpers the sign-in passkey uses)
 * and reads/writes the registered credential via the app storage K/V.
 *
 * SECURITY SCOPE: this is a LOCAL UI ACCESS GATE only (see appLockPasskey.ts). A
 * successful assertion grants local unlock; it does NOT decrypt data and does NOT
 * touch the E2E encryption keys (which derive from the account password / local
 * passcode).
 */

/** Read the registered app-lock passkey credential (normalized), or null. */
export function getAppLockPasskeyCredential(application: WebApplication): AppLockPasskeyCredential | null {
  const raw = application.getValue<Partial<AppLockPasskeyCredential> | undefined>(AppLockPasskeyStorageKey)
  return normalizeAppLockPasskeyCredential(raw)
}

/** True iff an app-lock passkey is registered on this device. */
export function isAppLockPasskeyRegistered(application: WebApplication): boolean {
  const raw = application.getValue<Partial<AppLockPasskeyCredential> | undefined>(AppLockPasskeyStorageKey)
  return hasRegisteredAppLockPasskey(raw)
}

/**
 * Whether this device/browser can support a passkey app-lock. Requires the
 * WebAuthn API and excludes native mobile web (which uses biometrics instead).
 */
export function isAppLockPasskeySupported(application: WebApplication): boolean {
  if (application.isNativeMobileWeb()) {
    return false
  }
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined'
}

function currentRpId(): string {
  return rpIdFromHostname(typeof window !== 'undefined' ? window.location.hostname : undefined)
}

/**
 * Register a platform passkey to unlock the app. Runs the WebAuthn `create`
 * ceremony and, on success, persists the credential locally. Returns the stored
 * credential, or null if the user cancelled / the ceremony failed.
 */
export async function registerAppLockPasskey(
  application: WebApplication,
  label = 'This device',
): Promise<AppLockPasskeyCredential | null> {
  const optionsJSON = buildAppLockRegistrationOptions({ rpId: currentRpId() })

  let registration
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registration = await startRegistration({ optionsJSON: optionsJSON as any })
  } catch (error) {
    // User cancelled, no platform authenticator, or ceremony error: do not register.
    console.error('App-lock passkey registration failed or was cancelled', error)
    return null
  }

  if (!registration || !registration.id) {
    return null
  }

  const credential: AppLockPasskeyCredential = {
    credentialId: registration.id,
    label,
    registeredAt: Date.now(),
  }

  application.setValue(AppLockPasskeyStorageKey, credential)
  return credential
}

/** Remove the registered app-lock passkey (disables passkey unlock on this device). */
export async function removeAppLockPasskey(application: WebApplication): Promise<void> {
  await application.removeValue(AppLockPasskeyStorageKey)
}

/**
 * Run an unlock assertion against the registered app-lock passkey. Returns true
 * only if the WebAuthn `get` ceremony succeeds and returns the registered
 * credential id. Cancellation/failure returns false (caller stays locked).
 */
export async function authenticateAppLockPasskey(application: WebApplication): Promise<boolean> {
  const credential = getAppLockPasskeyCredential(application)
  if (!credential) {
    return false
  }

  const optionsJSON = buildAppLockAuthenticationOptions({
    rpId: currentRpId(),
    credentialId: credential.credentialId,
  })

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const assertion = await startAuthentication({ optionsJSON: optionsJSON as any })
    // The browser only returns an assertion for a credential the platform
    // authenticator holds; confirm it matches the registered credential id.
    return !!assertion && assertion.id === credential.credentialId
  } catch (error) {
    console.error('App-lock passkey unlock failed or was cancelled', error)
    return false
  }
}
