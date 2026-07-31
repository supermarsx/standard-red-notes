import * as crypto from 'crypto'
import { injectable } from 'inversify'

import {
  hasOnlyKeys,
  isBoundedString,
  isEpochMilliseconds,
  isJsonObject,
  SecureJsonFileStore,
  SecureJsonFileTransaction,
} from '../../../Infra/SecureJsonFileStore'
import {
  isLegacyCompatibleSubscriptionId,
  isValidAdminUuid,
  isValidPairingState,
  isValidPkceVerifier,
  isValidSubscriptionId,
} from './pairingValidation'

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
  /** Stable, non-secret reason the operator must authorize again. */
  needsRepairReason?: 'refresh-token-missing' | 'refresh-token-rejected'
  /** Epoch ms before another transient refresh attempt should be made. */
  refreshRetryAt?: number
  /** Sanitized failure class; never an upstream response body or token. */
  refreshFailureCode?: 'network' | 'rate-limited' | 'provider-unavailable' | 'provider-error'
  /** Bounded counter used to calculate transient exponential backoff. */
  refreshFailureCount?: number
}

/** Non-secret status view — NEVER contains a token. Safe to return in responses. */
export interface SubscriptionStatus {
  paired: boolean
  /** Read-compatible historical id that is intentionally unusable until removed. */
  legacyInvalidId?: boolean
  /** The encrypted envelope exists but could not be authenticated/decoded. */
  storeUnreadable?: boolean
  accountId?: string
  accountLabel?: string
  expiresAt?: number
  needsRepair?: boolean
  needsRepairReason?: SubscriptionTokenRecord['needsRepairReason']
  refreshRetryAt?: number
  refreshFailureCode?: SubscriptionTokenRecord['refreshFailureCode']
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

/** Encrypted-at-rest pending OAuth state. Never returned through HTTP. */
export interface PendingPairingRecord {
  verifier: string
  adminUuid: string
  subscriptionId: string
  expiresAt: number
}

/** Encrypted lease held only while an authorization code is exchanged. */
interface PairingClaimRecord {
  adminUuid: string
  subscriptionId: string
  expiresAt: number
}

export interface ClaimedPairing extends PendingPairingRecord {
  claimId: string
}

interface DecryptedPayload {
  records: Record<string, SubscriptionTokenRecord>
  pendingPairings: Record<string, PendingPairingRecord>
  pairingClaims: Record<string, PairingClaimRecord>
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
const MAX_TOKEN_LENGTH = 256 * 1024
const MAX_ACCOUNT_ID_LENGTH = 1_024
const MAX_ACCOUNT_LABEL_LENGTH = 1_024
const MAX_ENCRYPTED_DATA_HEX_LENGTH = 1024 * 1024
export const MAX_PENDING_PAIRINGS = 256
export const MAX_PENDING_PAIRINGS_PER_ADMIN = 16
const MAX_PAIRING_CLAIMS = MAX_PENDING_PAIRINGS
const MAX_REFRESH_FAILURE_COUNT = 32

/** The reserved id of the first/legacy paired subscription credential. */
export const DEFAULT_SUBSCRIPTION_ID = 'default'

function isControlFreeBoundedString(value: unknown, minimumLength: number, maximumLength: number): value is string {
  return isBoundedString(value, minimumLength, maximumLength) && !/[\u0000-\u001f\u007f]/.test(value)
}

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
      'needsRepairReason',
      'refreshRetryAt',
      'refreshFailureCode',
      'refreshFailureCount',
    ]) &&
    isControlFreeBoundedString(value.accessToken, 1, MAX_TOKEN_LENGTH) &&
    isEpochMilliseconds(value.expiresAt) &&
    isEpochMilliseconds(value.pairedAt) &&
    (value.refreshToken === undefined || isControlFreeBoundedString(value.refreshToken, 1, MAX_TOKEN_LENGTH)) &&
    (value.idToken === undefined || isControlFreeBoundedString(value.idToken, 1, MAX_TOKEN_LENGTH)) &&
    (value.accountId === undefined || isControlFreeBoundedString(value.accountId, 1, MAX_ACCOUNT_ID_LENGTH)) &&
    (value.accountLabel === undefined || isControlFreeBoundedString(value.accountLabel, 1, MAX_ACCOUNT_LABEL_LENGTH)) &&
    (value.needsRepair === undefined || typeof value.needsRepair === 'boolean') &&
    (value.needsRepairReason === undefined ||
      value.needsRepairReason === 'refresh-token-missing' ||
      value.needsRepairReason === 'refresh-token-rejected') &&
    (value.refreshRetryAt === undefined || isEpochMilliseconds(value.refreshRetryAt)) &&
    (value.refreshFailureCode === undefined ||
      value.refreshFailureCode === 'network' ||
      value.refreshFailureCode === 'rate-limited' ||
      value.refreshFailureCode === 'provider-unavailable' ||
      value.refreshFailureCode === 'provider-error') &&
    (value.refreshFailureCount === undefined ||
      (typeof value.refreshFailureCount === 'number' &&
        Number.isSafeInteger(value.refreshFailureCount) &&
        value.refreshFailureCount >= 1 &&
        value.refreshFailureCount <= MAX_REFRESH_FAILURE_COUNT))
  )
}

