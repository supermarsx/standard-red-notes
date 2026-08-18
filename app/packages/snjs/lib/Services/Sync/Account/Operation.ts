import { ServerSyncPushContextualPayload } from '@standardnotes/models'
import { arrayByDifference, nonSecureRandomIdentifier, subtractFromArray } from '@standardnotes/utils'
import { ServerSyncResponse } from '@Lib/Services/Sync/Account/Response'
import { ResponseSignalReceiver, SyncSignal } from '@Lib/Services/Sync/Signals'
import { LegacyApiService } from '../../Api/ApiService'
import {
  AccountSyncTransportInterface,
  AccountSyncTransportRequest,
  AccountSyncCommandMetadata,
} from '@standardnotes/services'
import { HttpResponse, RawSyncResponse } from '@standardnotes/responses'

export const SyncUpDownLimit = 150
const MaxPendingTransportRecoveries = 8

export type AccountSyncPaginationGuard = {
  maxPages: number
  maxResponseBytes: number
  maxElapsedMs: number
}

export const DefaultAccountSyncPaginationGuard: Readonly<AccountSyncPaginationGuard> = Object.freeze({
  /** 15 million items at the normal 150-item page size. */
  maxPages: 100_000,
  /** Large enough for legitimate multi-hundred-gigabyte encrypted vault catch-up. */
  maxResponseBytes: 256 * 1024 * 1024 * 1024,
  /** A single foreground operation should never own the sync lock indefinitely. */
  maxElapsedMs: 12 * 60 * 60 * 1_000,
})

export type AccountSyncPaginationGuardReason =
  'repeated-cursor' | 'maximum-pages' | 'maximum-response-bytes' | 'maximum-elapsed-time'

export type AccountSyncPaginationMetric =
  | {
      type: 'page'
      page: number
      uploadedItems: number
      retrievedItems: number
      responseBytes: number
      cumulativeResponseBytes: number
      requestLatencyMs: number
      elapsedMs: number
      hasMore: boolean
      /** Redacted deterministic fingerprint; the cursor itself is never exposed. */
      cursorHash?: string
      guardReason?: 'repeated-cursor'
    }
  | {
      type: 'guard'
      reason: Exclude<AccountSyncPaginationGuardReason, 'repeated-cursor'>
      pages: number
      cumulativeResponseBytes: number
      elapsedMs: number
    }

export type AccountSyncOperationOptions = {
  syncToken?: string
  paginationToken?: string
  sharedVaultUuids?: string[]
  paginationGuard?: Partial<AccountSyncPaginationGuard> & {
    /** Test seam for elapsed-time guards. */
    now?: () => number
  }
  /** Receives redacted counters only; callback failures never affect sync. */
  onPaginationMetric?: (metric: AccountSyncPaginationMetric) => void
  /** Optional websocket-preferred transport; it must retain an HTTP fallback. */
  transport?: AccountSyncTransportInterface<HttpResponse<RawSyncResponse>>
}

/**
 * Controlled failure signal consumed by SyncService's normal failure/backoff
 * path. It contains no cursor, UUID, payload, ciphertext, or token material.
 */
export class AccountSyncPaginationGuardError extends Error {
  override readonly name = 'AccountSyncPaginationGuardError'
  readonly controlledSyncFailure = true

  constructor(
    readonly reason: AccountSyncPaginationGuardReason,
    readonly pages: number,
    readonly cumulativeResponseBytes: number,
    readonly elapsedMs: number,
  ) {
    super(
      `Account sync pagination stopped safely (${reason}; pages=${pages}; ` +
        `responseBytes=${cumulativeResponseBytes}; elapsedMs=${elapsedMs}).`,
    )
  }
}

/**
 * A long running operation that handles multiple roundtrips from a server,
 * emitting a stream of values that should be acted upon in real time.
 */
export class AccountSyncOperation {
  public readonly id = nonSecureRandomIdentifier()

  private pendingPayloads: ServerSyncPushContextualPayload[]
  private responses: ServerSyncResponse[] = []
  private readonly seenPaginationTokens = new Set<string>()
  private readonly paginationGuard: AccountSyncPaginationGuard
  private readonly now: () => number
  private readonly startedAt: number
  private pageCount = 0
  private cumulativeResponseBytes = 0

