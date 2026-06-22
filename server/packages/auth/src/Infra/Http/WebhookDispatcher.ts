import { AxiosInstance } from 'axios'
import { Logger } from 'winston'

import { Webhook } from '../../Domain/Webhook/Webhook'
import { WebhookRepositoryInterface } from '../../Domain/Webhook/WebhookRepositoryInterface'
import {
  WebhookDispatcherInterface,
  WebhookEventContext,
} from '../../Domain/Webhook/WebhookDispatcherInterface'
import { computeWebhookSignature } from '../../Domain/Webhook/WebhookSignature'

/**
 * Standard Red Notes: outbound webhook dispatcher. Fans a domain event out to
 * every enabled, subscribed webhook and POSTs a signed JSON payload to each
 * target URL with a bounded retry/backoff and a per-request timeout.
 *
 * E2E SAFETY: the payload only ever carries event metadata, uuids and
 * timestamps. Decrypted note content is never available server-side and is
 * never included.
 */
export class WebhookDispatcher implements WebhookDispatcherInterface {
  private readonly MAX_ATTEMPTS = 3
  private readonly BASE_BACKOFF_MS = 250
  private readonly REQUEST_TIMEOUT_MS = 5000

  constructor(
    private webhookRepository: WebhookRepositoryInterface,
    private httpClient: AxiosInstance,
    private logger: Logger,
  ) {}

  async dispatch(event: string, context: WebhookEventContext): Promise<void> {
    let webhooks: Webhook[]
    try {
      webhooks = await this.webhookRepository.findAllEnabled()
    } catch (error) {
      this.logger.error(`Could not load webhooks for event ${event}: ${(error as Error).message}`)

      return
    }

    const matching = webhooks.filter(
      (webhook) =>
        webhook.isSubscribedTo(event) &&
        // Global webhooks match every event; user-scoped webhooks only match
        // events originating from their own user.
        (webhook.isGlobal() || webhook.props.userUuid === context.userUuid),
    )

    if (matching.length === 0) {
      return
    }

    const deliveredAt = new Date().toISOString()

    await Promise.all(
      matching.map((webhook) =>
        this.deliver(webhook, {
          event,
          deliveredAt,
          // user_uuid is included so a global subscriber can attribute the
          // event; never an email or any decrypted content.
          userUuid: context.userUuid,
          data: context.metadata ?? {},
        }),
      ),
    )
  }

  private async deliver(webhook: Webhook, payload: Record<string, unknown>): Promise<void> {
    // Sign the EXACT serialized body the subscriber will receive so signature
    // verification over the raw request body matches byte-for-byte.
    const body = JSON.stringify(payload)
    const signature = computeWebhookSignature(webhook.props.secret, body)

    for (let attempt = 1; attempt <= this.MAX_ATTEMPTS; attempt++) {
      try {
        await this.httpClient.request({
          method: 'POST',
          url: webhook.props.targetUrl,
          data: body,
          timeout: this.REQUEST_TIMEOUT_MS,
          headers: {
            'Content-Type': 'application/json',
            'X-SRN-Signature': signature,
            'X-SRN-Event': payload.event as string,
            'X-SRN-Webhook-Id': webhook.id.toString(),
          },
          // We treat any 2xx as success; anything else triggers a retry.
          validateStatus: (status) => status >= 200 && status < 300,
        })

        return
      } catch (error) {
        const isLastAttempt = attempt === this.MAX_ATTEMPTS
        this.logger.warn(
          `Webhook delivery to ${webhook.props.targetUrl} failed (attempt ${attempt}/${this.MAX_ATTEMPTS}): ${
            (error as Error).message
          }`,
        )

        if (isLastAttempt) {
          this.logger.error(
            `Giving up webhook delivery to ${webhook.props.targetUrl} for event ${payload.event as string}`,
          )

          return
        }

        // Exponential backoff: 250ms, 500ms, ...
        await this.sleep(this.BASE_BACKOFF_MS * Math.pow(2, attempt - 1))
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
