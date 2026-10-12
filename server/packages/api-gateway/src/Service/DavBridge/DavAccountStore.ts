import { promises as fs } from 'fs'
import * as path from 'path'

import { hasOnlyKeys, isBoundedString, isEpochMilliseconds, SecureJsonFileStore } from '../../Infra/SecureJsonFileStore'
import { DavSecretEnvelope, isDavSecretEnvelope } from './DavSecretCipher'

/**
 * Standard Red Notes: the external accounts a user has connected, one file per
 * user.
 *
 * `<dataPath>/accounts/<userUuid>.json`, through the shared secure-file
 * primitive (owner-only mode, atomic replace, cross-process lock). One file per
 * user, not one file for everyone: the published-calendar store shares a single
 * 1 MiB file between all users and a write that would exceed it fails for all
 * of them. Here one user's five accounts cannot affect another's.
 *
 * WRITES ARE RARE BY DESIGN. Creating, replacing a password, pinning, removing,
 * and the two state transitions of a password (first accepted, rejected). The
 * relay writes nothing per forwarded request: the file lock recovers a dead
 * owner only on the same host, so a store written on every request is a store
 * that can wedge behind a crashed replica.
 *
 * The password is never in this file in the clear. `secret` is an AES-GCM
 * envelope bound to this user and this account (see DavSecretCipher). Host name
 * and username are plaintext: the server needs them to connect.
 */

export type DavAccountKind = 'nextcloud' | 'caldav'
export type DavCredentialKind = 'basic' | 'bearer'
/**
 * What is known about the stored secret:
 *   unverified - stored, no authenticated answer seen with it yet;
 *   accepted   - a request carrying it got a 2xx;
 *   rejected   - the remote answered 401. Nothing more is forwarded until it is
 *                replaced. Persisted, so that a restart does not try it again.
 */
export type DavSecretState = 'unverified' | 'accepted' | 'rejected'

export interface DavAccountPin {
  principalPath: string
  calendarHomePath: string
  setAt: number
}

export interface PersistedDavAccount {
  id: string
  kind: DavAccountKind
  origin: string
  entryPath: string
  username: string
  credentialKind: DavCredentialKind
  secret: DavSecretEnvelope
  secretSetAt: number
  secretState: DavSecretState
  pin: DavAccountPin | null
  createdAt: number
  updatedAt: number
}

interface PersistedDavAccounts {
  v: 1
  userUuid: string
  accounts: PersistedDavAccount[]
}

export const DAV_ACCOUNT_LIMITS = {
  /** Hard ceiling an operator setting cannot exceed. */
  accountsPerUserMaximum: 20,
  usernameLength: 255,
  originLength: 300,
  pathLength: 2048,
  /** Twenty accounts with their envelopes are well under this. */
  fileBytes: 64 * 1024,
} as const

/** Lower case, canonical 8-4-4-4-12. The only shape allowed into a file name. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class DavAccountStoreError extends Error {
  constructor(
    /** A closed list, safe to log: the underlying error text is not (it names a file by user). */
    readonly reason: 'invalid-user' | 'unreadable' | 'unwritable',
  ) {
    super(`DAV account store: ${reason}`)
    this.name = 'DavAccountStoreError'
  }
}

export class DavAccountLimitError extends Error {
  constructor(readonly limit: number) {
    super('DAV account limit reached')
    this.name = 'DavAccountLimitError'
  }
}

const isKind = (value: unknown): value is DavAccountKind => value === 'nextcloud' || value === 'caldav'
const isCredentialKind = (value: unknown): value is DavCredentialKind => value === 'basic' || value === 'bearer'
const isSecretState = (value: unknown): value is DavSecretState =>
  value === 'unverified' || value === 'accepted' || value === 'rejected'
const isAbsolutePath = (value: unknown): value is string =>
  isBoundedString(value, 1, DAV_ACCOUNT_LIMITS.pathLength) && value.startsWith('/')

function isPin(value: unknown): value is DavAccountPin {
  return (
    hasOnlyKeys(value, ['principalPath', 'calendarHomePath', 'setAt']) &&
    isAbsolutePath(value.principalPath) &&
    isAbsolutePath(value.calendarHomePath) &&
    isEpochMilliseconds(value.setAt)
  )
}

