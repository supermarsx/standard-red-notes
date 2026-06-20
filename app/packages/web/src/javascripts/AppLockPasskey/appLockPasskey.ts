/**
 * Standard Red Notes: Passkey app-lock — pure, dependency-free core.
 *
 * This module adds a *local* WebAuthn/passkey gate on top of the existing local
 * application lock (passcode / biometrics). It holds ONLY the pure logic so it
 * can be unit-tested without a running application or a real authenticator:
 *
 *  - the stored-credential shape + the storage key,
 *  - normalization of any persisted value into a valid credential (or null),
 *  - `hasRegisteredAppLockPasskey`, the single predicate the lock screen and the
 *    Security pane ask, and
 *  - builders for the client-side WebAuthn `create`/`get` option JSON.
 *
 * IMPORTANT SECURITY SCOPE (read me):
 *  - This is a LOCAL ACCESS GATE for the UI on THIS device only. A successful
 *    passkey assertion grants local unlock the same way the passcode/biometric
 *    unlock does — it does NOT decrypt anything by itself.
 *  - It does NOT change or protect the end-to-end encryption keys. Those still
 *    derive solely from the account password (and the local passcode, if set).
 *    Removing this passkey, or clearing local data, never exposes note plaintext
 *    that wasn't already protected by the account/passcode key.
 *  - Unlike the *server* sign-in passkey (task #234) which authenticates a
 *    session against the server, this passkey is generated and verified entirely
 *    client-side: the WebAuthn ceremony's value here is that the platform
 *    authenticator (Touch ID / Windows Hello / etc.) gates user verification and
 *    that unlock is bound to the specific registered credential id.
 *
 * Where things live (web-only, no `@standardnotes/models` changes):
 *  - The registered credential (id + metadata) is persisted via the app storage
 *    K/V (`application.getValue`/`setValue`) under {@link AppLockPasskeyStorageKey}
 *    — the same local-store precedent used by the Diary / email-backup features,
 *    which deliberately avoided adding keys to the published `PrefKey` enum.
 *    The stored data is non-secret (a public credential id + label); the private
 *    key never leaves the platform authenticator.
 */

/** A registered app-lock passkey credential (non-secret, local only). */
export type AppLockPasskeyCredential = {
  /** The WebAuthn credential id (base64url), used to scope the unlock assertion. */
  credentialId: string
  /** Human-friendly label shown in preferences (e.g. "This device"). */
  label: string
  /** When the passkey was registered (epoch ms), for display only. */
  registeredAt: number
}

/** Storage K/V key for the registered app-lock passkey (web-only, not synced as a model). */
export const AppLockPasskeyStorageKey = 'AppLockPasskey'

/** A short, stable relying-party id/name for the local ceremony. */
export const APP_LOCK_PASSKEY_RP_NAME = 'Standard Red Notes (App Lock)'
/** Local user handle label; not an account identity, just a ceremony participant. */
export const APP_LOCK_PASSKEY_USER_NAME = 'app-lock'

/**
 * Coerce any stored/partial value into a valid credential, or null. Never throws:
 * missing/malformed data is treated as "no passkey registered".
 */
export function normalizeAppLockPasskeyCredential(
  value: Partial<AppLockPasskeyCredential> | undefined | null,
): AppLockPasskeyCredential | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const credentialId = typeof value.credentialId === 'string' ? value.credentialId.trim() : ''
  if (credentialId.length === 0) {
    return null
  }
  const label = typeof value.label === 'string' && value.label.trim().length > 0 ? value.label.trim() : 'This device'
  const registeredAt = Number.isFinite(value.registeredAt as number) ? (value.registeredAt as number) : Date.now()
  return { credentialId, label, registeredAt }
}

/** True iff a usable app-lock passkey credential is registered. */
export function hasRegisteredAppLockPasskey(
  value: Partial<AppLockPasskeyCredential> | undefined | null,
): boolean {
  return normalizeAppLockPasskeyCredential(value) !== null
}

