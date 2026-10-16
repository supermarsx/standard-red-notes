import {
  AssistantChatRunProof,
  CHAT_RUN_LEASE_TTL_MS,
  CHAT_RUN_FENCE_RETENTION_MS,
  isAssistantChatRunIdentity,
  isAssistantChatRunProof,
  RedisAssistantChatRunLease,
} from './RedisAssistantChatRunLease'

const requestId = '11111111-1111-4111-8111-111111111111'
const secondRequest = '22222222-2222-4222-8222-222222222222'
const identity = { chatId: 'legacyChat_123', requestId }

/** Atomic Redis model, following the existing quota-store test convention. */
class AtomicRedis {
  now = 1000
  failed = false
  readonly records = new Map<string, { fields: Map<string, string>; expires: number }>()
  readonly fences = new Map<string, number>()
  readonly fenceExpiry = new Map<string, number>()
  eval = jest.fn(async (script: string, keyCount: number, ...values: Array<string | number>) => {
    if (this.failed) {
      throw new Error('offline')
    }
    const keys = values.slice(0, keyCount).map(String)
    const args = values.slice(keyCount).map(String)
    let record = this.records.get(keys[0])
    if (record && record.expires <= this.now) {
      this.records.delete(keys[0])
      record = undefined
    }
    if (script.startsWith('-- assistant-chat-acquire')) {
      if ((this.fenceExpiry.get(keys[1]) ?? Infinity) <= this.now) {
        this.fences.delete(keys[1])
      }
      if (record) {
        this.fenceExpiry.set(keys[1], this.now + CHAT_RUN_FENCE_RETENTION_MS)
        if (record.fields.get('requestId') === args[0] && record.fields.get('releaseRequested') !== '1') {
          return [1, record.fields.get('leaseId'), record.fields.get('fence'), record.expires]
        }
        return [0, record.expires - this.now]
      }
      const fence = (this.fences.get(keys[1]) ?? 0) + 1
      this.fences.set(keys[1], fence)
      this.fenceExpiry.set(keys[1], this.now + CHAT_RUN_FENCE_RETENTION_MS)
      record = {
        fields: new Map([
          ['requestId', args[0]],
          ['leaseId', args[1]],
          ['fence', String(fence)],
        ]),
        expires: this.now + CHAT_RUN_LEASE_TTL_MS,
      }
      this.records.set(keys[0], record)
      return [1, args[1], fence, record.expires]
    }
    if (
      !record ||
      record.fields.get('requestId') !== args[0] ||
      record.fields.get('leaseId') !== args[1] ||
      record.fields.get('fence') !== args[2]
    ) {
      return [0]
    }
    const touch = () => {
      record!.expires = this.now + CHAT_RUN_LEASE_TTL_MS
    }
    if (script.startsWith('-- assistant-chat-renew\n')) {
      if (record.fields.get('releaseRequested') === '1') {
        return [0]
      }
      touch()
      return [1, record.expires]
    }
    if (script.startsWith('-- assistant-chat-release')) {
      if (record.fields.has('streamId')) {
        record.fields.set('releaseRequested', '1')
      } else {
        this.records.delete(keys[0])
      }
      return [1]
    }
    if (script.startsWith('-- assistant-chat-begin-stream')) {
      if (record.fields.has('streamId') || record.fields.get('releaseRequested') === '1') {
        return [0]
      }
      record.fields.set('streamId', args[3])
      touch()
      return [1]
    }
    if (record.fields.get('streamId') !== args[3]) {
      return [0]
    }
    if (script.startsWith('-- assistant-chat-renew-stream')) {
      if (record.fields.get('releaseRequested') === '1') {
        return [0]
      }
      touch()
      return [1]
    }
    if (script.startsWith('-- assistant-chat-end-stream')) {
      if (record.fields.get('releaseRequested') === '1') {
        this.records.delete(keys[0])
      } else {
        record.fields.delete('streamId')
      }
      return [1]
    }
    throw new Error('Unknown script')
  })
}

const claim = async (
  store: RedisAssistantChatRunLease,
  user = 'user-a',
  id = identity,
): Promise<AssistantChatRunProof> => {
  const lease = await store.acquire(user, id)
  if (!lease.acquired) {
    throw new Error('Expected lease')
  }
  return { ...id, leaseId: lease.leaseId, fence: lease.fence }
}

it('admits one racing owner and makes same-request acquisition idempotent', async () => {
  const redis = new AtomicRedis()
  const store = new RedisAssistantChatRunLease(redis)
  const [first, second] = await Promise.all([
    store.acquire('user-a', identity),
    store.acquire('user-a', { ...identity, requestId: secondRequest }),
  ])
  expect(first.acquired).toBe(true)
  expect(second).toEqual({ acquired: false, retryAfterMs: CHAT_RUN_LEASE_TTL_MS })
  expect(await store.acquire('user-a', identity)).toEqual(first)
})

