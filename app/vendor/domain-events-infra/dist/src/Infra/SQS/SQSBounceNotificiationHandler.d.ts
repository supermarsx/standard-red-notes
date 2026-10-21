import { Logger } from 'winston';
import { DomainEventHandlerInterface, DomainEventMessageHandlerInterface } from '@standardnotes/domain-events';
export declare class SQSBounceNotificiationHandler implements DomainEventMessageHandlerInterface {
    private handlers;
    private logger;
    private readonly ALLOWED_NOTIFICATION_TYPES;
    constructor(handlers: Map<string, DomainEventHandlerInterface>, logger: Logger);
    handleMessage(message: string): Promise<void>;
    handleError(error: Error): Promise<void>;
}
