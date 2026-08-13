import { randomUUID } from 'crypto'

import {
  EMAIL_QUEUE_DEFAULT_MAX_JOB_BYTES,
  EMAIL_QUEUE_DEFAULT_MAX_TOTAL_BYTES,
  EmailQueueCipher,
  confirmEmailQueueAofPersistence,
  emailQueueCompatibleKeyPrefix,
  emailQueueRedisKeys,
  emailQueueSupersessionIdentity,
  validateEmailQueueProducerLimits,
} from '@standardnotes/domain-core'

import {
  ClaimedEmail,
  EmailAttemptLog,
  EmailAttemptLogStore,
  EmailAttemptLogView,
  EmailDeliveryQueue,
  Page,
  QueueDiscardResult,
  QueuedEmail,
  QueueItemView,
  QueueSettlementResult,
  QueueState,
  validateEmailMessage,
} from './Types'

export interface EmailQueueRedis {
  eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>
  zrange(key: string, start: number, stop: number, withScores?: 'WITHSCORES'): Promise<string[]>
  zrevrange(key: string, start: number, stop: number, withScores?: 'WITHSCORES'): Promise<string[]>
  hmget(key: string, ...fields: string[]): Promise<Array<string | null>>
  hget(key: string, field: string): Promise<string | null>
  zscore(key: string, member: string): Promise<string | null>
  waitaof?(localAofFiles: number, replicaAofFiles: number, timeoutMs: number): Promise<unknown>
  call?(command: string, ...args: Array<string | number>): Promise<unknown>
  nodes?(): unknown[]
}

export interface RedisEmailDeliveryQueueOptions {
  keyPrefix?: string
  leaseMs?: number
  retentionMs?: number
  deadLetterRetentionMs?: number
  clock?: () => number
  randomId?: () => string
  /** Existing stable 64-hex server encryption key; queue payloads fail closed without it. */
  encryptionKey?: string
  maxJobBytes?: number
  maxTotalBytes?: number
  maxAttempts?: number
}

const DEFAULT_LEASE_MS = 2 * 60 * 1_000
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
const DEFAULT_DEAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
const MAX_PAGE_SIZE = 100

const ENQUEUE_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
  return 0
end
local payload_bytes = string.len(ARGV[2])
if payload_bytes > tonumber(ARGV[5]) then
  return -1
end
local total_bytes = tonumber(redis.call('GET', KEYS[7]) or '0')
if total_bytes < 0 then total_bytes = 0; redis.call('SET', KEYS[7], 0) end
local previous_id = false
local previous_payload_bytes = 0
if ARGV[7] ~= '' then
  previous_id = redis.call('HGET', KEYS[8], ARGV[7])
  if previous_id and previous_id ~= ARGV[1] and not redis.call('ZSCORE', KEYS[3], previous_id) then
    previous_payload_bytes = redis.call('HSTRLEN', KEYS[1], previous_id)
  end
end
local projected_total = total_bytes - previous_payload_bytes + payload_bytes
if projected_total > tonumber(ARGV[6]) then return -2 end
if previous_id and previous_id ~= ARGV[1] and previous_payload_bytes > 0 then
    redis.call('HDEL', KEYS[1], previous_id)
    redis.call('ZREM', KEYS[2], previous_id)
    redis.call('ZREM', KEYS[4], previous_id)
    redis.call('ZREM', KEYS[5], previous_id)
    redis.call('HDEL', KEYS[6], previous_id)
    redis.call('HDEL', KEYS[9], previous_id)
    local previous_record = redis.call('HGET', KEYS[10], previous_id)
    if previous_record then
      local separator = string.find(previous_record, ':', 1, true)
      local fingerprint = separator and string.sub(previous_record, separator + 1) or ''
      redis.call('HSET', KEYS[10], previous_id, 'x:' .. fingerprint)
      redis.call('ZADD', KEYS[11], ARGV[8], previous_id)
    end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
if tonumber(ARGV[4]) > 0 then
  redis.call('ZADD', KEYS[5], ARGV[4], ARGV[1])
  redis.call('ZADD', KEYS[11], ARGV[4], ARGV[1])
else
  redis.call('ZREM', KEYS[5], ARGV[1])
  redis.call('ZREM', KEYS[11], ARGV[1])
end
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('HDEL', KEYS[6], ARGV[1])
redis.call('SET', KEYS[7], projected_total)
if ARGV[7] ~= '' then
  redis.call('HSET', KEYS[8], ARGV[7], ARGV[1])
  redis.call('HSET', KEYS[9], ARGV[1], ARGV[7])
end
return 1
`

const CLAIM_SCRIPT = `
local removed_bytes = 0
local mutated = 0
local function record_bytes(id)
  local record = redis.call('HGET', KEYS[10], id)
  if not record then return 0 end
  return string.len(id) + string.len(record) + 128
end
local function purge(id)
  local removed = redis.call('HSTRLEN', KEYS[1], id) + record_bytes(id)
  local supersession_key = redis.call('HGET', KEYS[9], id)
  if supersession_key and redis.call('HGET', KEYS[8], supersession_key) == id then
    redis.call('HDEL', KEYS[8], supersession_key)
  end
  redis.call('HDEL', KEYS[9], id)
  redis.call('HDEL', KEYS[10], id)
  redis.call('HDEL', KEYS[1], id)
  redis.call('ZREM', KEYS[2], id)
  redis.call('ZREM', KEYS[3], id)
  redis.call('ZREM', KEYS[4], id)
  redis.call('ZREM', KEYS[5], id)
  redis.call('ZREM', KEYS[11], id)
  redis.call('HDEL', KEYS[6], id)
  return removed
