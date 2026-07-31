import { safeErrorLogMetadata } from '@standardnotes/domain-core'
import { Consumer } from 'sqs-consumer'
import * as OpenTelemetryApi from '@opentelemetry/api'
import { Message, SQSClient } from '@aws-sdk/client-sqs'
import { DomainEventSubscriberInterface, DomainEventMessageHandlerInterface } from '@standardnotes/domain-events'
import { Logger } from 'winston'

export class SQSOpenTelemetryDomainEventSubscriber implements DomainEventSubscriberInterface {
  private consumer: Consumer | undefined
  private currentSpan: OpenTelemetryApi.Span | undefined

  constructor(
    private serviceName: string,
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
      preReceiveMessageCallback: this.startParentSpan.bind(this),
      handleMessage: this.handleMessage.bind(this),
    })

    sqsConsumer.on('error', this.handleError.bind(this))
    sqsConsumer.on('processing_error', this.handleError.bind(this))

    this.consumer = sqsConsumer

    sqsConsumer.start()
  }

  stop(): void {
    if (this.consumer && this.consumer.status.isRunning) {
      this.logger.info('Stopping SQS consumer...')
      this.consumer.stop()
    }
  }

  async startParentSpan(): Promise<void> {
    const tracer = OpenTelemetryApi.trace.getTracer(`${this.serviceName}-domain-event-subscriber`)

    this.currentSpan = tracer.startSpan(this.serviceName, { kind: OpenTelemetryApi.SpanKind.CONSUMER })
  }

  async handleMessage(message: Message): Promise<Message> {
    await this.domainEventMessageHandler.handleMessage(message.Body as string)

    if (this.currentSpan) {
      this.currentSpan.end()
      this.currentSpan = undefined
    }

    // sqs-consumer 15 treats the returned message as the acknowledgement.
    // Returning undefined leaves a successfully processed event on the queue.
    return message
  }

  handleError(error: Error): void {
    const safeError = safeErrorLogMetadata(error)
    this.logger.error('Error occurred while handling an SQS message.', safeError)

    if (this.currentSpan) {
      this.currentSpan.recordException({
        name: safeError.errorType,
        message: 'SQS message handling failed; exception details were redacted.',
      })
      this.currentSpan.end()
      this.currentSpan = undefined
    }
  }
}
