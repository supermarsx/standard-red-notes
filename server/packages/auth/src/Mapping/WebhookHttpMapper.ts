import { MapperInterface } from '@standardnotes/domain-core'

import { Webhook } from '../Domain/Webhook/Webhook'
import { WebhookHttpProjection } from '../Infra/Http/Projection/WebhookHttpProjection'

export class WebhookHttpMapper implements MapperInterface<Webhook, WebhookHttpProjection> {
  toDomain(_projection: WebhookHttpProjection): Webhook {
    throw new Error('Not implemented yet.')
  }

  toProjection(domain: Webhook): WebhookHttpProjection {
    // Never expose the HMAC secret in the list projection; it is returned
    // exactly once at creation time.
    return {
      uuid: domain.id.toString(),
      userUuid: domain.props.userUuid,
      targetUrl: domain.props.targetUrl,
      events: domain.props.events,
      enabled: domain.props.enabled,
      createdAt: domain.props.createdAt.toISOString(),
    }
  }
}
