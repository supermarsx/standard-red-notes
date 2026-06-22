import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { Webhook } from '../../Webhook/Webhook'
import { WebhookRepositoryInterface } from '../../Webhook/WebhookRepositoryInterface'

import { ListWebhooksDTO } from './ListWebhooksDTO'

export class ListWebhooks implements UseCaseInterface<Webhook[]> {
  constructor(private webhookRepository: WebhookRepositoryInterface) {}

  async execute(dto: ListWebhooksDTO): Promise<Result<Webhook[]>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not list webhooks: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const webhooks = await this.webhookRepository.findByUserUuid(userUuid)

    if (dto.includeGlobal === true) {
      const global = await this.webhookRepository.findGlobal()

      return Result.ok([...global, ...webhooks])
    }

    return Result.ok(webhooks)
  }
}
