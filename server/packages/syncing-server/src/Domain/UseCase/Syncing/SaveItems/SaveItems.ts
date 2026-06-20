import { MapperInterface, Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { SaveItemsResult } from './SaveItemsResult'
import { SaveItemsDTO } from './SaveItemsDTO'
import { Item } from '../../../Item/Item'
import { ItemConflict } from '../../../Item/ItemConflict'
import { ConflictType } from '@standardnotes/responses'
import { Time, TimerInterface } from '@standardnotes/time'
import { Logger } from 'winston'
import { ItemSaveValidatorInterface } from '../../../Item/SaveValidator/ItemSaveValidatorInterface'
import { SaveNewItem } from '../SaveNewItem/SaveNewItem'
import { UpdateExistingItem } from '../UpdateExistingItem/UpdateExistingItem'
import { ItemRepositoryInterface } from '../../../Item/ItemRepositoryInterface'
import { SendEventToClient } from '../SendEventToClient/SendEventToClient'
import { DomainEventFactoryInterface } from '../../../Event/DomainEventFactoryInterface'
import { SendEventToClients } from '../SendEventToClients/SendEventToClients'
import { CheckForContentLimit } from '../CheckForContentLimit/CheckForContentLimit'
import { ItemHttpRepresentation } from '../../../../Mapping/Http/ItemHttpRepresentation'
import { DomainEventInterface } from '@standardnotes/domain-events'

export class SaveItems implements UseCaseInterface<SaveItemsResult> {
  private readonly SYNC_TOKEN_VERSION = 2

  constructor(
    private itemSaveValidator: ItemSaveValidatorInterface,
    private itemRepository: ItemRepositoryInterface,
    private timer: TimerInterface,
    private saveNewItem: SaveNewItem,
    private updateExistingItem: UpdateExistingItem,
    private sendEventToClient: SendEventToClient,
    private sendEventToClients: SendEventToClients,
    private domainEventFactory: DomainEventFactoryInterface,
    private checkForContentLimit: CheckForContentLimit,
    private itemHttpMapper: MapperInterface<Item, ItemHttpRepresentation>,
    // Standard Red Notes (Phase 1A "websockets as primary sync path"):
    // when enabled, push the changed encrypted item payloads + the new sync
    // token over the websocket so other devices can apply them WITHOUT an HTTP
    // pull. This is purely an OPTIMIZATION layered on top of the existing
    // notify-then-pull flow: the client always degrades to a normal HTTP sync
    // if this is disabled, the change set is too large, the base token doesn't
    // match, or anything goes wrong. HTTP sync remains the source of truth.
    private websocketSyncPushEnabled: boolean,
    // Upper bound on the number of items we will inline into a single push. A
    // larger change set sends the plain ITEMS_CHANGED_ON_SERVER notification
    // only (the client then pulls via HTTP as today), so we never blow up a
    // single websocket frame.
    private websocketSyncPushMaxItems: number,
    private logger: Logger,
  ) {}

  async execute(dto: SaveItemsDTO): Promise<Result<SaveItemsResult>> {
    const savedItems: Array<Item> = []
    const conflicts: Array<ItemConflict> = []

    if (dto.hasContentLimit) {
      const checkForContentLimitResult = await this.checkForContentLimit.execute({
        userUuid: dto.userUuid,
        itemsBeingModified: dto.itemHashes,
      })
      if (checkForContentLimitResult.isFailed()) {
        this.logger.warn(`Checking for content limit failed. Error: ${checkForContentLimitResult.getError()}`, {
          userId: dto.userUuid,
        })

        return Result.fail(checkForContentLimitResult.getError())
      }
    }

    const lastUpdatedTimestamp = this.timer.getTimestampInMicroseconds()

    for (const itemHash of dto.itemHashes) {
      const itemUuidOrError = Uuid.create(itemHash.props.uuid)
      if (itemUuidOrError.isFailed()) {
        conflicts.push({
          unsavedItem: itemHash,
          type: ConflictType.UuidConflict,
        })

        continue
      }
      const itemUuid = itemUuidOrError.getValue()

      const existingItem = await this.itemRepository.findByUuid(itemUuid)

      if (dto.readOnlyAccess) {
        conflicts.push({
          unsavedItem: itemHash,
          serverItem: existingItem ?? undefined,
          type: ConflictType.ReadOnlyError,
        })

        continue
      }

      const processingResult = await this.itemSaveValidator.validate({
        userUuid: dto.userUuid,
        apiVersion: dto.apiVersion,
        itemHash,
        existingItem,
        snjsVersion: dto.snjsVersion,
      })
      if (!processingResult.passed) {
        if (processingResult.conflict) {
          conflicts.push(processingResult.conflict)
        }
        if (processingResult.skipped) {
          savedItems.push(processingResult.skipped)
        }

        continue
      }

      if (existingItem) {
        const udpatedItemOrError = await this.updateExistingItem.execute({
          existingItem,
          itemHash,
          sessionUuid: dto.sessionUuid,
          performingUserUuid: dto.userUuid,
          isFreeUser: dto.isFreeUser,
        })
        if (udpatedItemOrError.isFailed()) {
          this.logger.error(
            `[${dto.userUuid}] Updating item ${itemHash.props.uuid} failed. Error: ${udpatedItemOrError.getError()}`,
          )

          conflicts.push({
            unsavedItem: itemHash,
            type: ConflictType.UuidConflict,
          })

          continue
        }
        const updatedItem = udpatedItemOrError.getValue()

        savedItems.push(updatedItem)
      } else {
        try {
          const newItemOrError = await this.saveNewItem.execute({
            userUuid: dto.userUuid,
            itemHash,
            sessionUuid: dto.sessionUuid,
          })
          if (newItemOrError.isFailed()) {
            this.logger.error(
              `[${dto.userUuid}] Saving item ${itemHash.props.uuid} failed. Error: ${newItemOrError.getError()}`,
            )

            conflicts.push({
              unsavedItem: itemHash,
              type: ConflictType.UuidConflict,
            })

            continue
          }
          const newItem = newItemOrError.getValue()

          savedItems.push(newItem)
        } catch (error) {
          this.logger.error(
            `[${dto.userUuid}] Saving item ${itemHash.props.uuid} failed. Error: ${(error as Error).message}`,
          )

          conflicts.push({
            unsavedItem: itemHash,
            type: ConflictType.UuidConflict,
          })

          continue
        }
      }
    }

    const syncToken = this.calculateSyncToken(lastUpdatedTimestamp, savedItems)

    // The token representing the server's state immediately BEFORE this batch
    // was applied. A receiving device only fast-applies the pushed payloads if
    // its own current sync token equals this base token (i.e. it was exactly
    // caught up); otherwise it discards the push and reconciles over HTTP.
    const baseSyncToken = this.calculateSyncToken(lastUpdatedTimestamp, [])

    await this.notifyOtherClientsOfTheUserThatItemsChanged(dto, savedItems, lastUpdatedTimestamp, syncToken, baseSyncToken)

    return Result.ok({
      savedItems,
      conflicts,
      syncToken,
    })
  }

  /**
   * Build the realtime websocket message for a set of changed items. When the
   * change set is small enough and the push optimization is enabled, this is a
   * SYNC_ITEMS_PUSHED message carrying the already-encrypted item payloads plus
   * the new and base sync tokens, so other devices can apply the change without
   * an HTTP pull. Otherwise it falls back to the plain ITEMS_CHANGED_ON_SERVER
   * notification (the client then pulls via HTTP exactly as it does today).
   *
   * Never sends plaintext: the payloads are the same end-to-end-encrypted
   * representation the client already receives for retrieved items over HTTP.
   */
  private buildItemsChangedMessage(
    dto: SaveItemsDTO,
    savedItems: Item[],
    lastUpdatedTimestamp: number,
    syncToken: string,
    baseSyncToken: string,
  ): DomainEventInterface {
    const notification = this.domainEventFactory.createItemsChangedOnServerEvent({
      userUuid: dto.userUuid,
      sessionUuid: dto.sessionUuid ?? '',
      timestamp: lastUpdatedTimestamp,
    })

    const canPush =
      this.websocketSyncPushEnabled &&
      savedItems.length > 0 &&
      savedItems.length <= this.websocketSyncPushMaxItems

    if (!canPush) {
      return notification
    }

    return {
      type: 'SYNC_ITEMS_PUSHED',
      createdAt: notification.createdAt,
      meta: notification.meta,
      payload: {
        userUuid: dto.userUuid,
        sessionUuid: dto.sessionUuid ?? '',
        timestamp: lastUpdatedTimestamp,
        syncToken,
        baseSyncToken,
        items: savedItems.map((item) => this.itemHttpMapper.toProjection(item)),
      },
    }
  }

  private async notifyOtherClientsOfTheUserThatItemsChanged(
    dto: SaveItemsDTO,
    savedItems: Item[],
    lastUpdatedTimestamp: number,
    syncToken: string,
    baseSyncToken: string,
  ): Promise<void> {
    // Emit on any saved item so realtime push works even when the session is
    // not propagated into the sync context (self-hosted/cross-service). Without
    // a session the message simply isn't excluded from the originating client,
    // which is harmless (a no-op re-sync).
    if (savedItems.length === 0) {
      return
    }

    // Plain notification for cross-user shared-vault fan-out. We deliberately do
    // NOT inline payloads across users: the base-token continuity guarantee only
    // holds within a single user's own devices, so collaborators always pull via
    // HTTP (unchanged behaviour).
    const itemsChangedEvent = this.domainEventFactory.createItemsChangedOnServerEvent({
      userUuid: dto.userUuid,
      sessionUuid: dto.sessionUuid ?? '',
      timestamp: lastUpdatedTimestamp,
    })

    // The personal realtime message to the user's OTHER devices: SYNC_ITEMS_PUSHED
    // (encrypted payloads + tokens) when small enough and enabled, otherwise the
    // plain notification. Either way the gateway excludes the originating session.
    const personalMessage = this.buildItemsChangedMessage(
      dto,
      savedItems,
      lastUpdatedTimestamp,
      syncToken,
      baseSyncToken,
    )

    // Standard Red Notes: live-sync gating. When disabled for this user, skip the
    // personal realtime push only. The save has already persisted; clients will
    // still pick up the change on their next regular sync. The shared-vault
    // fan-out below is intentionally left untouched.
    if (dto.liveSyncEnabled) {
      const result = await this.sendEventToClient.execute({
        userUuid: dto.userUuid,
        originatingSessionUuid: dto.sessionUuid ?? undefined,
        event: personalMessage,
      })
      /* istanbul ignore next */
      if (result.isFailed()) {
        this.logger.error(`Sending items changed event to client failed. Error: ${result.getError()}`, {
          userId: dto.userUuid,
        })
      }
    }

    const sharedVaultUuidsMap = new Map<string, boolean>()
    for (const item of savedItems) {
      if (item.isAssociatedWithASharedVault()) {
        sharedVaultUuidsMap.set((item.sharedVaultUuid as Uuid).value, true)
      }
    }
    const sharedVaultUuids = Array.from(sharedVaultUuidsMap.keys())
    for (const sharedVaultUuid of sharedVaultUuids) {
      const result = await this.sendEventToClients.execute({
        sharedVaultUuid,
        event: itemsChangedEvent,
        originatingUserUuid: dto.userUuid,
      })
      /* istanbul ignore next */
      if (result.isFailed()) {
        this.logger.error(`Sending items changed event to clients failed. Error: ${result.getError()}`, {
          userId: dto.userUuid,
          sharedVaultUuid,
        })
      }
    }
  }

  private calculateSyncToken(lastUpdatedTimestamp: number, savedItems: Array<Item>): string {
    if (savedItems.length) {
      const sortedItems = savedItems.sort((itemA: Item, itemB: Item) => {
        return itemA.props.timestamps.updatedAt > itemB.props.timestamps.updatedAt ? 1 : -1
      })
      lastUpdatedTimestamp = sortedItems[sortedItems.length - 1].props.timestamps.updatedAt
    }

    const lastUpdatedTimestampWithMicrosecondPreventingSyncDoubles = lastUpdatedTimestamp + 1

    return Buffer.from(
      `${this.SYNC_TOKEN_VERSION}:${
        lastUpdatedTimestampWithMicrosecondPreventingSyncDoubles / Time.MicrosecondsInASecond
      }`,
      'utf-8',
    ).toString('base64')
  }
}