end
local function apply_removed_bytes()
  if removed_bytes <= 0 then return end
  local total_bytes = tonumber(redis.call('GET', KEYS[7]) or '0') - removed_bytes
  if total_bytes < 0 then total_bytes = 0 end
  redis.call('SET', KEYS[7], total_bytes)
  removed_bytes = 0
end
local expired_idempotency = redis.call('ZRANGEBYSCORE', KEYS[11], '-inf', ARGV[1], 'LIMIT', 0, 500)
for _, id in ipairs(expired_idempotency) do
  -- An active record is owned by its payload until the per-job expiry purge.
  if redis.call('HEXISTS', KEYS[1], id) == 0 then
    removed_bytes = removed_bytes + record_bytes(id)
    redis.call('HDEL', KEYS[10], id)
    redis.call('ZREM', KEYS[11], id)
    mutated = 1
  end
end
local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', ARGV[1], 'LIMIT', 0, 100)
for _, id in ipairs(expired) do
  if redis.call('HEXISTS', KEYS[1], id) == 1 then
    redis.call('ZADD', KEYS[2], ARGV[1], id)
  end
  redis.call('ZREM', KEYS[3], id)
  redis.call('HDEL', KEYS[6], id)
  mutated = 1
end

local stale = redis.call('ZRANGEBYSCORE', KEYS[5], '-inf', ARGV[1], 'LIMIT', 0, 200)
for _, id in ipairs(stale) do
  removed_bytes = removed_bytes + purge(id)
  mutated = 1
end

local candidates = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', 0, 100)
for _, id in ipairs(candidates) do
  local expires_at = redis.call('ZSCORE', KEYS[5], id)
  if expires_at and tonumber(expires_at) <= tonumber(ARGV[1]) then
    removed_bytes = removed_bytes + purge(id)
    mutated = 1
  else
    local payload = redis.call('HGET', KEYS[1], id)
    if not payload then
      removed_bytes = removed_bytes + purge(id)
      mutated = 1
    else
    local supersession_key = redis.call('HGET', KEYS[9], id)
    if supersession_key and redis.call('HGET', KEYS[8], supersession_key) ~= id then
      local payload_bytes = string.len(payload)
      redis.call('HDEL', KEYS[1], id)
      redis.call('ZREM', KEYS[3], id)
      redis.call('ZREM', KEYS[4], id)
      redis.call('ZREM', KEYS[5], id)
      redis.call('HDEL', KEYS[6], id)
      redis.call('HDEL', KEYS[9], id)
      local record = redis.call('HGET', KEYS[10], id)
      if record then
        local separator = string.find(record, ':', 1, true)
        local fingerprint = separator and string.sub(record, separator + 1) or ''
        redis.call('HSET', KEYS[10], id, 'x:' .. fingerprint)
        redis.call('ZADD', KEYS[11], ARGV[4], id)
      end
      removed_bytes = removed_bytes + payload_bytes
      mutated = 1
    else
      redis.call('ZREM', KEYS[2], id)
      redis.call('ZADD', KEYS[3], ARGV[2], id)
      redis.call('HSET', KEYS[6], id, ARGV[3])
      apply_removed_bytes()
      return { id, payload, 1 }
    end
    end
  end
end
apply_removed_bytes()
return { mutated }
`

const RENEW_LEASE_SCRIPT = `
if redis.call('HGET', KEYS[6], ARGV[1]) ~= ARGV[2] or not redis.call('ZSCORE', KEYS[3], ARGV[1]) then
  return 0
