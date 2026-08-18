import { describe, expect, it } from 'vitest'

import type { SyncTicketIdentity } from '../src/auth.js'
import { InMemorySyncCommandLeaseRegistry, InMemorySyncSocketBudget } from '../src/registry.js'
import { RedisSyncAuthTicketStore, createRedisSyncState, type SyncRedisClient } from '../src/syncRedisState.js'

type StoredString = { value: string; expiresAt: number }

class SharedRedisHarness {
  now = Date.now()
  fail = false
  hang = false
  returnBuffers = false
  readonly strings = new Map<string, StoredString>()
  readonly sortedSets = new Map<string, Map<string, number>>()

  string(key: string): StoredString | undefined {
    const value = this.strings.get(key)
    if (value && value.expiresAt <= this.now) {
      this.strings.delete(key)
      return undefined
    }
    return value
  }
}

class FakeRedisClient implements SyncRedisClient {
  status = 'ready'

  constructor(private readonly state: SharedRedisHarness) {}

  async set(key: string, value: string, _mode: 'PX', ttlMs: number, _condition: 'NX'): Promise<'OK' | null> {
    if (this.state.fail) {
      throw new Error('redis unavailable')
    }
    if (this.state.string(key)) {
      return null
    }
    this.state.strings.set(key, { value, expiresAt: this.state.now + ttlMs })
    return 'OK'
  }

