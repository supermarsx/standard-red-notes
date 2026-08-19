import { IntegrityEvent } from './IntegrityEvent'
import { AbstractService } from '../Service/AbstractService'
import { ItemsServerInterface } from '../Item/ItemsServerInterface'
import { IntegrityApiInterface } from './IntegrityApiInterface'
import { GetSingleItemResponse, HttpResponse, isErrorResponse, ServerItemResponse } from '@standardnotes/responses'
import { InternalEventHandlerInterface } from '../Internal/InternalEventHandlerInterface'
import { InternalEventInterface } from '../Internal/InternalEventInterface'
import { InternalEventBusInterface } from '../Internal/InternalEventBusInterface'
import { SyncEvent } from '../Event/SyncEvent'
import { IntegrityEventPayload } from './IntegrityEventPayload'
import { SyncSource } from '../Sync/SyncSource'
import { PayloadManagerInterface } from '../Payloads/PayloadManagerInterface'
import { LoggerInterface } from '@standardnotes/utils'

/**
 * Repairing a mismatch costs one request per item, so an unbounded fan-out puts the whole
 * mismatch set in flight at once. A few hundred concurrent GETs starve every other request the
 * app makes — including the ones the user is waiting on — and drive their own latency up.
 */
const MAXIMUM_CONCURRENT_ITEM_FETCHES = 8

export class IntegrityService
  extends AbstractService<IntegrityEvent, IntegrityEventPayload>
  implements InternalEventHandlerInterface
{
  /**
   * The uuids the previous repair attempt tried and failed to reconcile. Repair is only allowed
   * to run again while it is demonstrably making progress — see handleEvent.
   */
  private unresolvedMismatchUuids?: Set<string>
  private hasReportedStalledRepair = false

  constructor(
    private integrityApi: IntegrityApiInterface,
    private itemApi: ItemsServerInterface,
    private payloadManager: PayloadManagerInterface,
    private logger: LoggerInterface,
    protected override internalEventBus: InternalEventBusInterface,
  ) {
    super(internalEventBus)
  }

  async handleEvent(event: InternalEventInterface): Promise<void> {
    if (event.type !== SyncEvent.SyncRequestsIntegrityCheck) {
      return
    }

    const source = (event.payload as { source: SyncSource }).source

    const integrityCheckResponse = await this.integrityApi.checkIntegrity(this.payloadManager.integrityPayloads)
    if (isErrorResponse(integrityCheckResponse)) {
      this.logger.error(`Could not obtain integrity check: ${integrityCheckResponse.data.error?.message}`)

      return
    }

    const mismatches = integrityCheckResponse.data.mismatches
    const mismatchUuids = new Set(mismatches.map((mismatch) => mismatch.uuid))

    if (mismatchUuids.size === 0) {
      this.unresolvedMismatchUuids = undefined
      this.hasReportedStalledRepair = false

      await this.notifyEventSync(IntegrityEvent.IntegrityCheckCompleted, { rawPayloads: [], source })

      return
    }

    /**
     * Applying a fetched item is not guaranteed to satisfy the next check: the apply path drops
     * payloads it cannot use (a payload that fails the remote filter, fails construction, or
     * fails to decrypt is discarded), and a mismatch on such an item is therefore permanent.
     * Because a completed repair re-arms another check, that turns into an endless cycle
     * re-fetching an identical uuid set, one request per item, for as long as the app is open.
     *
     * Repair may only proceed while it is converging. Anything else — the same set again, or a
     * set that grew — means the previous round achieved nothing, so stop fetching and report an
     * empty result, which settles the sync state rather than arming yet another round. The check
     * itself still runs each time (it is a single request), so genuine progress from any other
     * source resumes repair immediately.
     */
    if (this.unresolvedMismatchUuids && !this.isConvergingFrom(this.unresolvedMismatchUuids, mismatchUuids)) {
      if (!this.hasReportedStalledRepair) {
        this.hasReportedStalledRepair = true
        this.logger.error(
          `Integrity repair is not converging: ${mismatchUuids.size} item(s) still mismatch after a full repair ` +
            `round, so no further items will be fetched for them. First unreconciled uuids: ${[...mismatchUuids]
              .slice(0, 5)
              .join(', ')}`,
        )
      }

      await this.notifyEventSync(IntegrityEvent.IntegrityCheckCompleted, { rawPayloads: [], source })

      return
    }

    this.unresolvedMismatchUuids = mismatchUuids
    this.hasReportedStalledRepair = false

    const rawPayloads = await this.fetchMismatchedItems(mismatches.map((mismatch) => mismatch.uuid))

    await this.notifyEventSync(IntegrityEvent.IntegrityCheckCompleted, {
      rawPayloads: rawPayloads,
      source,
    })
  }

  /** Progress means strictly fewer outstanding mismatches than the round before. */
  private isConvergingFrom(previous: Set<string>, current: Set<string>): boolean {
    return current.size < previous.size
  }

  private async fetchMismatchedItems(uuids: string[]): Promise<ServerItemResponse[]> {
    const rawPayloads: ServerItemResponse[] = []
    let nextIndex = 0

    const worker = async (): Promise<void> => {
      while (nextIndex < uuids.length) {
        const uuid = uuids[nextIndex++]
        this.collectItemResponse(await this.itemApi.getSingleItem(uuid), rawPayloads)
      }
    }

    await Promise.all(Array.from({ length: Math.min(MAXIMUM_CONCURRENT_ITEM_FETCHES, uuids.length) }, () => worker()))

    return rawPayloads
  }

  private collectItemResponse(
    serverItemResponse: HttpResponse<GetSingleItemResponse>,
    rawPayloads: ServerItemResponse[],
  ): void {
    if (
      serverItemResponse.data == undefined ||
      isErrorResponse(serverItemResponse) ||
      !('item' in serverItemResponse.data)
    ) {
      this.logger.error(
        `Could not obtain item for integrity adjustments: ${
          isErrorResponse(serverItemResponse) ? serverItemResponse.data.error?.message : ''
        }`,
      )

      return
    }

    rawPayloads.push(serverItemResponse.data.item)
  }
}