it('keeps accounts and chats isolated, using hash-tag matched atomic keys', async () => {
  const redis = new AtomicRedis()
  const store = new RedisAssistantChatRunLease(redis)
  await claim(store)
  await claim(store, 'user-b')
  await claim(store, 'user-a', { ...identity, chatId: 'other' })
  expect(redis.records.size).toBe(3)
  const [, count, lease, fence] = redis.eval.mock.calls[0]
  expect(count).toBe(2)
  expect(String(lease).match(/\{([^}]+)\}/)?.[1]).toBe(String(fence).match(/\{([^}]+)\}/)?.[1])
})

it('increments the fence after expiry and rejects stale renew/release without disturbing the new owner', async () => {
  const redis = new AtomicRedis()
  const store = new RedisAssistantChatRunLease(redis)
  const old = await claim(store)
  redis.now += CHAT_RUN_LEASE_TTL_MS + 1
  const next = await claim(store, 'user-a', { ...identity, requestId: secondRequest })
  expect(next.fence).toBeGreaterThan(old.fence)
  expect(await store.release('user-a', old)).toEqual({ released: false })
  expect(await store.renew('user-a', old)).toEqual({ renewed: false })
  expect((await store.renew('user-a', next)).renewed).toBe(true)
})

it('holds an active generation until cleanup, refuses parallel sends, and aborts renewal after owner release', async () => {
  const redis = new AtomicRedis()
  const store = new RedisAssistantChatRunLease(redis)
  const proof = await claim(store)
  const stream = (await store.beginStream('user-a', proof))!
  expect(stream).toBeDefined()
  expect(await store.beginStream('user-a', proof)).toBeUndefined()
  redis.now += 20_000
  expect(await store.renewStream('user-a', proof, stream)).toBe(true)
  expect(await store.release('user-a', proof)).toEqual({ released: true })
  expect((await store.acquire('user-a', { ...identity, requestId: secondRequest })).acquired).toBe(false)
  expect(await store.renewStream('user-a', proof, stream)).toBe(false)
  await store.endStream('user-a', proof, stream)
  expect((await store.acquire('user-a', { ...identity, requestId: secondRequest })).acquired).toBe(true)
})

it('allows serial model calls and ignores stale stream cleanup', async () => {
  const redis = new AtomicRedis()
  const store = new RedisAssistantChatRunLease(redis)
  const proof = await claim(store)
  const old = (await store.beginStream('user-a', proof))!
  await store.endStream('user-a', proof, old)
  const next = (await store.beginStream('user-a', proof))!
  await store.endStream('user-a', proof, old)
  expect(await store.renewStream('user-a', proof, next)).toBe(true)
})

it('bounds fence-counter retention and keeps stale UUID proofs invalid across a counter reset', async () => {
  const redis = new AtomicRedis()
  const store = new RedisAssistantChatRunLease(redis)
  const old = await claim(store)
  expect([...redis.fenceExpiry.values()]).toEqual([redis.now + CHAT_RUN_FENCE_RETENTION_MS])
  const script = String(redis.eval.mock.calls[0][0])
  expect(script).toContain(`redis.call('PEXPIRE', KEYS[2], ${CHAT_RUN_FENCE_RETENTION_MS})`)
  redis.now += CHAT_RUN_FENCE_RETENTION_MS + 1
  const next = await claim(store, 'user-a', { ...identity, requestId: secondRequest })
  expect(next.fence).toBe(1)
  expect(next.leaseId).not.toBe(old.leaseId)
  expect(await store.release('user-a', old)).toEqual({ released: false })
  expect((await store.renew('user-a', next)).renewed).toBe(true)
})

it('fails closed on Redis failure or malformed replies', async () => {
  const redis = new AtomicRedis()
  redis.failed = true
  await expect(new RedisAssistantChatRunLease(redis).acquire('user-a', identity)).rejects.toThrow('offline')
  const invalid = { eval: jest.fn(async () => [1, 'invalid', 1, 1000]) }
  await expect(new RedisAssistantChatRunLease(invalid).acquire('user-a', identity)).rejects.toThrow('Invalid')
})

it('bounds legacy chat ids and validates opaque proof identities without accepting fractional fences', () => {
  expect(isAssistantChatRunIdentity(identity)).toBe(true)
  expect(isAssistantChatRunIdentity({ ...identity, chatId: '../escape' })).toBe(false)
  expect(isAssistantChatRunIdentity({ ...identity, chatId: 'a'.repeat(129) })).toBe(false)
  expect(isAssistantChatRunIdentity({ ...identity, requestId: 'anything' })).toBe(false)
  expect(isAssistantChatRunProof({ ...identity, leaseId: secondRequest, fence: 1 })).toBe(true)
  expect(isAssistantChatRunProof({ ...identity, leaseId: secondRequest, fence: 1.5 })).toBe(false)
})

it('bounds a hung Redis call instead of letting admission or renewal wait forever', async () => {
  jest.useFakeTimers()
  try {
    const store = new RedisAssistantChatRunLease({ eval: () => new Promise(() => undefined) })
    const pending = store.acquire('user-a', identity)
    const rejected = expect(pending).rejects.toThrow('unavailable')
    await jest.advanceTimersByTimeAsync(2000)
    await rejected
  } finally {
    jest.useRealTimers()
  }
})
