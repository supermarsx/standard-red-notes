import { DomainEventInterface, DomainEventPublisherInterface } from '@standardnotes/domain-events'

import {
  DomainEventTransportUnavailableError,
  eventBrokerIsConfigured,
  selectCliDomainEventPublisher,
  UndeliverableDomainEventPublisher,
} from './UndeliverableDomainEventPublisher'

const anEvent = (type: string): DomainEventInterface =>
  ({ type, createdAt: new Date(), meta: {}, payload: {} }) as unknown as DomainEventInterface

describe('UndeliverableDomainEventPublisher', () => {
  it('refuses the publish with a typed error naming the event', async () => {
    const publisher = new UndeliverableDomainEventPublisher()

    await expect(publisher.publish(anEvent('FILE_QUOTA_RECALCULATION_REQUESTED'))).rejects.toThrow(
      DomainEventTransportUnavailableError,
    )
  })

  it('carries the event type on the error so a caller can report it', async () => {
    const publisher = new UndeliverableDomainEventPublisher()

    const error = await publisher.publish(anEvent('WEB_SOCKET_MESSAGE_REQUESTED')).catch((caught) => caught)

    expect(error).toBeInstanceOf(DomainEventTransportUnavailableError)
    expect((error as DomainEventTransportUnavailableError).eventType).toBe('WEB_SOCKET_MESSAGE_REQUESTED')
    expect((error as Error).message).toContain('WEB_SOCKET_MESSAGE_REQUESTED')
  })

  it('is never a silent no-op: every publish rejects', async () => {
    const publisher = new UndeliverableDomainEventPublisher()

    const outcomes = await Promise.all(
      ['ACCOUNT_DELETION_REQUESTED', 'USER_ROLES_CHANGED'].map((type) =>
        publisher
          .publish(anEvent(type))
          .then(() => 'resolved')
          .catch(() => 'rejected'),
      ),
    )

    expect(outcomes).toEqual(['rejected', 'rejected'])
  })
})

describe('eventBrokerIsConfigured', () => {
  it('is false when no topic ARN is configured', () => {
    expect(eventBrokerIsConfigured(undefined)).toBe(false)
  })

  it('is false for an empty or whitespace-only topic ARN', () => {
    expect(eventBrokerIsConfigured('')).toBe(false)
    expect(eventBrokerIsConfigured('   ')).toBe(false)
  })

  it('is true for a configured topic ARN', () => {
    expect(eventBrokerIsConfigured('arn:aws:sns:us-east-1:000000000000:auth-local-topic')).toBe(true)
  })
})

describe('selectCliDomainEventPublisher', () => {
  const broker: DomainEventPublisherInterface = { publish: jest.fn() }

  it('uses the broker publisher when the deployment configures a topic', () => {
    const build = jest.fn().mockReturnValue(broker)

    expect(selectCliDomainEventPublisher('arn:aws:sns:us-east-1:000000000000:auth-local-topic', build)).toBe(broker)
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('refuses, and never builds a broker client, when the deployment has no topic', () => {
    const build = jest.fn().mockReturnValue(broker)

    const selected = selectCliDomainEventPublisher('', build)

    expect(selected).toBeInstanceOf(UndeliverableDomainEventPublisher)
    expect(build).not.toHaveBeenCalled()
  })

  it('refuses when the topic variable is absent altogether', () => {
    expect(selectCliDomainEventPublisher(undefined, () => broker)).toBeInstanceOf(UndeliverableDomainEventPublisher)
  })
})
