import { safeErrorLogMetadata, ContentType, Result, UseCaseInterface } from '@standardnotes/domain-core'

import { Item } from '../../../Item/Item'
import { ItemConflict } from '../../../Item/ItemConflict'
import { SyncItemsDTO } from './SyncItemsDTO'
import { SyncItemsResponse } from './SyncItemsResponse'
import { GetItems } from '../GetItems/GetItems'
import { SaveItems } from '../SaveItems/SaveItems'
import { GetSharedVaults } from '../../SharedVaults/GetSharedVaults/GetSharedVaults'
import { GetSharedVaultInvitesSentToUser } from '../../SharedVaults/GetSharedVaultInvitesSentToUser/GetSharedVaultInvitesSentToUser'
import { GetMessagesSentToUser } from '../../Messaging/GetMessagesSentToUser/GetMessagesSentToUser'
import { GetUserNotifications } from '../../Messaging/GetUserNotifications/GetUserNotifications'
import { Logger } from 'winston'
import { ItemRepositoryInterface } from '../../../Item/ItemRepositoryInterface'
import { GetItemsResult } from '../GetItems/GetItemsResult'
import { SaveItemsResult } from '../SaveItems/SaveItemsResult'
import { decodeSyncTokenPosition, encodeSyncToken } from '../SyncToken'

export class SyncItems implements UseCaseInterface<SyncItemsResponse> {
  constructor(
    private itemRepository: ItemRepositoryInterface,
    private getItemsUseCase: GetItems,
    private saveItemsUseCase: SaveItems,
    private getSharedVaultsUseCase: GetSharedVaults,
    private getSharedVaultInvitesSentToUserUseCase: GetSharedVaultInvitesSentToUser,
    private getMessagesSentToUser: GetMessagesSentToUser,
    private getUserNotifications: GetUserNotifications,
    private logger: Logger,
  ) {}

  async execute(dto: SyncItemsDTO): Promise<Result<SyncItemsResponse>> {
    try {
      const getItemsResultOrError = await this.getItemsUseCase.execute({
        userUuid: dto.userUuid,
        syncToken: dto.syncToken,
        cursorToken: dto.cursorToken,
        limit: dto.limit,
        contentType: dto.contentType,
        sharedVaultUuids: dto.sharedVaultUuids,
        // Standard Red Notes: SHADOW-BAN — GetItems caps page size + transfer.
        shadowBanned: dto.shadowBanned === true,
      })
      if (getItemsResultOrError.isFailed()) {
        return Result.fail(getItemsResultOrError.getError())
      }
      const getItemsResult = getItemsResultOrError.getValue()

      const saveItemsResultOrError = await this.saveItemsUseCase.execute({
        itemHashes: dto.itemHashes,
        userUuid: dto.userUuid,
        apiVersion: dto.apiVersion,
        readOnlyAccess: dto.readOnlyAccess,
        sessionUuid: dto.sessionUuid,
        snjsVersion: dto.snjsVersion,
        isFreeUser: dto.isFreeUser,
        hasContentLimit: dto.hasContentLimit,
        // Standard Red Notes: SHADOW-BAN silently disables real-time push for
        // the user (their other devices fall back to slower manual/HTTP sync).
        // Achieved by forcing live-sync off here — SaveItems needs no change.
        liveSyncEnabled: dto.liveSyncEnabled && dto.shadowBanned !== true,
      })
      if (saveItemsResultOrError.isFailed()) {
        return Result.fail(saveItemsResultOrError.getError())
      }
      const saveItemsResult = saveItemsResultOrError.getValue()

      let retrievedItems = this.filterOutSyncConflictsForConsecutiveSyncs(
        getItemsResult.items,
        saveItemsResult.conflicts,
      )
      const isSharedVaultExclusiveSync = dto.sharedVaultUuids && dto.sharedVaultUuids.length > 0
      if (this.isFirstSync(dto) && !isSharedVaultExclusiveSync) {
        retrievedItems = await this.frontLoadHighLoadingPriorityItemsToTop(dto.userUuid, retrievedItems)
      }

      const sharedVaultsOrError = await this.getSharedVaultsUseCase.execute({
        userUuid: dto.userUuid,
        includeDesignatedSurvivors: false,
        lastSyncTime: getItemsResult.lastSyncTime ?? undefined,
      })
      if (sharedVaultsOrError.isFailed()) {
        return Result.fail(sharedVaultsOrError.getError())
      }
      const sharedVaultsResult = sharedVaultsOrError.getValue()

      const sharedVaultInvitesOrError = await this.getSharedVaultInvitesSentToUserUseCase.execute({
        userUuid: dto.userUuid,
        lastSyncTime: getItemsResult.lastSyncTime ?? undefined,
      })
      if (sharedVaultInvitesOrError.isFailed()) {
        return Result.fail(sharedVaultInvitesOrError.getError())
      }
      const sharedVaultInvites = sharedVaultInvitesOrError.getValue()

      const messagesOrError = await this.getMessagesSentToUser.execute({
        recipientUuid: dto.userUuid,
        lastSyncTime: getItemsResult.lastSyncTime ?? undefined,
      })
      if (messagesOrError.isFailed()) {
        return Result.fail(messagesOrError.getError())
      }
      const messages = messagesOrError.getValue()

      const notificationsOrError = await this.getUserNotifications.execute({
        userUuid: dto.userUuid,
        lastSyncTime: getItemsResult.lastSyncTime ?? undefined,
      })
      if (notificationsOrError.isFailed()) {
        return Result.fail(notificationsOrError.getError())
      }
      const notifications = notificationsOrError.getValue()

      const syncResponse: SyncItemsResponse = {
        retrievedItems,
        syncToken: this.responseSyncToken(dto, getItemsResult, saveItemsResult),
        savedItems: saveItemsResult.savedItems,
        conflicts: saveItemsResult.conflicts,
        cursorToken: getItemsResult.cursorToken,
        sharedVaultInvites,
        sharedVaults: sharedVaultsResult.sharedVaults,
        messages,
        notifications,
      }

      return Result.ok(syncResponse)
    } catch (error) {
      const itemHashUuids = dto.itemHashes.map((itemHash) => itemHash.props.uuid)
      this.logger.error(
        `Sync error for user ${dto.userUuid} syncing items ${itemHashUuids.join(',')}.`,
        safeErrorLogMetadata(error),
      )
      throw error
    }
  }

