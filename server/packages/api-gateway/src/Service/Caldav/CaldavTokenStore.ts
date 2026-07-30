import * as crypto from 'crypto'
import { randomUUID } from 'crypto'

import {
  hasOnlyKeys,
  isBoundedString,
  isEpochMilliseconds,
  isJsonObject,
  isSafeRecordKey,
  SecureJsonFileStore,
} from '../../Infra/SecureJsonFileStore'
import { CaldavInputError } from './CaldavInputError'

/**
 * Standard Red Notes: scoped, revocable CalDAV access tokens.
 *
 * These authenticate CalDAV clients with VTODO support over HTTP Basic,
 * INSTEAD of the account password. They mirror the MCP token model: a
 * high-entropy server-generated secret stored only as a salted hash, with the
 * plaintext returned to the caller exactly once at creation.
 *
 * SCOPE: every token here is read-only calendar access for a single user. The
 * scope field is fixed to 'calendar-read' and is enforced by the DAV router.
 *
 * Plaintext form: `<tokenUuid>.<secret>`. The uuid prefix selects the row to
 * verify so we never scan the whole table. Matching secrets are compared in
 * constant time.
 *
 * STORAGE: a single JSON file, like the published-calendar store, keeping the
 * feature self-contained inside api-gateway (which has no database). The shared
 * secure-file primitive bounds and validates reads, rejects unsafe link/type
 * targets, and serializes durable atomic writes across local store instances.
 *
 * HASHING: Node scrypt (no extra dependency vs. bcrypt) with a per-token random
 * salt, compared with timingSafeEqual.
 */

export type CaldavTokenScope = 'calendar-read'

interface StoredToken {
  uuid: string
  userUuid: string
  label: string
  scope: CaldavTokenScope
  // scrypt hash + salt, both hex.
  salt: string
  hash: string
  createdAt: number
  lastUsedAt: number | null
}

export interface CaldavTokenMetadata {
  uuid: string
  userUuid: string
  label: string
  scope: CaldavTokenScope
  createdAt: number
  lastUsedAt: number | null
}

export interface CreatedCaldavToken extends CaldavTokenMetadata {
  /** Returned exactly once; never persisted in plaintext. */
  token: string
}

interface StoreShape {
  // tokenUuid -> StoredToken
  [tokenUuid: string]: StoredToken
}

const SECRET_BYTES = 32
const SALT_BYTES = 16
const SCRYPT_KEYLEN = 64
const MAX_TOKENS = 10_000
const DEFAULT_MAX_TOKENS_PER_USER = 100
const MAX_LABEL_LENGTH = 256
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface CaldavTokenStoreOptions {
  clock?: () => number
  deriveKey?: (secret: string, salt: string, keyLength: number) => Promise<Buffer>
  maxTokensPerUser?: number
}

function isStoredToken(value: unknown, uuid: string): value is StoredToken {
  return (
    hasOnlyKeys(value, ['uuid', 'userUuid', 'label', 'scope', 'salt', 'hash', 'createdAt', 'lastUsedAt']) &&
    UUID_PATTERN.test(uuid) &&
    value.uuid === uuid &&
    isSafeRecordKey(value.userUuid) &&
    isBoundedString(value.label, 1, MAX_LABEL_LENGTH) &&
    value.scope === 'calendar-read' &&
    typeof value.salt === 'string' &&
    /^[0-9a-f]{32}$/i.test(value.salt) &&
    typeof value.hash === 'string' &&
    /^[0-9a-f]{128}$/i.test(value.hash) &&
    isEpochMilliseconds(value.createdAt) &&
    (value.lastUsedAt === null || isEpochMilliseconds(value.lastUsedAt))
  )
}

function isStoreShape(value: unknown): value is StoreShape {
  if (!isJsonObject(value)) {
    return false
  }
  const entries = Object.entries(value)
  return entries.length <= MAX_TOKENS && entries.every(([uuid, token]) => isStoredToken(token, uuid))
}

export class CaldavTokenStore {
  private readonly store: SecureJsonFileStore<StoreShape>
  private readonly clock: () => number
  private readonly deriveKey: (secret: string, salt: string, keyLength: number) => Promise<Buffer>
  private readonly maxTokensPerUser: number

  constructor(filePath: string, options: CaldavTokenStoreOptions = {}) {
    this.store = new SecureJsonFileStore({
      filePath,
      validate: isStoreShape,
    })
    this.clock = options.clock ?? Date.now
    this.deriveKey = options.deriveKey ?? this.scrypt
    this.maxTokensPerUser = options.maxTokensPerUser ?? DEFAULT_MAX_TOKENS_PER_USER
    if (!Number.isSafeInteger(this.maxTokensPerUser) || this.maxTokensPerUser <= 0) {
      throw new Error('maxTokensPerUser must be a positive integer.')
    }
  }