  /**
   * @param payloads   An array of payloads to send to the server
   * @param receiver   A function that receives callback multiple times during the operation
   */
  constructor(
    public payloads: ServerSyncPushContextualPayload[],
    private receiver: ResponseSignalReceiver<ServerSyncResponse>,
    private apiService: LegacyApiService,
    public readonly options: AccountSyncOperationOptions,
  ) {
    this.pendingPayloads = payloads.slice()
    this.paginationGuard = {
      maxPages: positiveFiniteIntegerOrDefault(
        options.paginationGuard?.maxPages,
        DefaultAccountSyncPaginationGuard.maxPages,
      ),
      maxResponseBytes: positiveFiniteIntegerOrDefault(
        options.paginationGuard?.maxResponseBytes,
        DefaultAccountSyncPaginationGuard.maxResponseBytes,
      ),
      maxElapsedMs: positiveFiniteIntegerOrDefault(
        options.paginationGuard?.maxElapsedMs,
        DefaultAccountSyncPaginationGuard.maxElapsedMs,
      ),
    }
    this.now = options.paginationGuard?.now ?? Date.now
    this.startedAt = this.now()
    if (options.paginationToken) {
      this.seenPaginationTokens.add(options.paginationToken)
    }
  }

  /**
   * Read the payloads that have been saved, or are currently in flight.
   */
  get payloadsSavedOrSaving(): ServerSyncPushContextualPayload[] {
    return arrayByDifference(this.payloads, this.pendingPayloads)
  }

  popPayloads(count: number) {
    const payloads = this.pendingPayloads.slice(0, count)
    subtractFromArray(this.pendingPayloads, payloads)
    return payloads
  }

  async run(): Promise<void> {
    this.assertPaginationWithinLimits()

    await this.receiver(SyncSignal.StatusChanged, undefined, {
      completedUploadCount: this.totalUploadCount - this.pendingUploadCount,
      totalUploadCount: this.totalUploadCount,
    })
    const payloads = this.popPayloads(this.upLimit)
    const requestStartedAt = this.now()

    const transportRequest: AccountSyncTransportRequest = {
      api: this.apiService.apiVersion,
      items: payloads,
      ...(this.options.syncToken ? { sync_token: this.options.syncToken } : {}),
      ...(this.options.paginationToken ? { cursor_token: this.options.paginationToken } : {}),
      limit: this.downLimit,
      ...(this.options.sharedVaultUuids ? { shared_vault_uuids: this.options.sharedVaultUuids } : {}),
    }
    const transportResult = this.options.transport
      ? await this.options.transport.execute(transportRequest, (request, command) =>
          this.syncOverHttp(request, command),
        )
      : { response: await this.syncOverHttp(transportRequest) }
    const rawResponse = transportResult.response
    const requestLatencyMs = Math.max(0, this.now() - requestStartedAt)

    const response = new ServerSyncResponse(rawResponse)
    this.responses.push(response)
    this.pageCount += 1
    const responseBytes = estimateResponseBytes(rawResponse, this.remainingResponseByteBudget())
    this.cumulativeResponseBytes += responseBytes

    const nextPaginationToken = response.paginationToken
    const repeatedCursor = nextPaginationToken !== undefined && this.seenPaginationTokens.has(nextPaginationToken)
    const pageMetric: AccountSyncPaginationMetric = {
      type: 'page',
      page: this.pageCount,
      uploadedItems: payloads.length,
      retrievedItems: response.retrievedPayloads.length,
      responseBytes,
      cumulativeResponseBytes: this.cumulativeResponseBytes,
      requestLatencyMs,
      elapsedMs: this.elapsedMs(),
      hasMore: nextPaginationToken !== undefined,
      ...(nextPaginationToken ? { cursorHash: hashCursorForMetric(nextPaginationToken) } : {}),
      ...(repeatedCursor ? { guardReason: 'repeated-cursor' as const } : {}),
    }
    this.emitPaginationMetric(pageMetric)

    if (repeatedCursor) {
      throw this.guardError('repeated-cursor')
    }
    if (nextPaginationToken) {
      this.seenPaginationTokens.add(nextPaginationToken)
    }

    this.options.syncToken = response.lastSyncToken as string
    this.options.paginationToken = nextPaginationToken

    /**
     * RELIABILITY (silent-drop fix): the receiver persists this page's retrieved
     * payloads AND advances the PERSISTED sync token (see
     * SyncService.handleSuccessServerResponse) — but only the persisted token
     * gates what a future sync re-pulls. If the receiver throws (e.g. a transient
     * IndexedDB write or decrypt failure on THIS page), we must NOT keep
     * paginating: continuing would run subsequent pages whose success could
     * advance the persisted token PAST the items this page failed to persist,
     * silently dropping them with no way to re-pull. Instead, surface the error so
     * the sync is marked failed; the persisted token is still at the pre-failure
     * position, so the existing failure-backoff retry re-pulls this page cleanly.
     */
    await this.receiver(SyncSignal.Response, response)

    // The worker outbox is intentionally retained until the encrypted response
    // and its sync-token checkpoint have survived the local durability boundary.
    // Receiver failures therefore leave the exact command available for STATUS /
    // idempotent replay after a reload.
    if (!response.hasError) {
      await transportResult.markCheckpointDurable?.()
    }

    /**
     * DATA-LOSS fix (mid-batch upload failure): for a large dirty set the upload
     * paginates, and popPayloads() removes each batch BEFORE its request. A
     * RETURNED error response (network/server failure handled by
     * handleErrorServerResponse) leaves this batch's items dirty — good — but
     * carries no paginationToken, so `done` stays FALSE while later batches remain
     * pending. Recursing here would upload the next batch against a now-stale
     * syncToken; a later batch could commit while this one failed, and the failed
     * batch's items can be re-pulled as the server's older copy and clobber the
     * still-dirty local edit. Stop paginating on the FIRST failed batch; the dirty
     * items remain dirty and re-upload cleanly on the next sync. The normal
     * multi-page SUCCESS path is unaffected (hasError is false there).
     */
    if (response.hasError) {
      return
    }

    if (!this.done) {
      return this.run()
    }
  }

