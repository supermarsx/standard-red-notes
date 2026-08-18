/**
 * Wire-compatible body of one account-sync request. Item bodies remain
 * end-to-end encrypted; transports must treat this object as opaque data.
 */
export type AccountSyncTransportRequest = {
  /** Exact API version serialized by the HTTP sync request. */
  api: string
  items: unknown[]
  sync_token?: string
  cursor_token?: string
  limit: number
  shared_vault_uuids?: string[]
}

/** Stable idempotency metadata shared by websocket and HTTP replay paths. */
export type AccountSyncCommandMetadata = {
  id: string
  digest: string
  sequence: number
}

export type AccountSyncHttpFallback<TResponse> = (
  request: AccountSyncTransportRequest,
  command?: AccountSyncCommandMetadata,
) => Promise<TResponse>

export type AccountSyncTransportResult<TResponse> = {
  response: TResponse
  /**
   * Called only after the response and its sync-token checkpoint are durable.
   * A durable transport outbox must retain the command until this resolves.
   */
  markCheckpointDurable?: () => Promise<void>
}

/**
 * A command recovered from the durable transport outbox. The original request
 * is returned alongside the response so the sync layer can reconcile exactly
 * the payloads that command uploaded before it advances local sync tokens.
 */
export type AccountSyncTransportRecoveryResult<TResponse> = AccountSyncTransportResult<TResponse> & {
  request: AccountSyncTransportRequest
}

/**
 * Optional online account-sync transport. Implementations must always retain a
 * safe HTTP fallback and must never receive a long-lived session credential.
 */
export interface AccountSyncTransportInterface<TResponse> {
  /**
   * Recover at most one command created by this authenticated session. Callers
   * must apply and durably checkpoint the result before collecting a new batch.
   */
  recoverPending?(
    httpFallback: AccountSyncHttpFallback<TResponse>,
  ): Promise<AccountSyncTransportRecoveryResult<TResponse> | undefined>
  execute(
    request: AccountSyncTransportRequest,
    httpFallback: AccountSyncHttpFallback<TResponse>,
  ): Promise<AccountSyncTransportResult<TResponse>>
  /** Quarantine this session's outbox and resolve only after worker acknowledgement. */
  notifySessionRevoked?(): Promise<void>
  deinit?(): void
}
