import { Entity, Result, UniqueEntityId } from '@standardnotes/domain-core'

import { WebhookProps } from './WebhookProps'
import { isValidWebhookEvent } from './WebhookEvent'

export class Webhook extends Entity<WebhookProps> {
  private constructor(props: WebhookProps, id?: UniqueEntityId) {
    super(props, id)
  }

  static create(props: WebhookProps, id?: UniqueEntityId): Result<Webhook> {
    if (props.targetUrl.length === 0) {
      return Result.fail<Webhook>('Webhook target URL cannot be empty')
    }

    if (props.targetUrl.length > 2048) {
      return Result.fail<Webhook>('Webhook target URL cannot be longer than 2048 characters')
    }

    // Only allow http(s) targets; reject anything else so a webhook can never be
    // pointed at, e.g., a file:// or gopher:// URL.
    if (!/^https?:\/\//i.test(props.targetUrl)) {
      return Result.fail<Webhook>('Webhook target URL must be an http(s) URL')
    }

    if (props.events.length === 0) {
      return Result.fail<Webhook>('Webhook must subscribe to at least one event')
    }

    for (const event of props.events) {
      if (!isValidWebhookEvent(event)) {
        return Result.fail<Webhook>(`Unknown webhook event: ${event}`)
      }
    }

    if (props.secret.length === 0) {
      return Result.fail<Webhook>('Webhook secret cannot be empty')
    }

    return Result.ok<Webhook>(new Webhook(props, id))
  }

  isSubscribedTo(event: string): boolean {
    return this.props.enabled && this.props.events.includes(event)
  }

  isGlobal(): boolean {
    return this.props.userUuid === null
  }
}
