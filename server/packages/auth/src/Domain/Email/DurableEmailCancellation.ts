import { EmailDeliveryCancellationResult, EmailSenderInterface } from './EmailSenderInterface'

export type DurableEmailCancellationResult = EmailDeliveryCancellationResult | 'not-durable'

/**
 * Cancels a deterministic queue occurrence. Durable senders fail closed when
 * the cancellation adapter is missing; direct provider senders have no queued
 * occurrence to revoke.
 */
export async function cancelDurableEmailDelivery(
  emailSender: EmailSenderInterface,
  deliveryId: string,
): Promise<DurableEmailCancellationResult> {
  if (emailSender.acceptanceMode !== 'durable-queue') {
    return 'not-durable'
  }
  if (!emailSender.cancelDelivery) {
    throw new Error('Durable email delivery cancellation is unavailable.')
  }

  return emailSender.cancelDelivery(deliveryId)
}
