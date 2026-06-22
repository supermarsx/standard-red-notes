import { UniqueEntityId, Uuid } from '@standardnotes/domain-core'

import { Webhook } from './Webhook'

export interface WebhookRepositoryInterface {
  findByUserUuid(userUuid: Uuid): Promise<Webhook[]>
  // Global (admin) webhooks have a null user_uuid.
  findGlobal(): Promise<Webhook[]>
  // All enabled webhooks (global + per-user) — used by the dispatcher to fan an
  // event out to every matching subscriber.
  findAllEnabled(): Promise<Webhook[]>
  findById(id: UniqueEntityId): Promise<Webhook | null>
  save(webhook: Webhook): Promise<void>
  remove(webhook: Webhook): Promise<void>
  removeByUserUuid(userUuid: Uuid): Promise<void>
}
