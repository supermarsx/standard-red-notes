import * as crypto from 'crypto'
import { injectable } from 'inversify'

import {
  hasOnlyKeys,
  isBoundedString,
  isEpochMilliseconds,
  isJsonObject,
  isSafeRecordKey,
  SecureJsonFileStore,
} from '../../../Infra/SecureJsonFileStore'

/**
 * Encrypted, server-held storage for the single ChatGPT / Codex subscription
 * credential the Assistant proxy replays upstream.
 *
 * Mirrors CaldavTokenStore's self-contained secure JSON-file pattern — the
 * api-gateway has no database — BUT the payload is AES-256-GCM encrypted at
 * rest. Unlike CalDAV tokens (one-way scrypt hashes), this credential must be
 * REVERSIBLE because it is replayed to the upstream provider, so we encrypt
 * with a symmetric operator key (ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY) instead
 * of hashing.
 *
 * FAIL-SAFE: if the encryption key is absent or malformed, `save` throws and
 * NOTHING is written — the credential is never persisted in plaintext. `load`
 * likewise throws if the on-disk envelope cannot be authenticated/decrypted
 * (wrong key or tampering), so a bad key fails closed rather than silently
 * returning stale or partial data.
 *
 * The shared secure JSON primitive serializes separate local store instances.
 * A horizontally-scaled gateway on different hosts would still need a shared
 * encrypted store.
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

/** A status entry tagged with the paired-subscription id it belongs to. */
export interface SubscriptionStatusEntry extends SubscriptionStatus {
  id: string
}

/** On-disk envelope: an authenticated AES-256-GCM ciphertext of the payload JSON. */
interface EncryptedEnvelope {
  v: 1
  iv: string
  tag: string
  data: string
}

/**
 * The decrypted payload. Standard Red Notes: to hold MULTIPLE paired
 * subscriptions the payload is a map of id -> record. LEGACY files hold a bare
 * record (a single subscription); those are migrated on read into the map under
 * the reserved DEFAULT id, so an existing single-pairing deployment keeps working.
 */
const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const MAX_SUBSCRIPTIONS = 1_000
const MAX_SUBSCRIPTION_ID_LENGTH = 128
const MAX_TOKEN_LENGTH = 256 * 1024
const MAX_ACCOUNT_ID_LENGTH = 1_024
const MAX_ACCOUNT_LABEL_LENGTH = 1_024
const MAX_ENCRYPTED_DATA_HEX_LENGTH = 1024 * 1024

/** The reserved id of the first/legacy paired subscription credential. */
export const DEFAULT_SUBSCRIPTION_ID = 'default'

function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  return (
    hasOnlyKeys(value, ['v', 'iv', 'tag', 'data']) &&
    value.v === 1 &&
    typeof value.iv === 'string' &&
    /^[0-9a-f]{24}$/i.test(value.iv) &&
    typeof value.tag === 'string' &&
    /^[0-9a-f]{32}$/i.test(value.tag) &&
    typeof value.data === 'string' &&
    value.data.length > 0 &&
    value.data.length <= MAX_ENCRYPTED_DATA_HEX_LENGTH &&
    value.data.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(value.data)
  )
}

function isSubscriptionTokenRecord(value: unknown): value is SubscriptionTokenRecord {
  return (
    hasOnlyKeys(value, [
      'accessToken',
      'refreshToken',
      'idToken',
      'expiresAt',
      'accountId',
      'accountLabel',
      'pairedAt',
      'needsRepair',
    ]) &&
    isBoundedString(value.accessToken, 1, MAX_TOKEN_LENGTH) &&
    isEpochMilliseconds(value.expiresAt) &&
    isEpochMilliseconds(value.pairedAt) &&
    (value.refreshToken === undefined || isBoundedString(value.refreshToken, 1, MAX_TOKEN_LENGTH)) &&
    (value.idToken === undefined || isBoundedString(value.idToken, 1, MAX_TOKEN_LENGTH)) &&
    (value.accountId === undefined || isBoundedString(value.accountId, 1, MAX_ACCOUNT_ID_LENGTH)) &&
    (value.accountLabel === undefined || isBoundedString(value.accountLabel, 1, MAX_ACCOUNT_LABEL_LENGTH)) &&
    (value.needsRepair === undefined || typeof value.needsRepair === 'boolean')
  )
}

