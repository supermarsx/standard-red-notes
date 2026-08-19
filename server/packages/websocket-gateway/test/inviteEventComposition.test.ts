import { describe, expect, it } from 'vitest'
import { InviteEventAvailabilityBus } from '../src/inviteEventAvailability.js'
import { createSharedInviteEventComposition } from '../src/inviteEventComposition.js'
import { InviteEventStore } from '../src/inviteEventStore.js'

describe('createSharedInviteEventComposition', () => {
  it('returns the exact gateway, transactional producer, and outbox dispatcher seams', () => {
    const store = sharedStore()
    const availability = sharedAvailability()

    const composition = createSharedInviteEventComposition({ store, availability, clock: () => 1 })

    expect(composition.gatewayAdapter.distribution).toBe('shared')
    expect(composition.gatewayAdapter.ready()).toBe(true)
    expect(composition.producer).toBeDefined()
    expect(composition.dispatcher).toBeDefined()
  })

  it('refuses a process-local store or availability bus in the production composition', () => {
    expect(() =>
      createSharedInviteEventComposition({
        store: { ...sharedStore(), distribution: 'process' },
        availability: sharedAvailability(),
      }),
    ).toThrow('shared persistence')
    expect(() =>
      createSharedInviteEventComposition({
        store: sharedStore(),
        availability: { ...sharedAvailability(), distribution: 'process' },
      }),
    ).toThrow('shared persistence')
  })
})

function sharedStore(): InviteEventStore {
  return {
    distribution: 'shared',
    ready: () => true,
    append: async () => ({ cursor: 'cursor-1', duplicate: false }),
    tail: async () => 'cursor-0',
    readAfter: async (_userUuid, cursor) => ({
      previousCursor: cursor,
      events: [],
      nextCursor: cursor,
      hasMore: false,
    }),
  }
}

function sharedAvailability(): InviteEventAvailabilityBus {
  return {
    distribution: 'shared',
    ready: () => true,
    publishAvailability: async () => undefined,
    subscribeAvailability: () => () => undefined,
  }
}
