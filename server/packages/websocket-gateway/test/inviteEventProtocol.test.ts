import { describe, expect, it } from 'vitest'
import { isInviteEventReplay, isStoredInviteEvent } from '../src/inviteEventProtocol.js'
import { inviteRealtimeProtocolEvents } from './fixtures/inviteRealtimeEvents.js'

describe('invite event wire compatibility', () => {
  it('accepts legacy invite actions and every membership/application-state action in one versioned schema', () => {
    const events = inviteRealtimeProtocolEvents()

    // 6 invite + 6 subscription + 5 membership (role-changed dropped with the client contract, N16) + 2 application-state
    expect(events).toHaveLength(19)
    expect(events.every(isStoredInviteEvent)).toBe(true)
    const membership = events.find(
      (candidate) => candidate.kind === 'shared-vault-membership' && candidate.action === 'left',
    )
    // The client disconnects on an action it does not know; the wire validator must not let one through.
    expect(isStoredInviteEvent({ ...membership, action: 'role-changed' })).toBe(false)
    expect(
      isInviteEventReplay(
        {
          previousCursor: 'cursor-0',
          events,
          nextCursor: events.at(-1)?.streamPosition,
          hasMore: false,
        },
        'cursor-0',
        100,
      ),
    ).toBe(true)
  })

  it('fails closed on unknown versions, extra data, malformed sequencing, and oversized batches', () => {
    const event = inviteRealtimeProtocolEvents()[0]

    expect(isStoredInviteEvent({ ...event, version: 2 })).toBe(false)
    expect(isStoredInviteEvent({ ...event, plaintext: 'must never cross the event stream' })).toBe(false)
    expect(isStoredInviteEvent({ ...event, binary: new Uint8Array([1]) })).toBe(false)
    expect(
      isInviteEventReplay(
        {
          previousCursor: 'cursor-0',
          events: [event],
          nextCursor: 'different-cursor',
          hasMore: false,
        },
        'cursor-0',
        1,
      ),
    ).toBe(false)
    expect(
      isInviteEventReplay(
        {
          previousCursor: 'cursor-0',
          events: Array.from({ length: 101 }, () => event),
          nextCursor: event.streamPosition,
          hasMore: true,
        },
        'cursor-0',
        100,
      ),
    ).toBe(false)
  })

  it('accepts an empty caught-up replay only when it preserves the cursor', () => {
    expect(
      isInviteEventReplay(
        { previousCursor: 'cursor-0', events: [], nextCursor: 'cursor-0', hasMore: false },
        'cursor-0',
        10,
      ),
    ).toBe(true)
    expect(
      isInviteEventReplay(
        { previousCursor: 'cursor-0', events: [], nextCursor: 'cursor-1', hasMore: false },
        'cursor-0',
        10,
      ),
    ).toBe(false)
  })
})
