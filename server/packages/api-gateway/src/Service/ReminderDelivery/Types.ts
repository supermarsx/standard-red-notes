/**
 * Standard Red Notes: domain types + pure helpers for server-side reminder
 * DELIVERY.
 *
 * WHY THIS EXISTS: notes/reminders are end-to-end encrypted, so the server
 * cannot read them. To deliver a due reminder over WhatsApp / Telegram / Email
 * the server can only act on reminders the user has EXPLICITLY PUBLISHED into a
 * separate, server-readable store (plaintext by design — that is the cost of
 * letting the server send them on the user's behalf). This mirrors the CalDAV
 * "published calendar" model: opt-in, OFF by default, never exposing any other
 * E2E data.
 */

export type DeliveryChannel = 'whatsapp' | 'telegram' | 'email'

export const DELIVERY_CHANNELS: DeliveryChannel[] = ['whatsapp', 'telegram', 'email']

export function isDeliveryChannel(value: unknown): value is DeliveryChannel {
  return typeof value === 'string' && (DELIVERY_CHANNELS as string[]).includes(value)
}

/**
 * A single reminder a user explicitly published for server-side delivery.
 * PLAINTEXT BY DESIGN: this is the only reminder data the server can read, and
 * it exists only because the user asked the server to deliver it.
 */
export interface PublishedReminder {
  /** Stable per-user identifier (caller-supplied). */
  id: string
  /** The text to deliver. */
  message: string
  /** When the reminder is due, as an ISO-8601 UTC timestamp. */
  dueAtUtc: string
  /**
   * Optional per-reminder channel override. When absent, the user's
   * DeliveryConfig channel is used.
   */
  channel?: DeliveryChannel
  /**
   * Optional per-reminder destination override (phone / chat-id / email). When
   * absent, the user's DeliveryConfig destination is used.
   */
  destination?: string
  /** Whether this reminder has already been delivered (or terminally failed). */
  sent: boolean
  /** ms-epoch the delivery attempt that set `sent` completed. */
  sentAt?: number
  /** Last delivery error, if the last attempt failed. */
  error?: string
  /** ms-epoch of creation. */
  createdAt: number
  /** ms-epoch of last change. */
  updatedAt: number
}

/** Per-user delivery configuration. Default = disabled / unset. */
export interface DeliveryConfig {
  channel: DeliveryChannel
  /** Phone number (whatsapp), chat-id (telegram) or email address. */
  destination: string
  enabled: boolean
}

/**
 * Outcome of a single send attempt. Adapters NEVER throw — an unconfigured or
 * failing adapter returns `ok: false` with a reason, so the scheduler can record
 * it and move on.
 */
export interface DeliveryResult {
  ok: boolean
  /** True when the adapter had no credentials and therefore did nothing. */
  notConfigured?: boolean
  /** Human-readable reason on failure / no-op. */
  reason?: string
}

/**
 * One interface, three adapters. Implementations read their own credentials from
 * the environment at construction time and NO-OP gracefully (return
 * `{ ok: false, notConfigured: true }`) when those credentials are absent.
 */
export interface ReminderDeliveryProvider {
  readonly channel: DeliveryChannel
  send(destination: string, message: string): Promise<DeliveryResult>
}

/**
 * Pure due-selection predicate. A reminder is due when it is unsent and its
 * dueAtUtc is at or before `now`. Unparseable timestamps are treated as NOT due
 * (fail-closed: never deliver something we can't reason about).
 */
export function isDue(reminder: Pick<PublishedReminder, 'sent' | 'dueAtUtc'>, now: Date = new Date()): boolean {
  if (reminder.sent) {
    return false
  }
  const due = Date.parse(reminder.dueAtUtc)
  if (Number.isNaN(due)) {
    return false
  }
  return due <= now.getTime()
}

/**
 * Build the delivered message body. Kept deliberately small and channel-agnostic
 * so every adapter sends the same human-readable text.
 */
export function formatReminderMessage(reminder: Pick<PublishedReminder, 'message' | 'dueAtUtc'>): string {
  const message = (reminder.message ?? '').trim()
  const dueMs = Date.parse(reminder.dueAtUtc)
  const prefix = 'Reminder'
  if (Number.isNaN(dueMs)) {
    return message.length > 0 ? `${prefix}: ${message}` : prefix
  }
  const when = new Date(dueMs).toISOString().replace('.000Z', 'Z')
  if (message.length === 0) {
    return `${prefix} (due ${when})`
  }
  return `${prefix} (due ${when}): ${message}`
}
