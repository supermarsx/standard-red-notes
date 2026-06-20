/**
 * Standard Red Notes: OPTIONAL, OFF-BY-DEFAULT account/password recovery escrow.
 *
 * SECURITY MODEL (Option B — ciphertext-only escrow):
 * When (and only when) a user explicitly opts in, the client generates a
 * high-entropy recovery code, shows it to the user ONCE, and never sends it to
 * the server. The client derives a wrapping key from that code via argon2 and
 * encrypts the account master key (plus the key params needed to re-derive the
 * server password during recovery) under it with XChaCha20-Poly1305. Only the
 * resulting ciphertext blob is escrowed on the server.
 *
 * What the server can see: the opaque ciphertext blob ONLY. The server never
 * receives the recovery code or the wrapping key, so it CANNOT decrypt the
 * escrow and CANNOT read the user's data from the escrow alone. Recovery
 * requires the user-held recovery code.
 *
 * Residual risk (must be disclosed to the user): the escrow's security reduces
 * to the entropy of the recovery code plus the argon2 work factor. An attacker
 * who exfiltrates the escrow blob AND obtains/brute-forces the recovery code can
 * recover the master key. This is strictly weaker than pure end-to-end
 * encryption, where no escrow exists. Hence: off by default, explicit opt-in,
 * explicit warning, deletable on opt-out.
 */

/**
 * The server-side setting name under which the escrow ciphertext is stored.
 * Addressed as a raw string (rather than via the published client-side
 * SettingName value object) because the client's bundled
 * `@standardnotes/domain-core` enum may not include it; the server validates it.
 */
export const ACCOUNT_RECOVERY_ESCROW_SETTING_NAME = 'ACCOUNT_RECOVERY_ESCROW'

/** Bit length of the raw recovery code entropy. 256 bits = ample. */
export const RECOVERY_CODE_ENTROPY_BITS = 256

/**
 * The escrow blob format persisted as the setting value (JSON-serialized).
 * `version` allows future format evolution. All binary fields are hex/base64.
 */
export interface AccountRecoveryEscrowPayload {
  /** Format version of this escrow blob. */
  version: 1
  /** Account identifier (email/username) this escrow belongs to. */
  identifier: string
  /** Hex salt fed to argon2 alongside the recovery code. */
  salt: string
  /** Hex nonce used for the XChaCha20-Poly1305 encryption. */
  nonce: string
  /** Base64 XChaCha20-Poly1305 ciphertext of the secret payload (see below). */
  ciphertext: string
}

/**
 * The plaintext that gets encrypted into `AccountRecoveryEscrowPayload.ciphertext`.
 * It carries exactly what a recovery flow needs to restore access, and nothing
 * more. Serialized to JSON before encryption.
 */
export interface AccountRecoveryEscrowSecret {
  /** The account master key (encrypts the user's items keys). */
  masterKey: string
  /** The key params at escrow time, so recovery can recompute the server password. */
  keyParams: Record<string, unknown>
}
