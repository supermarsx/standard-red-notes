"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DirectCallDomainEventPublisher = void 0;
class DirectCallDomainEventPublisher {
    handlers = [];
    register(domainEventMessageHandler) {
        this.handlers.push(domainEventMessageHandler);
    }
    async publish(event) {
        await Promise.all(this.handlers.map((handler) => handler.handleMessage(event)));
    }
}
exports.DirectCallDomainEventPublisher = DirectCallDomainEventPublisher;
