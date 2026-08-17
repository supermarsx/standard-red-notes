import * as IORedis from 'ioredis'

import { RedisTokenUsageStore } from './RedisTokenUsageStore'

type Operation = 'migrate' | 'reserve' | 'refresh' | 'commit' | 'release' | 'record' | 'read'

class FakeRedis {
  redisNow = 1_000_000
  readonly buckets = new Map<string, Map<string, number>>()
  readonly pending = new Map<string, Map<string, number>>()
  readonly ledgers = new Map<string, Map<string, string>>()
  readonly legacy = new Map<string, string[]>()
  readonly evalKeys: string[][] = []
  readonly calls: Operation[] = []
  zrangeCalls = 0
  failBefore = new Set<Operation>()
  loseReplyAfterApply = new Set<Operation>()

  async zrangebyscore(key: string): Promise<string[]> {
    this.zrangeCalls += 1
    return this.legacy.get(key) ?? []
  }

  async hget(key: string, field: string): Promise<string | null> {
    const value = this.mapFor(this.buckets, key).get(field)
    return value === undefined ? null : String(value)
  }

  async eval(script: string, keyCount: number, ...raw: Array<string | number>): Promise<unknown> {
    const keys = raw.slice(0, keyCount).map(String)
    const args = raw.slice(keyCount)
    const operation: Operation = script.includes('__legacy_migrated')
      ? 'migrate'
      : script.includes('local capacity = prompt + requested_output')
        ? 'reserve'
        : script.includes('actual > reserved')
          ? 'commit'
          : script.includes("redis.call('HDEL', KEYS[3], ARGV[1])")
            ? 'release'
            : script.includes("redis.call('ZADD', KEYS[1], now + tonumber(ARGV[1])")
              ? 'refresh'
              : script.includes("'usage:'")
                ? 'read'
                : script.includes("redis.call('HINCRBY', KEYS[1], tostring(bucket), ARGV[1])")
                  ? 'record'
                  : 'read'
    this.calls.push(operation)
    this.evalKeys.push(keys)
    if (this.failBefore.delete(operation)) {
      throw new Error(`redis ${operation} unavailable`)
    }

    const result =
      operation === 'migrate'
        ? this.migrate(keys, args)
        : operation === 'reserve'
          ? this.reserve(keys, args)
          : operation === 'commit'
            ? this.commit(keys, args)
            : operation === 'release'
              ? this.release(keys, args)
              : operation === 'refresh'
                ? this.refresh(keys, args)
                : operation === 'record'
                  ? this.record(keys, args)
                  : this.read(keys)
    if (this.loseReplyAfterApply.delete(operation)) {
      throw new Error(`redis ${operation} reply lost`)
    }
    return result
  }

  private reserve(keys: string[], args: Array<string | number>): number[] {
    const [bucketKey, pendingKey, ledgerKey] = keys
    const [fiveLimitRaw, weekLimitRaw, leaseRaw, promptRaw, outputRaw, idRaw] = args
    const fiveLimit = Number(fiveLimitRaw)
    const weekLimit = Number(weekLimitRaw)
    const lease = Number(leaseRaw)
    const prompt = Number(promptRaw)
    const requestedOutput = Number(outputRaw)
    const id = String(idRaw)
    const buckets = this.mapFor(this.buckets, bucketKey)
    const pending = this.mapFor(this.pending, pendingKey)
    const ledger = this.mapFor(this.ledgers, ledgerKey)
    let pendingUsed = buckets.get('__pending') ?? 0

    for (const [expiredId, expiresAt] of pending) {
      if (expiresAt <= this.redisNow) {
        const state = ledger.get(expiredId)
        if (state?.startsWith('pending:')) {
          pendingUsed -= Number(state.split(':')[1])
        }
        pending.delete(expiredId)
        ledger.delete(expiredId)
      }
    }
    buckets.set('__pending', pendingUsed)
    const committed = [...buckets.entries()]
      .filter(([field]) => !field.startsWith('__'))
      .reduce((sum, [, tokens]) => sum + tokens, 0)
    const fiveUsed = committed + pendingUsed
    const weekUsed = committed + pendingUsed
    let capacity = prompt + requestedOutput
    if (fiveLimit > 0) {
      capacity = Math.min(capacity, fiveLimit - fiveUsed)
    }
    if (weekLimit > 0) {
      capacity = Math.min(capacity, weekLimit - weekUsed)
    }
    if (capacity <= prompt) {
      return [0, fiveLimit > 0 ? 1 : 2, fiveUsed, weekUsed, this.redisNow, 0, 0]
    }

    const granted = Math.min(requestedOutput, capacity - prompt)
    const reserved = prompt + granted
    buckets.set('__pending', pendingUsed + reserved)
    pending.set(id, this.redisNow + lease)
    ledger.set(id, `pending:${reserved}:${granted}`)
    return [1, 0, fiveUsed + reserved, weekUsed + reserved, 0, granted, reserved]
  }

