import { Message, SQSClient } from '@aws-sdk/client-sqs';
import { DomainEventSubscriberInterface, DomainEventMessageHandlerInterface } from '@standardnotes/domain-events';
import { Logger } from 'winston';
export declare class SQSDomainEventSubscriber implements DomainEventSubscriberInterface {
    private sqs;
    private queueUrl;
    private domainEventMessageHandler;
    private logger;
    private consumer;
    constructor(sqs: SQSClient, queueUrl: string, domainEventMessageHandler: DomainEventMessageHandlerInterface, logger: Logger);
    start(): void;
    stop(): void;
    handleMessage(message: Message): Promise<void>;
    handleError(error: Error): void;
}
