import { DomainEventInterface, DomainEventMessageHandlerInterface, DomainEventPublisherInterface } from '@standardnotes/domain-events';
export declare class DirectCallDomainEventPublisher implements DomainEventPublisherInterface {
    private handlers;
    register(domainEventMessageHandler: DomainEventMessageHandlerInterface): void;
    publish(event: DomainEventInterface): Promise<void>;
}