  private refresh(keys: string[], args: Array<string | number>): number {
    const [pendingKey, ledgerKey] = keys
    const [leaseRaw, idRaw] = args
    const id = String(idRaw)
    const pending = this.mapFor(this.pending, pendingKey)
    const state = this.mapFor(this.ledgers, ledgerKey).get(id)
    if (!state?.startsWith('pending:') || (pending.get(id) ?? 0) <= this.redisNow) {
      return 0
    }
    pending.set(id, this.redisNow + Number(leaseRaw))
    return 1
  }

  private migrate(keys: string[], args: Array<string | number>): number {
    const buckets = this.mapFor(this.buckets, keys[0])
    if (buckets.has('__legacy_migrated')) {
      return 0
    }
    for (let index = 0; index < args.length - 1; index += 2) {
      const bucket = String(args[index])
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + Number(args[index + 1]))
    }
    buckets.set('__legacy_migrated', 1)
    return 1
  }

  private commit(keys: string[], args: Array<string | number>): number[] {
    const [bucketKey, pendingKey, ledgerKey] = keys
    const [actualRaw, , idRaw] = args
    const actual = Number(actualRaw)
    const id = String(idRaw)
    const buckets = this.mapFor(this.buckets, bucketKey)
    const pending = this.mapFor(this.pending, pendingKey)
    const ledger = this.mapFor(this.ledgers, ledgerKey)
    const state = ledger.get(id)
    if (state?.startsWith('committed:')) {
      return [1, 0]
    }
    if (!state?.startsWith('pending:')) {
      return [0, 0]
    }
    const reserved = Number(state.split(':')[1])
    if (actual > reserved) {
      return [-1, reserved]
    }
    if ((pending.get(id) ?? 0) <= this.redisNow) {
      return [0, reserved]
    }
    buckets.set('__pending', (buckets.get('__pending') ?? 0) - reserved)
    const bucket = String(Math.floor(this.redisNow / 300_000) * 300_000)
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + actual)
    pending.delete(id)
    ledger.set(id, `committed:${actual}`)
    return [1, reserved - actual]
  }

  private release(keys: string[], args: Array<string | number>): number {
    const [bucketKey, pendingKey, ledgerKey] = keys
    const [idRaw] = args
    const id = String(idRaw)
    const buckets = this.mapFor(this.buckets, bucketKey)
    const pending = this.mapFor(this.pending, pendingKey)
    const ledger = this.mapFor(this.ledgers, ledgerKey)
    const state = ledger.get(id)
    if (!state) {
      return 1
    }
    if (state.startsWith('committed:')) {
      return 0
    }
    const reserved = Number(state.split(':')[1])
    buckets.set('__pending', (buckets.get('__pending') ?? 0) - reserved)
    pending.delete(id)
    ledger.delete(id)
    return 1
  }

  private record(keys: string[], args: Array<string | number>): number {
    const buckets = this.mapFor(this.buckets, keys[0])
    const bucket = String(Math.floor(this.redisNow / 300_000) * 300_000)
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + Number(args[0]))
    return this.redisNow
  }

  private read(keys: string[]): string[] {
    return [...this.mapFor(this.buckets, keys[0]).entries()]
      .filter(([field, tokens]) => !field.startsWith('__') && tokens > 0)
      .map(([field, tokens]) => `${field}:${tokens}:bucket`)
  }

  private mapFor<T>(container: Map<string, Map<string, T>>, key: string): Map<string, T> {
    let value = container.get(key)
    if (!value) {
      value = new Map()
      container.set(key, value)
    }
    return value
  }
}

