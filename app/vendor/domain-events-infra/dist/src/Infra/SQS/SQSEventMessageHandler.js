"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SQSEventMessageHandler = void 0;
const zlib = require("zlib");
class SQSEventMessageHandler {
    handlers;
    logger;
    constructor(handlers, logger) {
        this.handlers = handlers;
        this.logger = logger;
    }
    async handleMessage(message) {
        const messageParsed = JSON.parse(message);
        const domainEventJson = zlib.unzipSync(Buffer.from(messageParsed.Message, 'base64')).toString();
        const domainEvent = JSON.parse(domainEventJson);
        domainEvent.createdAt = new Date(domainEvent.createdAt);
        const handler = this.handlers.get(domainEvent.type);
        if (!handler) {
            this.logger.debug(`Event handler for event type ${domainEvent.type} does not exist`);
            return;
        }
        this.logger.debug(`Received event: ${domainEvent.type}`);
        await handler.handle(domainEvent);
    }
    async handleError(error) {
        this.logger.error('Error occured while handling SQS message: %O', error);
    }
}
exports.SQSEventMessageHandler = SQSEventMessageHandler;
