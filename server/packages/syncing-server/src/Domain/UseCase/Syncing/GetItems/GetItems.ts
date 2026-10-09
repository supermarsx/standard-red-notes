import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'
import { Time, TimerInterface } from '@standardnotes/time'

import { Item } from '../../../Item/Item'
import { GetItemsResult } from './GetItemsResult'
import { ItemQuery } from '../../../Item/ItemQuery'
import { ItemTransferCalculatorInterface } from '../../../Item/ItemTransferCalculatorInterface'
import { GetItemsDTO } from './GetItemsDTO'
import { SharedVaultUserRepositoryInterface } from '../../../SharedVault/User/SharedVaultUserRepositoryInterface'
import { ItemRepositoryInterface } from '../../../Item/ItemRepositoryInterface'
import { decodeSyncTokenExtension, scopeDigestFor, SYNC_POSITION_FUTURE_ALLOWANCE_MICROSECONDS } from '../SyncToken'

type SyncPosition = {
  lastSyncTime: number | null
  lastSyncUuid?: string
  isLegacyCursor: boolean
  ownWriteSessionUuid?: string
  ownWriteCeilingMicroseconds?: number
  scopeDigest?: string
}

export class GetItems implements UseCaseInterface<GetItemsResult> {
  private readonly DEFAULT_ITEMS_LIMIT = 150
  /** Sync tokens remain v2; cursor v3 adds the UUID keyset tie breaker. */
  private readonly CURSOR_TOKEN_VERSION = 3

  constructor(
    private itemRepository: ItemRepositoryInterface,
    private sharedVaultUserRepository: SharedVaultUserRepositoryInterface,
    private contentSizeTransferLimit: number,
    private itemTransferCalculator: ItemTransferCalculatorInterface,
    private timer: TimerInterface,
    private maxItemsSyncLimit: number,
    // Standard Red Notes: SHADOW-BAN caps. A shadow-banned user's per-sync page
    // size and content-transfer allowance are clamped to (at most) these values.
    // Trailing optional params (with sane defaults) so existing constructions
    // and specs keep their arity; the Container passes the env-configured values.
    private shadowBannedMaxItemsSyncLimit: number = 25,
    private shadowBannedContentSizeTransferLimit: number = 1_048_576,
  ) {}