describe('RedisTokenUsageStore hard quota', () => {
  it('atomically includes concurrent pending reservations and reduces output to remaining capacity', async () => {
    const redis = new FakeRedis()
    const store = new RedisTokenUsageStore(redis as unknown as IORedis.Redis, 1_000, 200)

    const first = await store.reserve('user-1', 100, 400, { fiveHour: 700, weekly: 0 })
    const second = await store.reserve('user-1', 100, 400, { fiveHour: 700, weekly: 0 })
    const third = await store.reserve('user-1', 1, 1, { fiveHour: 700, weekly: 0 })

    expect(first).toMatchObject({ allowed: true, maxOutputTokens: 400, reservedTokens: 500 })
    expect(second).toMatchObject({ allowed: true, maxOutputTokens: 100, reservedTokens: 200 })
    expect(third).toMatchObject({ allowed: false, window: 'fiveHour', usedTokens: 700 })
  })

  it('reconciles actual successful usage and refunds the unused reservation atomically', async () => {
    const redis = new FakeRedis()
    const store = new RedisTokenUsageStore(redis as unknown as IORedis.Redis, 1_000, 200)
    const decision = await store.reserve('user-1', 100, 400, { fiveHour: 700, weekly: 0 })
    if (!decision.allowed) {
      throw new Error('expected token reservation')
    }

    await decision.reservation.commit(180)
    const next = await store.reserve('user-1', 100, 400, { fiveHour: 700, weekly: 0 })

    expect(next).toMatchObject({ allowed: true, maxOutputTokens: 400, reservedTokens: 500 })
    await expect(store.entriesWithinWeek('user-1', Date.now())).resolves.toEqual([
      expect.objectContaining({ tokens: 180 }),
    ])
  })

  it('releases failed usage without charging and makes lost replies idempotent', async () => {
    const redis = new FakeRedis()
    const store = new RedisTokenUsageStore(redis as unknown as IORedis.Redis, 1_000, 200)
    const failed = await store.reserve('user-1', 100, 400, { fiveHour: 500, weekly: 0 })
    if (!failed.allowed) {
      throw new Error('expected token reservation')
    }
    redis.loseReplyAfterApply.add('release')
    await expect(failed.reservation.release()).rejects.toThrow('reply lost')
    await expect(failed.reservation.release()).resolves.toBeUndefined()

    const success = await store.reserve('user-1', 100, 400, { fiveHour: 500, weekly: 0 })
    if (!success.allowed) {
      throw new Error('expected replacement reservation')
    }
    redis.loseReplyAfterApply.add('commit')
    await expect(success.reservation.commit(200)).rejects.toThrow('reply lost')
    await expect(success.reservation.commit(200)).resolves.toBeUndefined()

    await expect(store.entriesWithinWeek('user-1', Date.now())).resolves.toEqual([
      expect.objectContaining({ tokens: 200 }),
    ])
  })

  it('reclaims crashed leases and never commits more tokens than it reserved', async () => {
    const redis = new FakeRedis()
    const store = new RedisTokenUsageStore(redis as unknown as IORedis.Redis, 1_000, 200)
    const abandoned = await store.reserve('user-1', 100, 400, { fiveHour: 500, weekly: 0 })
    if (!abandoned.allowed) {
      throw new Error('expected token reservation')
    }
    await expect(abandoned.reservation.commit(501)).rejects.toThrow('exceeded its reserved upper bound')

    redis.redisNow += 1_001
    await expect(store.reserve('user-1', 100, 400, { fiveHour: 500, weekly: 0 })).resolves.toMatchObject({
      allowed: true,
    })
  })

  it('uses cluster-co-located keys and preserves legacy rolling usage during deployment', async () => {
    const redis = new FakeRedis()
    redis.legacy.set('ai-token-usage:user-1', [`${Date.now()}:120:legacy`])
    const store = new RedisTokenUsageStore(redis as unknown as IORedis.Redis, 1_000, 200)

    await expect(store.reserve('user-1', 100, 400, { fiveHour: 200, weekly: 0 })).resolves.toMatchObject({
      allowed: false,
      usedTokens: 120,
    })
    const quotaKeys = redis.evalKeys.find((keys) => keys.length === 3)
    expect(quotaKeys).toHaveLength(3)
    expect(quotaKeys?.map((key) => key.match(/\{[^}]+\}/)?.[0])).toEqual(['{user-1}', '{user-1}', '{user-1}'])
    expect(redis.zrangeCalls).toBe(1)

    const secondStore = new RedisTokenUsageStore(redis as unknown as IORedis.Redis, 1_000, 200)
    await secondStore.reserve('user-1', 10, 10, { fiveHour: 1_000, weekly: 0 })
    expect(redis.zrangeCalls).toBe(1)
  })
})