  /**
   * Apply stale durable commands as a distinct phase before a caller snapshots
   * or dequeues any new uploads. Each recovered response is persisted locally
   * before its worker checkpoint is acknowledged, and the bounded extra probe
   * fails closed if a corrupt/legacy outbox somehow contains an endless chain.
   */
  async recoverPending(): Promise<{ recoveredCount: number; hasError: boolean }> {
    const transport = this.options.transport
    if (!transport?.recoverPending) {
      return { recoveredCount: 0, hasError: false }
    }

    let recoveredCount = 0
    for (let attempt = 0; attempt <= MaxPendingTransportRecoveries; attempt += 1) {
      const transportResult = await transport.recoverPending((request, command) => this.syncOverHttp(request, command))
      if (!transportResult) {
        return { recoveredCount, hasError: false }
      }
      if (attempt === MaxPendingTransportRecoveries) {
        throw new Error('Durable sync recovery exceeded its bounded command limit.')
      }

      const recoveredPayloads = transportResult.request.items as ServerSyncPushContextualPayload[]
      this.payloads = recoveredPayloads
      this.pendingPayloads = []
      this.options.sharedVaultUuids = transportResult.request.shared_vault_uuids

      const response = new ServerSyncResponse(transportResult.response)
      this.responses.push(response)
      this.options.syncToken = response.lastSyncToken as string
      this.options.paginationToken = response.paginationToken

      await this.receiver(SyncSignal.Response, response)
      if (response.hasError) {
        return { recoveredCount: recoveredCount + 1, hasError: true }
      }
      await transportResult.markCheckpointDurable?.()
      recoveredCount += 1
    }

    return { recoveredCount, hasError: false }
  }

  get done() {
    return this.pendingPayloads.length === 0 && !this.options.paginationToken
  }

  private get pendingUploadCount() {
    return this.pendingPayloads.length
  }

  private get totalUploadCount() {
    return this.payloads.length
  }

  private get upLimit() {
    return SyncUpDownLimit
  }

  private get downLimit() {
    return SyncUpDownLimit
  }

  get numberOfItemsInvolved() {
    let total = 0
    for (const response of this.responses) {
      total += response.numberOfItemsInvolved
    }
    return total
  }