function isPersistedAccount(value: unknown): value is PersistedDavAccount {
  return (
    hasOnlyKeys(value, [
      'id',
      'kind',
      'origin',
      'entryPath',
      'username',
      'credentialKind',
      'secret',
      'secretSetAt',
      'secretState',
      'pin',
      'createdAt',
      'updatedAt',
    ]) &&
    typeof value.id === 'string' &&
    UUID_PATTERN.test(value.id) &&
    isKind(value.kind) &&
    isBoundedString(value.origin, 1, DAV_ACCOUNT_LIMITS.originLength) &&
    isAbsolutePath(value.entryPath) &&
    isBoundedString(value.username, 0, DAV_ACCOUNT_LIMITS.usernameLength) &&
    isCredentialKind(value.credentialKind) &&
    isDavSecretEnvelope(value.secret) &&
    isEpochMilliseconds(value.secretSetAt) &&
    isSecretState(value.secretState) &&
    (value.pin === null || isPin(value.pin)) &&
    isEpochMilliseconds(value.createdAt) &&
    isEpochMilliseconds(value.updatedAt)
  )
}

function isPersistedAccounts(value: unknown): value is PersistedDavAccounts {
  if (!hasOnlyKeys(value, ['v', 'userUuid', 'accounts']) || value.v !== 1) {
    return false
  }
  if (typeof value.userUuid !== 'string' || !UUID_PATTERN.test(value.userUuid)) {
    return false
  }
  const accounts = value.accounts
  if (
    !Array.isArray(accounts) ||
    accounts.length > DAV_ACCOUNT_LIMITS.accountsPerUserMaximum ||
    !accounts.every(isPersistedAccount)
  ) {
    return false
  }
  return new Set(accounts.map((account) => account.id)).size === accounts.length
}

export class DavAccountStore {
  private readonly accountsDirectory: string
  private readonly stores = new Map<string, SecureJsonFileStore<PersistedDavAccounts>>()

  constructor(dataPath: string) {
    this.accountsDirectory = path.join(path.resolve(dataPath), 'accounts')
  }

  async list(userUuid: string): Promise<PersistedDavAccount[]> {
    const data = await this.read(userUuid)
    return data === null ? [] : data.accounts
  }

  async get(userUuid: string, accountId: string): Promise<PersistedDavAccount | null> {
    if (!UUID_PATTERN.test(accountId)) {
      return null
    }
    return (await this.list(userUuid)).find((account) => account.id === accountId) ?? null
  }

  /**
   * `build` runs inside the file lock with the accounts that exist at that
   * moment, so the limit cannot be passed by two concurrent creations.
   */
  async create(
    userUuid: string,
    limit: number,
    build: (existing: readonly PersistedDavAccount[]) => PersistedDavAccount,
  ): Promise<PersistedDavAccount> {
    const store = this.storeFor(userUuid)
    const effectiveLimit = Math.min(limit, DAV_ACCOUNT_LIMITS.accountsPerUserMaximum)
    return this.writing(async () =>
      store.runExclusive(async (transaction) => {
        const current = await transaction.read()
        this.assertOwnedBy(current, userUuid)
        const accounts = current?.accounts ?? []
        if (accounts.length >= effectiveLimit) {
          throw new DavAccountLimitError(effectiveLimit)
        }
        const created = build(accounts)
        await transaction.write({ v: 1, userUuid: userUuid.toLowerCase(), accounts: [...accounts, created] })
        return created
      }),
    )
  }

  /**
   * Applies `change` to one account under the file lock. Returning the account
   * it was given (same object) means "nothing to write", which keeps a
   * transition that already happened from costing a second write.
   */
  async update(
    userUuid: string,
    accountId: string,
    change: (account: PersistedDavAccount) => PersistedDavAccount,
  ): Promise<PersistedDavAccount | null> {
    if (!UUID_PATTERN.test(accountId)) {
      return null
    }
    const store = this.storeFor(userUuid)
    return this.writing(async () =>
      store.runExclusive(async (transaction) => {
        const current = await transaction.read()
        this.assertOwnedBy(current, userUuid)
        const existing = current?.accounts.find((account) => account.id === accountId)
        if (!current || !existing) {
          return null
        }
        const next = change(existing)
        if (next === existing) {
          return existing
        }
        await transaction.write({
          v: 1,
          userUuid: current.userUuid,
          accounts: current.accounts.map((account) => (account.id === accountId ? next : account)),
        })
        return next
      }),
    )
  }

