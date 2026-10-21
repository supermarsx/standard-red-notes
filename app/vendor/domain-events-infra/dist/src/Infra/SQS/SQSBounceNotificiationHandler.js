"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SQSBounceNotificiationHandler = void 0;
const domain_events_1 = require("@standardnotes/domain-events");
class SQSBounceNotificiationHandler {
    handlers;
    logger;
    ALLOWED_NOTIFICATION_TYPES = ['Bounce'];
    constructor(handlers, logger) {
        this.handlers = handlers;
        this.logger = logger;
    }
    async handleMessage(message) {
        const messageParsed = JSON.parse(JSON.parse(message).Message);
        if (!this.ALLOWED_NOTIFICATION_TYPES.includes(messageParsed.notificationType)) {
            this.logger.error(`Received notification of type ${messageParsed.notificationType} which is not allowed`);
            return;
        }
        for (const bouncedRecipient of messageParsed.bounce.bouncedRecipients) {
            const domainEvent = {
                type: 'EMAIL_BOUNCED',
                payload: {
                    bounceType: messageParsed.bounce.bounceType,
                    bounceSubType: messageParsed.bounce.bounceSubType,
                    recipientEmail: bouncedRecipient.emailAddress,
                    diagnosticCode: bouncedRecipient.diagnosticCode,
                },
                createdAt: new Date(),
                meta: {
                    correlation: {
                        userIdentifier: bouncedRecipient.emailAddress,
                        userIdentifierType: 'email',
                    },
                    origin: domain_events_1.DomainEventService.SES,
                },
            };
            const handler = this.handlers.get(domainEvent.type);
            if (!handler) {
                this.logger.debug(`Event handler for event type ${domainEvent.type} does not exist`);
                return;
            }
            this.logger.debug(`Received event: ${domainEvent.type}`);
            await handler.handle(domainEvent);
        }
    }
    async handleError(error) {
        this.logger.error('Error occured while handling SQS message: %O', error);
    }
}
exports.SQSBounceNotificiationHandler = SQSBounceNotificiationHandler;
