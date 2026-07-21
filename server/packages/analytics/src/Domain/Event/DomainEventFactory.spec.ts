import 'reflect-metadata'

import { TimerInterface } from '@standardnotes/time'

import { DomainEventFactory } from './DomainEventFactory'

describe('DomainEventFactory', () => {
  let timer: TimerInterface

  const createFactory = () => new DomainEventFactory(timer)

  beforeEach(() => {
    timer = {} as jest.Mocked<TimerInterface>
    timer.getUTCDate = jest.fn().mockReturnValue(new Date(1))
  })

  it('should create an EMAIL_REQUESTED event stamped with the current utc date', () => {
    const event = createFactory().createEmailRequestedEvent({
      userEmail: 'test@test.te',
      messageIdentifier: 'EMAIL_BACKUP',
      level: 'system',
      body: '<p>body</p>',
      subject: 'A subject',
    })

    expect(event.type).toEqual('EMAIL_REQUESTED')
    expect(event.createdAt).toEqual(new Date(1))
  })

  it('should correlate the event to the recipient by email address and mark analytics as the origin', () => {
    const event = createFactory().createEmailRequestedEvent({
      userEmail: 'test@test.te',
      messageIdentifier: 'EMAIL_BACKUP',
      level: 'system',
      body: '<p>body</p>',
      subject: 'A subject',
    })

    expect(event.meta).toEqual({
      correlation: {
        userIdentifier: 'test@test.te',
        userIdentifierType: 'email',
      },
      origin: 'analytics',
    })
  })

  it('should carry the request through as the payload verbatim', () => {
    const dto = {
      userEmail: 'test@test.te',
      messageIdentifier: 'EMAIL_BACKUP',
      level: 'system',
      body: '<p>body</p>',
      subject: 'A subject',
    }

    expect(createFactory().createEmailRequestedEvent(dto).payload).toEqual(dto)
  })
})