  async remove(userUuid: string, accountId: string): Promise<boolean> {
    if (!UUID_PATTERN.test(accountId)) {
      return false
    }
    const store = this.storeFor(userUuid)
    const result = await this.writing(async () =>
      store.runExclusive(async (transaction) => {
        const current = await transaction.read()
        this.assertOwnedBy(current, userUuid)
        if (!current || !current.accounts.some((account) => account.id === accountId)) {
          return { removed: false, emptied: false }
        }
        const remaining = current.accounts.filter((account) => account.id !== accountId)
        if (remaining.length === 0) {
          await transaction.delete()
          return { removed: true, emptied: true }
        }
        await transaction.write({ v: 1, userUuid: current.userUuid, accounts: remaining })
        return { removed: true, emptied: false }
      }),
    )
    if (result.emptied) {
      await this.removeLockDirectory(userUuid)
    }
    return result.removed
  }

  /**
   * Removes everything held for a user and returns how many accounts that was.
   * Deliberately does not need the file to be readable: a file that no longer
   * validates still has to be removable, or "delete what the server holds"
   * would fail exactly when something is wrong.
   */
  async removeAllForUser(userUuid: string): Promise<number> {
    const store = this.storeFor(userUuid)
    const count = await this.writing(async () =>
      store.runExclusive(async (transaction) => {
        let existing = 0
        try {
          existing = (await transaction.read())?.accounts.length ?? 0
        } catch {
          // Unreadable is still removable. Counted as one so the caller can
          // tell "something was there" from "nothing was there".
          existing = 1
        }
        await transaction.delete()
        return existing
      }),
    )
    await this.removeLockDirectory(userUuid)
    this.stores.delete(userUuid.toLowerCase())
    return count
  }

  /** Every user that has a file here. For the administrator's view and for purge. */
  async listUserUuids(): Promise<string[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.accountsDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw new DavAccountStoreError('unreadable')
    }
    return names
      .filter((name) => name.endsWith('.json') && UUID_PATTERN.test(name.slice(0, -'.json'.length)))
      .map((name) => name.slice(0, -'.json'.length))
      .sort()
  }

  private async read(userUuid: string): Promise<PersistedDavAccounts | null> {
    const store = this.storeFor(userUuid)
    let data: PersistedDavAccounts | null
    try {
      data = await store.read()
    } catch {
      throw new DavAccountStoreError('unreadable')
    }
    this.assertOwnedBy(data, userUuid)
    return data
  }

  /**
   * A file that names another user inside is treated as unreadable, not as that
   * user's accounts: a file renamed or copied onto another user's path must not
   * hand over its contents. (The secret would fail to open anyway, being bound
   * to its owner; this keeps the host name and username from crossing too.)
   */
  private assertOwnedBy(data: PersistedDavAccounts | null, userUuid: string): void {
    if (data !== null && data.userUuid !== userUuid.toLowerCase()) {
      throw new DavAccountStoreError('unreadable')
    }
  }

  private async writing<R>(action: () => Promise<R>): Promise<R> {
    try {
      return await action()
    } catch (error) {
      if (error instanceof DavAccountLimitError || error instanceof DavAccountStoreError) {
        throw error
      }
      throw new DavAccountStoreError('unwritable')
    }
  }

  private storeFor(userUuid: string): SecureJsonFileStore<PersistedDavAccounts> {
    const key = typeof userUuid === 'string' ? userUuid.toLowerCase() : ''
    // The id becomes a file name. It comes from a verified session, and is
    // still held to one exact shape here so that nothing else can ever be one.
    if (!UUID_PATTERN.test(key)) {
      throw new DavAccountStoreError('invalid-user')
    }
    let store = this.stores.get(key)
    if (!store) {
      store = new SecureJsonFileStore<PersistedDavAccounts>({
        filePath: this.filePathFor(key),
        validate: isPersistedAccounts,
        maxBytes: DAV_ACCOUNT_LIMITS.fileBytes,
      })
      // Bounded: an instance holds no data, only its place in a write queue.
      if (this.stores.size >= 1_000) {
        this.stores.clear()
      }
      this.stores.set(key, store)
    }
    return store
  }

  private filePathFor(normalizedUserUuid: string): string {
    return path.join(this.accountsDirectory, `${normalizedUserUuid}.json`)
  }

  /**
   * The file primitive keeps its lock and temporary artifacts in a private
   * sibling directory. It holds no data, but "deleted" should leave nothing
   * behind that names the user, so it goes when the file goes.
   */
  private async removeLockDirectory(userUuid: string): Promise<void> {
    const key = userUuid.toLowerCase()
    if (!UUID_PATTERN.test(key)) {
      return
    }
    await fs
      .rm(path.join(this.accountsDirectory, `.${key}.json.secure`), { recursive: true, force: true })
      .catch(() => undefined)
  }
}
