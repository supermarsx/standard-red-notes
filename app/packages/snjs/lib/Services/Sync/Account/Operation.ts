import { ServerSyncPushContextualPayload } from '@standardnotes/models'
import { arrayByDifference, nonSecureRandomIdentifier, subtractFromArray } from '@standardnotes/utils'
import { ServerSyncResponse } from '@Lib/Services/Sync/Account/Response'
import { ResponseSignalReceiver, SyncSignal } from '@Lib/Services/Sync/Signals'
import { LegacyApiService } from '../../Api/ApiService'

export const SyncUpDownLimit = 150

/**
 * A long running operation that handles multiple roundtrips from a server,
 * emitting a stream of values that should be acted upon in real time.
 */
export class AccountSyncOperation {
  public readonly id = nonSecureRandomIdentifier()

  private pendingPayloads: ServerSyncPushContextualPayload[]
  private responses: ServerSyncResponse[] = []

  /**
   * @param payloads   An array of payloads to send to the server
   * @param receiver   A function that receives callback multiple times during the operation
   */
  constructor(
    public readonly payloads: ServerSyncPushContextualPayload[],
    private receiver: ResponseSignalReceiver<ServerSyncResponse>,
    private apiService: LegacyApiService,
    public readonly options: {
      syncToken?: string
      paginationToken?: string
      sharedVaultUuids?: string[]
    },
  ) {
    this.pendingPayloads = payloads.slice()
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
    await this.receiver(SyncSignal.StatusChanged, undefined, {
      completedUploadCount: this.totalUploadCount - this.pendingUploadCount,
      totalUploadCount: this.totalUploadCount,
    })
    const payloads = this.popPayloads(this.upLimit)

    const rawResponse = await this.apiService.sync(
      payloads,
      this.options.syncToken,
      this.options.paginationToken,
      this.downLimit,
      this.options.sharedVaultUuids,
    )

    const response = new ServerSyncResponse(rawResponse)
    this.responses.push(response)

    this.options.syncToken = response.lastSyncToken as string
    this.options.paginationToken = response.paginationToken as string

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

    if (!this.done) {
      return this.run()
    }
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
}
