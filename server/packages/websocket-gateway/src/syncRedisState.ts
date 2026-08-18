import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'

import {
  DEFAULT_SYNC_TICKET_TTL_MS,
  isValidSyncTicketIdentity,
  type IssuedSyncTicket,
  type SyncAuthTicketStore,
  type SyncTicketIdentity,
} from './auth.js'
import type { SyncCommandLeaseRegistry, SyncCommandLeaseResult, SyncSocketBudget } from './registry.js'

export const DEFAULT_SYNC_REDIS_OPERATION_TIMEOUT_MS = 1_500
export const DEFAULT_SYNC_COMMAND_LEASE_TTL_MS = 30_000
export const DEFAULT_SYNC_SOCKET_LEASE_TTL_MS = 75_000
export const DEFAULT_SYNC_MAX_SOCKETS_PER_USER = 4

const SYNC_LEASE_RENEWAL_SAFETY_FACTOR = 4
const MIN_SYNC_LEASE_RENEW_INTERVAL_MS = 1_000

const TICKET_CONSUME_SCRIPT = `
-- SRN_SYNC_TICKET_GETDEL_V1
local value = redis.call('GET', KEYS[1])
if value then redis.call('DEL', KEYS[1]) end
return value
`

const COMMAND_LEASE_ACQUIRE_SCRIPT = `
-- SRN_SYNC_COMMAND_LEASE_ACQUIRE_V1
local current = redis.call('GET', KEYS[1])
if current then
  local first = string.find(current, '|', 1, true)
  local second = first and string.find(current, '|', first + 1, true) or nil
  if not first or not second then return 0 end
  local command = string.sub(current, first + 1, second - 1)
  local digest = string.sub(current, second + 1)
  if command == ARGV[2] and digest ~= ARGV[3] then return -1 end
  return 0
end
if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[4], 'NX') then return 1 end
return 0
`

const COMMAND_LEASE_RENEW_SCRIPT = `
-- SRN_SYNC_COMMAND_LEASE_RENEW_V1
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
`

const COMMAND_LEASE_RELEASE_SCRIPT = `
-- SRN_SYNC_COMMAND_LEASE_RELEASE_V1
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`

const SOCKET_BUDGET_ACQUIRE_SCRIPT = `
-- SRN_SYNC_SOCKET_BUDGET_ACQUIRE_V1
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local expires = now + tonumber(ARGV[2])
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], expires, ARGV[1])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], expires, ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`

const SOCKET_BUDGET_RENEW_SCRIPT = `
-- SRN_SYNC_SOCKET_BUDGET_RENEW_V1
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`

const SOCKET_BUDGET_RELEASE_SCRIPT = `
-- SRN_SYNC_SOCKET_BUDGET_RELEASE_V1
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[1]) end
return 1
`

export interface SyncRedisClient {
  readonly status: string
  set(key: string, value: string, mode: 'PX', ttlMs: number, condition: 'NX'): Promise<'OK' | null>
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>
}

export interface RedisSyncStateOptions {
  keyPrefix?: string
  operationTimeoutMs?: number
  commandLeaseTtlMs?: number
  socketLeaseTtlMs?: number
  maxSocketsPerUser?: number
}

interface NormalizedRedisSyncStateOptions {
  keyPrefix: string
  operationTimeoutMs: number
  commandLeaseTtlMs: number
  socketLeaseTtlMs: number
  maxSocketsPerUser: number
}

function positiveSafeInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid ${name}.`)
  }
  return value
}

function normalizeOptions(options: RedisSyncStateOptions = {}): NormalizedRedisSyncStateOptions {
  const keyPrefix = options.keyPrefix ?? 'srn:ws-sync:v1'
  if (!/^[A-Za-z0-9:_-]{1,128}$/u.test(keyPrefix)) {
    throw new Error('Invalid sync Redis key prefix.')
  }
  return {
    keyPrefix,
    operationTimeoutMs: positiveSafeInteger(
      options.operationTimeoutMs ?? DEFAULT_SYNC_REDIS_OPERATION_TIMEOUT_MS,
      'sync Redis operation timeout',
      30_000,
    ),
    commandLeaseTtlMs: positiveSafeInteger(
      options.commandLeaseTtlMs ?? DEFAULT_SYNC_COMMAND_LEASE_TTL_MS,
      'sync command lease TTL',
      300_000,
    ),
    socketLeaseTtlMs: positiveSafeInteger(
      options.socketLeaseTtlMs ?? DEFAULT_SYNC_SOCKET_LEASE_TTL_MS,
      'sync socket lease TTL',
      300_000,
    ),
    maxSocketsPerUser: positiveSafeInteger(
      options.maxSocketsPerUser ?? DEFAULT_SYNC_MAX_SOCKETS_PER_USER,
      'sync per-user socket limit',
      1_024,
    ),
  }
}

function abortError(): Error {
  const error = new Error('Sync Redis operation aborted.')
  error.name = 'AbortError'
  return error
}

async function boundedRedisOperation<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw abortError()
  }
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Sync Redis operation timed out.')), timeoutMs)
      timer.unref()
    })
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!signal) {
        return
      }
      onAbort = () => reject(abortError())
      signal.addEventListener('abort', onAbort, { once: true })
    })
    return await Promise.race([operation, timeout, aborted])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function ticketKey(prefix: string, ticket: string): string {
  return `${prefix}:ticket:${digest(ticket)}`
}

function ticketEncryptionKey(ticket: string, key: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(ticket, 'utf8'), Buffer.from('srn-ws-sync-ticket-v1'), Buffer.from(key, 'utf8'), 32),
  )
}

interface EncryptedTicketEnvelope {
  v: 1
  expiresAt: number
  iv: string
  ciphertext: string
  tag: string
}

function encryptTicketIdentity(ticket: string, key: string, identity: SyncTicketIdentity, expiresAt: number): string {
  const encryptionKey = ticketEncryptionKey(ticket, key)
  const plaintext = Buffer.from(JSON.stringify(identity), 'utf8')
  const iv = randomBytes(12)
  try {
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
    cipher.setAAD(Buffer.from(key, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const envelope: EncryptedTicketEnvelope = {
      v: 1,
      expiresAt,
      iv: iv.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    }
    ciphertext.fill(0)
    return JSON.stringify(envelope)
  } finally {
    plaintext.fill(0)
    encryptionKey.fill(0)
  }
}

function decryptTicketIdentity(ticket: string, key: string, raw: string, now: number): SyncTicketIdentity | undefined {
  const encryptionKey = ticketEncryptionKey(ticket, key)
  let plaintext: Buffer | undefined
  try {
    const parsed = JSON.parse(raw) as Partial<EncryptedTicketEnvelope>
    if (
      parsed.v !== 1 ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      Number(parsed.expiresAt) <= now ||
      typeof parsed.iv !== 'string' ||
      typeof parsed.ciphertext !== 'string' ||
      typeof parsed.tag !== 'string'
    ) {
      return undefined
    }
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(parsed.iv, 'base64url'))
    decipher.setAAD(Buffer.from(key, 'utf8'))
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64url'))
    plaintext = Buffer.concat([decipher.update(Buffer.from(parsed.ciphertext, 'base64url')), decipher.final()])
    const identity = JSON.parse(plaintext.toString('utf8')) as SyncTicketIdentity
    return isValidSyncTicketIdentity(identity) ? { ...identity } : undefined
  } catch {
    return undefined
  } finally {
    plaintext?.fill(0)
    encryptionKey.fill(0)
  }
}

export class RedisSyncAuthTicketStore implements SyncAuthTicketStore {
  readonly distribution = 'shared' as const
  private readonly options: NormalizedRedisSyncStateOptions

  constructor(
    private readonly client: SyncRedisClient,
    options: RedisSyncStateOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.options = normalizeOptions(options)
  }

  ready(): boolean {
    return this.client.status === 'ready'
  }

  async issue(identity: SyncTicketIdentity, ttlMs = DEFAULT_SYNC_TICKET_TTL_MS): Promise<IssuedSyncTicket> {
    if (!isValidSyncTicketIdentity(identity)) {
      throw new Error('Invalid sync ticket identity.')
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 120_000) {
      throw new Error('Invalid sync ticket TTL.')
    }
    if (!this.ready()) {
      throw new Error('Sync Redis ticket store is unavailable.')
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ticket = randomBytes(32).toString('base64url')
      const key = ticketKey(this.options.keyPrefix, ticket)
      const expiresAt = this.now() + ttlMs
      const stored = encryptTicketIdentity(ticket, key, identity, expiresAt)
      const result = await boundedRedisOperation(
        this.client.set(key, stored, 'PX', ttlMs, 'NX'),
        this.options.operationTimeoutMs,
      )
      if (result === 'OK') {
        return { ticket, expiresAt }
      }
    }
    throw new Error('Unable to reserve a unique sync authentication ticket.')
  }

  async consume(ticket: string, signal?: AbortSignal): Promise<SyncTicketIdentity | undefined> {
    if (typeof ticket !== 'string' || ticket.length < 32 || ticket.length > 256 || !this.ready()) {
      return undefined
    }
    const key = ticketKey(this.options.keyPrefix, ticket)
    const result = await boundedRedisOperation(
      this.client.eval(TICKET_CONSUME_SCRIPT, 1, key),
      this.options.operationTimeoutMs,
      signal,
    )
    const raw = typeof result === 'string' ? result : Buffer.isBuffer(result) ? result.toString('utf8') : undefined
    return raw === undefined ? undefined : decryptTicketIdentity(ticket, key, raw, this.now())
  }
}

type CommandLeaseInput = {
  userUuid: string
  deviceId: string
  commandId: string
  digest: string
  ownerId: string
}

function commandLeaseKey(prefix: string, input: Pick<CommandLeaseInput, 'userUuid' | 'deviceId'>): string {
  return `${prefix}:command-lease:${digest(`${input.userUuid}\u0000${input.deviceId}`)}`
}

function commandLeaseValue(input: CommandLeaseInput): string {
  if (!/^[a-f0-9]{64}$/u.test(input.digest)) {
    throw new Error('Invalid sync command lease digest.')
  }
  return `${leasePart(input.ownerId)}|${leasePart(input.commandId)}|${input.digest}`
}

function leasePart(value: string): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 1 || Buffer.byteLength(value, 'utf8') > 256) {
    throw new Error('Invalid sync command lease identifier.')
  }
  return Buffer.from(value, 'utf8').toString('base64url')
}

export class RedisSyncCommandLeaseRegistry implements SyncCommandLeaseRegistry {
  readonly distribution = 'shared' as const
  private readonly options: NormalizedRedisSyncStateOptions

  constructor(
    private readonly client: SyncRedisClient,
    options: RedisSyncStateOptions = {},
  ) {
    this.options = normalizeOptions(options)
  }

  ready(): boolean {
    return this.client.status === 'ready'
  }

  async acquire(input: CommandLeaseInput, signal?: AbortSignal): Promise<SyncCommandLeaseResult> {
    if (!this.ready()) {
      throw new Error('Sync Redis command lease registry is unavailable.')
    }
    const result = await boundedRedisOperation(
      this.client.eval(
        COMMAND_LEASE_ACQUIRE_SCRIPT,
        1,
        commandLeaseKey(this.options.keyPrefix, input),
        commandLeaseValue(input),
        leasePart(input.commandId),
        input.digest,
        this.options.commandLeaseTtlMs,
      ),
      this.options.operationTimeoutMs,
      signal,
    )
    if (Number(result) === 1) {
      return { acquired: true }
    }
    return Number(result) === -1
      ? { acquired: false, reason: 'COMMAND_ID_CONFLICT' }
      : { acquired: false, reason: 'BUSY' }
  }

  async renew(input: CommandLeaseInput, signal?: AbortSignal): Promise<boolean> {
    if (!this.ready()) {
      return false
    }
    const result = await boundedRedisOperation(
      this.client.eval(
        COMMAND_LEASE_RENEW_SCRIPT,
        1,
        commandLeaseKey(this.options.keyPrefix, input),
        commandLeaseValue(input),
        this.options.commandLeaseTtlMs,
      ),
      this.options.operationTimeoutMs,
      signal,
    )
    return Number(result) === 1
  }

  async release(input: CommandLeaseInput, signal?: AbortSignal): Promise<void> {
    if (!this.ready()) {
      return
    }
    await boundedRedisOperation(
      this.client.eval(
        COMMAND_LEASE_RELEASE_SCRIPT,
        1,
        commandLeaseKey(this.options.keyPrefix, input),
        commandLeaseValue(input),
      ),
      this.options.operationTimeoutMs,
      signal,
    )
  }
}

function socketBudgetKey(prefix: string, userUuid: string): string {
  return `${prefix}:socket-budget:${digest(userUuid)}`
}

function socketOwner(ownerId: string): string {
  return digest(ownerId)
}

export class RedisSyncSocketBudget implements SyncSocketBudget {
  readonly distribution = 'shared' as const
  private readonly options: NormalizedRedisSyncStateOptions

  constructor(
    private readonly client: SyncRedisClient,
    options: RedisSyncStateOptions = {},
  ) {
    this.options = normalizeOptions(options)
  }

  ready(): boolean {
    return this.client.status === 'ready'
  }

  async acquire(input: { userUuid: string; ownerId: string }, signal?: AbortSignal): Promise<boolean> {
    if (!this.ready()) {
      return false
    }
    const result = await boundedRedisOperation(
      this.client.eval(
        SOCKET_BUDGET_ACQUIRE_SCRIPT,
        1,
        socketBudgetKey(this.options.keyPrefix, input.userUuid),
        socketOwner(input.ownerId),
        this.options.socketLeaseTtlMs,
        this.options.maxSocketsPerUser,
      ),
      this.options.operationTimeoutMs,
      signal,
    )
    return Number(result) === 1
  }

  async renew(input: { userUuid: string; ownerId: string }, signal?: AbortSignal): Promise<boolean> {
    if (!this.ready()) {
      return false
    }
    const result = await boundedRedisOperation(
      this.client.eval(
        SOCKET_BUDGET_RENEW_SCRIPT,
        1,
        socketBudgetKey(this.options.keyPrefix, input.userUuid),
        socketOwner(input.ownerId),
        this.options.socketLeaseTtlMs,
      ),
      this.options.operationTimeoutMs,
      signal,
    )
    return Number(result) === 1
  }

  async release(input: { userUuid: string; ownerId: string }, signal?: AbortSignal): Promise<void> {
    if (!this.ready()) {
      return
    }
    await boundedRedisOperation(
      this.client.eval(
        SOCKET_BUDGET_RELEASE_SCRIPT,
        1,
        socketBudgetKey(this.options.keyPrefix, input.userUuid),
        socketOwner(input.ownerId),
      ),
      this.options.operationTimeoutMs,
      signal,
    )
  }
}

export interface RedisSyncState {
  tickets: RedisSyncAuthTicketStore
  leases: RedisSyncCommandLeaseRegistry
  socketBudget: RedisSyncSocketBudget
  leaseRenewIntervalMs: number
  socketBudgetRenewIntervalMs: number
}

function deriveLeaseRenewIntervalMs(ttlMs: number, operationTimeoutMs: number, name: string): number {
  const minimumTtlMs = Math.max(
    operationTimeoutMs * SYNC_LEASE_RENEWAL_SAFETY_FACTOR,
    MIN_SYNC_LEASE_RENEW_INTERVAL_MS * SYNC_LEASE_RENEWAL_SAFETY_FACTOR,
  )
  if (ttlMs < minimumTtlMs) {
    throw new Error(
      `Invalid ${name}: must be at least ${minimumTtlMs} ms (${SYNC_LEASE_RENEWAL_SAFETY_FACTOR}x the sync Redis operation timeout and a ${MIN_SYNC_LEASE_RENEW_INTERVAL_MS} ms renewal floor).`,
    )
  }

  return Math.floor(ttlMs / SYNC_LEASE_RENEWAL_SAFETY_FACTOR)
}

/**
 * Build the fleet-shared sync primitives and their safe renewal cadence over a
 * bootstrap-owned Redis client. A renewal starts after one quarter of its lease
 * TTL, reserving the other quarters for the previous Redis response, the next
 * bounded Redis operation, and expiry margin. The absolute renewal floor also
 * prevents operator configuration from creating a hot timer loop.
 */
export function createRedisSyncState(client: SyncRedisClient, options: RedisSyncStateOptions = {}): RedisSyncState {
  const normalizedOptions = normalizeOptions(options)
  return {
    tickets: new RedisSyncAuthTicketStore(client, normalizedOptions),
    leases: new RedisSyncCommandLeaseRegistry(client, normalizedOptions),
    socketBudget: new RedisSyncSocketBudget(client, normalizedOptions),
    leaseRenewIntervalMs: deriveLeaseRenewIntervalMs(
      normalizedOptions.commandLeaseTtlMs,
      normalizedOptions.operationTimeoutMs,
      'sync command lease TTL',
    ),
    socketBudgetRenewIntervalMs: deriveLeaseRenewIntervalMs(
      normalizedOptions.socketLeaseTtlMs,
      normalizedOptions.operationTimeoutMs,
      'sync socket lease TTL',
    ),
  }
}
