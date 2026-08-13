import * as crypto from 'crypto'

export interface EncryptedEmailDeliveryEnvelope {
  v: 1
  alg: 'A256GCM'
  iv: string
  tag: string
  ciphertext: string
}

export class EmailDeliveryEncryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmailDeliveryEncryptionError'
  }
}

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32
const HKDF_SALT = Buffer.from('standard-red-notes/server-runtime', 'utf8')
export const EMAIL_RELAY_SETTINGS_ENCRYPTION_CONTEXT = 'standard-red-notes/email-delivery/relay-settings/v1'

/**
 * Derives a purpose-specific key from the server's existing stable encryption
 * secret. The stable secret is never used directly as an AES key, and the
 * context keeps relay settings cryptographically separate from queued payloads.
 */
export class EmailDeliveryCipher {
  constructor(
    private readonly stableSecret: string | undefined,
    private readonly context = EMAIL_RELAY_SETTINGS_ENCRYPTION_CONTEXT,
  ) {}

  encrypt(value: unknown): EncryptedEmailDeliveryEnvelope {
    const key = this.deriveKey()
    const iv = crypto.randomBytes(IV_BYTES)
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
    cipher.setAAD(Buffer.from(this.context, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])

    return {
      v: 1,
      alg: 'A256GCM',
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    }
  }

  decrypt<T>(envelope: EncryptedEmailDeliveryEnvelope): T {
    if (!isEncryptedEmailDeliveryEnvelope(envelope)) {
      throw new EmailDeliveryEncryptionError('Stored email delivery ciphertext has an invalid envelope.')
    }
    const key = this.deriveKey()
    try {
      const iv = strictBase64Url(envelope.iv, IV_BYTES)
      const tag = strictBase64Url(envelope.tag, 16)
      const ciphertext = strictBase64Url(envelope.ciphertext)
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
      decipher.setAAD(Buffer.from(this.context, 'utf8'))
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
      return JSON.parse(plaintext) as T
    } catch (error) {
      if (error instanceof EmailDeliveryEncryptionError) {
        throw error
      }
      throw new EmailDeliveryEncryptionError(
        'Stored email delivery data could not be decrypted (wrong server key or tampered ciphertext).',
      )
    }
  }

  private deriveKey(): Buffer {
    const secret = this.stableSecret?.trim()
    if (!secret) {
      throw new EmailDeliveryEncryptionError(
        'The existing server encryption key is required to protect email delivery credentials.',
      )
    }
    if (!/^[0-9a-fA-F]{64}$/.test(secret)) {
      throw new EmailDeliveryEncryptionError('The existing server encryption key must be 32 bytes of hexadecimal.')
    }
    return Buffer.from(
      crypto.hkdfSync('sha256', Buffer.from(secret, 'hex'), HKDF_SALT, Buffer.from(this.context, 'utf8'), KEY_BYTES),
    )
  }
}

export function isEncryptedEmailDeliveryEnvelope(value: unknown): value is EncryptedEmailDeliveryEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    Object.keys(candidate).length === 5 &&
    candidate.v === 1 &&
    candidate.alg === 'A256GCM' &&
    isBase64Url(candidate.iv, 16, 16) &&
    isBase64Url(candidate.tag, 22, 22) &&
    isBase64Url(candidate.ciphertext, 0, 50_000_000)
  )
}

function strictBase64Url(value: string, expectedBytes?: number): Buffer {
  const decoded = Buffer.from(value, 'base64url')
  if (
    decoded.toString('base64url') !== value ||
    (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)
  ) {
    throw new EmailDeliveryEncryptionError('Stored email delivery ciphertext has invalid encoding.')
  }
  return decoded
}

function isBase64Url(value: unknown, minimumLength: number, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= minimumLength &&
    value.length <= maximumLength &&
    /^[A-Za-z0-9_-]*$/.test(value)
  )
}