/**
 * Generate a random challenge as a base64url string (no padding). For a local
 * gate the challenge is not server-verified; it exists to satisfy the WebAuthn
 * ceremony and to keep each assertion fresh. Uses Web Crypto when available and
 * falls back to Math.random only if it is not (still adequate for a local gate).
 */
export function generateLocalChallenge(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  const cryptoObj = typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes)
  } else {
    for (let i = 0; i < byteLength; i++) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  return bytesToBase64Url(bytes)
}

/** Encode bytes as base64url (RFC 4648 §5) without padding. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  const base64 = typeof btoa === 'function' ? btoa(binary) : bufferToBase64Fallback(binary)
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function bufferToBase64Fallback(binary: string): string {
  // Minimal base64 encoder for non-browser (test) environments lacking btoa.
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let output = ''
  let i = 0
  while (i < binary.length) {
    const a = binary.charCodeAt(i++)
    const b = i < binary.length ? binary.charCodeAt(i++) : NaN
    const c = i < binary.length ? binary.charCodeAt(i++) : NaN
    const enc1 = a >> 2
    const enc2 = ((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)
    const enc3 = Number.isNaN(b) ? 64 : ((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)
    const enc4 = Number.isNaN(c) ? 64 : c & 63
    output += chars.charAt(enc1) + chars.charAt(enc2) + (enc3 === 64 ? '=' : chars.charAt(enc3)) + (enc4 === 64 ? '=' : chars.charAt(enc4))
  }
  return output
}

/**
 * Build the `PublicKeyCredentialCreationOptionsJSON` for registering a platform
 * passkey used to unlock the app. Requires a platform authenticator with user
 * verification so the OS-level gate (Touch ID / Hello / PIN) is enforced.
 *
 * Returned as a plain JSON object compatible with @simplewebauthn/browser's
 * `startRegistration({ optionsJSON })`.
 */
export function buildAppLockRegistrationOptions(input: {
  rpId: string
  challenge?: string
  userId?: string
  userName?: string
}): Record<string, unknown> {
  return {
    challenge: input.challenge ?? generateLocalChallenge(),
    rp: { name: APP_LOCK_PASSKEY_RP_NAME, id: input.rpId },
    user: {
      id: input.userId ?? generateLocalChallenge(16),
      name: input.userName ?? APP_LOCK_PASSKEY_USER_NAME,
      displayName: input.userName ?? APP_LOCK_PASSKEY_USER_NAME,
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 }, // ES256
      { type: 'public-key', alg: -257 }, // RS256
    ],
    timeout: 60000,
    attestation: 'none',
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'preferred',
      requireResidentKey: false,
      userVerification: 'required',
    },
  }
}

/**
 * Build the `PublicKeyCredentialRequestOptionsJSON` for an unlock assertion,
 * scoped to the single registered credential id and requiring user verification.
 *
 * Returned as a plain JSON object compatible with @simplewebauthn/browser's
 * `startAuthentication({ optionsJSON })`.
 */
export function buildAppLockAuthenticationOptions(input: {
  rpId: string
  credentialId: string
  challenge?: string
}): Record<string, unknown> {
  return {
    challenge: input.challenge ?? generateLocalChallenge(),
    rpId: input.rpId,
    timeout: 60000,
    userVerification: 'required',
    allowCredentials: [
      {
        id: input.credentialId,
        type: 'public-key',
      },
    ],
  }
}

/**
 * The relying-party id for the local ceremony: the current page hostname. WebAuthn
 * requires an effective domain (not an origin/port); `localhost` and bare hostnames
 * are valid. Returns the hostname, or 'localhost' as a safe default.
 */
export function rpIdFromHostname(hostname: string | undefined | null): string {
  const h = (hostname ?? '').trim()
  return h.length > 0 ? h : 'localhost'
}
