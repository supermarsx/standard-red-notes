import {
  assertPublicHttpUrl,
  PinnedHttpError,
  PinnedHttpTransport,
  SsrfValidationError,
} from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { Webhook } from '../../Domain/Webhook/Webhook'
import { WebhookRepositoryInterface } from '../../Domain/Webhook/WebhookRepositoryInterface'
import { WebhookDispatcherInterface, WebhookEventContext } from '../../Domain/Webhook/WebhookDispatcherInterface'
import { computeWebhookSignature } from '../../Domain/Webhook/WebhookSignature'
import { safeErrorLogMetadata, sanitizeUrlForSafeLog } from '../../Domain/Logging/SafeLog'

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
    private httpTransport: PinnedHttpTransport,
    private logger: Logger,
  ) {}

  async dispatch(event: string, context: WebhookEventContext): Promise<void> {
    let webhooks: Webhook[]
    try {
      webhooks = await this.webhookRepository.findAllEnabled()
    } catch (error) {
      this.logger.error('Could not load webhooks for an event.', {
        event,
        ...safeErrorLogMetadata(error),
      })

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
    // SSRF guard at DELIVERY: re-validate the target right before sending. DNS
    // records can change between registration and delivery. This preliminary
    // check gives blocked targets the existing no-retry behavior; the shared
    // transport below performs the authoritative resolve-and-pin operation for
    // the actual socket. A blocked target is logged and dropped.
    try {
      await assertPublicHttpUrl(webhook.props.targetUrl)
    } catch (error) {
      this.logger.warn('Skipping webhook delivery because target validation failed.', {
        endpoint: sanitizeUrlForSafeLog(webhook.props.targetUrl),
        validationFailure: error instanceof SsrfValidationError,
        ...safeErrorLogMetadata(error),
      })

      return
    }

    // Sign the EXACT serialized body the subscriber will receive so signature
    // verification over the raw request body matches byte-for-byte.
    const body = JSON.stringify(payload)
    const signature = computeWebhookSignature(webhook.props.secret, body)

    for (let attempt = 1; attempt <= this.MAX_ATTEMPTS; attempt++) {
      try {
        const response = await this.httpTransport.request({
          method: 'POST',
          url: webhook.props.targetUrl,
          body,
          timeoutMs: this.REQUEST_TIMEOUT_MS,
          // Webhook signatures and payloads are origin-bound, so do not follow
          // redirects even though the transport can safely re-pin them.
          maxRedirects: 0,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
            'X-SRN-Signature': signature,
            'X-SRN-Event': payload.event as string,
            'X-SRN-Webhook-Id': webhook.id.toString(),
          },
        })
        await response.discard()
        if (!response.ok) {
          throw new PinnedHttpError('Webhook delivery returned a non-success status.', 'upstream-status')
        }

        return
      } catch (error) {
        if (error instanceof SsrfValidationError) {
          this.logger.warn('Skipping webhook delivery because the pinned target was blocked.', {
            endpoint: sanitizeUrlForSafeLog(webhook.props.targetUrl),
            validationFailure: true,
          })
          return
        }
        const isLastAttempt = attempt === this.MAX_ATTEMPTS
        this.logger.warn('Webhook delivery attempt failed.', {
          endpoint: sanitizeUrlForSafeLog(webhook.props.targetUrl),
          attempt,
          maxAttempts: this.MAX_ATTEMPTS,
          ...safeErrorLogMetadata(error),
        })

        if (isLastAttempt) {
          this.logger.error('Giving up webhook delivery.', {
            endpoint: sanitizeUrlForSafeLog(webhook.props.targetUrl),
            event: payload.event as string,
          })

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
