import { Result, UniqueEntityId, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { WebhookRepositoryInterface } from '../../Webhook/WebhookRepositoryInterface'

import { DeleteWebhookDTO } from './DeleteWebhookDTO'

export class DeleteWebhook implements UseCaseInterface<string> {
  constructor(private webhookRepository: WebhookRepositoryInterface) {}

  async execute(dto: DeleteWebhookDTO): Promise<Result<string>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not delete webhook: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const webhook = await this.webhookRepository.findById(new UniqueEntityId(dto.webhookId))
    if (!webhook) {
      return Result.fail('Webhook not found')
    }

    // Ownership check: a non-admin may only delete their own (non-global)
    // webhook. Admins may delete any webhook, including global ones.
    const ownsWebhook = webhook.props.userUuid === userUuid.value
    if (!ownsWebhook && dto.isAdmin !== true) {
      return Result.fail('Webhook not found')
    }

    await this.webhookRepository.remove(webhook)

    return Result.ok('Webhook deleted')
  }
}
