import { describe, expect, it, vi } from 'vitest'

import {
  INVITE_REALTIME_DOMAIN_EVENT_TYPE,
  InviteRealtimeDomainEventMessageHandler,
  createInviteRealtimeDomainEventBridge,
} from '../src/inviteEventDomainEventBridge.js'
import { InviteRealtimeDomainEventHandler } from '../src/inviteEventDomainEventHandler.js'
import { inviteAccountOwner, inviteRealtimeProtocolEvents } from './fixtures/inviteRealtimeEvents.js'

describe('createInviteRealtimeDomainEventBridge', () => {
  it('registers DirectCall once, ignores unrelated broadcasts, and reaches the durable dispatcher', async () => {
    const dispatch = vi.fn().mockResolvedValue({ affectedUsers: 1, appended: 1, duplicates: 0 })
    let registered: InviteRealtimeDomainEventMessageHandler | undefined
    const register = vi.fn((handler: InviteRealtimeDomainEventMessageHandler) => {
      registered = handler
    })
    const bridge = createInviteRealtimeDomainEventBridge({
      dispatcher: { dispatch },
      directCallPublisher: { register },
    })

    bridge.start()
    bridge.start()

    expect(register).toHaveBeenCalledTimes(1)
    await registered!.handleMessage({ type: 'SOME_OTHER_EVENT', payload: { secret: 'must not cross' } })
    await registered!.handleMessage(eventEnvelope())
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(eventEnvelope().payload)

    const firstClose = bridge.close()
    const secondClose = bridge.close()
    expect(secondClose).toBe(firstClose)
    await firstClose
    await registered!.handleMessage(eventEnvelope())
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('supplies the standard SQS factory with the strict handler and owns start/stop exactly once', async () => {
    const dispatch = vi.fn().mockResolvedValue({ affectedUsers: 1, appended: 1, duplicates: 0 })
    const start = vi.fn()
    const stop = vi.fn()
    let sqsDomainHandler: InviteRealtimeDomainEventHandler | undefined
    const createSubscriber = vi.fn((handler: InviteRealtimeDomainEventHandler, eventType: string) => {
      sqsDomainHandler = handler
      expect(eventType).toBe(INVITE_REALTIME_DOMAIN_EVENT_TYPE)
      return { start, stop }
    })
    const bridge = createInviteRealtimeDomainEventBridge({
      dispatcher: { dispatch },
      createSubscriber,
    })

    bridge.start()
    bridge.start()
    await sqsDomainHandler!.handle(eventEnvelope())
    await bridge.close()
    await bridge.close()

    expect(createSubscriber).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(eventEnvelope().payload)
    expect(() => bridge.start()).toThrow('closed')
  })

  it('stops a subscriber exactly once when startup fails after it may have acquired resources', async () => {
    const stop = vi.fn()
    const bridge = createInviteRealtimeDomainEventBridge({
      dispatcher: { dispatch: vi.fn() },
      createSubscriber: () => ({
        start: () => {
          throw new Error('consumer start failed')
        },
        stop,
      }),
    })

    expect(() => bridge.start()).toThrow('consumer start failed')
    await bridge.close()
    await bridge.close()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('fails closed if raw SQS data is registered as a DirectCall message', async () => {
    let registered: InviteRealtimeDomainEventMessageHandler | undefined
    const bridge = createInviteRealtimeDomainEventBridge({
      dispatcher: { dispatch: vi.fn() },
      directCallPublisher: {
        register: (handler) => {
          registered = handler
        },
      },
    })
    bridge.start()

    await expect(registered!.handleMessage('{"Message":"compressed"}')).rejects.toThrow('SQSEventMessageHandler')
  })
})

function eventEnvelope() {
  const event = inviteRealtimeProtocolEvents()[0]!
  const { streamPosition: _streamPosition, ...invalidation } = event
  return {
    eventId: event.eventId,
    type: INVITE_REALTIME_DOMAIN_EVENT_TYPE,
    payload: {
      version: 1 as const,
      recordId: event.eventId,
      affectedUserUuids: [inviteAccountOwner],
      event: invalidation,
    },
  }
}
