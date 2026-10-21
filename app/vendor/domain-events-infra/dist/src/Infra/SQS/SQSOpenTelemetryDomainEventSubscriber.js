"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SQSOpenTelemetryDomainEventSubscriber = void 0;
const sqs_consumer_1 = require("sqs-consumer");
const OpenTelemetryApi = require("@opentelemetry/api");
class SQSOpenTelemetryDomainEventSubscriber {
    serviceName;
    sqs;
    queueUrl;
    domainEventMessageHandler;
    logger;
    consumer;
    currentSpan;
    constructor(serviceName, sqs, queueUrl, domainEventMessageHandler, logger) {
        this.serviceName = serviceName;
        this.sqs = sqs;
        this.queueUrl = queueUrl;
        this.domainEventMessageHandler = domainEventMessageHandler;
        this.logger = logger;
    }
    start() {
        const sqsConsumer = sqs_consumer_1.Consumer.create({
            attributeNames: ['All'],
            messageAttributeNames: ['All'],
            queueUrl: this.queueUrl,
            sqs: this.sqs,
            preReceiveMessageCallback: this.startParentSpan.bind(this),
            handleMessage: this.handleMessage.bind(this),
        });
        sqsConsumer.on('error', this.handleError.bind(this));
        sqsConsumer.on('processing_error', this.handleError.bind(this));
        this.consumer = sqsConsumer;
        sqsConsumer.start();
    }
    stop() {
        if (this.consumer && this.consumer.isRunning) {
            this.logger.info('Stopping SQS consumer...');
            this.consumer.stop();
        }
    }
    async startParentSpan() {
        const tracer = OpenTelemetryApi.trace.getTracer(`${this.serviceName}-domain-event-subscriber`);
        this.currentSpan = tracer.startSpan(this.serviceName, { kind: OpenTelemetryApi.SpanKind.CONSUMER });
    }
    async handleMessage(message) {
        await this.domainEventMessageHandler.handleMessage(message.Body);
        if (this.currentSpan) {
            this.currentSpan.end();
            this.currentSpan = undefined;
        }
    }
    handleError(error) {
        this.logger.error('Error occured while handling SQS message: %O', error);
        if (this.currentSpan) {
            this.currentSpan.recordException(error);
            this.currentSpan.end();
            this.currentSpan = undefined;
        }
    }
}
exports.SQSOpenTelemetryDomainEventSubscriber = SQSOpenTelemetryDomainEventSubscriber;
