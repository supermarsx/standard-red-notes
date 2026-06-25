import * as crypto from 'crypto'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import * as path from 'path'

/**
 * Standard Red Notes: scoped, revocable CalDAV access tokens.
 *
 * These authenticate stock CalDAV clients (Apple Calendar, Thunderbird, DAVx5)
 * over HTTP Basic, INSTEAD of the account password. They mirror the MCP token
 * model: a high-entropy server-generated secret stored only as a salted hash,
 * with the plaintext returned to the caller exactly once at creation.
 *
 * SCOPE: every token here is read-only calendar access for a single user. The
 * scope field is fixed to 'calendar-read' in this first slice; it exists so a
 * future write scope can be added without changing the token shape.
 *
 * Plaintext form: `<tokenUuid>.<secret>`. The uuid prefix selects the row to
 * verify so we never scan the whole table. Verification is constant-time.
 *
 * STORAGE: a single JSON file, like the published-calendar store, keeping the
 * feature self-contained inside api-gateway (which has no database).
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

export class CaldavTokenStore {
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async create(userUuid: string, label: string): Promise<CreatedCaldavToken> {
    const trimmedLabel = (label ?? '').trim()
    if (trimmedLabel.length === 0) {
      throw new Error('A label is required to create a CalDAV token.')
    }

    const uuid = randomUUID()
    const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url')
    const salt = crypto.randomBytes(SALT_BYTES).toString('hex')
    const hash = this.deriveHash(secret, salt)
    const createdAt = Date.now()

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

    const data = await this.read()
    const token = data[tokenUuid]
    if (!token) {
      return null
    }

    const candidate = this.deriveHash(secret, token.salt)
    const expected = Buffer.from(token.hash, 'hex')
    const actual = Buffer.from(candidate, 'hex')
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      return null
    }

    // Best-effort; never let bookkeeping failure block auth.
    try {
      await this.mutate((store) => {
        if (store[tokenUuid]) {
          store[tokenUuid].lastUsedAt = Date.now()
        }
      })
    } catch {
      // ignored
    }

    return this.toMetadata(token)
  }

  private deriveHash(secret: string, salt: string): string {
    return crypto.scryptSync(secret, salt, SCRYPT_KEYLEN).toString('hex')
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
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as StoreShape
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {}
      }
      throw error
    }
  }

  private async mutate(mutator: (data: StoreShape) => void): Promise<void> {
    const run = this.writeChain.then(async () => {
      const data = await this.read()
      mutator(data)
      await this.atomicWrite(data)
    })
    this.writeChain = run.catch(() => undefined)
    return run
  }

  private async atomicWrite(data: StoreShape): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}