  async execute(dto: GetItemsDTO): Promise<Result<GetItemsResult>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`User uuid is invalid: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const sharedVaultUsers = await this.sharedVaultUserRepository.findByUserUuid(userUuid)
    const userSharedVaultUuids = sharedVaultUsers.map((sharedVaultUser) => sharedVaultUser.props.sharedVaultUuid.value)

    const exclusiveSharedVaultUuids = dto.sharedVaultUuids
      ? dto.sharedVaultUuids.filter((sharedVaultUuid) => userSharedVaultUuids.includes(sharedVaultUuid))
      : undefined
    const includeSharedVaultUuids = !dto.sharedVaultUuids ? userSharedVaultUuids : undefined
    const scopeDigest = scopeDigestFor(exclusiveSharedVaultUuids)

    const syncPositionOrError = this.getSyncPosition(dto)
    if (syncPositionOrError.isFailed()) {
      return Result.fail(syncPositionOrError.getError())
    }
    const syncPosition = syncPositionOrError.getValue()

    const positionIsHonourableOrError = await this.verifyPositionIsHonourable(syncPosition, scopeDigest, {
      userUuid: userUuid.value,
      includeSharedVaultUuids,
      exclusiveSharedVaultUuids,
    })
    if (positionIsHonourableOrError.isFailed()) {
      return Result.fail(positionIsHonourableOrError.getError())
    }

    const { lastSyncTime, lastSyncUuid, isLegacyCursor } = syncPosition

    // Standard Red Notes: SHADOW-BAN degradation. For a shadow-banned user, clamp
    // both the max page size and the content-transfer allowance to the (smaller)
    // shadow limits, silently reducing how much they can pull per sync. Never
    // exceeds the normal limits, so it can only ever reduce, never widen.
    const effectiveMaxItemsSyncLimit = dto.shadowBanned
      ? Math.min(this.maxItemsSyncLimit, this.shadowBannedMaxItemsSyncLimit)
      : this.maxItemsSyncLimit
    const effectiveContentSizeTransferLimit = dto.shadowBanned
      ? Math.min(this.contentSizeTransferLimit, this.shadowBannedContentSizeTransferLimit)
      : this.contentSizeTransferLimit

    // Legacy cursors contain only a timestamp, so retain the inclusive boundary
    // for one compatibility page. Every response cursor emitted below is v3 and
    // can advance exactly by (timestamp, uuid).
    const syncTimeComparison = isLegacyCursor ? '>=' : '>'
    const limit = dto.limit === undefined || dto.limit < 1 ? this.DEFAULT_ITEMS_LIMIT : dto.limit
    const upperBoundLimit = limit < effectiveMaxItemsSyncLimit ? limit : effectiveMaxItemsSyncLimit

    const itemQuery: ItemQuery = {
      userUuid: userUuid.value,
      lastSyncTime: lastSyncTime ?? undefined,
      lastSyncUuid,
      syncTimeComparison,
      excludeUpdatedWithSession: syncPosition.ownWriteSessionUuid,
      excludeUpdatedWithSessionUpToTimestamp: syncPosition.ownWriteCeilingMicroseconds,
      contentType: dto.contentType,
      deleted: lastSyncTime ? undefined : false,
      sortBy: 'updated_at_timestamp',
      sortOrder: 'ASC',
      limit: upperBoundLimit,
      includeSharedVaultUuids,
      exclusiveSharedVaultUuids,
    }

    /**
     * Standard Red Notes (t99): THE RETRIEVAL HORIZON, and it must be read
     * before the line below and not after.
     *
     * Everything this result goes on to show was committed at or before this
     * instant, so this — not the end of the caller's save loop — is the position
     * the response may claim. The two reads underneath it can both return a row
     * that was rewritten after it, which only ever means the response carries
     * CONTENT NEWER than the position it reports: over-delivery, which the client
     * reconciles, and never the reverse.
     */
    const retrievalHorizonMicroseconds = this.timer.getTimestampInMicroseconds()

    const itemContentSizeDescriptors = await this.itemRepository.findContentSizeForComputingTransferLimit(itemQuery)
    const { uuids, transferLimitBreachedBeforeEndOfItems } = await this.itemTransferCalculator.computeItemUuidsToFetch(
      itemContentSizeDescriptors,
      effectiveContentSizeTransferLimit,
      userUuid,
    )
    let items: Array<Item> = []
    if (uuids.length > 0) {
      items = await this.itemRepository.findAll({
        uuids,
        sortBy: 'updated_at_timestamp',
        sortOrder: 'ASC',
      })
    }

    let cursorToken = undefined
    const thereAreStillMoreItemsToFetch = await this.stillMoreItemsToFetch(itemQuery, upperBoundLimit)
    // Standard Red Notes: only derive a cursor from the last fetched item when we
    // actually fetched something. The more-items flag can be set while `items` is
    // empty (e.g. descriptor rows hard-deleted between the transfer-limit
    // computation and findAll), and dereferencing items[-1] on an empty array
    // throws `undefined.props`, failing the entire sync. When empty, return
    // without a bogus cursor; the client re-syncs from its existing token.
    if ((transferLimitBreachedBeforeEndOfItems || thereAreStillMoreItemsToFetch) && items.length > 0) {
      const lastItem = items[items.length - 1]
      cursorToken = Buffer.from(
        `${this.CURSOR_TOKEN_VERSION}:${lastItem.props.timestamps.updatedAt}:${lastItem.id.toString()}`,
        'utf-8',
      ).toString('base64')
    }

    return Result.ok({
      items,
      cursorToken,
      lastSyncTime,
      retrievalHorizonMicroseconds,
      scopeDigest,
    })
  }

  private async stillMoreItemsToFetch(itemQuery: ItemQuery, upperBoundLimit: number): Promise<boolean> {
    const totalItemsCount = await this.itemRepository.countAll(itemQuery)

    return totalItemsCount > upperBoundLimit
  }

  /**
   * Standard Red Notes (t99): a position that cannot be honoured is an ERROR,
   * not an empty success.
   *
   * A well-formed token or cursor used to be answered `200` with no items and a
   * fresh token whenever it named a place this account could never be — a cursor
   * minted for a different account, or a position past this server's own clock.
   * That is the only shape that empties an account in one response, and it used
   * to emit no signal whatsoever: the client stored the fresh token and every row
   * below it was gone for good. Three guards, all of which refuse rather than
   * invent:
   *
   *  1. THE CLOCK. A position ahead of this server's clock (beyond a skew
   *     allowance) describes rows that do not exist yet.
   *  2. THE ACCOUNT. A v3 cursor carries an item uuid. The page it continues
   *     ended on that row, so the row must be one this account can SEE — its
   *     own, or one reachable through a shared vault it belongs to. A cursor
   *     replayed from another account fails this and used to answer `200 []`.
   *  3. THE SCOPE. A position measured inside a vault-exclusive retrieval is not
   *     a global one. Presenting it on a differently scoped sync is refused. The
   *     reverse — a global position on a vault-exclusive sync — is ACCEPTED,
   *     because a global position already covers every row in the narrower scope
   *     and so can only ever over-deliver.
   */
  private async verifyPositionIsHonourable(
    position: SyncPosition,
    requestScopeDigest: string | undefined,
    visibility: {
      userUuid: string
      includeSharedVaultUuids: string[] | undefined
      exclusiveSharedVaultUuids: string[] | undefined
    },
  ): Promise<Result<void>> {
    if (position.lastSyncTime === null) {
      return Result.ok()
    }

    const latestHonourablePosition =
      this.timer.getTimestampInMicroseconds() + SYNC_POSITION_FUTURE_ALLOWANCE_MICROSECONDS
    if (position.lastSyncTime > latestHonourablePosition) {
      return Result.fail('Sync position is ahead of the server clock and cannot be honoured')
    }

    if (position.scopeDigest !== undefined && position.scopeDigest !== requestScopeDigest) {
      return Result.fail('Sync token was issued for a different retrieval scope and cannot be honoured')
    }

    if (position.lastSyncUuid !== undefined) {
      const visibleRows = await this.itemRepository.countAll({
        uuids: [position.lastSyncUuid],
        userUuid: visibility.userUuid,
        includeSharedVaultUuids: visibility.includeSharedVaultUuids,
        exclusiveSharedVaultUuids: visibility.exclusiveSharedVaultUuids,
      })
      if (visibleRows === 0) {
        return Result.fail('Sync cursor refers to an item this account cannot continue from')
      }
    }

    return Result.ok()
  }

  private getSyncPosition(dto: GetItemsDTO): Result<SyncPosition> {
    let token = dto.syncToken
    let isCursor = false
    if (dto.cursorToken !== undefined && dto.cursorToken !== null) {
      token = dto.cursorToken
      isCursor = true
    }

    if (!token) {
      return Result.ok({ lastSyncTime: null, isLegacyCursor: false })
    }

    const decodedToken = Buffer.from(token, 'base64').toString('utf-8')

    const tokenParts = decodedToken.split(':')
    const version = tokenParts.shift()

    switch (version) {
      case '1': {
        const timestamp = this.timer.convertStringDateToMicroseconds(tokenParts.join(':'))
        return Number.isSafeInteger(timestamp) && timestamp >= 0
          ? Result.ok({ lastSyncTime: timestamp, isLegacyCursor: isCursor })
          : Result.fail('Sync token contains an invalid timestamp')
      }
      case '2': {
        const timestampInSeconds = Number(tokenParts[0])
        const timestamp = Math.round(timestampInSeconds * Time.MicrosecondsInASecond)
        if (!Number.isFinite(timestampInSeconds) || !Number.isSafeInteger(timestamp) || timestamp < 0) {
          return Result.fail('Sync token contains an invalid timestamp')
        }

        // Standard Red Notes (t99): the extension fields. A reader that does not
        // know them sees only tokenParts[0] and re-delivers, which is why they
        // could be added without a new version.
        return Result.ok({
          lastSyncTime: timestamp,
          isLegacyCursor: isCursor,
          ...decodeSyncTokenExtension(tokenParts.slice(1)),
        })
      }
      case '3': {
        if (tokenParts.length !== 2) {
          return Result.fail('Sync cursor is malformed')
        }
        const timestamp = Number(tokenParts[0])
        const uuidOrError = Uuid.create(tokenParts[1])
        if (!Number.isSafeInteger(timestamp) || timestamp < 0 || uuidOrError.isFailed()) {
          return Result.fail('Sync cursor is malformed')
        }
        return Result.ok({
          lastSyncTime: timestamp,
          lastSyncUuid: uuidOrError.getValue().value,
          isLegacyCursor: false,
        })
      }
      default:
        return Result.fail('Sync token is missing version part')
    }
  }
}
