import {
  EmailDeliveryCipher,
  EncryptedEmailDeliveryEnvelope,
  isEncryptedEmailDeliveryEnvelope,
} from '../EmailDelivery/EmailDeliveryEncryption'
import { SecretString } from './SecretString'

/**
 * Purpose string for the HKDF derivation. It makes the key that protects DAV
 * account secrets different from every other key derived from the server's
 * encryption key (relay settings, queued mail), so a flaw or a leak in one use
 * says nothing about another.
 */
export const DAV_ACCOUNT_SECRET_ENCRYPTION_CONTEXT = 'standard-red-notes/dav-bridge/account-secret/v1'

export type DavSecretEnvelope = EncryptedEmailDeliveryEnvelope

export const isDavSecretEnvelope = isEncryptedEmailDeliveryEnvelope

/** The server has no usable encryption key: an administrator problem, not the user's. */
export class DavSecretStoreUnavailableError extends Error {
  constructor() {
    super('The server encryption key is missing or malformed.')
    this.name = 'DavSecretStoreUnavailableError'
  }
}

/**
 * The stored secret did not decrypt: the server key changed, or the envelope was
 * altered or moved. The message carries nothing from the failure, because the
 * failure's own text is not something to show or log.
 */
export class DavSecretUnreadableError extends Error {
  constructor() {
    super('The stored account secret could not be decrypted.')
    this.name = 'DavSecretUnreadableError'
  }
}

/**
 * Standard Red Notes: seals and opens the password of one external account.
 *
 * AES-256-GCM under a key derived (HKDF) from the server's existing encryption
 * key, the same primitive that protects SMTP relay credentials. Each envelope
 * is additionally bound to the user and the account it was sealed for: copied
 * into another user's file, or under another account id, it fails to open.
 *
 * What this protects, plainly: a copy of the store, or a backup of it, that
 * leaks without the server's environment. It does not protect against someone
 * who controls the host, because the key is on the host.
 */
export class DavSecretCipher {
  private readonly cipher: EmailDeliveryCipher
  private readonly ready: boolean

  constructor(stableSecret: string | undefined) {
    this.cipher = new EmailDeliveryCipher(stableSecret, DAV_ACCOUNT_SECRET_ENCRYPTION_CONTEXT)
    this.ready = /^[0-9a-fA-F]{64}$/.test((stableSecret ?? '').trim())
  }

  /** Whether a secret can be sealed at all. Reported to the administrator, never to a user. */
  isReady(): boolean {
    return this.ready
  }

  seal(secret: SecretString, userUuid: string, accountId: string): DavSecretEnvelope {
    if (!this.ready) {
      throw new DavSecretStoreUnavailableError()
    }
    return this.cipher.encrypt({ secret: secret.reveal() }, [userUuid, accountId])
  }

  open(envelope: DavSecretEnvelope, userUuid: string, accountId: string): SecretString {
    if (!this.ready) {
      throw new DavSecretStoreUnavailableError()
    }
    let opened: unknown
    try {
      opened = this.cipher.decrypt<unknown>(envelope, [userUuid, accountId])
    } catch {
      throw new DavSecretUnreadableError()
    }
    const value = (opened as { secret?: unknown } | null)?.secret
    if (typeof value !== 'string' || value.length === 0) {
      throw new DavSecretUnreadableError()
    }
    return new SecretString(value)
  }
}
