"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SQSDomainEventSubscriber = void 0;
const sqs_consumer_1 = require("sqs-consumer");
class SQSDomainEventSubscriber {
    sqs;
    queueUrl;
    domainEventMessageHandler;
    logger;
    consumer;
    constructor(sqs, queueUrl, domainEventMessageHandler, logger) {
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
    async handleMessage(message) {
        await this.domainEventMessageHandler.handleMessage(message.Body);
    }
    handleError(error) {
        this.logger.error('Error occured while handling SQS message: %O', error);
    }
}
exports.SQSDomainEventSubscriber = SQSDomainEventSubscriber;
