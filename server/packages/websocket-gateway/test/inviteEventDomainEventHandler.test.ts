import { describe, expect, it, vi } from 'vitest'

import { InviteRealtimeDomainEventHandler } from '../src/inviteEventDomainEventHandler.js'
import {
  inviteAccountMember,
  inviteAccountOwner,
  inviteRealtimeProtocolEvents,
} from './fixtures/inviteRealtimeEvents.js'

describe('InviteRealtimeDomainEventHandler', () => {
  it('passes an exact metadata-only record and all affected accounts to the durable dispatcher', async () => {
    const dispatch = vi.fn().mockResolvedValue({ affectedUsers: 2, appended: 2, duplicates: 0 })
    const handler = new InviteRealtimeDomainEventHandler({ dispatch })
    const event = inviteRealtimeProtocolEvents()[0]!
    const { streamPosition: _streamPosition, ...invalidation } = event
    const record = {
      version: 1 as const,
      recordId: event.eventId,
      affectedUserUuids: [inviteAccountOwner, inviteAccountMember],
      event: invalidation,
    }

    await handler.handle({
      eventId: event.eventId,
      type: 'INVITE_REALTIME_INVALIDATION_REQUESTED',
      payload: record,
    })

    expect(dispatch).toHaveBeenCalledWith(record)
    expect(JSON.stringify(dispatch.mock.calls)).not.toMatch(/email|token|body|encrypted/i)
  })

  it('rejects mismatched identities and any non-contract payload fields', async () => {
    const dispatch = vi.fn()
    const handler = new InviteRealtimeDomainEventHandler({ dispatch })
    const event = inviteRealtimeProtocolEvents()[0]!
    const { streamPosition: _streamPosition, ...invalidation } = event
    const record = {
      version: 1 as const,
      recordId: event.eventId,
      affectedUserUuids: [inviteAccountOwner],
      event: invalidation,
    }

    await expect(
      handler.handle({ type: 'INVITE_REALTIME_INVALIDATION_REQUESTED', eventId: 'wrong', payload: record }),
    ).rejects.toThrow('identity')
    await expect(
      handler.handle({
        type: 'INVITE_REALTIME_INVALIDATION_REQUESTED',
        eventId: event.eventId,
        payload: { ...record, encryptedMessage: 'ciphertext' },
      }),
    ).rejects.toThrow('malformed')
    expect(dispatch).not.toHaveBeenCalled()
  })
})
