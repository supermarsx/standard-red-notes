import { Logger } from 'winston';
import { DomainEventHandlerInterface, DomainEventInterface, DomainEventMessageHandlerInterface } from '@standardnotes/domain-events';
export declare class DirectCallEventMessageHandler implements DomainEventMessageHandlerInterface {
    private handlers;
    private logger;
    constructor(handlers: Map<string, DomainEventHandlerInterface>, logger: Logger);
    handleMessage(messageOrEvent: string | DomainEventInterface): Promise<void>;
    handleError(error: Error): Promise<void>;
}
