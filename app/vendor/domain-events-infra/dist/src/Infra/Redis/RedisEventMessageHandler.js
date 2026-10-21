"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisEventMessageHandler = void 0;
const zlib = require("zlib");
class RedisEventMessageHandler {
    handlers;
    logger;
    constructor(handlers, logger) {
        this.handlers = handlers;
        this.logger = logger;
    }
    async handleMessage(message) {
        try {
            const domainEventJson = zlib.unzipSync(Buffer.from(message, 'base64')).toString();
            const domainEvent = JSON.parse(domainEventJson);
            const handler = this.handlers.get(domainEvent.type);
            if (!handler) {
                this.logger.debug(`Event handler for event type ${domainEvent.type} does not exist`);
                return;
            }
            await handler.handle(domainEvent);
        }
        catch (error) {
            await this.handleError(error);
        }
    }
    async handleError(error) {
        this.logger.error('Error occured while handling Redis message: %O', error);
    }
}
exports.RedisEventMessageHandler = RedisEventMessageHandler;
