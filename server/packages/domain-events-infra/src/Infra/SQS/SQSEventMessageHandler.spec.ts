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

  it('also accepts a gzip-compressed envelope', async () => {
    const body = JSON.stringify({
      Message: zlib.gzipSync(Buffer.from(JSON.stringify(domainEvent))).toString('base64'),
    })

    await createHandler().handleMessage(body)

    expect(handler.handle).toHaveBeenCalledTimes(1)
  })

  it('ignores an event with no registered handler', async () => {
    await createHandler().handleMessage(snsEnvelope({ ...domainEvent, type: 'UNREGISTERED' }))

    expect(handler.handle).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith('Event handler for event type UNREGISTERED does not exist')
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

  it('logs an error passed to handleError', async () => {
    const error = new Error('subscriber failure')

    await createHandler().handleError(error)

    expect(logger.error).toHaveBeenCalledWith('Error occured while handling SQS message: %O', error)
  })
})
