import 'reflect-metadata'

import { Logger } from 'winston'

import { DomainEventHandlerInterface, DomainEventInterface } from '@standardnotes/domain-events'

import { DirectCallEventMessageHandler } from './DirectCallEventMessageHandler'

describe('DirectCallEventMessageHandler', () => {
  let handler: jest.Mocked<DomainEventHandlerInterface>
  let handlers: Map<string, DomainEventHandlerInterface>
  let logger: jest.Mocked<Logger>
  let event: DomainEventInterface

  const createHandler = () => new DirectCallEventMessageHandler(handlers, logger)

  beforeEach(() => {
    handler = {} as jest.Mocked<DomainEventHandlerInterface>
    handler.handle = jest.fn().mockResolvedValue(undefined)

    handlers = new Map([['TEST', handler]])

    logger = {} as jest.Mocked<Logger>
    logger.debug = jest.fn()
    logger.error = jest.fn()

    event = {
      type: 'TEST',
      createdAt: new Date(1),
      meta: { correlation: { userIdentifier: 'user-1', userIdentifierType: 'uuid' }, origin: 'auth' },
      payload: { foo: 'bar' },
    } as unknown as DomainEventInterface
  })

  it('dispatches an event object to the handler registered for its type', async () => {
    await createHandler().handleMessage(event)

    expect(handler.handle).toHaveBeenCalledWith(event)
    expect(logger.debug).toHaveBeenCalledWith('Received event: TEST')
  })

  it('refuses a raw string message', async () => {
    // Unlike the SQS/Redis handlers this one is fed already-deserialised events by
    // the in-process publisher, so a string here means a wiring mistake.
    await expect(createHandler().handleMessage('some-string')).rejects.toThrow(
      'DirectCallEventMessageHandler does not support string messages',
    )
    expect(handler.handle).not.toHaveBeenCalled()
  })

  it('ignores an event with no registered handler', async () => {
    await createHandler().handleMessage({ ...event, type: 'UNREGISTERED' } as DomainEventInterface)

    expect(handler.handle).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith('Event handler for event type UNREGISTERED does not exist')
  })

  it('propagates a failure from the handler', async () => {
    handler.handle = jest.fn().mockRejectedValue(new Error('handler failed'))

    await expect(createHandler().handleMessage(event)).rejects.toThrow('handler failed')
  })

  it('logs a safe classification for an error passed to handleError', async () => {
    const error = new Error('subscriber failure')

    await createHandler().handleError(error)

    expect(logger.error).toHaveBeenCalledWith(
      'Error occurred while handling a direct-call event.',
      expect.objectContaining({ errorType: 'Error' }),
    )
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('subscriber failure')
  })
})