function isSubscriptionRecordMap(value: unknown): value is Record<string, SubscriptionTokenRecord> {
  if (!isJsonObject(value)) {
    return false
  }
  const entries = Object.entries(value)
  return (
    entries.length <= MAX_SUBSCRIPTIONS &&
    entries.every(([id, record]) => isLegacyCompatibleSubscriptionId(id) && isSubscriptionTokenRecord(record))
  )
}

function copyRecordMap(records: Record<string, SubscriptionTokenRecord>): Record<string, SubscriptionTokenRecord> {
  const copy = Object.create(null) as Record<string, SubscriptionTokenRecord>
  for (const [id, record] of Object.entries(records)) {
    copy[id] = record
  }
  return copy
}

function isPendingPairingRecord(value: unknown): value is PendingPairingRecord {
  return (
    hasOnlyKeys(value, ['verifier', 'adminUuid', 'subscriptionId', 'expiresAt']) &&
    isValidPkceVerifier(value.verifier) &&
    isValidAdminUuid(value.adminUuid) &&
    isValidSubscriptionId(value.subscriptionId) &&
    isEpochMilliseconds(value.expiresAt)
  )
}

function isPairingClaimRecord(value: unknown): value is PairingClaimRecord {
  return (
    hasOnlyKeys(value, ['adminUuid', 'subscriptionId', 'expiresAt']) &&
    isValidAdminUuid(value.adminUuid) &&
    isValidSubscriptionId(value.subscriptionId) &&
    isEpochMilliseconds(value.expiresAt)
  )
}

function isPendingPairingMap(value: unknown): value is Record<string, PendingPairingRecord> {
  if (!isJsonObject(value)) {
    return false
  }
  const entries = Object.entries(value)
  return (
    entries.length <= MAX_PENDING_PAIRINGS &&
    entries.every(([state, pending]) => isValidPairingState(state) && isPendingPairingRecord(pending))
  )
}

function isPairingClaimMap(value: unknown): value is Record<string, PairingClaimRecord> {
  if (!isJsonObject(value)) {
    return false
  }
  const entries = Object.entries(value)
  return (
    entries.length <= MAX_PAIRING_CLAIMS &&
    entries.every(([claimId, claim]) => isValidPairingState(claimId) && isPairingClaimRecord(claim))
  )
}

function copyMap<T>(records: Record<string, T>): Record<string, T> {
  const copy = Object.create(null) as Record<string, T>
  for (const [id, record] of Object.entries(records)) {
    copy[id] = record
  }
  return copy
}

