import { EmailQueueSource } from '@standardnotes/domain-core'

export type EmailDeliveryStatus =
  'pending' | 'provider-accepted' | 'dead' | 'quarantined' | 'discarded' | 'superseded' | 'missing'

export type EmailDeliveryCancellationResult = 'cancelled' | 'provider-accepted' | 'in-flight'

export interface EmailAttachment {
  content: Buffer
  contentType: string
  filename: string
}

export interface SendEmailOptions {
  attachments?: EmailAttachment[]
  html?: boolean
  /** Queue attribution only; never included in provider-visible content. */
  deliverySource?: EmailQueueSource
  /** Stable, non-secret id used to make queue acceptance idempotent. */
  deliveryId?: string
  /** Do not begin provider delivery at or after this absolute epoch timestamp. */
  expiresAt?: number
  /** Critical messages may retry transient failures indefinitely. */
  retryMode?: 'bounded' | 'indefinite'
  /** Opaque stream identity; a newer queued message supersedes an older one in the same stream. */
  supersessionKey?: string
}

export type EmailDeliveryAcceptanceMode = 'provider' | 'durable-queue'

export interface EmailSenderInterface {
  /** Whether true means provider acceptance or durable queue acceptance. */
  readonly acceptanceMode: EmailDeliveryAcceptanceMode

  /**
   * Sends an email. Returns true only after acceptance by the active delivery
   * pipeline. Inspect acceptanceMode before destructive post-send cleanup.
   * Returns false when
   * delivery is unconfigured or not accepted;
   * interactive callers may then use an alternative such as an on-screen code.
   */
  sendEmail(to: string, subject: string, body: string, options?: SendEmailOptions): Promise<boolean>

  /**
   * Redacted durable-delivery state for a deterministic id. Direct provider
   * senders omit this method because their successful return is already final.
   */
  getDeliveryStatus?(deliveryId: string): Promise<EmailDeliveryStatus>

  /**
   * Atomically fences a deterministic durable delivery against future sends.
   * Direct provider senders omit this because provider acceptance is final.
   */
  cancelDelivery?(deliveryId: string): Promise<EmailDeliveryCancellationResult>

  /** May resolve a shared runtime overlay before reporting configuration. */
  isConfigured(): boolean | Promise<boolean>
}