function isSubscriptionRecordMap(value: unknown): value is Record<string, SubscriptionTokenRecord> {
  if (!isJsonObject(value)) {
    return false
  }
  const entries = Object.entries(value)
  return (
    entries.length <= MAX_SUBSCRIPTIONS &&
    entries.every(
      ([id, record]) => isSafeRecordKey(id, MAX_SUBSCRIPTION_ID_LENGTH) && isSubscriptionTokenRecord(record),
    )
  )
}

function copyRecordMap(records: Record<string, SubscriptionTokenRecord>): Record<string, SubscriptionTokenRecord> {
  const copy = Object.create(null) as Record<string, SubscriptionTokenRecord>
  for (const [id, record] of Object.entries(records)) {
    copy[id] = record
  }
  return copy
}

@injectable()
export class SubscriptionTokenStore {
  private readonly store: SecureJsonFileStore<EncryptedEnvelope>

  /**
   * @param filePath        where the encrypted envelope lives.
   * @param encryptionKeyHex 32-byte key as 64 hex chars. Absent/invalid keys
   *                         make save/load fail closed.
   */
  constructor(
    filePath: string,
    private readonly encryptionKeyHex: string | undefined,
  ) {
    this.store = new SecureJsonFileStore({
      filePath,
      validate: isEncryptedEnvelope,
    })
  }

  /**
   * Encrypts and atomically persists a record under the DEFAULT id. Throws if
   * the key is unusable. Back-compat single-record API (used by the legacy
   * single-pairing flow).
   */
  async save(record: SubscriptionTokenRecord): Promise<void> {
    await this.saveRecord(DEFAULT_SUBSCRIPTION_ID, record)
  }

  /**
   * Decrypts and returns the DEFAULT stored record, or null if nothing is
   * paired. Throws if the store cannot be authenticated/decrypted — fail closed.
   */
  async load(): Promise<SubscriptionTokenRecord | null> {
    return this.loadRecord(DEFAULT_SUBSCRIPTION_ID)
  }

  /** Removes ALL stored credentials. Best-effort; missing file is not an error. */
  async clear(): Promise<void> {
    await this.store.delete()
  }

  /** Non-secret status for the DEFAULT subscription. Never returns a token. */
  async getStatus(id: string = DEFAULT_SUBSCRIPTION_ID): Promise<SubscriptionStatus> {
    if (!isSafeRecordKey(id, MAX_SUBSCRIPTION_ID_LENGTH)) {
      return { paired: false }
    }
    let records: Record<string, SubscriptionTokenRecord>
    try {
      records = await this.loadAll()
    } catch {
      return { paired: true, needsRepair: true }
    }
    return this.statusOf(records[id])
  }

  // -------------------------------------------------------------------------
  // Standard Red Notes: MULTIPLE subscription pairings (id-keyed).
  // -------------------------------------------------------------------------

  /** Encrypts and persists a record under an explicit subscription id. */
  async saveRecord(id: string, record: SubscriptionTokenRecord): Promise<void> {
    if (!isSafeRecordKey(id, MAX_SUBSCRIPTION_ID_LENGTH)) {
      throw new Error('Refusing to store a subscription credential under an invalid id.')
    }
    if (!isSubscriptionTokenRecord(record)) {
      throw new Error('Refusing to store an invalid subscription credential record.')
    }
    const key = this.requireKey()
    await this.store.runExclusive(async (transaction) => {
      const records = this.recordsFromEnvelope(await transaction.read())
      records[id] = record
      const envelope = this.encrypt({ records }, key)
      await transaction.write(envelope)
    })
  }

  /** Returns one record by id, or null. Throws (fail closed) on decrypt failure. */
  async loadRecord(id: string = DEFAULT_SUBSCRIPTION_ID): Promise<SubscriptionTokenRecord | null> {
    if (!isSafeRecordKey(id, MAX_SUBSCRIPTION_ID_LENGTH)) {
      return null
    }
    const records = await this.loadAll()
    return records[id] ?? null
  }