function emptyPayload(): DecryptedPayload {
  return {
    records: Object.create(null) as Record<string, SubscriptionTokenRecord>,
    pendingPairings: Object.create(null) as Record<string, PendingPairingRecord>,
    pairingClaims: Object.create(null) as Record<string, PairingClaimRecord>,
  }
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
    if (!isValidSubscriptionId(id)) {
      return { paired: false }
    }
    let records: Record<string, SubscriptionTokenRecord>
    try {
      records = await this.loadAll()
    } catch {
      return { paired: false, needsRepair: true, storeUnreadable: true }
    }
    return this.statusOf(records[id])
  }

  // -------------------------------------------------------------------------
  // Standard Red Notes: MULTIPLE subscription pairings (id-keyed).
  // -------------------------------------------------------------------------

  /** Encrypts and persists a record under an explicit subscription id. */
  async saveRecord(id: string, record: SubscriptionTokenRecord): Promise<void> {
    if (!isValidSubscriptionId(id)) {
      throw new Error('Refusing to store a subscription credential under an invalid id.')
    }
    if (!isSubscriptionTokenRecord(record)) {
      throw new Error('Refusing to store an invalid subscription credential record.')
    }
    const key = this.requireKey()
    await this.store.runExclusive(async (transaction) => {
      const payload = this.payloadFromEnvelope(await transaction.read())
      payload.records[id] = record
      await this.writePayload(transaction, payload, key)
    })
  }

  /**
   * Compare-and-swap a record under the secure-file lock. Refresh losers cannot
   * overwrite a token rotated (or re-paired) by another process.
   */
  async replaceRecordIfUnchanged(
    id: string,
    expected: SubscriptionTokenRecord,
    replacement: SubscriptionTokenRecord,
  ): Promise<boolean> {
    if (!isValidSubscriptionId(id) || !isSubscriptionTokenRecord(expected) || !isSubscriptionTokenRecord(replacement)) {
      throw new Error('Refusing an invalid subscription credential compare-and-swap.')
    }
    const key = this.requireKey()
    return this.store.runExclusive(async (transaction) => {
      const payload = this.payloadFromEnvelope(await transaction.read())
      const current = payload.records[id]
      if (!current || !this.sameRecordVersion(current, expected)) {
        return false
      }
      payload.records[id] = replacement
      await this.writePayload(transaction, payload, key)
      return true
    })
  }

  /**
   * Commit a successful token rotation when the credential generation is still
   * the one that was refreshed. A competing process may have recorded only
   * repair/backoff metadata for that same generation; successful rotation is
   * authoritative over those failure annotations. Re-pairing, unpairing, or a
   * different token/account generation still blocks the write.
   */
  async replaceRecordAfterSuccessfulRefresh(
    id: string,
    expectedGeneration: SubscriptionTokenRecord,
    replacement: SubscriptionTokenRecord,
  ): Promise<boolean> {
    if (
      !isValidSubscriptionId(id) ||
      !isSubscriptionTokenRecord(expectedGeneration) ||
      !isSubscriptionTokenRecord(replacement)
    ) {
      throw new Error('Refusing an invalid successful-refresh compare-and-swap.')
    }
    const key = this.requireKey()
    return this.store.runExclusive(async (transaction) => {
      const payload = this.payloadFromEnvelope(await transaction.read())
      const current = payload.records[id]
      if (!current || !this.sameCredentialGeneration(current, expectedGeneration)) {
        return false
      }
      payload.records[id] = replacement
      await this.writePayload(transaction, payload, key)
      return true
    })
  }

  /** Returns one record by id, or null. Throws (fail closed) on decrypt failure. */
  async loadRecord(id: string = DEFAULT_SUBSCRIPTION_ID): Promise<SubscriptionTokenRecord | null> {
    if (!isValidSubscriptionId(id)) {
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
   * Persist a pending PKCE state inside the encrypted credential envelope.
   * Starting a newer attempt for the same target invalidates pending and
   * in-flight older attempts, preventing a late code exchange from overwriting
   * the newer pairing.
   */
  async putPendingPairing(
    state: string,
    pending: PendingPairingRecord,
    now: number,
    maximumTotal: number = MAX_PENDING_PAIRINGS,
    maximumPerAdmin: number = MAX_PENDING_PAIRINGS_PER_ADMIN,
  ): Promise<void> {
    if (
      !isValidPairingState(state) ||
      !isPendingPairingRecord(pending) ||
      !isEpochMilliseconds(now) ||
      !Number.isSafeInteger(maximumTotal) ||
      maximumTotal < 1 ||
      maximumTotal > MAX_PENDING_PAIRINGS ||
      !Number.isSafeInteger(maximumPerAdmin) ||
      maximumPerAdmin < 1 ||
      maximumPerAdmin > MAX_PENDING_PAIRINGS_PER_ADMIN
    ) {
      throw new Error('Refusing to store invalid pending pairing state.')
    }
    const key = this.requireKey()
    await this.store.runExclusive(async (transaction) => {
      const payload = this.payloadFromEnvelope(await transaction.read())
      this.prunePairingLifecycle(payload, now)

      for (const [existingState, entry] of Object.entries(payload.pendingPairings)) {
        if (entry.subscriptionId === pending.subscriptionId) {
          delete payload.pendingPairings[existingState]
        }
      }
      for (const [claimId, claim] of Object.entries(payload.pairingClaims)) {
        if (claim.subscriptionId === pending.subscriptionId) {
          delete payload.pairingClaims[claimId]
        }
      }

      const adminCount =
        Object.values(payload.pendingPairings).filter((entry) => entry.adminUuid === pending.adminUuid).length +
        Object.values(payload.pairingClaims).filter((entry) => entry.adminUuid === pending.adminUuid).length
      if (adminCount >= maximumPerAdmin) {
        throw new Error('This administrator already has the maximum number of pending pairing attempts.')
      }
      if (Object.keys(payload.pendingPairings).length + Object.keys(payload.pairingClaims).length >= maximumTotal) {
        throw new Error('The server has reached the bounded pending-pairing limit. Retry after an attempt expires.')
      }

      payload.pendingPairings[state] = pending
      await this.writePayload(transaction, payload, key)
    })
  }

  /**
   * Atomically consume a state and replace it with a short encrypted claim
   * lease. The lease prevents a concurrent callback from exchanging the same
   * code and lets unpair/newer-pairing operations invalidate an exchange that is
   * still in flight.
   */
  async claimPendingPairing(
    state: string,
    expectedAdminUuid: string | undefined,
    now: number,
    claimTtlMs: number,
  ): Promise<ClaimedPairing | null> {
    if (
      !isValidPairingState(state) ||
      (expectedAdminUuid !== undefined && !isValidAdminUuid(expectedAdminUuid)) ||
      !isEpochMilliseconds(now) ||
      !Number.isSafeInteger(claimTtlMs) ||
      claimTtlMs <= 0
    ) {
      return null
    }
    const key = this.requireKey()
    return this.store.runExclusive(async (transaction) => {
      const payload = this.payloadFromEnvelope(await transaction.read())
      const pruned = this.prunePairingLifecycle(payload, now)
      const pending = payload.pendingPairings[state]
      if (!pending || (expectedAdminUuid !== undefined && pending.adminUuid !== expectedAdminUuid)) {
        if (pruned) {
          await this.writePayload(transaction, payload, key)
        }
        return null
      }

      delete payload.pendingPairings[state]
      const claimId = crypto.randomBytes(32).toString('base64url')
      payload.pairingClaims[claimId] = {
        adminUuid: pending.adminUuid,
        subscriptionId: pending.subscriptionId,
        expiresAt: now + claimTtlMs,
      }
      await this.writePayload(transaction, payload, key)
      return { ...pending, claimId }
    })
  }

  /**
   * Commit an exchanged credential only while its claim lease still exists.
   * A restart-safe unpair, a newer attempt for the target, or lease expiry makes
   * this return false rather than resurrecting/overwriting a pairing.
   */
  async commitPairingClaim(claimId: string, record: SubscriptionTokenRecord, now: number): Promise<boolean> {
    if (!isValidPairingState(claimId) || !isSubscriptionTokenRecord(record) || !isEpochMilliseconds(now)) {
      return false
    }
    const key = this.requireKey()
    return this.store.runExclusive(async (transaction) => {
      const payload = this.payloadFromEnvelope(await transaction.read())
      this.prunePairingLifecycle(payload, now)
      const claim = payload.pairingClaims[claimId]
      if (!claim) {
        await this.writePayload(transaction, payload, key)
        return false
      }
      payload.records[claim.subscriptionId] = record
      delete payload.pairingClaims[claimId]
      await this.writePayload(transaction, payload, key)
      return true
    })
  }

  /** Drop a failed exchange claim without exposing or restoring its OAuth state. */
  async abortPairingClaim(claimId: string): Promise<void> {
    if (!isValidPairingState(claimId)) {
      return
    }
    const key = this.requireKey()
    await this.store.runExclusive(async (transaction) => {
      const payload = this.payloadFromEnvelope(await transaction.read())
      if (!(claimId in payload.pairingClaims)) {
        return
      }
      delete payload.pairingClaims[claimId]
      await this.writePayload(transaction, payload, key)
    })
  }

  /**
   * Removes ONE record by id. When it was the last one the file is deleted.
   * Best-effort: a missing store is a no-op.
   */
  async removeRecord(id: string): Promise<void> {
    if (!isValidSubscriptionId(id)) {
      throw new Error('Refusing to remove a subscription credential with an invalid id.')
    }
    const key = this.requireKey()
    await this.store.runExclusive(async (transaction) => {
      // Deliberately no decrypt-error catch: targeted removal must fail closed.
      // It must never turn wrong-key/tamper damage into deletion of all pairings.
      const payload = this.payloadFromEnvelope(await transaction.read())
      delete payload.records[id]
      for (const [state, pending] of Object.entries(payload.pendingPairings)) {
        if (pending.subscriptionId === id) {
          delete payload.pendingPairings[state]
        }
      }
      for (const [claimId, claim] of Object.entries(payload.pairingClaims)) {
        if (claim.subscriptionId === id) {
          delete payload.pairingClaims[claimId]
        }
      }
      await this.writePayload(transaction, payload, key)
    })
  }

  /**
   * Explicit remediation path for a historical safe record key that no longer
   * meets the portable subscription-id grammar. It cannot remove a current
   * valid id; callers must use removeRecord for that path.
   */
  async removeLegacyRecord(id: string): Promise<void> {
    if (!isLegacyCompatibleSubscriptionId(id) || isValidSubscriptionId(id)) {
      throw new Error('A legacy-invalid subscription id is required for legacy removal.')
    }
    const key = this.requireKey()
    await this.store.runExclusive(async (transaction) => {
      const payload = this.payloadFromEnvelope(await transaction.read())
      if (!isLegacyCompatibleSubscriptionId(id) || isValidSubscriptionId(id) || !(id in payload.records)) {
        throw new Error('The legacy-invalid subscription pairing no longer exists.')
      }
      delete payload.records[id]
      await this.writePayload(transaction, payload, key)
    })
  }

  /**
   * Non-secret status for EVERY paired subscription. Never returns a token.
   * Throws (fail closed) when the store cannot be decrypted or authenticated;
   * callers must not fabricate a status entry for unreadable credentials.
   */
  async listStatuses(): Promise<SubscriptionStatusEntry[]> {
    const records = await this.loadAll()
    return Object.entries(records)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, record]) => ({
        id,
        ...this.statusOf(record),
        ...(!isValidSubscriptionId(id) ? { legacyInvalidId: true } : {}),
      }))
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
      needsRepairReason: record.needsRepairReason,
      refreshRetryAt: record.refreshRetryAt,
      refreshFailureCode: record.refreshFailureCode,
    }
  }

  /**
   * Reads + decrypts the store into an id -> record map. Missing file => empty
   * map. A LEGACY bare-record payload is migrated into the map under DEFAULT.
   * Throws (fail closed) when a stored payload cannot be authenticated.
   */
  private async readRecordsMap(): Promise<Record<string, SubscriptionTokenRecord>> {
    return this.payloadFromEnvelope(await this.store.read()).records
  }

  private payloadFromEnvelope(envelope: EncryptedEnvelope | null): DecryptedPayload {
    if (!envelope) {
      return emptyPayload()
    }
    const key = this.requireKey()
    const payload = this.decrypt(envelope, key)
    if (hasOnlyKeys(payload, ['records', 'pendingPairings', 'pairingClaims']) && 'records' in payload) {
      const records = payload.records
      const pendingPairings = payload.pendingPairings ?? Object.create(null)
      const pairingClaims = payload.pairingClaims ?? Object.create(null)
      if (
        !isSubscriptionRecordMap(records) ||
        !isPendingPairingMap(pendingPairings) ||
        !isPairingClaimMap(pairingClaims)
      ) {
        throw new Error('The stored subscription credential contains an invalid record map.')
      }
      return {
        records: copyRecordMap(records),
        pendingPairings: copyMap(pendingPairings),
        pairingClaims: copyMap(pairingClaims),
      }
    }
    if (!isSubscriptionTokenRecord(payload)) {
      throw new Error('The stored subscription credential contains an invalid legacy record.')
    }
    // Legacy bare record → migrate under the default id.
    const migrated = emptyPayload()
    migrated.records[DEFAULT_SUBSCRIPTION_ID] = payload
    return migrated
  }

  private prunePairingLifecycle(payload: DecryptedPayload, now: number): boolean {
    let changed = false
    for (const [state, pending] of Object.entries(payload.pendingPairings)) {
      if (pending.expiresAt <= now) {
        delete payload.pendingPairings[state]
        changed = true
      }
    }
    for (const [claimId, claim] of Object.entries(payload.pairingClaims)) {
      if (claim.expiresAt <= now) {
        delete payload.pairingClaims[claimId]
        changed = true
      }
    }
    return changed
  }

  private async writePayload(
    transaction: SecureJsonFileTransaction<EncryptedEnvelope>,
    payload: DecryptedPayload,
    key: Buffer,
  ): Promise<void> {
    if (
      Object.keys(payload.records).length === 0 &&
      Object.keys(payload.pendingPairings).length === 0 &&
      Object.keys(payload.pairingClaims).length === 0
    ) {
      await transaction.delete()
      return
    }
    await transaction.write(this.encrypt(payload, key))
  }

  private sameRecordVersion(left: SubscriptionTokenRecord, right: SubscriptionTokenRecord): boolean {
    return (
      this.sameCredentialGeneration(left, right) &&
      left.needsRepair === right.needsRepair &&
      left.needsRepairReason === right.needsRepairReason &&
      left.refreshRetryAt === right.refreshRetryAt &&
      left.refreshFailureCode === right.refreshFailureCode &&
      left.refreshFailureCount === right.refreshFailureCount
    )
  }

  /**
   * Fields that identify the credential generation independently of mutable
   * refresh-failure annotations.
   */
  private sameCredentialGeneration(left: SubscriptionTokenRecord, right: SubscriptionTokenRecord): boolean {
    return (
      left.accessToken === right.accessToken &&
      left.refreshToken === right.refreshToken &&
      left.idToken === right.idToken &&
      left.expiresAt === right.expiresAt &&
      left.accountId === right.accountId &&
      left.accountLabel === right.accountLabel &&
      left.pairedAt === right.pairedAt
    )
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