  async eval(script: string, _numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> {
    if (this.state.fail) {
      throw new Error('redis unavailable')
    }
    if (this.state.hang) {
      return new Promise(() => undefined)
    }
    const key = String(args[0])
    if (script.includes('SRN_SYNC_TICKET_GETDEL_V1')) {
      const stored = this.state.string(key)
      this.state.strings.delete(key)
      if (!stored) {
        return null
      }
      return this.state.returnBuffers ? Buffer.from(stored.value, 'utf8') : stored.value
    }
    if (script.includes('SRN_SYNC_COMMAND_LEASE_ACQUIRE_V1')) {
      const value = String(args[1])
      const commandId = String(args[2])
      const digest = String(args[3])
      const ttlMs = Number(args[4])
      const existing = this.state.string(key)
      if (existing) {
        const [, existingCommand, existingDigest] = existing.value.split('|')
        return existingCommand === commandId && existingDigest !== digest ? -1 : 0
      }
      this.state.strings.set(key, { value, expiresAt: this.state.now + ttlMs })
      return 1
    }
    if (script.includes('SRN_SYNC_COMMAND_LEASE_RENEW_V1')) {
      const existing = this.state.string(key)
      if (!existing || existing.value !== String(args[1])) {
        return 0
      }
      existing.expiresAt = this.state.now + Number(args[2])
      return 1
    }
    if (script.includes('SRN_SYNC_COMMAND_LEASE_RELEASE_V1')) {
      const existing = this.state.string(key)
      if (!existing || existing.value !== String(args[1])) {
        return 0
      }
      this.state.strings.delete(key)
      return 1
    }
    const members = this.state.sortedSets.get(key) ?? new Map<string, number>()
    for (const [member, expiresAt] of members) {
      if (expiresAt <= this.state.now) {
        members.delete(member)
      }
    }
    if (script.includes('SRN_SYNC_SOCKET_BUDGET_ACQUIRE_V1')) {
      const member = String(args[1])
      const ttlMs = Number(args[2])
      const maximum = Number(args[3])
      if (!members.has(member) && members.size >= maximum) {
        return 0
      }
      members.set(member, this.state.now + ttlMs)
      this.state.sortedSets.set(key, members)
      return 1
    }
    if (script.includes('SRN_SYNC_SOCKET_BUDGET_RENEW_V1')) {
      const member = String(args[1])
      if (!members.has(member)) {
        return 0
      }
      members.set(member, this.state.now + Number(args[2]))
      this.state.sortedSets.set(key, members)
      return 1
    }
    if (script.includes('SRN_SYNC_SOCKET_BUDGET_RELEASE_V1')) {
      members.delete(String(args[1]))
      if (members.size === 0) {
        this.state.sortedSets.delete(key)
      }
      return 1
    }
    throw new Error('unexpected script')
  }
}

const identity: SyncTicketIdentity = {
  userUuid: 'user-1',
  sessionUuid: 'session-1',
  deviceId: 'device-1',
  authorization: 'Bearer highly-sensitive-session-token',
}

const lease = (
  overrides: Partial<Parameters<ReturnType<typeof createRedisSyncState>['leases']['acquire']>[0]> = {},
) => ({
  userUuid: 'user-1',
  deviceId: 'device-1',
  commandId: 'command-1',
  digest: 'a'.repeat(64),
  ownerId: 'owner-1',
  ...overrides,
})

describe('fleet-shared Redis sync state', () => {
  it('stores only a ticket digest plus ticket-derived authenticated ciphertext and consumes once across instances', async () => {
    const backend = new SharedRedisHarness()
    const first = createRedisSyncState(new FakeRedisClient(backend), { keyPrefix: 'test:sync' })
    const second = createRedisSyncState(new FakeRedisClient(backend), { keyPrefix: 'test:sync' })

    const issued = await first.tickets.issue(identity)
    const [[key, stored]] = [...backend.strings.entries()]
    expect(key).not.toContain(issued.ticket)
    expect(key).not.toContain(identity.userUuid)
    expect(stored.value).not.toContain(identity.userUuid)
    expect(stored.value).not.toContain(identity.authorization)

    const results = await Promise.all([first.tickets.consume(issued.ticket), second.tickets.consume(issued.ticket)])
    expect(results.filter(Boolean)).toEqual([identity])
    expect(results.filter((value) => value === undefined)).toHaveLength(1)
  })

  it('accepts a Buffer reply, rejects tampering and expiry, and fails closed during outage', async () => {
    const backend = new SharedRedisHarness()
    const client = new FakeRedisClient(backend)
    const store = new RedisSyncAuthTicketStore(client, { operationTimeoutMs: 20 }, () => backend.now)
    backend.returnBuffers = true
    const buffered = await store.issue(identity, 1_000)
    await expect(store.consume(buffered.ticket)).resolves.toEqual(identity)

    const tampered = await store.issue(identity, 1_000)
    const entry = [...backend.strings.values()][0]
    entry.value = entry.value.replace(/.$/u, entry.value.endsWith('A') ? 'B' : 'A')
    await expect(store.consume(tampered.ticket)).resolves.toBeUndefined()

    const expired = await store.issue(identity, 1_000)
    backend.now += 1_001
    await expect(store.consume(expired.ticket)).resolves.toBeUndefined()

    client.status = 'end'
    expect(store.ready()).toBe(false)
    await expect(store.issue(identity)).rejects.toThrow(/unavailable/i)
    await expect(store.consume('x'.repeat(43))).resolves.toBeUndefined()
  })

  it('bounds Redis operations and honors caller cancellation', async () => {
    const backend = new SharedRedisHarness()
    const store = new RedisSyncAuthTicketStore(new FakeRedisClient(backend), { operationTimeoutMs: 5 })
    const issued = await store.issue(identity)
    backend.hang = true
    await expect(store.consume(issued.ticket)).rejects.toThrow(/timed out/i)

    const controller = new AbortController()
    controller.abort()
    await expect(store.consume('x'.repeat(43), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('coordinates command lease conflict, renewal, release, and TTL takeover across replicas', async () => {
    const backend = new SharedRedisHarness()
    const first = createRedisSyncState(new FakeRedisClient(backend), {
      operationTimeoutMs: 100,
      commandLeaseTtlMs: 4_000,
    })
    const second = createRedisSyncState(new FakeRedisClient(backend), {
      operationTimeoutMs: 100,
      commandLeaseTtlMs: 4_000,
    })

    await expect(first.leases.acquire(lease())).resolves.toEqual({ acquired: true })
    await expect(first.leases.acquire(lease({ digest: 'invalid' }))).rejects.toThrow(/digest/i)
    await expect(first.leases.acquire(lease({ ownerId: '' }))).rejects.toThrow(/identifier/i)
    await expect(second.leases.acquire(lease({ commandId: 'command-2', ownerId: 'owner-2' }))).resolves.toEqual({
      acquired: false,
      reason: 'BUSY',
    })
    await expect(second.leases.acquire(lease({ digest: 'b'.repeat(64), ownerId: 'owner-2' }))).resolves.toEqual({
      acquired: false,
      reason: 'COMMAND_ID_CONFLICT',
    })
    await expect(first.leases.renew(lease())).resolves.toBe(true)
    await second.leases.release(lease({ ownerId: 'owner-2' }))
    await expect(second.leases.acquire(lease({ commandId: 'command-2', ownerId: 'owner-2' }))).resolves.toEqual({
      acquired: false,
      reason: 'BUSY',
    })
    await first.leases.release(lease())
    await expect(second.leases.acquire(lease({ commandId: 'command-2', ownerId: 'owner-2' }))).resolves.toEqual({
      acquired: true,
    })

    backend.now += 4_001
    await expect(first.leases.acquire(lease({ commandId: 'takeover', ownerId: 'owner-3' }))).resolves.toEqual({
      acquired: true,
    })
  })

  it('enforces and reclaims the fleet-wide authenticated socket cap', async () => {
    const backend = new SharedRedisHarness()
    const first = createRedisSyncState(new FakeRedisClient(backend), {
      operationTimeoutMs: 100,
      maxSocketsPerUser: 2,
      socketLeaseTtlMs: 4_000,
    })
    const second = createRedisSyncState(new FakeRedisClient(backend), {
      operationTimeoutMs: 100,
      maxSocketsPerUser: 2,
      socketLeaseTtlMs: 4_000,
    })
    const owner1 = { userUuid: 'user-1', ownerId: 'socket-1' }
    const owner2 = { userUuid: 'user-1', ownerId: 'socket-2' }
    const owner3 = { userUuid: 'user-1', ownerId: 'socket-3' }

    await expect(first.socketBudget.acquire(owner1)).resolves.toBe(true)
    await expect(second.socketBudget.acquire(owner2)).resolves.toBe(true)
    await expect(first.socketBudget.acquire(owner3)).resolves.toBe(false)
    await expect(second.socketBudget.renew(owner1)).resolves.toBe(true)
    await first.socketBudget.release(owner1)
    await expect(second.socketBudget.acquire(owner3)).resolves.toBe(true)
    backend.now += 4_001
    await expect(first.socketBudget.renew(owner2)).resolves.toBe(false)
    await expect(first.socketBudget.acquire(owner1)).resolves.toBe(true)
  })

  it('validates Redis factory limits and reports unavailable primitives as not ready', async () => {
    const backend = new SharedRedisHarness()
    const client = new FakeRedisClient(backend)
    expect(() => createRedisSyncState(client, { keyPrefix: '../bad' })).toThrow(/prefix/i)
    expect(() => createRedisSyncState(client, { operationTimeoutMs: 0 })).toThrow(/timeout/i)
    expect(() => createRedisSyncState(client, { commandLeaseTtlMs: 300_001 })).toThrow(/TTL/i)
    expect(() => createRedisSyncState(client, { socketLeaseTtlMs: 0 })).toThrow(/TTL/i)
    expect(() => createRedisSyncState(client, { maxSocketsPerUser: 0 })).toThrow(/socket limit/i)
    expect(() => createRedisSyncState(client, { operationTimeoutMs: 1_001, commandLeaseTtlMs: 4_003 })).toThrow(
      /command lease TTL.*at least 4004 ms.*4x/i,
    )
    expect(() => createRedisSyncState(client, { operationTimeoutMs: 1, socketLeaseTtlMs: 3_999 })).toThrow(
      /socket lease TTL.*at least 4000 ms.*1000 ms renewal floor/i,
    )

    const boundary = createRedisSyncState(client, {
      operationTimeoutMs: 100,
      commandLeaseTtlMs: 4_000,
      socketLeaseTtlMs: 4_000,
    })
    expect(boundary.leaseRenewIntervalMs).toBe(1_000)
    expect(boundary.socketBudgetRenewIntervalMs).toBe(1_000)

    const timeoutBoundary = createRedisSyncState(client, {
      operationTimeoutMs: 1_001,
      commandLeaseTtlMs: 4_004,
      socketLeaseTtlMs: 4_004,
    })
    expect(timeoutBoundary.leaseRenewIntervalMs).toBe(1_001)
    expect(timeoutBoundary.socketBudgetRenewIntervalMs).toBe(1_001)

    const configured = createRedisSyncState(client, {
      operationTimeoutMs: 100,
      commandLeaseTtlMs: 4_001,
      socketLeaseTtlMs: 8_003,
    })
    expect(configured.leaseRenewIntervalMs).toBe(1_000)
    expect(configured.socketBudgetRenewIntervalMs).toBe(2_000)

    const state = createRedisSyncState(client)
    expect(state.leaseRenewIntervalMs).toBe(7_500)
    expect(state.socketBudgetRenewIntervalMs).toBe(18_750)
    client.status = 'reconnecting'
    expect(state.leases.ready()).toBe(false)
    expect(state.socketBudget.ready()).toBe(false)
    await expect(state.leases.acquire(lease())).rejects.toThrow(/unavailable/i)
    await expect(state.leases.renew(lease())).resolves.toBe(false)
    await expect(state.leases.release(lease())).resolves.toBeUndefined()
    await expect(state.socketBudget.acquire({ userUuid: 'user-1', ownerId: 'owner' })).resolves.toBe(false)
    await expect(state.socketBudget.renew({ userUuid: 'user-1', ownerId: 'owner' })).resolves.toBe(false)
    await expect(state.socketBudget.release({ userUuid: 'user-1', ownerId: 'owner' })).resolves.toBeUndefined()
  })
})

describe('explicit process-local sync state', () => {
  it('expires, conflicts, renews, and ownership-checks command leases', async () => {
    let now = 1_000
    const leases = new InMemorySyncCommandLeaseRegistry(() => now, 100)
    expect(leases.ready()).toBe(true)
    await expect(leases.renew(lease())).resolves.toBe(false)
    await expect(leases.acquire(lease())).resolves.toEqual({ acquired: true })
    await expect(leases.acquire(lease({ digest: 'b'.repeat(64) }))).resolves.toEqual({
      acquired: false,
      reason: 'COMMAND_ID_CONFLICT',
    })
    await expect(leases.acquire(lease({ commandId: 'other' }))).resolves.toEqual({ acquired: false, reason: 'BUSY' })
    await expect(leases.renew(lease({ commandId: 'other' }))).resolves.toBe(false)
    await expect(leases.renew(lease({ ownerId: 'other-owner' }))).resolves.toBe(false)
    await expect(leases.renew(lease({ digest: 'b'.repeat(64) }))).resolves.toBe(false)
    await expect(leases.renew(lease())).resolves.toBe(true)
    await leases.release(lease({ ownerId: 'other-owner' }))
    await expect(leases.acquire(lease({ commandId: 'still-busy' }))).resolves.toEqual({
      acquired: false,
      reason: 'BUSY',
    })
    await leases.release(lease())
    await expect(leases.acquire(lease({ commandId: 'replacement' }))).resolves.toEqual({ acquired: true })
    now += 101
    await expect(leases.renew(lease({ commandId: 'replacement' }))).resolves.toBe(false)
    await expect(leases.acquire(lease({ commandId: 'after-expiry' }))).resolves.toEqual({ acquired: true })

    const acquireExpiry = new InMemorySyncCommandLeaseRegistry(() => now, 100)
    await acquireExpiry.acquire(lease({ commandId: 'before-expiry' }))
    now += 101
    await expect(acquireExpiry.acquire(lease({ commandId: 'direct-takeover' }))).resolves.toEqual({ acquired: true })
  })

  it('bounds, refreshes, expires, and releases process-local socket reservations', async () => {
    expect(() => new InMemorySyncSocketBudget(0)).toThrow(/socket limit/i)
    expect(() => new InMemorySyncSocketBudget(1.5)).toThrow(/socket limit/i)
    let now = 1_000
    const budget = new InMemorySyncSocketBudget(1, () => now, 100)
    const first = { userUuid: 'user', ownerId: 'first' }
    const second = { userUuid: 'user', ownerId: 'second' }
    expect(budget.ready()).toBe(true)
    await expect(budget.renew(first)).resolves.toBe(false)
    await expect(budget.acquire(first)).resolves.toBe(true)
    await expect(budget.acquire(first)).resolves.toBe(true)
    await expect(budget.acquire(second)).resolves.toBe(false)
    await expect(budget.renew(first)).resolves.toBe(true)
    await budget.release({ userUuid: 'missing-user', ownerId: 'missing' })
    await budget.release(first)
    await expect(budget.acquire(second)).resolves.toBe(true)
    now += 101
    await expect(budget.renew(second)).resolves.toBe(false)
    await expect(budget.acquire(first)).resolves.toBe(true)
  })
})
