"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisDomainEventPublisher = void 0;
const zlib = require("zlib");
class RedisDomainEventPublisher {
    redisClient;
    eventChannel;
    constructor(redisClient, eventChannel) {
        this.redisClient = redisClient;
        this.eventChannel = eventChannel;
    }
    async publish(event) {
        const message = zlib.deflateSync(JSON.stringify(event)).toString('base64');
        await this.redisClient.publish(this.eventChannel, message);
    }
}
exports.RedisDomainEventPublisher = RedisDomainEventPublisher;
