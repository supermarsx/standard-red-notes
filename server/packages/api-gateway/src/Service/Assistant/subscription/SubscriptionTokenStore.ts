import * as crypto from 'crypto'
import { promises as fs } from 'fs'
import * as path from 'path'
import { injectable } from 'inversify'

/**
 * Encrypted, server-held storage for the single ChatGPT / Codex subscription
 * credential the Assistant proxy replays upstream.
 *
 * Mirrors CaldavTokenStore's self-contained JSON-file pattern (serialized
 * writeChain + atomic tmp+rename + ENOENT->empty) — the api-gateway has no
 * database — BUT the payload is AES-256-GCM encrypted at rest. Unlike CalDAV
 * tokens (one-way scrypt hashes), this credential must be REVERSIBLE because it
 * is replayed to the upstream provider, so we encrypt with a symmetric operator
 * key (ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY) instead of hashing.
 *
 * FAIL-SAFE: if the encryption key is absent or malformed, `save` throws and
 * NOTHING is written — the credential is never persisted in plaintext. `load`
 * likewise throws if the on-disk envelope cannot be authenticated/decrypted
 * (wrong key or tampering), so a bad key fails closed rather than silently
 * returning stale or partial data.
 *
 * SINGLE-INSTANCE: one JSON file suits the single-process home-server. A
 * horizontally-scaled gateway would need a shared encrypted store.
 */

/** The full record persisted on disk (encrypted). Contains secret material. */
export interface SubscriptionTokenRecord {
  accessToken: string
  refreshToken?: string
  idToken?: string
  /** Epoch ms at which the access token expires. */
  expiresAt: number
  accountId?: string
  /** Human-friendly label for the paired account (e.g. an email), if known. */
  accountLabel?: string
  /** Epoch ms the pairing was established. */
  pairedAt: number
  /**
   * Set when a refresh has failed and the operator must re-pair. The credential
   * is retained (not wiped) so the UI can explain the state, but it must not be
   * used upstream while this is true.
   */
  needsRepair?: boolean
}

/** Non-secret status view — NEVER contains a token. Safe to return in responses. */
export interface SubscriptionStatus {
  paired: boolean
  accountId?: string
  accountLabel?: string
  expiresAt?: number
  needsRepair?: boolean
}

/** On-disk envelope: an authenticated AES-256-GCM ciphertext of the record JSON. */
interface EncryptedEnvelope {
  v: 1
  iv: string
  tag: string
  data: string
}

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12

@injectable()
export class SubscriptionTokenStore {
  private writeChain: Promise<void> = Promise.resolve()

  /**
   * @param filePath        where the encrypted envelope lives.
   * @param encryptionKeyHex 32-byte key as 64 hex chars. Absent/invalid keys
   *                         make save/load fail closed.
   */
  constructor(
    private readonly filePath: string,
    private readonly encryptionKeyHex: string | undefined,
  ) {}

  /** Encrypts and atomically persists the record. Throws if the key is unusable. */
  async save(record: SubscriptionTokenRecord): Promise<void> {
    const key = this.requireKey()
    const envelope = this.encrypt(record, key)
    await this.atomicWrite(envelope)
  }

  /**
   * Decrypts and returns the stored record, or null if nothing is paired.
   * Throws if a record exists but cannot be authenticated/decrypted (wrong key
   * or tampering) — fail closed.
   */
  async load(): Promise<SubscriptionTokenRecord | null> {
    const envelope = await this.readEnvelope()
    if (!envelope) {
      return null
    }
    const key = this.requireKey()
    return this.decrypt(envelope, key)
  }

  /** Removes the stored credential. Best-effort; missing file is not an error. */
  async clear(): Promise<void> {
    await this.runExclusive(async () => {
      try {
        await fs.unlink(this.filePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    })
  }

  /**
   * Non-secret status derived from the stored record. Never returns a token.
   * If the record cannot be decrypted, reports paired+needsRepair so the UI can
   * prompt a re-pair rather than crashing.
   */
  async getStatus(): Promise<SubscriptionStatus> {
    let record: SubscriptionTokenRecord | null
    try {
      record = await this.load()
    } catch {
      return { paired: true, needsRepair: true }
    }
    if (!record) {
      return { paired: false }
    }
    return {
      paired: true,
      accountId: record.accountId,
      accountLabel: record.accountLabel,
      expiresAt: record.expiresAt,
      needsRepair: record.needsRepair,
    }
  }

  private requireKey(): Buffer {
    const hex = (this.encryptionKeyHex ?? '').trim()
    if (!hex) {
      throw new Error(
        'ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY is not set. A 32-byte hex key is required to store the ' +
          'subscription credential; pairing fails closed so nothing is ever written in plaintext.',
      )
    }
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY must be exactly 32 bytes encoded as 64 hex characters.')
    }
    return Buffer.from(hex, 'hex')
  }

  private encrypt(record: SubscriptionTokenRecord, key: Buffer): EncryptedEnvelope {
    const iv = crypto.randomBytes(IV_BYTES)
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
    const plaintext = Buffer.from(JSON.stringify(record), 'utf8')
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    return {
      v: 1,
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      data: ciphertext.toString('hex'),
    }
  }

  private decrypt(envelope: EncryptedEnvelope, key: Buffer): SubscriptionTokenRecord {
    try {
      const iv = Buffer.from(envelope.iv, 'hex')
      const tag = Buffer.from(envelope.tag, 'hex')
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'hex')), decipher.final()])
      return JSON.parse(plaintext.toString('utf8')) as SubscriptionTokenRecord
    } catch {
      // Wrong key or tampering — GCM authentication failed. Fail closed.
      throw new Error('Could not decrypt the stored subscription credential (wrong encryption key or corrupted store).')
    }
  }

  private async readEnvelope(): Promise<EncryptedEnvelope | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as EncryptedEnvelope
      if (parsed && typeof parsed === 'object' && parsed.iv && parsed.tag && parsed.data) {
        return parsed
      }
      return null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  private async atomicWrite(envelope: EncryptedEnvelope): Promise<void> {
    await this.runExclusive(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      await fs.writeFile(tmp, JSON.stringify(envelope, null, 2), 'utf8')
      await fs.rename(tmp, this.filePath)
    })
  }

  /** Serializes writes so concurrent save/clear never interleave a tmp+rename. */
  private runExclusive(fn: () => Promise<void>): Promise<void> {
    const run = this.writeChain.then(fn)
    this.writeChain = run.catch(() => undefined)
    return run
  }
}
