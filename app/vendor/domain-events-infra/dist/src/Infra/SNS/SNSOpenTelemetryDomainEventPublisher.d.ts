import { SNSClient } from '@aws-sdk/client-sns';
import { DomainEventInterface, DomainEventPublisherInterface } from '@standardnotes/domain-events';
export declare class SNSOpenTelemetryDomainEventPublisher implements DomainEventPublisherInterface {
    private snsClient;
    private topicArn;
    constructor(snsClient: SNSClient, topicArn: string);
    publish(event: DomainEventInterface): Promise<void>;
}
