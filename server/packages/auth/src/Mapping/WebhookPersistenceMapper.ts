import { MapperInterface, UniqueEntityId } from '@standardnotes/domain-core'

import { Webhook } from '../Domain/Webhook/Webhook'
import { TypeORMWebhook } from '../Infra/TypeORM/TypeORMWebhook'

export class WebhookPersistenceMapper implements MapperInterface<Webhook, TypeORMWebhook> {
  toDomain(projection: TypeORMWebhook): Webhook {
    let events: string[] = []
    try {
      const parsed = JSON.parse(projection.events)
      events = Array.isArray(parsed) ? (parsed as string[]) : []
    } catch {
      events = []
    }

    const webhookOrError = Webhook.create(
      {
        userUuid: projection.userUuid ?? null,
        targetUrl: projection.targetUrl,
        events,
        secret: projection.secret,
        enabled: Boolean(projection.enabled),
        createdAt: new Date(Number(projection.createdAt)),
      },
      new UniqueEntityId(projection.uuid),
    )
    if (webhookOrError.isFailed()) {
      throw new Error(`Failed to create webhook from projection: ${webhookOrError.getError()}`)
    }

    return webhookOrError.getValue()
  }

  toProjection(domain: Webhook): TypeORMWebhook {
    const typeorm = new TypeORMWebhook()

    typeorm.uuid = domain.id.toString()
    typeorm.userUuid = domain.props.userUuid
    typeorm.targetUrl = domain.props.targetUrl
    typeorm.events = JSON.stringify(domain.props.events)
    typeorm.secret = domain.props.secret
    typeorm.enabled = domain.props.enabled
    typeorm.createdAt = domain.props.createdAt.getTime()

    return typeorm
  }
}
