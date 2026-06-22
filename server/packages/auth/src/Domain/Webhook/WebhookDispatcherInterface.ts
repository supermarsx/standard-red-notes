export interface WebhookEventContext {
  // The originating user. For user-scoped webhooks only matching webhooks of
  // this user (plus global webhooks) receive the event.
  userUuid: string | null
  // Optional metadata included in the payload. MUST NOT contain decrypted note
  // content — items are end-to-end encrypted, so only uuids/metadata are sent.
  metadata?: Record<string, unknown>
}

export interface WebhookDispatcherInterface {
  /**
   * Fan an event out to every enabled webhook subscribed to `event`. A global
   * (null user_uuid) webhook always matches; a user-scoped webhook matches only
   * when its user_uuid equals `context.userUuid`. Delivery is best-effort with a
   * bounded retry/backoff and a per-request timeout; failures are logged and
   * never propagated to the caller.
   */
  dispatch(event: string, context: WebhookEventContext): Promise<void>
}