  /**
   * Standard Red Notes (t99): THE RESPONSE TOKEN, CLAMPED TO WHAT WAS SHOWN.
   *
   * This method exists because of a proven, silent, permanent loss. The token
   * used to be `saveItemsResult.syncToken`, derived from the END of this
   * request's save loop, while the rows came from a snapshot taken BEFORE it.
   * The response therefore told the client "you hold everything up to
   * T_save_end" having shown it rows only as of T_get, and every row another
   * device committed in between — measured at 10/10 lost with a 25-item client
   * batch, with every cursor followed to exhaustion — was skipped for good. The
   * window is the duration of the client's own save loop, so it is widest
   * exactly when an idle tab wakes up and flushes a big dirty batch.
   *
   * Two halves, and the second one is only an optimisation of the first:
   *
   *  (1) THE CLAMP. The position is `min(save token, retrieval horizon)`, so the
   *      response can only ever claim a position it actually showed. Nothing is
   *      skipped, at any batch size.
   *
   *  (2) THE OWN-WRITE SKIP. Clamping below this request's own saves means the
   *      next sync would re-deliver what the client just saved. That is SAFE —
   *      re-delivering beats skipping, always — but not free: a re-delivered own
   *      write whose local copy has since been edited and left to settle resolves
   *      through the client's conflict strategy, which moves the newer edit into
   *      a conflict copy and restores the older content under the original uuid.
   *      So the clamped token carries the saving session and a CEILING, and the
   *      next retrieval skips only rows that session wrote at or below it.
   *
   *      The ceiling is what keeps this safe. Another tab on the same device
   *      shares a session uuid, so an open-ended "never deliver my own session's
   *      writes" would silently withhold a peer tab's later saves — trading this
   *      defect for a fresh one. Above the ceiling nothing is ever skipped.
   *
   *      `updated_with_session` is NULL whenever the session was not propagated
   *      into the sync context, and the skip then matches nothing: the token is
   *      still clamped and the own writes are simply re-delivered. The
   *      conservative direction is the default, not the exception.
   */
  private responseSyncToken(
    dto: SyncItemsDTO,
    getItemsResult: GetItemsResult,
    saveItemsResult: SaveItemsResult,
  ): string {
    const saveTokenPosition = decodeSyncTokenPosition(saveItemsResult.syncToken)
    if (saveTokenPosition === undefined) {
      // SaveItems always emits a v2 token; if that ever stops being true, hand
      // its token back untouched rather than invent a position for it.
      return saveItemsResult.syncToken
    }

    const positionMicroseconds = Math.min(saveTokenPosition, getItemsResult.retrievalHorizonMicroseconds)
    const clampedBelowOwnWrites = positionMicroseconds < saveTokenPosition
    const canSkipOwnWrites = clampedBelowOwnWrites && dto.sessionUuid !== null && saveItemsResult.savedItems.length > 0

    return encodeSyncToken({
      positionMicroseconds,
      ownWriteSessionUuid: canSkipOwnWrites ? (dto.sessionUuid as string) : undefined,
      ownWriteCeilingMicroseconds: canSkipOwnWrites ? saveTokenPosition : undefined,
      scopeDigest: getItemsResult.scopeDigest,
    })
  }

  private isFirstSync(dto: SyncItemsDTO): boolean {
    return dto.syncToken === undefined || dto.syncToken === null
  }

  private filterOutSyncConflictsForConsecutiveSyncs(
    retrievedItems: Array<Item>,
    conflicts: Array<ItemConflict>,
  ): Array<Item> {
    const syncConflictIds: Array<string> = []
    conflicts.forEach((conflict: ItemConflict) => {
      if (conflict.type === 'sync_conflict' && conflict.serverItem) {
        syncConflictIds.push(conflict.serverItem.id.toString())
      }
    })

    return retrievedItems.filter((item: Item) => syncConflictIds.indexOf(item.id.toString()) === -1)
  }

  private async frontLoadHighLoadingPriorityItemsToTop(
    userUuid: string,
    retrievedItems: Array<Item>,
  ): Promise<Array<Item>> {
    const highPriorityItems = await this.itemRepository.findAll({
      userUuid,
      contentType: [ContentType.TYPES.ItemsKey, ContentType.TYPES.UserPrefs, ContentType.TYPES.Theme],
      sortBy: 'updated_at_timestamp',
      sortOrder: 'ASC',
    })

    const retrievedItemsIds: Array<string> = retrievedItems.map((item: Item) => item.id.toString())

    highPriorityItems.forEach((highPriorityItem: Item) => {
      if (retrievedItemsIds.indexOf(highPriorityItem.id.toString()) === -1) {
        retrievedItems.unshift(highPriorityItem)
      }
    })

    return retrievedItems
  }
}
