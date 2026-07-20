import 'reflect-metadata'

import * as zlib from 'zlib'
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns'

import { DomainEventInterface } from '@standardnotes/domain-events'

import { SNSOpenTelemetryDomainEventPublisher } from './SNSOpenTelemetryDomainEventPublisher'

describe('SNSOpenTelemetryDomainEventPublisher', () => {
  let snsClient: jest.Mocked<SNSClient>
  let event: DomainEventInterface

  const createPublisher = () => new SNSOpenTelemetryDomainEventPublisher(snsClient, 'arn:aws:sns:test:topic')

  /** The PublishCommand input the publisher handed to the SNS client. */
  const publishedInput = (): Record<string, never> =>
    (snsClient.send as jest.Mock).mock.calls[0][0].input as Record<string, never>

  beforeEach(() => {
    snsClient = {} as jest.Mocked<SNSClient>
    snsClient.send = jest.fn().mockResolvedValue({})

    event = {
      type: 'TEST',
      createdAt: new Date(1),
      meta: { correlation: { userIdentifier: 'user-1', userIdentifierType: 'uuid' }, origin: 'auth' },
      payload: { foo: 'bar' },
    } as unknown as DomainEventInterface
  })

  it('publishes a PublishCommand to the configured topic', async () => {
    await createPublisher().publish(event)

    expect(snsClient.send).toHaveBeenCalledTimes(1)
    expect((snsClient.send as jest.Mock).mock.calls[0][0]).toBeInstanceOf(PublishCommand)
    expect(publishedInput().TopicArn).toEqual('arn:aws:sns:test:topic')
  })

  it('deflates the event into the message body so subscribers can inflate it back', async () => {
    await createPublisher().publish(event)

    const inflated = JSON.parse(zlib.inflateSync(Buffer.from(publishedInput().Message, 'base64')).toString())
    expect(inflated.type).toEqual('TEST')
    expect(inflated.payload).toEqual({ foo: 'bar' })
  })

  it('advertises the event type, compression and origin as message attributes', async () => {
    await createPublisher().publish(event)

    const attributes = publishedInput().MessageAttributes as Record<string, { DataType: string; StringValue: string }>
    expect(attributes.event).toEqual({ DataType: 'String', StringValue: 'TEST' })
    expect(attributes.compression).toEqual({ DataType: 'String', StringValue: 'true' })
    expect(attributes.origin).toEqual({ DataType: 'String', StringValue: 'auth' })
  })

  it('omits the target attribute when the event has no target', async () => {
    await createPublisher().publish(event)

    expect(publishedInput().MessageAttributes).not.toHaveProperty('target')
  })

  it('adds the target attribute when the event is addressed to one service', async () => {
    event = { ...event, meta: { ...event.meta, target: 'syncing-server' } } as DomainEventInterface

    await createPublisher().publish(event)

    const attributes = publishedInput().MessageAttributes as Record<string, { DataType: string; StringValue: string }>
    expect(attributes.target).toEqual({ DataType: 'String', StringValue: 'syncing-server' })
  })

  it('propagates a publish failure', async () => {
    snsClient.send = jest.fn().mockRejectedValue(new Error('sns unavailable'))

    await expect(createPublisher().publish(event)).rejects.toThrow('sns unavailable')
  })
})
