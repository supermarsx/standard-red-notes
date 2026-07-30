import { randomUUID } from 'crypto'
import { constants, fsync, promises as fs, Stats } from 'fs'
import { hostname } from 'os'
import * as path from 'path'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_LOCK_TIMEOUT_MS = 5_000
const DEFAULT_STALE_LOCK_MS = 30_000
const DEFAULT_LOCK_RETRY_MS = 10
const MAX_LOCK_ARTIFACT_BYTES = 1024
const LOCK_CHOOSING_PREFIX = 'write.lock.choosing.'
const LOCK_OWNER_PREFIX = 'write.lock.owner.'

export interface SecureJsonFileHandle {
  readonly fd: number
  stat(): Promise<Stats>
  read(buffer: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>
  writeFile(data: string, encoding: BufferEncoding): Promise<void>
  chmod(mode: number): Promise<void>
  close(): Promise<void>
}

export interface SecureJsonFileOperations {
  platform: NodeJS.Platform
  processId: number
  hostName: string
  now(): number
  randomId(): string
  isProcessAlive(processId: number): boolean
  sleep(milliseconds: number): Promise<void>
  lstat(filePath: string): Promise<Stats>
  mkdir(directoryPath: string, options: { recursive: true; mode: number }): Promise<string | undefined>
  open(filePath: string, flags: string | number, mode?: number): Promise<SecureJsonFileHandle>
  fsync(fileDescriptor: number): Promise<void>
  readdir(directoryPath: string): Promise<string[]>
  rename(oldPath: string, newPath: string): Promise<void>
  unlink(filePath: string): Promise<void>
}

export const defaultSecureJsonFileOperations: SecureJsonFileOperations = {
  platform: process.platform,
  processId: process.pid,
  hostName: hostname(),
  now: () => Date.now(),
  randomId: () => randomUUID(),
  isProcessAlive: (processId) => {
    try {
      process.kill(processId, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  },
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  lstat: (filePath) => fs.lstat(filePath),
  mkdir: (directoryPath, options) => fs.mkdir(directoryPath, options),
  open: (filePath, flags, mode) => fs.open(filePath, flags, mode),
  fsync: (fileDescriptor) =>
    new Promise((resolve, reject) => {
      fsync(fileDescriptor, (error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    }),
  readdir: (directoryPath) => fs.readdir(directoryPath),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  unlink: (filePath) => fs.unlink(filePath),
}

export interface SecureJsonFileStoreOptions<T extends object> {
  filePath: string
  validate(value: unknown): value is T
  maxBytes?: number
  lockTimeoutMs?: number
  staleLockMs?: number
  lockRetryMs?: number
  operations?: Partial<SecureJsonFileOperations>
}

export interface SecureJsonFileTransaction<T extends object> {
  read(): Promise<T | null>
  write(value: T): Promise<void>
  delete(): Promise<void>
}

interface AcquiredLock {
  ownerPath: string
  token: string
}

interface LockArtifactMetadata {
  v: 1
  token: string
  processId: number
  hostName: string
  createdAt: number
  ticket?: number
}

interface LockOwner {
  filePath: string
  metadata: LockArtifactMetadata & { ticket: number }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const UNSAFE_RECORD_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype'])

/** True when an object contains no fields outside the explicitly allowed set. */
export function hasOnlyKeys(value: unknown, allowedKeys: readonly string[]): value is Record<string, unknown> {
  return isJsonObject(value) && Object.keys(value).every((key) => allowedKeys.includes(key))
}

/** A UTF-16 code-unit bound for persisted strings; callers choose domain limits. */
export function isBoundedString(value: unknown, minimumLength: number, maximumLength: number): value is string {
  return typeof value === 'string' && value.length >= minimumLength && value.length <= maximumLength
}

/**
 * A bounded map key that cannot mutate an ordinary object's prototype when used
 * with bracket assignment. Identifiers remain intentionally format-agnostic so
 * UUIDs, emails, and legacy ids all remain compatible.
 */
export function isSafeRecordKey(value: unknown, maximumLength = 256): value is string {
  return (
    isBoundedString(value, 1, maximumLength) &&
    value.trim() === value &&
    !UNSAFE_RECORD_KEYS.has(value) &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

/** Safe persisted epoch milliseconds, within JavaScript Date's supported range. */
export function isEpochMilliseconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000
}

/**
 * A bounded, durable JSON-file primitive for gateway-local secrets and
 * server-readable data.
 *
 * The target file keeps its existing path and JSON shape. Lock and temporary
 * artifacts live in a private, per-target sibling directory so the helper never
 * chmods a shared data directory. POSIX modes are defense in depth; Windows
 * still gets exclusive creation, link/type validation, bounded reads, durable
 * replacement, and locking, but its ACL model cannot be expressed by chmod.
 * Dead-owner recovery is intentionally limited to one host and one PID
 * namespace. Foreign-host or unreadable lock artifacts fail closed and time out
 * instead of being guessed stale.
 */
export class SecureJsonFileStore<T extends object> {
  private readonly filePath: string
  private readonly parentDirectoryPath: string
  private readonly privateDirectoryPath: string
  private readonly temporaryFilePrefix: string
  private readonly validate: (value: unknown) => value is T
  private readonly maxBytes: number
  private readonly lockTimeoutMs: number
  private readonly staleLockMs: number
  private readonly lockRetryMs: number
  private readonly operations: SecureJsonFileOperations
  private operationChain: Promise<void> = Promise.resolve()

  constructor(options: SecureJsonFileStoreOptions<T>) {
    this.filePath = path.resolve(options.filePath)
    this.parentDirectoryPath = path.dirname(this.filePath)
    this.privateDirectoryPath = path.join(this.parentDirectoryPath, `.${path.basename(this.filePath)}.secure`)
    this.temporaryFilePrefix = `${path.basename(this.filePath)}.`
    this.validate = options.validate
    this.maxBytes = this.positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, 'maxBytes')
    this.lockTimeoutMs = this.positiveInteger(options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, 'lockTimeoutMs')
    this.staleLockMs = this.positiveInteger(options.staleLockMs ?? DEFAULT_STALE_LOCK_MS, 'staleLockMs')
    this.lockRetryMs = this.positiveInteger(options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS, 'lockRetryMs')
    this.operations = {
      ...defaultSecureJsonFileOperations,
      ...options.operations,
    }
  }

  async read(): Promise<T | null> {
    const raw = await this.readTextFile(this.filePath, this.maxBytes, true)
    if (raw === null) {
      return null
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw) as unknown
    } catch (error) {
      throw new Error(`The JSON store at ${this.filePath} is malformed.`, { cause: error })
    }

    if (!this.validate(parsed)) {
      throw new Error(`The JSON store at ${this.filePath} has an invalid object shape.`)
    }

    return parsed
  }

  async write(value: T): Promise<void> {
    await this.runExclusive((transaction) => transaction.write(value))
  }

  async update(transform: (current: T | null) => T | Promise<T>): Promise<T> {
    return this.runExclusive(async (transaction) => {
      const next = await transform(await transaction.read())
      await transaction.write(next)
      return next
    })
  }

  async delete(): Promise<void> {
    await this.runExclusive((transaction) => transaction.delete())
  }

  async runExclusive<R>(action: (transaction: SecureJsonFileTransaction<T>) => Promise<R>): Promise<R> {
    return this.enqueue(async () =>
      this.withFileLock(() =>
        action({
          read: () => this.read(),
          write: (value) => this.atomicWrite(value),
          delete: () => this.deleteTarget(),
        }),
      ),
    )
  }

  private positiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer.`)
    }
    return value
  }

  private async enqueue<R>(action: () => Promise<R>): Promise<R> {
    const run = this.operationChain.then(action)
    this.operationChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async withFileLock<R>(action: () => Promise<R>): Promise<R> {
    const lock = await this.acquireLock()
    let result: R | undefined
    let failure: unknown

    try {
      result = await action()
    } catch (error) {
      failure = error
    }

    try {
      await this.releaseLock(lock)
    } catch (error) {
      if (failure === undefined) {
        failure = error
      }
    }

    if (failure !== undefined) {
      throw failure
    }
    return result as R
  }

  private async acquireLock(): Promise<AcquiredLock> {
    await this.ensureWriteDirectories()
    const deadline = this.operations.now() + this.lockTimeoutMs
    const token = this.safeLockToken(this.operations.randomId())
    const choosingPath = path.join(
      this.privateDirectoryPath,
      `${LOCK_CHOOSING_PREFIX}${this.operations.processId}.${token}`,
    )
    let ownerPath: string | undefined

    await this.createLockArtifact(choosingPath, {
      v: 1,
      token,
      processId: this.operations.processId,
      hostName: this.operations.hostName,
      createdAt: this.operations.now(),
    })

    try {
      await this.removeStaleLockArtifacts()
      const ticket = await this.nextLockTicket()
      ownerPath = path.join(
        this.privateDirectoryPath,
        `${LOCK_OWNER_PREFIX}${ticket}.${this.operations.processId}.${token}`,
      )
      await this.createLockArtifact(ownerPath, {
        v: 1,
        token,
        processId: this.operations.processId,
        hostName: this.operations.hostName,
        createdAt: this.operations.now(),
        ticket,
      })
      await this.unlinkIfPresent(choosingPath)
      await this.bestEffortSyncDirectory(this.privateDirectoryPath)

      while (true) {
        const state = await this.readLockState()
        if (!state.blocked && state.choosingCount === 0) {
          const firstOwner = state.owners.sort(
            (left, right) =>
              left.metadata.ticket - right.metadata.ticket || left.metadata.token.localeCompare(right.metadata.token),
          )[0]
          if (firstOwner?.metadata.token === token) {
            await this.cleanupAbandonedArtifacts()
            return { ownerPath, token }
          }
          if (!state.owners.some((owner) => owner.metadata.token === token)) {
            throw new Error(`Lost ownership of the JSON store lock ticket at ${ownerPath}.`)
          }
        }

        const remaining = deadline - this.operations.now()
        if (remaining <= 0) {
          throw new Error(`Timed out waiting for the JSON store lock in ${this.privateDirectoryPath}.`)
        }
        await this.operations.sleep(Math.min(this.lockRetryMs, remaining))
      }
    } catch (error) {
      await this.unlinkIfPresent(ownerPath)
      await this.unlinkIfPresent(choosingPath)
      throw error
    }
  }

  private async releaseLock(lock: AcquiredLock): Promise<void> {
    const metadata = await this.readLockArtifact(lock.ownerPath)
    if (metadata === null) {
      return
    }
    if (metadata.token !== lock.token || metadata.processId !== this.operations.processId) {
      throw new Error(`Refusing to release a JSON store lock ticket owned by another process: ${lock.ownerPath}.`)
    }

    await this.unlinkIfPresent(lock.ownerPath)
    await this.bestEffortSyncDirectory(this.privateDirectoryPath)
  }

  private async createLockArtifact(filePath: string, metadata: LockArtifactMetadata): Promise<void> {
    await this.assertSafeDirectory(this.privateDirectoryPath, true)
    let handle: SecureJsonFileHandle | undefined
    let created = false
    try {
      handle = await this.operations.open(filePath, 'wx', FILE_MODE)
      created = true
      if (this.enforcesPosixModes()) {
        await handle.chmod(FILE_MODE)
      }
      await handle.writeFile(JSON.stringify(metadata), 'utf8')
      await this.operations.fsync(handle.fd)
      await handle.close()
      handle = undefined
    } finally {
      await handle?.close().catch(() => undefined)
      if (handle !== undefined && created) {
        await this.unlinkIfPresent(filePath)
      }
    }
  }

  private async nextLockTicket(): Promise<number> {
    const names = await this.operations.readdir(this.privateDirectoryPath)
    let maximum = 0
    for (const name of names) {
      const identity = this.parseOwnerFileName(name)
      if (identity) {
        maximum = Math.max(maximum, identity.ticket)
      }
    }
    if (maximum >= Number.MAX_SAFE_INTEGER) {
      throw new Error(`The JSON store lock ticket space is exhausted in ${this.privateDirectoryPath}.`)
    }
    return maximum + 1
  }

  private async readLockState(): Promise<{
    blocked: boolean
    choosingCount: number
    owners: LockOwner[]
  }> {
    await this.removeStaleLockArtifacts()
    const names = await this.operations.readdir(this.privateDirectoryPath)
    const owners: LockOwner[] = []
    let blocked = false
    let choosingCount = 0

    for (const name of names) {
      const choosingIdentity = this.parseChoosingFileName(name)
      const ownerIdentity = this.parseOwnerFileName(name)
      if (!choosingIdentity && !ownerIdentity) {
        continue
      }

      const filePath = path.join(this.privateDirectoryPath, name)
      let metadata: LockArtifactMetadata
      try {
        const parsed = await this.readLockArtifact(filePath)
        if (!parsed) {
          continue
        }
        metadata = parsed
      } catch {
        blocked = true
        continue
      }

      const identity = choosingIdentity ?? ownerIdentity!
      if (
        metadata.token !== identity.token ||
        metadata.processId !== identity.processId ||
        (ownerIdentity !== null && metadata.ticket !== ownerIdentity.ticket)
      ) {
        blocked = true
        continue
      }

      if (choosingIdentity) {
        choosingCount += 1
      } else if (metadata.ticket !== undefined) {
        owners.push({
          filePath,
          metadata: metadata as LockArtifactMetadata & { ticket: number },
        })
      }
    }

    return { blocked, choosingCount, owners }
  }

  private async removeStaleLockArtifacts(): Promise<void> {
    const names = await this.operations.readdir(this.privateDirectoryPath)
    for (const name of names) {
      const identity = this.parseChoosingFileName(name) ?? this.parseOwnerFileName(name)
      if (!identity) {
        continue
      }
      const filePath = path.join(this.privateDirectoryPath, name)
      let stats: Stats
      try {
        stats = await this.operations.lstat(filePath)
      } catch (error) {
        if (this.errorCode(error) === 'ENOENT') {
          continue
        }
        throw error
      }
      this.assertSafeRegularFile(stats, filePath)
      if (this.operations.now() - stats.mtimeMs <= this.staleLockMs) {
        continue
      }

      let metadata: LockArtifactMetadata | null
      try {
        metadata = await this.readLockArtifact(filePath)
      } catch {
        // Without authenticated host metadata, PID liveness is ambiguous across
        // hosts/namespaces. Leave the artifact in place and fail closed.
        continue
      }
      if (
        !metadata ||
        metadata.token !== identity.token ||
        metadata.processId !== identity.processId ||
        ('ticket' in identity && metadata.ticket !== identity.ticket) ||
        metadata.hostName !== this.operations.hostName ||
        this.operations.isProcessAlive(identity.processId)
      ) {
        continue
      }
      await this.unlinkStaleArtifact(filePath)
    }
  }

  private async readLockArtifact(filePath: string): Promise<LockArtifactMetadata | null> {
    const raw = await this.readTextFile(filePath, MAX_LOCK_ARTIFACT_BYTES, true)
    if (raw === null) {
      return null
    }
    let value: unknown
    try {
      value = JSON.parse(raw) as unknown
    } catch (error) {
      throw new Error(`Malformed JSON store lock artifact: ${filePath}.`, { cause: error })
    }
    if (!this.isLockArtifactMetadata(value)) {
      throw new Error(`Invalid JSON store lock artifact: ${filePath}.`)
    }
    return value
  }

  private isLockArtifactMetadata(value: unknown): value is LockArtifactMetadata {
    return (
      isJsonObject(value) &&
      value.v === 1 &&
      typeof value.token === 'string' &&
      /^[A-Za-z0-9_-]{1,128}$/.test(value.token) &&
      typeof value.processId === 'number' &&
      Number.isSafeInteger(value.processId) &&
      value.processId > 0 &&
      typeof value.hostName === 'string' &&
      value.hostName.length > 0 &&
      value.hostName.length <= 255 &&
      typeof value.createdAt === 'number' &&
      Number.isFinite(value.createdAt) &&
      (value.ticket === undefined ||
        (typeof value.ticket === 'number' && Number.isSafeInteger(value.ticket) && value.ticket > 0))
    )
  }

  private parseChoosingFileName(name: string): { processId: number; token: string } | null {
    const match = /^write\.lock\.choosing\.(\d+)\.([A-Za-z0-9_-]{1,128})$/.exec(name)
    if (!match) {
      return null
    }
    const processId = Number(match[1])
    return Number.isSafeInteger(processId) && processId > 0 ? { processId, token: match[2] } : null
  }

  private parseOwnerFileName(name: string): { ticket: number; processId: number; token: string } | null {
    const match = /^write\.lock\.owner\.(\d+)\.(\d+)\.([A-Za-z0-9_-]{1,128})$/.exec(name)
    if (!match) {
      return null
    }
    const ticket = Number(match[1])
    const processId = Number(match[2])
    return Number.isSafeInteger(ticket) && ticket > 0 && Number.isSafeInteger(processId) && processId > 0
      ? { ticket, processId, token: match[3] }
      : null
  }

  private safeLockToken(token: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(token)) {
      throw new Error('The JSON store lock token generator returned an unsafe value.')
    }
    return token
  }

  private async unlinkIfPresent(filePath: string | undefined): Promise<void> {
    if (!filePath) {
      return
    }
    try {
      await this.operations.unlink(filePath)
    } catch (error) {
      if (this.errorCode(error) !== 'ENOENT') {
        throw error
      }
    }
  }

  private async unlinkStaleArtifact(filePath: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.operations.unlink(filePath)
        return
      } catch (error) {
        const code = this.errorCode(error)
        if (code === 'ENOENT') {
          return
        }
        if ((code === 'EPERM' || code === 'EBUSY') && attempt < 4) {
          await this.operations.sleep(this.lockRetryMs)
          continue
        }
        throw error
      }
    }
  }

  private async ensureWriteDirectories(): Promise<void> {
    await this.operations.mkdir(this.parentDirectoryPath, {
      recursive: true,
      mode: DIRECTORY_MODE,
    })
    await this.assertSafeDirectory(this.parentDirectoryPath, false)

    await this.operations.mkdir(this.privateDirectoryPath, {
      recursive: true,
      mode: DIRECTORY_MODE,
    })
    await this.assertSafeDirectory(this.privateDirectoryPath, true)
  }

  private async assertSafeDirectory(directoryPath: string, tightenMode: boolean): Promise<void> {
    const pathStats = await this.operations.lstat(directoryPath)
    if (pathStats.isSymbolicLink() || !pathStats.isDirectory()) {
      throw new Error(`Refusing unsafe JSON store directory: ${directoryPath}.`)
    }
    if (!this.enforcesPosixModes()) {
      return
    }

    const directoryOnly = constants.O_DIRECTORY ?? 0
    const noFollow = constants.O_NOFOLLOW ?? 0
    const handle = await this.operations.open(directoryPath, constants.O_RDONLY | directoryOnly | noFollow)
    try {
      const handleStats = await handle.stat()
      if (!handleStats.isDirectory()) {
        throw new Error(`Refusing non-directory JSON store path: ${directoryPath}.`)
      }
      if (this.hasStableIdentity(pathStats) && this.hasStableIdentity(handleStats)) {
        if (pathStats.dev !== handleStats.dev || pathStats.ino !== handleStats.ino) {
          throw new Error(`The JSON store directory changed while it was being opened: ${directoryPath}.`)
        }
      }
      if (tightenMode && (handleStats.mode & 0o777) !== DIRECTORY_MODE) {
        await handle.chmod(DIRECTORY_MODE)
      }
    } finally {
      await handle.close()
    }
  }

  private async cleanupAbandonedArtifacts(): Promise<void> {
    const names = await this.operations.readdir(this.privateDirectoryPath)
    for (const name of names) {
      const isTemporaryFile = name.startsWith(this.temporaryFilePrefix) && name.endsWith('.tmp')
      if (!isTemporaryFile) {
        continue
      }
      await this.removePrivateArtifact(path.join(this.privateDirectoryPath, name))
    }
  }

  private async removePrivateArtifact(artifactPath: string): Promise<void> {
    let stats: Stats
    try {
      stats = await this.operations.lstat(artifactPath)
    } catch (error) {
      if (this.errorCode(error) === 'ENOENT') {
        return
      }
      throw error
    }

    if (stats.isSymbolicLink()) {
      await this.operations.unlink(artifactPath)
      return
    }
    this.assertSafeRegularFile(stats, artifactPath)
    await this.operations.unlink(artifactPath)
  }

  private async atomicWrite(value: T): Promise<void> {
    if (!this.validate(value)) {
      throw new Error(`Refusing to write an invalid object to ${this.filePath}.`)
    }

    const serialized = JSON.stringify(value, null, 2)
    if (Buffer.byteLength(serialized, 'utf8') > this.maxBytes) {
      throw new Error(`The JSON store at ${this.filePath} exceeds the ${this.maxBytes}-byte limit.`)
    }

    const temporaryPath = path.join(
      this.privateDirectoryPath,
      `${this.temporaryFilePrefix}${this.operations.randomId()}.tmp`,
    )
    let handle: SecureJsonFileHandle | undefined
    let temporaryFileExists = false

    try {
      await this.assertSafeDirectory(this.privateDirectoryPath, true)
      handle = await this.operations.open(temporaryPath, 'wx', FILE_MODE)
      temporaryFileExists = true
      if (this.enforcesPosixModes()) {
        await handle.chmod(FILE_MODE)
      }
      await handle.writeFile(serialized, 'utf8')
      await this.operations.fsync(handle.fd)
      await handle.close()
      handle = undefined

      await this.assertSafeDirectory(this.privateDirectoryPath, true)
      await this.assertSafeReplacementTarget()
      await this.operations.rename(temporaryPath, this.filePath)
      temporaryFileExists = false
      await this.bestEffortSyncDirectory(this.privateDirectoryPath)
      await this.bestEffortSyncDirectory(this.parentDirectoryPath)
    } finally {
      await handle?.close().catch(() => undefined)
      if (temporaryFileExists) {
        await this.operations.unlink(temporaryPath).catch(() => undefined)
      }
    }
  }

  private async assertSafeReplacementTarget(): Promise<void> {
    try {
      const stats = await this.operations.lstat(this.filePath)
      this.assertSafeRegularFile(stats, this.filePath)
    } catch (error) {
      if (this.errorCode(error) !== 'ENOENT') {
        throw error
      }
    }
  }

  private async deleteTarget(): Promise<void> {
    try {
      const stats = await this.operations.lstat(this.filePath)
      this.assertSafeRegularFile(stats, this.filePath)
      await this.operations.unlink(this.filePath)
      await this.bestEffortSyncDirectory(this.parentDirectoryPath)
    } catch (error) {
      if (this.errorCode(error) !== 'ENOENT') {
        throw error
      }
    }
  }

  private async readTextFile(
    filePath: string,
    maximumBytes: number,
    tightenLegacyMode: boolean,
  ): Promise<string | null> {
    let pathStats: Stats
    try {
      pathStats = await this.operations.lstat(filePath)
    } catch (error) {
      if (this.errorCode(error) === 'ENOENT') {
        return null
      }
      throw error
    }
    this.assertSafeRegularFile(pathStats, filePath)

    let handle: SecureJsonFileHandle
    try {
      const noFollow = constants.O_NOFOLLOW ?? 0
      handle = await this.operations.open(filePath, constants.O_RDONLY | noFollow)
    } catch (error) {
      if (this.errorCode(error) === 'ENOENT') {
        return null
      }
      if (this.errorCode(error) === 'ELOOP') {
        throw new Error(`Refusing symbolic-link JSON store path: ${filePath}.`)
      }
      throw error
    }

    try {
      const handleStats = await handle.stat()
      this.assertSafeRegularFile(handleStats, filePath)
      if (this.hasStableIdentity(pathStats) && this.hasStableIdentity(handleStats)) {
        if (pathStats.dev !== handleStats.dev || pathStats.ino !== handleStats.ino) {
          throw new Error(`The JSON store changed while it was being opened: ${filePath}.`)
        }
      }
      if (handleStats.size > maximumBytes) {
        throw new Error(`The JSON store at ${filePath} exceeds the ${maximumBytes}-byte limit.`)
      }
      if (tightenLegacyMode && this.enforcesPosixModes() && (handleStats.mode & 0o777) !== FILE_MODE) {
        await handle.chmod(FILE_MODE)
      }

      const buffer = Buffer.alloc(maximumBytes + 1)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
        if (bytesRead === 0) {
          break
        }
        offset += bytesRead
      }
      if (offset > maximumBytes) {
        throw new Error(`The JSON store at ${filePath} exceeds the ${maximumBytes}-byte limit.`)
      }
      return buffer.subarray(0, offset).toString('utf8')
    } finally {
      await handle.close()
    }
  }

  private assertSafeRegularFile(stats: Stats, filePath: string): void {
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Refusing non-regular JSON store file: ${filePath}.`)
    }
    if (stats.nlink > 1) {
      throw new Error(`Refusing hard-linked JSON store file: ${filePath}.`)
    }
  }

  private hasStableIdentity(stats: Stats): boolean {
    return stats.ino !== 0
  }

  private async bestEffortSyncDirectory(directoryPath: string): Promise<void> {
    let handle: SecureJsonFileHandle | undefined
    try {
      handle = await this.operations.open(directoryPath, constants.O_RDONLY)
      await this.operations.fsync(handle.fd)
    } catch (error) {
      if (!this.isUnsupportedDirectorySync(error)) {
        throw error
      }
    } finally {
      await handle?.close().catch(() => undefined)
    }
  }

  private isUnsupportedDirectorySync(error: unknown): boolean {
    const code = this.errorCode(error)
    if (code === 'EINVAL' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EBADF') {
      return true
    }
    return this.operations.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EISDIR')
  }

  private enforcesPosixModes(): boolean {
    return this.operations.platform !== 'win32'
  }

  private errorCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code
  }
}
