import * as crypto from 'crypto'
import { assertPublicHttpUrl, Result, SsrfValidationError, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { Webhook } from '../../Webhook/Webhook'
import { WebhookRepositoryInterface } from '../../Webhook/WebhookRepositoryInterface'
import { isValidWebhookEvent } from '../../Webhook/WebhookEvent'

import { RegisterWebhookDTO } from './RegisterWebhookDTO'
import { RegisterWebhookResult } from './RegisterWebhookResult'

export class RegisterWebhook implements UseCaseInterface<RegisterWebhookResult> {
  // 32 bytes (256 bits) of entropy for the HMAC secret, hex-encoded.
  private readonly SECRET_BYTE_LENGTH = 32

  constructor(private webhookRepository: WebhookRepositoryInterface) {}

  async execute(dto: RegisterWebhookDTO): Promise<Result<RegisterWebhookResult>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not register webhook: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const targetUrl = (dto.targetUrl ?? '').trim()
    if (targetUrl.length === 0) {
      return Result.fail('Could not register webhook: a target URL is required.')
    }

    if (!Array.isArray(dto.events) || dto.events.length === 0) {
      return Result.fail('Could not register webhook: at least one event is required.')
    }

    for (const event of dto.events) {
      if (!isValidWebhookEvent(event)) {
        return Result.fail(`Could not register webhook: unknown event '${event}'.`)
      }
    }

    // SSRF guard at REGISTRATION: any authenticated user can register a webhook
    // whose targetUrl the server will later POST to, so reject targets that
    // resolve to a private / loopback / link-local / cloud-metadata address.
    // Delivery re-validates too (DNS can change), but rejecting here gives the
    // user immediate feedback and blocks persisting an obviously-malicious URL.
    try {
      await assertPublicHttpUrl(targetUrl)
    } catch (error) {
      if (error instanceof SsrfValidationError) {
        return Result.fail(`Could not register webhook: ${error.message}`)
      }
      return Result.fail('Could not register webhook: the target URL could not be validated.')
    }

    const secret = crypto.randomBytes(this.SECRET_BYTE_LENGTH).toString('hex')
    const createdAt = new Date()

    const webhookOrError = Webhook.create({
      // A global webhook persists a null user_uuid so it fires for all users.
      userUuid: dto.global === true ? null : userUuid.value,
      targetUrl,
      events: dto.events,
      secret,
      enabled: true,
      createdAt,
    })
    if (webhookOrError.isFailed()) {
      return Result.fail(`Could not register webhook: ${webhookOrError.getError()}`)
    }
    const webhook = webhookOrError.getValue()

    await this.webhookRepository.save(webhook)

    return Result.ok({
      uuid: webhook.id.toString(),
      userUuid: webhook.props.userUuid,
      targetUrl: webhook.props.targetUrl,
      events: webhook.props.events,
      enabled: webhook.props.enabled,
      createdAt,
      secret,
    })
  }
}
