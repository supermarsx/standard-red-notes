import { describe, expect, it } from 'vitest'

import { InMemorySyncAuthTicketStore, type SyncTicketIdentity } from '../src/auth.js'

const validIdentity: SyncTicketIdentity = {
  userUuid: 'user-1',
  sessionUuid: 'session-1',
  deviceId: 'device-1',
  authorization: 'Bearer token',
}

describe('InMemorySyncAuthTicketStore validation and lifecycle', () => {
  it.each([
    { ...validIdentity, userUuid: '' },
    { ...validIdentity, userUuid: 'u'.repeat(129) },
    { ...validIdentity, sessionUuid: '' },
    { ...validIdentity, sessionUuid: 's'.repeat(129) },
    { ...validIdentity, deviceId: '../bad' },
    { ...validIdentity, authorization: '' },
    { ...validIdentity, authorization: 'a'.repeat(16_385) },
  ])('rejects an invalid server-side identity %#', async (identity) => {
    await expect(new InMemorySyncAuthTicketStore().issue(identity)).rejects.toThrow(/identity/i)
  })

  it.each([999, 120_001, 1_000.5])('rejects unsafe ticket TTL %s', async (ttl) => {
    await expect(new InMemorySyncAuthTicketStore().issue(validIdentity, ttl)).rejects.toThrow(/TTL/)
  })

  it('rejects malformed and unknown tickets without exposing store state', async () => {
    const store = new InMemorySyncAuthTicketStore()
    await expect(store.consume(undefined as unknown as string)).resolves.toBeUndefined()
    await expect(store.consume('short')).resolves.toBeUndefined()
    await expect(store.consume('x'.repeat(257))).resolves.toBeUndefined()
    await expect(store.consume('x'.repeat(43))).resolves.toBeUndefined()
  })

  it('sweeps expired entries and clears every remaining opaque ticket', async () => {
    let now = 1_000
    const store = new InMemorySyncAuthTicketStore(() => now)
    const expired = await store.issue(validIdentity, 1_000)
    now = 2_001
    const current = await store.issue(validIdentity, 1_000)

    await expect(store.consume(expired.ticket)).resolves.toBeUndefined()
    store.clear()
    await expect(store.consume(current.ticket)).resolves.toBeUndefined()
  })
})
