import 'reflect-metadata'

import * as OpenTelemetryApi from '@opentelemetry/api'
import { Message, SQSClient } from '@aws-sdk/client-sqs'
import { Consumer } from 'sqs-consumer'
import { Logger } from 'winston'

import { DomainEventMessageHandlerInterface } from '@standardnotes/domain-events'

import { SQSOpenTelemetryDomainEventSubscriber } from './SQSOpenTelemetryDomainEventSubscriber'

jest.mock('sqs-consumer')

describe('SQSOpenTelemetryDomainEventSubscriber', () => {
  let sqs: SQSClient
  let domainEventMessageHandler: jest.Mocked<DomainEventMessageHandlerInterface>
  let logger: jest.Mocked<Logger>
  let consumer: { on: jest.Mock; start: jest.Mock; stop: jest.Mock; status: { isRunning: boolean } }
  let span: { end: jest.Mock; recordException: jest.Mock }
  let startSpan: jest.Mock

  const createSubscriber = () =>
    new SQSOpenTelemetryDomainEventSubscriber(
      'syncing-server',
      sqs,
      'https://sqs/queue',
      domainEventMessageHandler,
      logger,
    )

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

    span = { end: jest.fn(), recordException: jest.fn() }
    startSpan = jest.fn().mockReturnValue(span)
    jest.spyOn(OpenTelemetryApi.trace, 'getTracer').mockReturnValue({ startSpan } as never)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('registers a pre-receive callback so each poll opens a parent span', () => {
    createSubscriber().start()

    const config = (Consumer.create as jest.Mock).mock.calls[0][0]
    expect(typeof config.preReceiveMessageCallback).toEqual('function')
    expect(config.queueUrl).toEqual('https://sqs/queue')
    expect(consumer.start).toHaveBeenCalled()
  })

  it('opens a consumer-kind span named after the service', async () => {
    const subscriber = createSubscriber()

    await subscriber.startParentSpan()

    expect(OpenTelemetryApi.trace.getTracer).toHaveBeenCalledWith('syncing-server-domain-event-subscriber')
    expect(startSpan).toHaveBeenCalledWith('syncing-server', { kind: OpenTelemetryApi.SpanKind.CONSUMER })
  })

  it('ends the open span after a message is handled', async () => {
    const subscriber = createSubscriber()
    await subscriber.startParentSpan()

    const result = await subscriber.handleMessage({ Body: 'raw-message-body' } as Message)

    expect(domainEventMessageHandler.handleMessage).toHaveBeenCalledWith('raw-message-body')
    expect(span.end).toHaveBeenCalledTimes(1)
    expect(result).toBeUndefined()
  })

  it('does not end a span twice across consecutive messages', async () => {
    const subscriber = createSubscriber()
    await subscriber.startParentSpan()

    await subscriber.handleMessage({ Body: 'first' } as Message)
    await subscriber.handleMessage({ Body: 'second' } as Message)

    expect(span.end).toHaveBeenCalledTimes(1)
  })

  it('handles a message even when no span was opened', async () => {
    await expect(createSubscriber().handleMessage({ Body: 'body' } as Message)).resolves.toBeUndefined()
    expect(span.end).not.toHaveBeenCalled()
  })

  it('records the exception on the open span and ends it on error', async () => {
    const subscriber = createSubscriber()
    subscriber.start()
    await subscriber.startParentSpan()
    const error = new Error('sqs blew up')

    registeredOn('processing_error')[0](error as never)

    expect(logger.error).toHaveBeenCalledWith('Error occured while handling SQS message: %O', error)
    expect(span.recordException).toHaveBeenCalledWith(error)
    expect(span.end).toHaveBeenCalledTimes(1)
  })

  it('logs an error with no span open without throwing', () => {
    const subscriber = createSubscriber()
    subscriber.start()

    expect(() => registeredOn('error')[0](new Error('boom') as never)).not.toThrow()
    expect(span.recordException).not.toHaveBeenCalled()
  })

  it('stops a running consumer and leaves a stopped one alone', () => {
    const subscriber = createSubscriber()
    subscriber.start()

    subscriber.stop()
    expect(logger.info).toHaveBeenCalledWith('Stopping SQS consumer...')
    expect(consumer.stop).toHaveBeenCalledTimes(1)

    consumer.status.isRunning = false
    subscriber.stop()
    expect(consumer.stop).toHaveBeenCalledTimes(1)
  })

  it('tolerates stop() before start()', () => {
    expect(() => createSubscriber().stop()).not.toThrow()
  })
})
