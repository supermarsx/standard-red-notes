"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DirectCallEventMessageHandler = void 0;
class DirectCallEventMessageHandler {
    handlers;
    logger;
    constructor(handlers, logger) {
        this.handlers = handlers;
        this.logger = logger;
    }
    async handleMessage(messageOrEvent) {
        if (typeof messageOrEvent === 'string') {
            throw new Error('DirectCallEventMessageHandler does not support string messages');
        }
        const handler = this.handlers.get(messageOrEvent.type);
        if (!handler) {
            this.logger.debug(`Event handler for event type ${messageOrEvent.type} does not exist`);
            return;
        }
        this.logger.debug(`Received event: ${messageOrEvent.type}`);
        await handler.handle(messageOrEvent);
    }
    async handleError(error) {
        this.logger.error('Error occured while handling SQS message: %O', error);
    }
}
exports.DirectCallEventMessageHandler = DirectCallEventMessageHandler;