  private assertPaginationWithinLimits(): void {
    if (this.pageCount >= this.paginationGuard.maxPages) {
      this.stopForGuard('maximum-pages')
    }
    if (this.cumulativeResponseBytes >= this.paginationGuard.maxResponseBytes) {
      this.stopForGuard('maximum-response-bytes')
    }
    if (this.elapsedMs() >= this.paginationGuard.maxElapsedMs) {
      this.stopForGuard('maximum-elapsed-time')
    }
  }

  private remainingResponseByteBudget(): number {
    return Math.max(1, this.paginationGuard.maxResponseBytes - this.cumulativeResponseBytes + 1)
  }

  private stopForGuard(reason: Exclude<AccountSyncPaginationGuardReason, 'repeated-cursor'>): never {
    this.emitPaginationMetric({
      type: 'guard',
      reason,
      pages: this.pageCount,
      cumulativeResponseBytes: this.cumulativeResponseBytes,
      elapsedMs: this.elapsedMs(),
    })
    throw this.guardError(reason)
  }

  private guardError(reason: AccountSyncPaginationGuardReason): AccountSyncPaginationGuardError {
    return new AccountSyncPaginationGuardError(reason, this.pageCount, this.cumulativeResponseBytes, this.elapsedMs())
  }

  private elapsedMs(): number {
    return Math.max(0, this.now() - this.startedAt)
  }

  private emitPaginationMetric(metric: AccountSyncPaginationMetric): void {
    try {
      this.options.onPaginationMetric?.(metric)
    } catch {
      // Observability is best-effort and must never alter sync correctness.
    }
  }

  private syncOverHttp(
    request: AccountSyncTransportRequest,
    command?: AccountSyncCommandMetadata,
  ): Promise<HttpResponse<RawSyncResponse>> {
    return this.apiService.sync(
      request.items as ServerSyncPushContextualPayload[],
      request.sync_token,
      request.cursor_token,
      request.limit,
      request.shared_vault_uuids,
      command,
    )
  }
}

function positiveFiniteIntegerOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/** Non-cryptographic redacted fingerprint for correlation only; never log raw cursors. */
function hashCursorForMetric(cursor: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < cursor.length; index++) {
    hash ^= cursor.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function estimateResponseBytes(rawResponse: unknown, stopAfterBytes: number): number {
  const candidate = rawResponse as {
    data?: unknown
    headers?: { get?: (key: string) => string | null | undefined }
  }
  const contentLengthValue = candidate.headers?.get?.('content-length')
  const contentLength =
    contentLengthValue === undefined || contentLengthValue === null ? NaN : Number(contentLengthValue)
  if (Number.isSafeInteger(contentLength) && contentLength >= 0) {
    return contentLength
  }

  return estimateJsonUtf8Bytes(candidate.data, stopAfterBytes)
}

/**
 * Allocation-bounded JSON-size estimate. It scans strings without serializing
 * ciphertext into a second giant buffer and stops once the configured guard is
 * known to have been crossed.
 */
function estimateJsonUtf8Bytes(value: unknown, stopAfterBytes: number): number {
  const seen = new WeakSet<object>()
  let bytes = 0

  const add = (amount: number): boolean => {
    bytes += amount
    return bytes >= stopAfterBytes
  }
  const visit = (candidate: unknown): boolean => {
    if (candidate === null) {
      return add(4)
    }
    switch (typeof candidate) {
      case 'string':
        return add(utf8ByteLength(candidate) + 2)
      case 'number':
        return add(String(candidate).length)
      case 'boolean':
        return add(candidate ? 4 : 5)
      case 'undefined':
        return false
      case 'object': {
        if (seen.has(candidate)) {
          return false
        }
        seen.add(candidate)
        if (Array.isArray(candidate)) {
          if (add(2)) {
            return true
          }
          for (const entry of candidate) {
            if (visit(entry) || add(1)) {
              return true
            }
          }
          return false
        }
        if (add(2)) {
          return true
        }
        for (const [key, entry] of Object.entries(candidate)) {
          if (add(utf8ByteLength(key) + 4) || visit(entry)) {
            return true
          }
        }
        return false
      }
      default:
        return false
    }
  }

  visit(value)
  return bytes
}

function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) {
      bytes += 1
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}
