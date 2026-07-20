import 'reflect-metadata'

import { DomainEventInterface, DomainEventMessageHandlerInterface } from '@standardnotes/domain-events'

import { DirectCallDomainEventPublisher } from './DirectCallDomainEventPublisher'

describe('DirectCallDomainEventPublisher', () => {
  let event: DomainEventInterface

  const createPublisher = () => new DirectCallDomainEventPublisher()

  const createMessageHandler = (): jest.Mocked<DomainEventMessageHandlerInterface> => {
    const handler = {} as jest.Mocked<DomainEventMessageHandlerInterface>
    handler.handleMessage = jest.fn().mockResolvedValue(undefined)
    handler.handleError = jest.fn().mockResolvedValue(undefined)

    return handler
  }

  beforeEach(() => {
    event = {
      type: 'TEST',
      createdAt: new Date(1),
      meta: { correlation: { userIdentifier: 'user-1', userIdentifierType: 'uuid' }, origin: 'auth' },
      payload: { foo: 'bar' },
    } as unknown as DomainEventInterface
  })

  it('publishes the event to every registered handler', async () => {
    const publisher = createPublisher()
    const first = createMessageHandler()
    const second = createMessageHandler()
    publisher.register(first)
    publisher.register(second)

    await publisher.publish(event)

    expect(first.handleMessage).toHaveBeenCalledWith(event)
    expect(second.handleMessage).toHaveBeenCalledWith(event)
  })

  it('publishes to a handler once per registration', async () => {
    const publisher = createPublisher()
    const handler = createMessageHandler()
    publisher.register(handler)
    publisher.register(handler)

    await publisher.publish(event)

    expect(handler.handleMessage).toHaveBeenCalledTimes(2)
  })

  it('is a no-op when no handler has been registered', async () => {
    await expect(createPublisher().publish(event)).resolves.toBeUndefined()
  })

  it('waits for every handler before resolving', async () => {
    const publisher = createPublisher()
    const completed: string[] = []
    const slow = createMessageHandler()
    slow.handleMessage = jest.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      completed.push('slow')
    })
    const fast = createMessageHandler()
    fast.handleMessage = jest.fn().mockImplementation(async () => {
      completed.push('fast')
    })
    publisher.register(slow)
    publisher.register(fast)

    await publisher.publish(event)

    expect(completed).toEqual(['fast', 'slow'])
  })

  it('rejects when a handler rejects', async () => {
    const publisher = createPublisher()
    const failing = createMessageHandler()
    failing.handleMessage = jest.fn().mockRejectedValue(new Error('handler failed'))
    publisher.register(failing)

    await expect(publisher.publish(event)).rejects.toThrow('handler failed')
  })

  it('keeps registrations isolated between publisher instances', async () => {
    const first = createPublisher()
    const second = createPublisher()
    const handler = createMessageHandler()
    first.register(handler)

    await second.publish(event)

    expect(handler.handleMessage).not.toHaveBeenCalled()
  })
})
