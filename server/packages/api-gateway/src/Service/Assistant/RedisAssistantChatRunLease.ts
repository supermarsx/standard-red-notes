import { createHash, randomUUID } from 'node:crypto'

export const CHAT_RUN_LEASE_TTL_MS = 30_000
export const CHAT_RUN_LEASE_RENEW_MS = 10_000
/** Bound hung upstream generations so a synced chat cannot remain owned forever. */
export const CHAT_RUN_STREAM_MAX_MS = 5 * 60_000
/** Bound abandoned chat counters; the UUID lease identity remains authoritative across counter epochs. */
export const CHAT_RUN_FENCE_RETENTION_MS = 90 * 24 * 60 * 60_000
const REDIS_TIMEOUT_MS = 2_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CHAT_ID = /^[A-Za-z0-9_-]{1,128}$/

export interface AssistantChatRunProof {
  chatId: string
  requestId: string
  leaseId: string
  fence: number
}

export function isAssistantChatRunIdentity(
  value: unknown,
): value is Pick<AssistantChatRunProof, 'chatId' | 'requestId'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const item = value as Record<string, unknown>
  return (
    typeof item.chatId === 'string' &&
    CHAT_ID.test(item.chatId) &&
    typeof item.requestId === 'string' &&
    UUID.test(item.requestId)
  )
}

export function isAssistantChatRunProof(value: unknown): value is AssistantChatRunProof {
  return (
    isAssistantChatRunIdentity(value) &&
    typeof (value as AssistantChatRunProof).leaseId === 'string' &&
    UUID.test((value as AssistantChatRunProof).leaseId) &&
    Number.isSafeInteger((value as AssistantChatRunProof).fence) &&
    (value as AssistantChatRunProof).fence > 0
  )
}

const NOW = `local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)`
const MATCH = `if redis.call('HGET', KEYS[1], 'requestId') ~= ARGV[1] or redis.call('HGET', KEYS[1], 'leaseId') ~= ARGV[2] or redis.call('HGET', KEYS[1], 'fence') ~= ARGV[3] then return {0} end`
const ACQUIRE = `-- assistant-chat-acquire
${NOW}
if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('PEXPIRE', KEYS[2], ${CHAT_RUN_FENCE_RETENTION_MS})
  if redis.call('HGET', KEYS[1], 'requestId') == ARGV[1] and redis.call('HGET', KEYS[1], 'releaseRequested') ~= '1' then
    return {1, redis.call('HGET', KEYS[1], 'leaseId'), redis.call('HGET', KEYS[1], 'fence'), redis.call('HGET', KEYS[1], 'expiresAt')}
  end
  return {0, math.max(1, redis.call('PTTL', KEYS[1]))}
end
local fence = redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], ${CHAT_RUN_FENCE_RETENTION_MS})
local expires = now + ${CHAT_RUN_LEASE_TTL_MS}
redis.call('HSET', KEYS[1], 'requestId', ARGV[1], 'leaseId', ARGV[2], 'fence', tostring(fence), 'expiresAt', tostring(expires))
redis.call('PEXPIRE', KEYS[1], ${CHAT_RUN_LEASE_TTL_MS})
return {1, ARGV[2], tostring(fence), tostring(expires)}`
const RENEW = `-- assistant-chat-renew
${MATCH}
if redis.call('HGET', KEYS[1], 'releaseRequested') == '1' then return {0} end
${NOW}
local expires = now + ${CHAT_RUN_LEASE_TTL_MS}
redis.call('HSET', KEYS[1], 'expiresAt', tostring(expires))
redis.call('PEXPIRE', KEYS[1], ${CHAT_RUN_LEASE_TTL_MS})
return {1, tostring(expires)}`
const RELEASE = `-- assistant-chat-release
${MATCH}
if redis.call('HEXISTS', KEYS[1], 'streamId') == 1 then
  redis.call('HSET', KEYS[1], 'releaseRequested', '1')
else
  redis.call('DEL', KEYS[1])
end
return {1}`
const BEGIN_STREAM = `-- assistant-chat-begin-stream
${MATCH}
if redis.call('HGET', KEYS[1], 'releaseRequested') == '1' or redis.call('HEXISTS', KEYS[1], 'streamId') == 1 then return {0} end
${NOW}
redis.call('HSET', KEYS[1], 'streamId', ARGV[4], 'expiresAt', tostring(now + ${CHAT_RUN_LEASE_TTL_MS}))
redis.call('PEXPIRE', KEYS[1], ${CHAT_RUN_LEASE_TTL_MS})
return {1}`
const RENEW_STREAM = `-- assistant-chat-renew-stream
${MATCH}
if redis.call('HGET', KEYS[1], 'streamId') ~= ARGV[4] or redis.call('HGET', KEYS[1], 'releaseRequested') == '1' then return {0} end
${NOW}
redis.call('HSET', KEYS[1], 'expiresAt', tostring(now + ${CHAT_RUN_LEASE_TTL_MS}))
redis.call('PEXPIRE', KEYS[1], ${CHAT_RUN_LEASE_TTL_MS})
return {1}`
const END_STREAM = `-- assistant-chat-end-stream
${MATCH}
if redis.call('HGET', KEYS[1], 'streamId') ~= ARGV[4] then return {0} end
if redis.call('HGET', KEYS[1], 'releaseRequested') == '1' then redis.call('DEL', KEYS[1])
else redis.call('HDEL', KEYS[1], 'streamId') end
return {1}`

