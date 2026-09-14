import { safeErrorLogMetadata } from '@standardnotes/domain-core'
import { Consumer } from 'sqs-consumer'
import { Message, SQSClient } from '@aws-sdk/client-sqs'
import { DomainEventSubscriberInterface, DomainEventMessageHandlerInterface } from '@standardnotes/domain-events'
import { Logger } from 'winston'

export class SQSDomainEventSubscriber implements DomainEventSubscriberInterface {
  private consumer: Consumer | undefined

  constructor(
    private sqs: SQSClient,
    private queueUrl: string,
    private domainEventMessageHandler: DomainEventMessageHandlerInterface,
    private logger: Logger,
  ) {}

  start(): void {
    const sqsConsumer = Consumer.create({
      attributeNames: ['All'],
      messageAttributeNames: ['All'],
      queueUrl: this.queueUrl,
      sqs: this.sqs,
      handleMessage: this.handleMessage.bind(this),
    })

    sqsConsumer.on('error', this.handleError.bind(this))
    sqsConsumer.on('processing_error', this.handleError.bind(this))

    this.consumer = sqsConsumer

    // Every worker names the queue it drains. Four workers that inherit one
    // bare SQS_QUEUE_URL silently steal each other's (and the gateway's)
    // messages; with this line the collision is visible in the boot logs.
    this.logger.info(`Consuming SQS queue ${this.queueUrl}`)

    sqsConsumer.start()
  }

  stop(): void {
    if (this.consumer && this.consumer.status.isRunning) {
      this.logger.info('Stopping SQS consumer...')
      this.consumer.stop()
    }
  }

  async handleMessage(message: Message): Promise<Message> {
    await this.domainEventMessageHandler.handleMessage(message.Body as string)

    // sqs-consumer 15 only acknowledges a successfully processed message when
    // the handler returns that message. Returning undefined deliberately leaves
    // it on the queue, which would replay every domain event indefinitely.
    return message
  }

  handleError(error: Error): void {
    this.logger.error('Error occurred while handling an SQS message.', safeErrorLogMetadata(error))
  }
}