end
local supersession_key = redis.call('HGET', KEYS[9], ARGV[1])
if supersession_key and redis.call('HGET', KEYS[8], supersession_key) ~= ARGV[1] then
  local payload_bytes = redis.call('HSTRLEN', KEYS[1], ARGV[1])
  redis.call('HDEL', KEYS[1], ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('ZREM', KEYS[3], ARGV[1])
  redis.call('ZREM', KEYS[4], ARGV[1])
  redis.call('ZREM', KEYS[5], ARGV[1])
  redis.call('HDEL', KEYS[6], ARGV[1])
  redis.call('HDEL', KEYS[9], ARGV[1])
  local record = redis.call('HGET', KEYS[10], ARGV[1])
  if record then
    local separator = string.find(record, ':', 1, true)
    local fingerprint = separator and string.sub(record, separator + 1) or ''
    redis.call('HSET', KEYS[10], ARGV[1], 'x:' .. fingerprint)
    redis.call('ZADD', KEYS[11], ARGV[4], ARGV[1])
  end
  local total_bytes = tonumber(redis.call('GET', KEYS[7]) or '0') - payload_bytes
  if total_bytes < 0 then total_bytes = 0 end
  redis.call('SET', KEYS[7], total_bytes)
  return 2
end
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
return 1
`

const SETTLE_SCRIPT = `
if redis.call('HGET', KEYS[6], ARGV[1]) ~= ARGV[2] or not redis.call('ZSCORE', KEYS[3], ARGV[1]) then
  return 0
end
local supersession_key = redis.call('HGET', KEYS[9], ARGV[1])
if supersession_key and redis.call('HGET', KEYS[8], supersession_key) ~= ARGV[1] then
  local payload_bytes = redis.call('HSTRLEN', KEYS[1], ARGV[1])
  redis.call('HDEL', KEYS[1], ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('ZREM', KEYS[3], ARGV[1])
  redis.call('ZREM', KEYS[4], ARGV[1])
  redis.call('ZREM', KEYS[5], ARGV[1])
  redis.call('HDEL', KEYS[6], ARGV[1])
  redis.call('HDEL', KEYS[9], ARGV[1])
  local record = redis.call('HGET', KEYS[10], ARGV[1])
  if record then
    local separator = string.find(record, ':', 1, true)
    local fingerprint = separator and string.sub(record, separator + 1) or ''
    redis.call('HSET', KEYS[10], ARGV[1], 'x:' .. fingerprint)
    redis.call('ZADD', KEYS[11], ARGV[10], ARGV[1])
  end
  local remaining_bytes = tonumber(redis.call('GET', KEYS[7]) or '0') - payload_bytes
  if remaining_bytes < 0 then remaining_bytes = 0 end
  redis.call('SET', KEYS[7], remaining_bytes)
  return 3
end
local old_bytes = redis.call('HSTRLEN', KEYS[1], ARGV[1])
local total_bytes = tonumber(redis.call('GET', KEYS[7]) or '0')
if total_bytes < 0 then total_bytes = 0 end
local next_total = total_bytes - old_bytes
if next_total < 0 then next_total = 0 end
if ARGV[3] ~= 'ack' then
  local new_bytes = string.len(ARGV[4])
  if new_bytes > tonumber(ARGV[7]) then
    redis.call('ZREM', KEYS[2], ARGV[1])
    redis.call('ZREM', KEYS[3], ARGV[1])
    redis.call('ZADD', KEYS[4], ARGV[9], ARGV[1])
    redis.call('ZADD', KEYS[5], ARGV[10], ARGV[1])
    redis.call('ZADD', KEYS[11], ARGV[10], ARGV[1])
    redis.call('HDEL', KEYS[6], ARGV[1])
    local record = redis.call('HGET', KEYS[10], ARGV[1])
    if record then
      local separator = string.find(record, ':', 1, true)
      local fingerprint = separator and string.sub(record, separator + 1) or ''
      redis.call('HSET', KEYS[10], ARGV[1], 'q:' .. fingerprint)
    end
    return 2
  end
  next_total = next_total + new_bytes
  if next_total > tonumber(ARGV[8]) then
    redis.call('ZREM', KEYS[2], ARGV[1])
    redis.call('ZREM', KEYS[3], ARGV[1])
    redis.call('ZADD', KEYS[4], ARGV[9], ARGV[1])
    redis.call('ZADD', KEYS[5], ARGV[10], ARGV[1])
    redis.call('ZADD', KEYS[11], ARGV[10], ARGV[1])
    redis.call('HDEL', KEYS[6], ARGV[1])
    local record = redis.call('HGET', KEYS[10], ARGV[1])
    if record then
      local separator = string.find(record, ':', 1, true)
      local fingerprint = separator and string.sub(record, separator + 1) or ''
      redis.call('HSET', KEYS[10], ARGV[1], 'q:' .. fingerprint)
    end
    return 2
  end
end
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('HDEL', KEYS[6], ARGV[1])
if ARGV[3] == 'ack' then
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('ZREM', KEYS[4], ARGV[1])
  redis.call('ZREM', KEYS[5], ARGV[1])
  redis.call('HDEL', KEYS[1], ARGV[1])
  if supersession_key and redis.call('HGET', KEYS[8], supersession_key) == ARGV[1] then
    redis.call('HDEL', KEYS[8], supersession_key)
  end
  redis.call('HDEL', KEYS[9], ARGV[1])
  local record = redis.call('HGET', KEYS[10], ARGV[1])
  if record then
    local separator = string.find(record, ':', 1, true)
    local fingerprint = separator and string.sub(record, separator + 1) or ''
    redis.call('HSET', KEYS[10], ARGV[1], 's:' .. fingerprint)
    redis.call('ZADD', KEYS[11], ARGV[10], ARGV[1])
  end
elseif ARGV[3] == 'retry' then
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[4])
  redis.call('ZADD', KEYS[2], ARGV[5], ARGV[1])
  if tonumber(ARGV[6]) > 0 then
    redis.call('ZADD', KEYS[5], ARGV[6], ARGV[1])
  else
    redis.call('ZREM', KEYS[5], ARGV[1])
  end
  redis.call('ZREM', KEYS[4], ARGV[1])
  if tonumber(ARGV[6]) > 0 then
    redis.call('ZADD', KEYS[11], ARGV[6], ARGV[1])
  else
    redis.call('ZREM', KEYS[11], ARGV[1])
  end
else
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[4])
  redis.call('ZADD', KEYS[4], ARGV[5], ARGV[1])
  redis.call('ZADD', KEYS[5], ARGV[6], ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  redis.call('ZADD', KEYS[11], ARGV[6], ARGV[1])
  local record = redis.call('HGET', KEYS[10], ARGV[1])
  if record then
    local separator = string.find(record, ':', 1, true)
    local fingerprint = separator and string.sub(record, separator + 1) or ''
    redis.call('HSET', KEYS[10], ARGV[1], 'f:' .. fingerprint)
  end
end
redis.call('SET', KEYS[7], next_total)
return 1
`

const QUARANTINE_CLAIM_SCRIPT = `
if redis.call('HGET', KEYS[6], ARGV[1]) ~= ARGV[2] or not redis.call('ZSCORE', KEYS[3], ARGV[1]) then
  return 0
end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('HDEL', KEYS[6], ARGV[1])
-- Keep the exact encrypted-at-rest value in the jobs hash for
-- incident recovery. Only its redacted dead-letter projection is exposed.
redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1])
if tonumber(ARGV[4]) > 0 then
  redis.call('ZADD', KEYS[5], ARGV[4], ARGV[1])
else
  redis.call('ZREM', KEYS[5], ARGV[1])
end
redis.call('ZADD', KEYS[11], ARGV[4], ARGV[1])
local record = redis.call('HGET', KEYS[10], ARGV[1])
if record then
  local separator = string.find(record, ':', 1, true)
  local fingerprint = separator and string.sub(record, separator + 1) or ''
  redis.call('HSET', KEYS[10], ARGV[1], 'q:' .. fingerprint)
