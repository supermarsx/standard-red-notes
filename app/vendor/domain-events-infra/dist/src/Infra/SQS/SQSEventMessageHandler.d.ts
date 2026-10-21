import { Logger } from 'winston';
import { DomainEventHandlerInterface, DomainEventMessageHandlerInterface } from '@standardnotes/domain-events';
export declare class SQSEventMessageHandler implements DomainEventMessageHandlerInterface {
    private handlers;
    private logger;
    constructor(handlers: Map<string, DomainEventHandlerInterface>, logger: Logger);
    handleMessage(message: string): Promise<void>;
    handleError(error: Error): Promise<void>;
}
