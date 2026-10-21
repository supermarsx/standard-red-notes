import { Message, SQSClient } from '@aws-sdk/client-sqs';
import { DomainEventSubscriberInterface, DomainEventMessageHandlerInterface } from '@standardnotes/domain-events';
import { Logger } from 'winston';
export declare class SQSOpenTelemetryDomainEventSubscriber implements DomainEventSubscriberInterface {
    private serviceName;
    private sqs;
    private queueUrl;
    private domainEventMessageHandler;
    private logger;
    private consumer;
    private currentSpan;
    constructor(serviceName: string, sqs: SQSClient, queueUrl: string, domainEventMessageHandler: DomainEventMessageHandlerInterface, logger: Logger);
    start(): void;
    stop(): void;
    startParentSpan(): Promise<void>;
    handleMessage(message: Message): Promise<void>;
    handleError(error: Error): void;
}