end
return 1
`

const MAINTENANCE_SCRIPT = `
local removed_bytes = 0
local removed_idempotency = 0
local function record_bytes(id)
  local record = redis.call('HGET', KEYS[10], id)
  if not record then return 0 end
  return string.len(id) + string.len(record) + 128
end
local function purge(id)
  local removed = redis.call('HSTRLEN', KEYS[1], id) + record_bytes(id)
  local supersession_key = redis.call('HGET', KEYS[9], id)
  if supersession_key and redis.call('HGET', KEYS[8], supersession_key) == id then
    redis.call('HDEL', KEYS[8], supersession_key)
  end
  redis.call('HDEL', KEYS[9], id)
  redis.call('HDEL', KEYS[10], id)
  redis.call('HDEL', KEYS[1], id)
  redis.call('ZREM', KEYS[2], id)
  redis.call('ZREM', KEYS[3], id)
  redis.call('ZREM', KEYS[4], id)
  redis.call('ZREM', KEYS[5], id)
  redis.call('ZREM', KEYS[11], id)
  redis.call('HDEL', KEYS[6], id)
  return removed
end
local expired_idempotency = redis.call('ZRANGEBYSCORE', KEYS[11], '-inf', ARGV[1], 'LIMIT', 0, 500)
for _, id in ipairs(expired_idempotency) do
  if redis.call('HEXISTS', KEYS[1], id) == 0 then
    removed_bytes = removed_bytes + record_bytes(id)
    redis.call('HDEL', KEYS[10], id)
    redis.call('ZREM', KEYS[11], id)
    removed_idempotency = removed_idempotency + 1
  end
end
local expired = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', ARGV[1], 'LIMIT', 0, 100)
for _, id in ipairs(expired) do
  if redis.call('HEXISTS', KEYS[1], id) == 1 then redis.call('ZADD', KEYS[2], ARGV[1], id) end
  redis.call('ZREM', KEYS[3], id)
  redis.call('HDEL', KEYS[6], id)
end
local stale = redis.call('ZRANGEBYSCORE', KEYS[5], '-inf', ARGV[1], 'LIMIT', 0, 500)
for _, id in ipairs(stale) do
  removed_bytes = removed_bytes + purge(id)
end
if removed_bytes > 0 then
  local total_bytes = tonumber(redis.call('GET', KEYS[7]) or '0') - removed_bytes
  if total_bytes < 0 then total_bytes = 0 end
  redis.call('SET', KEYS[7], total_bytes)
