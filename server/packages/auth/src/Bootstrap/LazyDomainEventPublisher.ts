import { SNSClientConfig } from '@aws-sdk/client-sns'
import { DomainEventInterface, DomainEventPublisherInterface } from '@standardnotes/domain-events'

import { Env } from './Env'

/**
 * Standard Red Notes: lazily-constructed domain-event publisher for the
 * ContainerConfigLoader's 'cli' mode.
 *
 * The srn-admin CLI resolves many use cases whose bindings eagerly
 * `container.get(TYPES.Auth_DomainEventPublisher)` at container-load time, but
 * only ONE CLI-reachable use case actually publishes an event
 * (FixStorageQuotaForUser → FILE_QUOTA_RECALCULATION_REQUESTED). Binding this
 * wrapper lets 'cli' mode skip constructing the SNS client at boot while
 * keeping fix-quota fully functional: the real publisher (and its SNS client)
 * is built on the FIRST publish and reused afterwards. This is deliberately
 * NOT a no-op stub — swallowing events would silently break fix-quota.
 */
export class LazyDomainEventPublisher implements DomainEventPublisherInterface {
  private instance: DomainEventPublisherInterface | undefined

  constructor(private readonly factory: () => DomainEventPublisherInterface) {}

  async publish(event: DomainEventInterface): Promise<void> {
    this.instance = this.instance ?? this.factory()

    await this.instance.publish(event)
  }
}

/**
 * Assemble the SNS client configuration exactly like ContainerConfigLoader's
 * eager server/worker path (keep the two in sync): region + optional endpoint
 * + optional static credentials from the SNS_* envs.
 */
export function buildSnsClientConfig(env: Env): SNSClientConfig {
  const snsConfig: SNSClientConfig = {
    region: env.get('SNS_AWS_REGION', true),
  }
  if (env.get('SNS_ENDPOINT', true)) {
    snsConfig.endpoint = env.get('SNS_ENDPOINT', true)
  }
  if (env.get('SNS_ACCESS_KEY_ID', true) && env.get('SNS_SECRET_ACCESS_KEY', true)) {
    snsConfig.credentials = {
      accessKeyId: env.get('SNS_ACCESS_KEY_ID', true),
      secretAccessKey: env.get('SNS_SECRET_ACCESS_KEY', true),
    }
  }

  return snsConfig
}
