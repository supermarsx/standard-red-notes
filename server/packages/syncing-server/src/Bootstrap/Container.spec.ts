import 'reflect-metadata'
import { SNSClient } from '@aws-sdk/client-sns'
import { SNSDomainEventPublisher } from '@standardnotes/domain-events-infra'

import { SNS_PUBLISH_TIMEOUT_MILLISECONDS, createSNSDomainEventPublisher } from './Container'

describe('Container wiring', () => {
  /**
   * t90 R11: the non-durable realtime notification is awaited inline on the
   * save request path, so the SNS publish must be bounded. The infra class
   * only aborts when a timeout is supplied.
   */
  it('bounds SNS publishes from the request path to 2 seconds', () => {
    const publisher = createSNSDomainEventPublisher({} as SNSClient, 'arn:aws:sns:local:000000000000:topic')

    expect(publisher).toBeInstanceOf(SNSDomainEventPublisher)
    expect(SNS_PUBLISH_TIMEOUT_MILLISECONDS).toBe(2_000)
    expect(publisher).toHaveProperty('publishTimeoutMs', 2_000)
  })
})
