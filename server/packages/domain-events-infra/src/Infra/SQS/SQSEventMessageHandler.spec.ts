import 'reflect-metadata'

import * as zlib from 'zlib'
import { Logger } from 'winston'

import { DomainEventHandlerInterface } from '@standardnotes/domain-events'

import { SQSEventMessageHandler } from './SQSEventMessageHandler'

describe('SQSEventMessageHandler', () => {
  let handler: jest.Mocked<DomainEventHandlerInterface>
  let handlers: Map<string, DomainEventHandlerInterface>
  let logger: jest.Mocked<Logger>

  const createHandler = () => new SQSEventMessageHandler(handlers, logger)

  /** Builds the SNS->SQS envelope shape the handler expects. */
  const snsEnvelope = (event: unknown): string =>
    JSON.stringify({ Message: zlib.deflateSync(Buffer.from(JSON.stringify(event))).toString('base64') })

  const domainEvent = {
    type: 'TEST',
    createdAt: '2020-01-01T00:00:00.000Z',
    meta: { correlation: { userIdentifier: 'user-1', userIdentifierType: 'uuid' }, origin: 'auth' },
    payload: { foo: 'bar' },
  }

  beforeEach(() => {
    handler = {} as jest.Mocked<DomainEventHandlerInterface>
    handler.handle = jest.fn().mockResolvedValue(undefined)

    handlers = new Map([['TEST', handler]])

    logger = {} as jest.Mocked<Logger>
    logger.debug = jest.fn()
    logger.warn = jest.fn()
    logger.error = jest.fn()
  })

  it('inflates the envelope and dispatches to the handler for the event type', async () => {
    await createHandler().handleMessage(snsEnvelope(domainEvent))

    expect(handler.handle).toHaveBeenCalledTimes(1)
    expect(logger.debug).toHaveBeenCalledWith('Received event: TEST')
  })

  it('revives createdAt as a Date rather than leaving it a string', async () => {
    await createHandler().handleMessage(snsEnvelope(domainEvent))

    const dispatched = handler.handle.mock.calls[0][0]
    expect(dispatched.createdAt).toBeInstanceOf(Date)
    expect(dispatched.createdAt.toISOString()).toEqual('2020-01-01T00:00:00.000Z')
  })

  it('preserves the payload and meta through the round trip', async () => {
    await createHandler().handleMessage(snsEnvelope(domainEvent))

    const dispatched = handler.handle.mock.calls[0][0]
    expect(dispatched.payload).toEqual({ foo: 'bar' })
    expect(dispatched.meta.origin).toEqual('auth')
  })

  it('suppresses a completed redelivery with the same durable event id', async () => {
    const durableEvent = { ...domainEvent, eventId: 'event-1' }
    const message = snsEnvelope(durableEvent)
    const messageHandler = createHandler()

    await messageHandler.handleMessage(message)
    await messageHandler.handleMessage(message)

    expect(handler.handle).toHaveBeenCalledTimes(1)
  })

  it('also accepts a gzip-compressed envelope', async () => {
    const body = JSON.stringify({
      Message: zlib.gzipSync(Buffer.from(JSON.stringify(domainEvent))).toString('base64'),
    })

    await createHandler().handleMessage(body)

    expect(handler.handle).toHaveBeenCalledTimes(1)
  })

  it('warns once per unhandled event type, then counts further occurrences at debug', async () => {
    const messageHandler = createHandler()

    await messageHandler.handleMessage(snsEnvelope({ ...domainEvent, type: 'UNREGISTERED' }))

    expect(handler.handle).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      'unhandled event type UNREGISTERED; check the SQS_QUEUE_URL of this worker',
    )
    expect(logger.debug).not.toHaveBeenCalled()

    await messageHandler.handleMessage(snsEnvelope({ ...domainEvent, type: 'UNREGISTERED' }))
    await messageHandler.handleMessage(snsEnvelope({ ...domainEvent, type: 'ALSO_UNREGISTERED' }))

    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenLastCalledWith(
      'unhandled event type ALSO_UNREGISTERED; check the SQS_QUEUE_URL of this worker',
    )
    expect(logger.debug).toHaveBeenCalledWith(
      'Event handler for event type UNREGISTERED does not exist (2 unhandled so far)',
    )
    expect([...messageHandler.unhandledEventTypeCounts()]).toEqual([
      ['UNREGISTERED', 2],
      ['ALSO_UNREGISTERED', 1],
    ])
    expect(handler.handle).not.toHaveBeenCalled()
  })

  it('stops remembering new unhandled types once 256 distinct ones were seen', async () => {
    const messageHandler = createHandler()
    for (let index = 0; index < 256; index += 1) {
      await messageHandler.handleMessage(snsEnvelope({ ...domainEvent, type: `UNREGISTERED_${index}` }))
    }
    expect(logger.warn).toHaveBeenCalledTimes(256)

    await messageHandler.handleMessage(snsEnvelope({ ...domainEvent, type: 'ONE_TOO_MANY' }))

    expect(logger.warn).toHaveBeenCalledTimes(256)
    expect(logger.debug).toHaveBeenCalledWith('Event handler for event type ONE_TOO_MANY does not exist')
    expect(messageHandler.unhandledEventTypeCounts().has('ONE_TOO_MANY')).toBe(false)
    expect(messageHandler.unhandledEventTypeCounts().size).toBe(256)

    // A type already tracked keeps counting past the cap.
    await messageHandler.handleMessage(snsEnvelope({ ...domainEvent, type: 'UNREGISTERED_0' }))
    expect(messageHandler.unhandledEventTypeCounts().get('UNREGISTERED_0')).toBe(2)
  })

  it('throws on an envelope that is not valid json', async () => {
    await expect(createHandler().handleMessage('not-json')).rejects.toThrow()
    expect(handler.handle).not.toHaveBeenCalled()
  })

  it('throws when the compressed message is not inflatable', async () => {
    await expect(createHandler().handleMessage(JSON.stringify({ Message: 'bm90LXpsaWI=' }))).rejects.toThrow()
    expect(handler.handle).not.toHaveBeenCalled()
  })

  it('propagates a failure from the handler', async () => {
    handler.handle = jest.fn().mockRejectedValue(new Error('handler failed'))

    await expect(createHandler().handleMessage(snsEnvelope(domainEvent))).rejects.toThrow('handler failed')
  })

  it('logs a safe classification for an error passed to handleError', async () => {
    const error = new Error('subscriber failure')

    await createHandler().handleError(error)

    expect(logger.error).toHaveBeenCalledWith(
      'Error occurred while handling an SQS message.',
      expect.objectContaining({ errorType: 'Error' }),
    )
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('subscriber failure')
  })
})
