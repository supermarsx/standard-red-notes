import 'reflect-metadata'

import { Message, SQSClient } from '@aws-sdk/client-sqs'
import { Consumer } from 'sqs-consumer'
import { Logger } from 'winston'

import { DomainEventMessageHandlerInterface } from '@standardnotes/domain-events'

import { SQSDomainEventSubscriber } from './SQSDomainEventSubscriber'

jest.mock('sqs-consumer')

describe('SQSDomainEventSubscriber', () => {
  let sqs: SQSClient
  let domainEventMessageHandler: jest.Mocked<DomainEventMessageHandlerInterface>
  let logger: jest.Mocked<Logger>
  let consumer: {
    on: jest.Mock
    start: jest.Mock
    stop: jest.Mock
    status: { isRunning: boolean }
  }

  const createSubscriber = () =>
    new SQSDomainEventSubscriber(sqs, 'https://sqs/queue', domainEventMessageHandler, logger)

  /** The handlers the subscriber registered on the consumer, by event name. */
  const registeredOn = (event: string): ((...args: never[]) => unknown)[] =>
    consumer.on.mock.calls.filter((call) => call[0] === event).map((call) => call[1])

  beforeEach(() => {
    sqs = {} as SQSClient

    domainEventMessageHandler = {} as jest.Mocked<DomainEventMessageHandlerInterface>
    domainEventMessageHandler.handleMessage = jest.fn().mockResolvedValue(undefined)
    domainEventMessageHandler.handleError = jest.fn().mockResolvedValue(undefined)

    logger = {} as jest.Mocked<Logger>
    logger.info = jest.fn()
    logger.error = jest.fn()

    consumer = { on: jest.fn(), start: jest.fn(), stop: jest.fn(), status: { isRunning: true } }
    ;(Consumer.create as jest.Mock) = jest.fn().mockReturnValue(consumer)
  })

  it('creates the consumer against the configured queue and sqs client, then starts it', () => {
    createSubscriber().start()

    const config = (Consumer.create as jest.Mock).mock.calls[0][0]
    expect(config.queueUrl).toEqual('https://sqs/queue')
    expect(config.sqs).toBe(sqs)
    expect(config.attributeNames).toEqual(['All'])
    expect(config.messageAttributeNames).toEqual(['All'])
    expect(consumer.start).toHaveBeenCalled()
  })

  it('routes both error and processing_error to the logger', () => {
    createSubscriber().start()
    const error = new Error('sqs blew up')

    expect(registeredOn('error')).toHaveLength(1)
    expect(registeredOn('processing_error')).toHaveLength(1)

    registeredOn('error')[0](error as never)
    registeredOn('processing_error')[0](error as never)

    expect(logger.error).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledWith('Error occured while handling SQS message: %O', error)
  })

  it('forwards a received message body to the domain event message handler', async () => {
    const subscriber = createSubscriber()
    subscriber.start()

    const result = await subscriber.handleMessage({ Body: 'raw-message-body' } as Message)

    expect(domainEventMessageHandler.handleMessage).toHaveBeenCalledWith('raw-message-body')
    // sqs-consumer 15 deletes only the message returned by the handler.
    expect(result).toEqual({ Body: 'raw-message-body' })
  })

  it('stops a running consumer and says so', () => {
    const subscriber = createSubscriber()
    subscriber.start()

    subscriber.stop()

    expect(logger.info).toHaveBeenCalledWith('Stopping SQS consumer...')
    expect(consumer.stop).toHaveBeenCalled()
  })

  it('does not stop a consumer that is not running', () => {
    const subscriber = createSubscriber()
    subscriber.start()
    consumer.status.isRunning = false

    subscriber.stop()

    expect(consumer.stop).not.toHaveBeenCalled()
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('tolerates stop() before start()', () => {
    expect(() => createSubscriber().stop()).not.toThrow()
    expect(consumer.stop).not.toHaveBeenCalled()
  })
})