end
return { #stale, #expired, removed_idempotency }
`

const REQUEUE_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 or redis.call('ZSCORE', KEYS[3], ARGV[1]) then
  return 0
end
local supersession_key = redis.call('HGET', KEYS[9], ARGV[1])
if supersession_key and redis.call('HGET', KEYS[8], supersession_key) ~= ARGV[1] then
  return -3
end
local old_bytes = redis.call('HSTRLEN', KEYS[1], ARGV[1])
local new_bytes = string.len(ARGV[2])
if new_bytes > tonumber(ARGV[5]) then return -1 end
local total_bytes = tonumber(redis.call('GET', KEYS[7]) or '0') - old_bytes
if total_bytes < 0 then total_bytes = 0 end
local next_total = total_bytes + new_bytes
if next_total > tonumber(ARGV[6]) then return -2 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
if tonumber(ARGV[4]) > 0 then
  redis.call('ZADD', KEYS[5], ARGV[4], ARGV[1])
  redis.call('ZADD', KEYS[11], ARGV[4], ARGV[1])
else
  redis.call('ZREM', KEYS[5], ARGV[1])
  redis.call('ZREM', KEYS[11], ARGV[1])
end
redis.call('HDEL', KEYS[6], ARGV[1])
local record = redis.call('HGET', KEYS[10], ARGV[1])
if record then
  local separator = string.find(record, ':', 1, true)
  local fingerprint = separator and string.sub(record, separator + 1) or ''
  redis.call('HSET', KEYS[10], ARGV[1], 'a:' .. fingerprint)
end
redis.call('SET', KEYS[7], next_total)
return 1
`

const DISCARD_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then
  return 0
end
if redis.call('ZSCORE', KEYS[3], ARGV[1]) then
  return -1
end
local payload_bytes = redis.call('HSTRLEN', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('ZREM', KEYS[5], ARGV[1])
redis.call('HDEL', KEYS[6], ARGV[1])
local supersession_key = redis.call('HGET', KEYS[9], ARGV[1])
if supersession_key and redis.call('HGET', KEYS[8], supersession_key) == ARGV[1] then
  redis.call('HDEL', KEYS[8], supersession_key)
end
redis.call('HDEL', KEYS[9], ARGV[1])
local record = redis.call('HGET', KEYS[10], ARGV[1])
if record then
  local separator = string.find(record, ':', 1, true)
  local fingerprint = separator and string.sub(record, separator + 1) or ''
  redis.call('HSET', KEYS[10], ARGV[1], 'd:' .. fingerprint)
  redis.call('ZADD', KEYS[11], ARGV[2], ARGV[1])
end
if payload_bytes > 0 then
  local total_bytes = tonumber(redis.call('GET', KEYS[7]) or '0') - payload_bytes
  if total_bytes < 0 then total_bytes = 0 end
  redis.call('SET', KEYS[7], total_bytes)
end
return 1
`

export class RedisEmailDeliveryQueue implements EmailDeliveryQueue {
  private readonly keys: [string, string, string, string, string, string, string, string, string, string, string]
  private readonly leaseMs: number
  private readonly retentionMs: number
  private readonly deadLetterRetentionMs: number
  private readonly clock: () => number
  private readonly randomId: () => string
  private readonly cipher: EmailQueueCipher
  private readonly maxJobBytes: number
  private readonly maxTotalBytes: number
  private readonly encryptionKey: string
  private readonly canConfirmDurability: boolean

  constructor(
    private readonly redis: EmailQueueRedis,
    options: RedisEmailDeliveryQueueOptions = {},
  ) {
    // The hash tag keeps every Lua key in one Redis Cluster slot.
    this.encryptionKey = options.encryptionKey ?? ''
    this.canConfirmDurability = typeof redis.waitaof === 'function' || typeof redis.call === 'function'
    const compatibilityLimits = validateEmailQueueProducerLimits(options)
    const prefix = emailQueueCompatibleKeyPrefix(this.encryptionKey, options.keyPrefix, compatibilityLimits)
    const keys = emailQueueRedisKeys(prefix)
    this.keys = [
      keys.jobs,
      keys.ready,
      keys.leased,
      keys.dead,
      keys.expiry,
      keys.claims,
      keys.bytes,
      keys.supersessions,
      keys.jobSupersessions,
      keys.idempotency,
      keys.idempotencyExpiry,
    ]
    this.leaseMs = positiveInteger(options.leaseMs, DEFAULT_LEASE_MS, 60 * 60 * 1_000)
    this.retentionMs = positiveInteger(options.retentionMs, DEFAULT_RETENTION_MS, 90 * 24 * 60 * 60 * 1_000)
    this.deadLetterRetentionMs = positiveInteger(
      options.deadLetterRetentionMs,
      DEFAULT_DEAD_RETENTION_MS,
      90 * 24 * 60 * 60 * 1_000,
    )
    this.clock = options.clock ?? (() => Date.now())
    this.randomId = options.randomId ?? (() => randomUUID())
    this.cipher = new EmailQueueCipher(this.encryptionKey)
    this.maxJobBytes = positiveInteger(options.maxJobBytes, EMAIL_QUEUE_DEFAULT_MAX_JOB_BYTES, 1024 * 1024 * 1024)
    this.maxTotalBytes = positiveInteger(
      options.maxTotalBytes,
      EMAIL_QUEUE_DEFAULT_MAX_TOTAL_BYTES,
      10 * 1024 * 1024 * 1024,
    )
    if (this.maxTotalBytes < this.maxJobBytes) {
      throw new Error('Email delivery total storage budget must be at least the per-job limit.')
    }
  }

  async enqueue(job: QueuedEmail): Promise<void> {
    assertQueuedEmail(job)
    const encryptedJob = this.encryptJob(job)
    await confirmEmailQueueAofPersistence(this.redis)
    const stored = await this.redis.eval(
      ENQUEUE_SCRIPT,
      this.keys.length,
      ...this.keys,
      job.id,
      encryptedJob,
      job.nextAttemptAt,
      job.retryMode === 'indefinite' ? 0 : Math.max(job.createdAt, job.nextAttemptAt) + this.retentionMs,
      this.maxJobBytes,
      this.maxTotalBytes,
      job.supersessionKey ? emailQueueSupersessionIdentity(this.encryptionKey, job.supersessionKey) : '',
      this.clock() + this.deadLetterRetentionMs,
    )
    if (Number(stored) === 0) {
      throw new Error('An email delivery job with this id already exists.')
    }
    this.assertStorageMutation(stored, 'enqueue')
    await confirmEmailQueueAofPersistence(this.redis)
  }

  async claim(): Promise<ClaimedEmail | null> {
    await confirmEmailQueueAofPersistence(this.redis)
    const now = this.clock()
    const token = this.randomId()
    const result = await this.redis.eval(
      CLAIM_SCRIPT,
      this.keys.length,
      ...this.keys,
      now,
      now + this.leaseMs,
      token,
      now + this.deadLetterRetentionMs,
    )
    const values = arrayResult(result)
    if (values.length === 0) {
      return null
    }
    if (values.length === 1) {
      const maintenanceChanged = Number(values[0])
      if (![0, 1].includes(maintenanceChanged)) {
        throw new Error('The email delivery queue returned an invalid claim result.')
      }
      if (maintenanceChanged === 1) {
        await confirmEmailQueueAofPersistence(this.redis)
      }
      return null
    }
    if (values.length < 2) {
      throw new Error('The email delivery queue returned an invalid claim result.')
    }
    await confirmEmailQueueAofPersistence(this.redis)
    const id = String(values[0])
    try {
      const job = this.decryptJob(String(values[1]))
      if (job.id !== id) {
        throw new Error('Email delivery queue data is inconsistent.')
      }

      return { job, token, leaseExpiresAt: now + this.leaseMs }
    } catch {
      await this.quarantineClaimedPayload(id, token, now)
      throw new Error('Email delivery queue payload was quarantined after authentication or validation failed.')
    }
  }

  async renewLease(claim: ClaimedEmail): Promise<boolean> {
    if (!this.canConfirmDurability) {
      return false
    }
    await confirmEmailQueueAofPersistence(this.redis)
    const leaseExpiresAt = this.clock() + this.leaseMs
    const renewed = await this.redis.eval(
      RENEW_LEASE_SCRIPT,
      this.keys.length,
      ...this.keys,
      claim.job.id,
      claim.token,
      leaseExpiresAt,
      this.clock() + this.deadLetterRetentionMs,
    )
    if (Number(renewed) === 1) {
      await confirmEmailQueueAofPersistence(this.redis)
      claim.leaseExpiresAt = leaseExpiresAt
      return true
    }
    if (Number(renewed) === 2) {
      await confirmEmailQueueAofPersistence(this.redis)
      return false
    }
    if (Number(renewed) === 0) {
      return false
    }
    throw new Error('The email delivery queue returned an invalid lease renewal result.')
  }

  async acknowledge(claim: ClaimedEmail): Promise<QueueSettlementResult> {
    return this.settle('ack', claim)
  }

  async retry(claim: ClaimedEmail, job: QueuedEmail): Promise<QueueSettlementResult> {
    assertSameJob(claim, job)
    assertQueuedEmail(job)
    const expiresAt = job.retryMode === 'indefinite' ? 0 : Math.max(this.clock(), job.nextAttemptAt) + this.retentionMs
    return this.settle('retry', claim, job, job.nextAttemptAt, expiresAt)
  }

  async deadLetter(claim: ClaimedEmail, job: QueuedEmail): Promise<QueueSettlementResult> {
    assertSameJob(claim, job)
    assertQueuedEmail(job)
    const deadAt = job.deadAt ?? this.clock()
    return this.settle('dead', claim, { ...job, deadAt }, deadAt, deadAt + this.deadLetterRetentionMs)
  }

  async list(state: QueueState, limit = 50, cursor?: string): Promise<Page<QueueItemView>> {
    const boundedLimit = pageSize(limit)
    const offset = decodeCursor(cursor)
    await confirmEmailQueueAofPersistence(this.redis)
    const maintenanceResult = arrayResult(
      await this.redis.eval(MAINTENANCE_SCRIPT, this.keys.length, ...this.keys, this.clock()),
    )
    if (maintenanceResult.length > 0) {
      const counts = maintenanceResult.map(Number)
      if (counts.length !== 3 || counts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
        throw new Error('The email delivery queue returned an invalid maintenance result.')
      }
      if (counts.some((value) => value > 0)) {
        await confirmEmailQueueAofPersistence(this.redis)
      }
    }
    const key = this.stateKey(state)
    const raw =
      state === 'dead'
        ? await this.redis.zrevrange(key, offset, offset + boundedLimit, 'WITHSCORES')
        : await this.redis.zrange(key, offset, offset + boundedLimit, 'WITHSCORES')
    const pairs = scoredMembers(raw)
    const visible = pairs.slice(0, boundedLimit)
    const payloads = visible.length > 0 ? await this.redis.hmget(this.keys[0], ...visible.map(({ id }) => id)) : []
    const items: QueueItemView[] = []
    for (let index = 0; index < visible.length; index++) {
      const payload = payloads[index]
      if (!payload) {
        continue
      }
      try {
        const job = this.decryptJob(payload)
        items.push(toQueueView(job, state, visible[index].score))
      } catch {
        if (isSafeQueueId(visible[index].id)) {
          items.push(invalidQueueView(visible[index].id, state, visible[index].score))
        }
      }
    }

    return {
      items,
      ...(pairs.length > boundedLimit ? { nextCursor: encodeCursor(offset + boundedLimit) } : {}),
    }
  }

  async requeue(id: string): Promise<QueueItemView | null> {
    const payload = await this.redis.hget(this.keys[0], id)
    if (!payload) {
      return null
    }
    const now = this.clock()
    const current = this.decryptJob(payload)
    const job: QueuedEmail = {
      ...current,
      attempt: 0,
      nextAttemptAt: now,
    }
    delete job.deadAt
    delete job.lastFailureClass
    const encryptedJob = this.encryptJob(job)
    await confirmEmailQueueAofPersistence(this.redis)
    const changed = await this.redis.eval(
      REQUEUE_SCRIPT,
      this.keys.length,
      ...this.keys,
      id,
      encryptedJob,
      now,
      job.retryMode === 'indefinite' ? 0 : now + this.retentionMs,
      this.maxJobBytes,
      this.maxTotalBytes,
    )

    if (Number(changed) === 0) {
      return null
    }
    if (Number(changed) === -3) {
      return null
    }
    this.assertStorageMutation(changed, 'requeue')
    await confirmEmailQueueAofPersistence(this.redis)
    return toQueueView(job, 'ready', now)
  }

  async discard(id: string): Promise<QueueDiscardResult> {
    await confirmEmailQueueAofPersistence(this.redis)
    const discarded = await this.redis.eval(
      DISCARD_SCRIPT,
      this.keys.length,
      ...this.keys,
      id,
      this.clock() + this.deadLetterRetentionMs,
    )
    if (Number(discarded) === 1) {
      await confirmEmailQueueAofPersistence(this.redis)
      return 'discarded'
    }
    if (Number(discarded) === 0) {
      return 'not-found'
    }
    if (Number(discarded) === -1) {
      return 'leased'
    }
    throw new Error('The email delivery queue returned an invalid discard result.')
  }

  private async settle(
    operation: 'ack' | 'retry' | 'dead',
    claim: ClaimedEmail,
    job?: QueuedEmail,
    score = 0,
    expiresAt = 0,
  ): Promise<QueueSettlementResult> {
    const encryptedJob = job ? this.encryptJob(job) : ''
    await confirmEmailQueueAofPersistence(this.redis)
    const quarantineAt = this.clock()
    const changed = await this.redis.eval(
      SETTLE_SCRIPT,
      this.keys.length,
      ...this.keys,
      claim.job.id,
      claim.token,
      operation,
      encryptedJob,
      score,
      expiresAt,
      this.maxJobBytes,
      this.maxTotalBytes,
      quarantineAt,
      quarantineAt + this.deadLetterRetentionMs,
    )
    if (Number(changed) === 0) {
      return 'stale'
    }
    if (Number(changed) === 2) {
      await confirmEmailQueueAofPersistence(this.redis)
      return 'quarantined'
    }
    if (Number(changed) === 3) {
      await confirmEmailQueueAofPersistence(this.redis)
      return 'stale'
    }
    this.assertStorageMutation(changed, operation)
    await confirmEmailQueueAofPersistence(this.redis)
    return 'settled'
  }

  private stateKey(state: QueueState): string {
    return state === 'ready' ? this.keys[1] : state === 'leased' ? this.keys[2] : this.keys[3]
  }

  private encryptJob(job: QueuedEmail): string {
    const serializedJob = JSON.stringify(job)
    const maximumEnvelopeBytes = Math.ceil(Buffer.byteLength(serializedJob, 'utf8') / 3) * 4 + 256
    if (maximumEnvelopeBytes > this.maxJobBytes) {
      throw new Error('The encrypted email delivery job exceeds the per-job storage limit.')
    }

    return this.cipher.encrypt(serializedJob)
  }

  private decryptJob(payload: string): QueuedEmail {
    return parseQueuedEmail(this.cipher.decrypt(payload))
  }

  private async quarantineClaimedPayload(id: string, token: string, now: number): Promise<void> {
    await confirmEmailQueueAofPersistence(this.redis)
    const result = await this.redis.eval(
      QUARANTINE_CLAIM_SCRIPT,
      this.keys.length,
      ...this.keys,
      id,
      token,
      now,
      now + this.deadLetterRetentionMs,
    )
    if (![0, 1].includes(Number(result))) {
      throw new Error('Email delivery queue payload quarantine failed.')
    }
    if (Number(result) === 1) {
      await confirmEmailQueueAofPersistence(this.redis)
    }
  }

  private assertStorageMutation(result: unknown, operation: string): void {
    const code = Number(result)
    if (code === -1) {
      throw new Error(`The encrypted email delivery job exceeds the per-job storage limit during ${operation}.`)
    }
    if (code === -2) {
      throw new Error(`The email delivery queue has reached its encrypted storage budget during ${operation}.`)
    }
    if (code !== 1) {
      throw new Error(`The email delivery queue returned an invalid ${operation} result.`)
    }
  }
}

export interface RedisEmailAttemptLogOptions {
  keyPrefix?: string
  retentionMs?: number
  maximumEntries?: number
}

const LOG_SCRIPT = `
local stale = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[3], 'LIMIT', 0, 500)
for _, id in ipairs(stale) do redis.call('ZREM', KEYS[1], id); redis.call('HDEL', KEYS[2], id) end
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[1], ARGV[4], ARGV[1])
local size = redis.call('ZCARD', KEYS[1])
if size > tonumber(ARGV[5]) then
  local overflow = redis.call('ZRANGE', KEYS[1], 0, size - tonumber(ARGV[5]) - 1)
  for _, id in ipairs(overflow) do redis.call('ZREM', KEYS[1], id); redis.call('HDEL', KEYS[2], id) end