/** Atomic account-scoped ownership; counters survive expired owners for a bounded retention epoch. */
export class RedisAssistantChatRunLease {
  constructor(
    private readonly redis: {
      eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>
    },
  ) {}

  private keys(userUuid: string, chatId: string): [string, string] {
    const digest = createHash('sha256').update(`${userUuid}\0${chatId}`).digest('hex')
    const prefix = `assistant:chat-run:{${digest}}`
    return [`${prefix}:lease`, `${prefix}:fence`]
  }

  private async evaluate(script: string, keys: string[], args: Array<string | number>): Promise<unknown[]> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        this.redis.eval(script, keys.length, ...keys, ...args),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Assistant chat lease storage is unavailable.')), REDIS_TIMEOUT_MS)
        }),
      ])
      if (!Array.isArray(result) || (Number(result[0]) !== 0 && Number(result[0]) !== 1)) {
        throw new Error('Invalid assistant chat lease reply.')
      }
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  async acquire(
    userUuid: string,
    identity: Pick<AssistantChatRunProof, 'chatId' | 'requestId'>,
  ): Promise<
    { acquired: true; leaseId: string; fence: number; expiresAt: number } | { acquired: false; retryAfterMs: number }
  > {
    const reply = await this.evaluate(ACQUIRE, this.keys(userUuid, identity.chatId), [identity.requestId, randomUUID()])
    if (Number(reply[0]) === 0) {
      return { acquired: false, retryAfterMs: Math.max(1, Number(reply[1]) || CHAT_RUN_LEASE_TTL_MS) }
    }
    const result = {
      acquired: true as const,
      leaseId: String(reply[1]),
      fence: Number(reply[2]),
      expiresAt: Number(reply[3]),
    }
    if (
      !UUID.test(result.leaseId) ||
      !Number.isSafeInteger(result.fence) ||
      result.fence <= 0 ||
      !Number.isSafeInteger(result.expiresAt)
    ) {
      throw new Error('Invalid assistant chat lease reply.')
    }
    return result
  }

  private operation(
    script: string,
    userUuid: string,
    proof: AssistantChatRunProof,
    streamId?: string,
  ): Promise<unknown[]> {
    return this.evaluate(
      script,
      [this.keys(userUuid, proof.chatId)[0]],
      [proof.requestId, proof.leaseId, String(proof.fence), ...(streamId ? [streamId] : [])],
    )
  }

  async renew(userUuid: string, proof: AssistantChatRunProof): Promise<{ renewed: boolean; expiresAt?: number }> {
    const result = await this.operation(RENEW, userUuid, proof)
    if (Number(result[0]) === 1 && (!Number.isSafeInteger(Number(result[1])) || Number(result[1]) <= 0)) {
      throw new Error('Invalid assistant chat lease reply.')
    }
    return Number(result[0]) === 1 ? { renewed: true, expiresAt: Number(result[1]) } : { renewed: false }
  }

  async release(userUuid: string, proof: AssistantChatRunProof): Promise<{ released: boolean }> {
    return { released: Number((await this.operation(RELEASE, userUuid, proof))[0]) === 1 }
  }

  async beginStream(userUuid: string, proof: AssistantChatRunProof): Promise<string | undefined> {
    const streamId = randomUUID()
    return Number((await this.operation(BEGIN_STREAM, userUuid, proof, streamId))[0]) === 1 ? streamId : undefined
  }

  async renewStream(userUuid: string, proof: AssistantChatRunProof, streamId: string): Promise<boolean> {
    return Number((await this.operation(RENEW_STREAM, userUuid, proof, streamId))[0]) === 1
  }

  async endStream(userUuid: string, proof: AssistantChatRunProof, streamId: string): Promise<void> {
    await this.operation(END_STREAM, userUuid, proof, streamId)
  }
}