  async create(userUuid: string, label: string): Promise<CreatedCaldavToken> {
    if (!isSafeRecordKey(userUuid)) {
      throw new CaldavInputError('A valid user identifier is required to create a CalDAV token.')
    }
    const trimmedLabel = (label ?? '').trim()
    if (trimmedLabel.length === 0) {
      throw new CaldavInputError('A label is required to create a CalDAV token.')
    }
    if (!isBoundedString(trimmedLabel, 1, MAX_LABEL_LENGTH)) {
      throw new CaldavInputError(`A CalDAV token label may not exceed ${MAX_LABEL_LENGTH} characters.`)
    }

    const uuid = randomUUID()
    const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url')
    const salt = crypto.randomBytes(SALT_BYTES).toString('hex')
    const hash = (await this.deriveKey(secret, salt, SCRYPT_KEYLEN)).toString('hex')
    const createdAt = this.clock()

    const stored: StoredToken = {
      uuid,
      userUuid,
      label: trimmedLabel,
      scope: 'calendar-read',
      salt,
      hash,
      createdAt,
      lastUsedAt: null,
    }

    await this.mutate((data) => {
      const tokensForUser = Object.values(data).filter((token) => token.userUuid === userUuid).length
      if (tokensForUser >= this.maxTokensPerUser) {
        throw new CaldavInputError(`A user may not have more than ${this.maxTokensPerUser} CalDAV tokens.`)
      }
      data[uuid] = stored
    })

    return {
      uuid,
      userUuid,
      label: trimmedLabel,
      scope: 'calendar-read',
      createdAt,
      lastUsedAt: null,
      token: `${uuid}.${secret}`,
    }
  }

  async listForUser(userUuid: string): Promise<CaldavTokenMetadata[]> {
    const data = await this.read()
    return Object.values(data)
      .filter((token) => token.userUuid === userUuid)
      .map(this.toMetadata)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Revoke a token. Only succeeds if it belongs to the given user. */
  async revoke(userUuid: string, tokenUuid: string): Promise<boolean> {
    let removed = false
    await this.mutate((data) => {
      const token = data[tokenUuid]
      if (token && token.userUuid === userUuid) {
        delete data[tokenUuid]
        removed = true
      }
    })
    return removed
  }

  /** Revoke every CalDAV token owned by a user in one durable transaction. */
  async revokeAllForUser(userUuid: string): Promise<number> {
    if (!isSafeRecordKey(userUuid)) {
      return 0
    }
    let removed = 0
    await this.mutate((data) => {
      for (const [uuid, token] of Object.entries(data)) {
        if (token.userUuid === userUuid) {
          delete data[uuid]
          removed += 1
        }
      }
    })
    return removed
  }

  /**
   * Verify a plaintext `<uuid>.<secret>` token. Returns the token metadata on a
   * match, or null otherwise. Fails closed for any malformed/missing/mismatched
   * input. Best-effort updates last-used time on success.
   */
  async verify(plaintext: string): Promise<CaldavTokenMetadata | null> {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      return null
    }
    const separatorIndex = plaintext.indexOf('.')
    if (separatorIndex <= 0 || separatorIndex >= plaintext.length - 1) {
      return null
    }
    const tokenUuid = plaintext.substring(0, separatorIndex)
    const secret = plaintext.substring(separatorIndex + 1)
    if (!UUID_PATTERN.test(tokenUuid) || !SECRET_PATTERN.test(secret)) {
      return null
    }

    const data = await this.read()
    const token = data[tokenUuid]
    if (!token) {
      return null
    }

    // scrypt is intentionally asynchronous. The synchronous variant blocks the
    // gateway event loop and turns a known token UUID into a CPU denial-of-service
    // primitive even when every supplied secret is wrong.
    const candidate = await this.deriveKey(secret, token.salt, SCRYPT_KEYLEN)
    const expected = Buffer.from(token.hash, 'hex')
    if (expected.length !== candidate.length || !crypto.timingSafeEqual(expected, candidate)) {
      return null
    }

    // Linearize successful verification with revocation. The expensive hash is
    // computed before taking the lock, then the exact row is rechecked inside the
    // transaction. If revocation won the race, authentication fails closed.
    return this.store.runExclusive(async (transaction) => {
      const current = (await transaction.read()) ?? {}
      const live = current[tokenUuid]
      if (
        !live ||
        live.userUuid !== token.userUuid ||
        live.salt !== token.salt ||
        live.hash !== token.hash ||
        live.scope !== 'calendar-read'
      ) {
        return null
      }
      live.lastUsedAt = this.clock()
      await transaction.write(current)
      return this.toMetadata(live)
    })
  }

  private scrypt(secret: string, salt: string, keyLength: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      crypto.scrypt(secret, salt, keyLength, (error, derivedKey) => {
        if (error) {
          reject(error)
          return
        }
        resolve(derivedKey)
      })
    })
  }

  private toMetadata(token: StoredToken): CaldavTokenMetadata {
    return {
      uuid: token.uuid,
      userUuid: token.userUuid,
      label: token.label,
      scope: token.scope,
      createdAt: token.createdAt,
      lastUsedAt: token.lastUsedAt,
    }
  }

  private async read(): Promise<StoreShape> {
    return (await this.store.read()) ?? {}
  }

  private async mutate(mutator: (data: StoreShape) => void): Promise<void> {
    await this.store.update((current) => {
      const data = current ?? {}
      mutator(data)
      return data
    })
  }
}
