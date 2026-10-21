import * as IORedis from 'ioredis';
import { DomainEventPublisherInterface, DomainEventInterface } from '@standardnotes/domain-events';
export declare class RedisDomainEventPublisher implements DomainEventPublisherInterface {
    private redisClient;
    private eventChannel;
    constructor(redisClient: IORedis.Redis, eventChannel: string);
    publish(event: DomainEventInterface): Promise<void>;
}