end
return 1
`

export class RedisEmailAttemptLog implements EmailAttemptLogStore {
  private readonly keys: [string, string]
  private readonly retentionMs: number
  private readonly maximumEntries: number

  constructor(
    private readonly redis: EmailQueueRedis,
    options: RedisEmailAttemptLogOptions = {},
  ) {
    const prefix = options.keyPrefix ?? 'srn:email:{delivery}'
    this.keys = [`${prefix}:logs`, `${prefix}:log-entries`]
    this.retentionMs = positiveInteger(options.retentionMs, DEFAULT_RETENTION_MS, 90 * 24 * 60 * 60 * 1_000)
    this.maximumEntries = positiveInteger(options.maximumEntries, 10_000, 100_000)
  }

  async record(entry: EmailAttemptLog): Promise<void> {
    assertLogEntry(entry)
    await this.redis.eval(
      LOG_SCRIPT,
      this.keys.length,
      ...this.keys,
      entry.id,
      JSON.stringify(entry),
      entry.createdAt - this.retentionMs,
      entry.createdAt,
      this.maximumEntries,
    )
  }

  async list(
    limit = 50,
    cursor?: string,
    query: { relayId?: string; outcome?: EmailAttemptLog['outcome'] } = {},
  ): Promise<Page<EmailAttemptLogView>> {
    const boundedLimit = pageSize(limit)
    let offset = decodeCursor(cursor)
    const items: EmailAttemptLogView[] = []
    let hasMore = false
    // Read bounded chunks so filters do not force an unbounded Redis scan.
    for (let pages = 0; pages < 10 && items.length < boundedLimit; pages++) {
      const raw = await this.redis.zrevrange(this.keys[0], offset, offset + boundedLimit, 'WITHSCORES')
      const pairs = scoredMembers(raw)
      if (pairs.length === 0) {
        break
      }
      const batch = pairs.slice(0, boundedLimit)
      const payloads = await this.redis.hmget(this.keys[1], ...batch.map(({ id }) => id))
      let consumed = 0
      for (const payload of payloads) {
        consumed += 1
        if (!payload) {
          continue
        }
        let entry: EmailAttemptLog
        try {
          entry = parseLogEntry(payload)
        } catch {
          continue
        }
        if (
          (!query.relayId || entry.relayId === query.relayId) &&
          (!query.outcome || entry.outcome === query.outcome)
        ) {
          items.push(entry)
          if (items.length === boundedLimit) {
            break
          }
        }
      }
      offset += consumed
      hasMore = consumed < batch.length || pairs.length > boundedLimit
      if (items.length === boundedLimit) {
        break
      }
      if (consumed < batch.length) {
        // hmget is expected to preserve cardinality, but a short response must
        // never advance past queue records that were not actually inspected.
        hasMore = true
        break
      }
      if (!hasMore) {
        break
      }
    }

    return { items, ...(hasMore ? { nextCursor: encodeCursor(offset) } : {}) }
  }
}

function assertQueuedEmail(job: QueuedEmail): void {
  assertQueueMessageAllocationBounds(job?.message)
  if (
    !isSafeQueueId(job.id) ||
    !['reminder', 'published-reminder', 'account', 'backup', 'test', 'other'].includes(job.source) ||
    !Number.isSafeInteger(job.attempt) ||
    job.attempt < 0 ||
    !Number.isSafeInteger(job.maxAttempts) ||
    job.maxAttempts < 1 ||
    job.maxAttempts > 100 ||
    (job.retryMode !== 'indefinite' && job.attempt > job.maxAttempts) ||
    !Number.isSafeInteger(job.createdAt) ||
    job.createdAt < 0 ||
    !Number.isSafeInteger(job.nextAttemptAt) ||
    job.nextAttemptAt < 0 ||
    (job.lastRelayId !== undefined && !isSafeQueueId(job.lastRelayId)) ||
    (job.lastFailureClass !== undefined &&
      (typeof job.lastFailureClass !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(job.lastFailureClass))) ||
    (job.deadAt !== undefined && (!Number.isSafeInteger(job.deadAt) || job.deadAt < 0)) ||
    (job.expiresAt !== undefined && (!Number.isSafeInteger(job.expiresAt) || job.expiresAt < job.createdAt)) ||
    (job.retryMode !== undefined && !['bounded', 'indefinite'].includes(job.retryMode)) ||
    (job.supersessionKey !== undefined && !isSafeQueueId(job.supersessionKey))
  ) {
    throw new Error('Email delivery job is invalid.')
  }
  validateEmailMessage(job.message)
}

function assertQueueMessageAllocationBounds(message: QueuedEmail['message'] | undefined): void {
  if (!message || typeof message !== 'object') {
    return
  }
  let decodedBytes =
    Buffer.byteLength(typeof message.text === 'string' ? message.text : '', 'utf8') +
    Buffer.byteLength(typeof message.html === 'string' ? message.html : '', 'utf8')
  const attachments = Array.isArray(message.attachments) ? message.attachments : []
  for (const attachment of attachments) {
    if (!attachment || typeof attachment.contentBase64 !== 'string') {
      continue
    }
    const paddingBytes = attachment.contentBase64.endsWith('==') ? 2 : attachment.contentBase64.endsWith('=') ? 1 : 0
    decodedBytes += Math.max(0, Math.floor((attachment.contentBase64.length * 3) / 4) - paddingBytes)
    if (decodedBytes > 20 * 1024 * 1024) {
      throw new Error('The email message exceeds the aggregate content limit.')
    }
  }
}

function isSafeQueueId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
}

function assertSameJob(claim: ClaimedEmail, job: QueuedEmail): void {
  if (claim.job.id !== job.id) {
    throw new Error('A claimed email can settle only its own job.')
  }
}

function parseQueuedEmail(value: string): QueuedEmail {
  const parsed = JSON.parse(value) as QueuedEmail
  assertQueuedEmail(parsed)
  return parsed
}

function assertLogEntry(entry: EmailAttemptLog): void {
  if (
    !entry.id ||
    !entry.jobId ||
    !entry.relayId ||
    !Number.isSafeInteger(entry.attempt) ||
    entry.attempt < 1 ||
    !Number.isSafeInteger(entry.durationMs) ||
    entry.durationMs < 0 ||
    !Number.isSafeInteger(entry.createdAt)
  ) {
    throw new Error('Email delivery attempt log is invalid.')
  }
}

function parseLogEntry(value: string): EmailAttemptLog {
  const parsed = JSON.parse(value) as EmailAttemptLog
  assertLogEntry(parsed)
  return parsed
}

function toQueueView(job: QueuedEmail, state: QueueState, score: number): QueueItemView {
  return {
    id: job.id,
    state,
    source: job.source,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt,
    ...(state === 'ready' ? { nextAttemptAt: score } : {}),
    ...(state === 'leased' ? { leaseExpiresAt: score } : {}),
    ...(job.lastRelayId ? { lastRelayId: job.lastRelayId } : {}),
    ...(job.lastFailureClass ? { lastFailureClass: job.lastFailureClass } : {}),
    ...(job.expiresAt !== undefined ? { expiresAt: job.expiresAt } : {}),
    ...(job.retryMode !== undefined ? { retryMode: job.retryMode } : {}),
  }
}

function invalidQueueView(id: string, state: QueueState, score: number): QueueItemView {
  return {
    id,
    state,
    source: 'other',
    attempt: 0,
    maxAttempts: 1,
    createdAt: 0,
    ...(state === 'ready' ? { nextAttemptAt: score } : {}),
    ...(state === 'leased' ? { leaseExpiresAt: score } : {}),
    lastFailureClass: 'payload-invalid',
  }
}

function arrayResult(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function scoredMembers(values: string[]): Array<{ id: string; score: number }> {
  const result: Array<{ id: string; score: number }> = []
  for (let index = 0; index + 1 < values.length; index += 2) {
    const score = Number(values[index + 1])
    if (Number.isFinite(score)) {
      result.push({ id: values[index], score })
    }
  }
  return result
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) {
    return fallback
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error('Email delivery queue options are invalid.')
  }
  return value
}

function pageSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Email delivery page size is invalid.')
  }
  return Math.min(value, MAX_PAGE_SIZE)
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url')
}

function decodeCursor(cursor?: string): number {
  if (!cursor) {
    return 0
  }
  const value = Number(Buffer.from(cursor, 'base64url').toString('utf8'))
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Email delivery cursor is invalid.')
  }
  return value
}