  /** Returns the whole id -> record map. Throws (fail closed) on decrypt failure. */
  async loadAll(): Promise<Record<string, SubscriptionTokenRecord>> {
    return this.readRecordsMap()
  }

  /**
   * Removes ONE record by id. When it was the last one the file is deleted.
   * Best-effort: a missing store is a no-op.
   */
  async removeRecord(id: string): Promise<void> {
    if (!isSafeRecordKey(id, MAX_SUBSCRIPTION_ID_LENGTH)) {
      return
    }
    const key = this.requireKey()
    await this.store.runExclusive(async (transaction) => {
      let records: Record<string, SubscriptionTokenRecord>
      try {
        records = this.recordsFromEnvelope(await transaction.read())
      } catch {
        // Undecryptable store — clearing one id is meaningless; drop the file.
        await transaction.delete()
        return
      }
      if (!(id in records)) {
        return
      }
      delete records[id]
      if (Object.keys(records).length === 0) {
        await transaction.delete()
        return
      }
      const envelope = this.encrypt({ records }, key)
      await transaction.write(envelope)
    })
  }

  /**
   * Non-secret status for EVERY paired subscription. Never returns a token. On a
   * decrypt failure reports a single needs-repair entry so the UI can prompt.
   */
  async listStatuses(): Promise<SubscriptionStatusEntry[]> {
    let records: Record<string, SubscriptionTokenRecord>
    try {
      records = await this.loadAll()
    } catch {
      return [{ id: DEFAULT_SUBSCRIPTION_ID, paired: true, needsRepair: true }]
    }
    return Object.entries(records).map(([id, record]) => ({ id, ...this.statusOf(record) }))
  }

  private statusOf(record: SubscriptionTokenRecord | undefined): SubscriptionStatus {
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

  /**
   * Reads + decrypts the store into an id -> record map. Missing file => empty
   * map. A LEGACY bare-record payload is migrated into the map under DEFAULT.
   * Throws (fail closed) when a stored payload cannot be authenticated.
   */
  private async readRecordsMap(): Promise<Record<string, SubscriptionTokenRecord>> {
    return this.recordsFromEnvelope(await this.store.read())
  }

  private recordsFromEnvelope(envelope: EncryptedEnvelope | null): Record<string, SubscriptionTokenRecord> {
    if (!envelope) {
      return Object.create(null) as Record<string, SubscriptionTokenRecord>
    }
    const key = this.requireKey()
    const payload = this.decrypt(envelope, key)
    if (hasOnlyKeys(payload, ['records']) && 'records' in payload) {
      const records = payload.records
      if (!isSubscriptionRecordMap(records)) {
        throw new Error('The stored subscription credential contains an invalid record map.')
      }
      return copyRecordMap(records)
    }
    if (!isSubscriptionTokenRecord(payload)) {
      throw new Error('The stored subscription credential contains an invalid legacy record.')
    }
    // Legacy bare record → migrate under the default id.
    const records = Object.create(null) as Record<string, SubscriptionTokenRecord>
    records[DEFAULT_SUBSCRIPTION_ID] = payload
    return records
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

  private encrypt(payload: unknown, key: Buffer): EncryptedEnvelope {
    const iv = crypto.randomBytes(IV_BYTES)
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    return {
      v: 1,
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      data: ciphertext.toString('hex'),
    }
  }

  private decrypt(envelope: EncryptedEnvelope, key: Buffer): unknown {
    try {
      const iv = Buffer.from(envelope.iv, 'hex')
      const tag = Buffer.from(envelope.tag, 'hex')
      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'hex')), decipher.final()])
      return JSON.parse(plaintext.toString('utf8')) as unknown
    } catch {
      // Wrong key or tampering — GCM authentication failed. Fail closed.
      throw new Error('Could not decrypt the stored subscription credential (wrong encryption key or corrupted store).')
    }
  }
}
