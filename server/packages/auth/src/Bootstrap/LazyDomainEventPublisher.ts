import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'

import { SNSClientConfig } from '@aws-sdk/client-sns'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { DomainEventInterface, DomainEventPublisherInterface } from '@standardnotes/domain-events'

import { Env } from './Env'

export const CUSTOM_SNS_CONNECTION_TIMEOUT_MS = 3_000
export const CUSTOM_SNS_REQUEST_TIMEOUT_MS = 5_000
export const CUSTOM_SNS_SOCKET_TIMEOUT_MS = 5_000

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
 * Assemble the SNS client configuration shared by ContainerConfigLoader's
 * eager server/worker path and the lazy CLI path.
 */
export function buildSnsClientConfig(env: Env): SNSClientConfig {
  const snsConfig: SNSClientConfig = {
    region: env.get('SNS_AWS_REGION', true),
  }

  const endpoint = env.get('SNS_ENDPOINT', true)
  if (endpoint) {
    const protocol = new URL(endpoint).protocol
    let agent: { httpAgent: HttpAgent } | { httpsAgent: HttpsAgent }
    if (protocol === 'http:') {
      agent = { httpAgent: new HttpAgent({ keepAlive: false }) }
    } else if (protocol === 'https:') {
      agent = { httpsAgent: new HttpsAgent({ keepAlive: false }) }
    } else {
      throw new Error(`Unsupported SNS endpoint protocol: ${protocol}`)
    }

    snsConfig.endpoint = endpoint
    snsConfig.maxAttempts = 1
    snsConfig.requestHandler = new NodeHttpHandler({
      connectionTimeout: CUSTOM_SNS_CONNECTION_TIMEOUT_MS,
      requestTimeout: CUSTOM_SNS_REQUEST_TIMEOUT_MS,
      socketTimeout: CUSTOM_SNS_SOCKET_TIMEOUT_MS,
      throwOnRequestTimeout: true,
      ...agent,
    })
  }

  if (env.get('SNS_ACCESS_KEY_ID', true) && env.get('SNS_SECRET_ACCESS_KEY', true)) {
    snsConfig.credentials = {
      accessKeyId: env.get('SNS_ACCESS_KEY_ID', true),
      secretAccessKey: env.get('SNS_SECRET_ACCESS_KEY', true),
    }
  }

  return snsConfig
}
