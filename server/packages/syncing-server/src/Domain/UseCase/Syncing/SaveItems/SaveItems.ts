import {
  ContentType,
  safeErrorLogMetadata,
  MapperInterface,
  Result,
  UseCaseInterface,
  Uuid,
} from '@standardnotes/domain-core'

import { SaveItemsResult } from './SaveItemsResult'
import { SaveItemsDTO } from './SaveItemsDTO'
import { Item } from '../../../Item/Item'
import { ItemConflict } from '../../../Item/ItemConflict'
import { ItemHash } from '../../../Item/ItemHash'
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
import { ConcurrentItemUpdateError } from '../../../Item/ConcurrentItemUpdateError'

/**
 * `WEBSOCKET_SYNC_PUSH_ENABLED` parser. Only the exact string 'true' turns the
 * SYNC_ITEMS_PUSHED inlining on; unset, empty, or anything else leaves it off
 * (see the constructor comment on `websocketSyncPushEnabled` for why the
 * default is off).
 */
export const parseWebsocketSyncPushEnabled = (value: string | undefined): boolean => value === 'true'

export const WEBSOCKET_SYNC_PUSH_MAX_ITEMS_DEFAULT = 50
export const WEBSOCKET_SYNC_PUSH_MAX_BYTES_DEFAULT = 200 * 1024

/** `WEBSOCKET_SYNC_PUSH_MAX_ITEMS` parser: a positive integer, else the default. */
export const parseWebsocketSyncPushMaxItems = (value: string | undefined): number =>
  parsePositiveInteger(value) ?? WEBSOCKET_SYNC_PUSH_MAX_ITEMS_DEFAULT

/** `WEBSOCKET_SYNC_PUSH_MAX_BYTES` parser: a positive integer, else the default (200 KiB). */
export const parseWebsocketSyncPushMaxBytes = (value: string | undefined): number =>
  parsePositiveInteger(value) ?? WEBSOCKET_SYNC_PUSH_MAX_BYTES_DEFAULT

const parsePositiveInteger = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^\d+$/.test(value)) {
    return undefined
  }
  const parsed = Number(value)

  return parsed > 0 && Number.isSafeInteger(parsed) ? parsed : undefined
}

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
    // Standard Red Notes websocket push (`WEBSOCKET_SYNC_PUSH_ENABLED`). When
    // enabled, the changed encrypted item payloads + the new and base sync
    // tokens are inlined into a SYNC_ITEMS_PUSHED message so another device
    // that is exactly caught up can apply them WITHOUT an HTTP pull.
    //
    // DEFAULT OFF (t92 decision (i), t90 finding D4). Today's sync token is the
    // saver's own request-start microsecond (`lastUpdatedTimestamp` below), and
    // no receiver ever holds that value as its current token, so the client's
    // strict `currentToken === baseSyncToken` gate never passes: every inlined
    // payload was discarded and re-pulled over HTTP. Until the token is a
    // per-user monotonic change sequence persisted with each batch (the
    // planned redesign), inlining only doubles the bytes on the wire. With the
    // flag off the server sends the plain ITEMS_CHANGED_ON_SERVER notification
    // and the client pulls over HTTP, which is the same latency as before.
    // HTTP sync remains the source of truth either way.
    private websocketSyncPushEnabled: boolean,
    // Upper bound on the number of items we will inline into a single push. A
    // larger change set sends the plain ITEMS_CHANGED_ON_SERVER notification
    // only (the client then pulls via HTTP as today), so we never blow up a
    // single websocket frame.
    private websocketSyncPushMaxItems: number,
    // Upper bound on the serialised size of the inlined projections. The count
    // cap above does not bound bytes (50 large notes can exceed the 256 KiB SNS
    // message limit and poison the durable outbox), so a change set whose
    // JSON projections exceed this many bytes also degrades to the plain
    // notification.
    private websocketSyncPushMaxBytes: number,
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
        this.logger.warn('Checking for content limit failed.', {
          ...safeErrorLogMetadata(checkForContentLimitResult.getError()),
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
        // Standard Red Notes: wrap the update path symmetrically with the
        // save-new path below. UpdateExistingItem.execute normally returns a
        // failed Result on error, but a thrown/rejected execution (e.g. a
        // transient DB error) would otherwise propagate as an unhandled
        // rejection and abort the whole batch. The item is NOT pushed into
        // savedItems, so we never ack a save that did not persist; the client
        // retries it on the next sync (see the t97 fix note in the catch below
        // for why that must NOT be reported as ConflictType.UuidConflict).
        try {
          const udpatedItemOrError = await this.updateExistingItem.execute({
            existingItem,
            itemHash,
            sessionUuid: dto.sessionUuid,
            performingUserUuid: dto.userUuid,
            isFreeUser: dto.isFreeUser,
          })
          if (udpatedItemOrError.isFailed()) {
            this.logger.error(
              `[${dto.userUuid}] Updating item ${itemHash.props.uuid} failed.`,
              safeErrorLogMetadata(udpatedItemOrError.getError()),
            )

            conflicts.push({
              unsavedItem: itemHash,
              type: this.structuralFailureConflictType(itemHash),
            })

            continue
          }
          const updatedItem = udpatedItemOrError.getValue()

          savedItems.push(updatedItem)
        } catch (error) {
          if (error instanceof ConcurrentItemUpdateError) {
            conflicts.push({
              unsavedItem: itemHash,
              serverItem: error.serverItem,
              type: ConflictType.ConflictingData,
            })

            continue
          }

          /**
           * Standard Red Notes (t97): a genuine cross-account uuid collision for an
           * EXISTING item is already caught upstream, before this call ever runs, by
           * OwnershipFilter (ItemSaveValidatorInterface.validate above, `itemHash`
           * validated against `existingItem.props.userUuid`) — that is the one place
           * in this codebase that reliably knows this uuid belongs to someone else,
           * and it already reports ConflictType.UuidConflict when it does. Anything
           * that reaches THIS catch has therefore already passed ownership: it is an
           * unclassified failure from the update call itself (a DB connection error,
           * a timeout, a deadlock — SQLItemRepository.update's own "item disappeared"
           * throw included), not an identity conflict.
           *
           * Reporting it as UuidConflict was a bug, not a feature: on the client,
           * UuidConflict is a destructive instruction (PayloadsByAlternatingUuid
           * duplicates the item under a brand-new uuid and unconditionally discards
           * the original, dirty:false, in the same pass it is applied) triggered by
           * nothing more than this transient infrastructure fault. A note the user
           * was actively editing would vanish out from under them for no reason
           * connected to anything they did. Log and leave the item unacknowledged
           * instead (neither saved nor conflicted) so it stays dirty locally and the
           * client's ordinary next sync attempt retries it once the fault clears.
           */
          this.logger.error(
            `[${dto.userUuid}] Updating item ${itemHash.props.uuid} threw.`,
            safeErrorLogMetadata(error),
          )

          continue
        }
      } else {
        try {
          const newItemOrError = await this.saveNewItem.execute({
            userUuid: dto.userUuid,
            itemHash,
            sessionUuid: dto.sessionUuid,
          })
          if (newItemOrError.isFailed()) {
            this.logger.error(
              `[${dto.userUuid}] Saving item ${itemHash.props.uuid} failed.`,
              safeErrorLogMetadata(newItemOrError.getError()),
            )

            conflicts.push({
              unsavedItem: itemHash,
              type: this.structuralFailureConflictType(itemHash),
            })

            continue
          }
          const newItem = newItemOrError.getValue()

          savedItems.push(newItem)
        } catch (error) {
          // Standard Red Notes (t97): same reasoning as the update branch above — an
          // unclassified thrown error here (a DB connection fault, not a rejection
          // this use case itself decided on) is an infrastructure fault, not a
          // uuid identity conflict. Do not report ConflictType.UuidConflict for it;
          // leave the item unacknowledged so the client retries the create on its
          // next sync rather than being told to regenerate the item's uuid.
          this.logger.error(`[${dto.userUuid}] Saving item ${itemHash.props.uuid} failed.`, safeErrorLogMetadata(error))

          continue
        }
      }
    }

    const syncToken = this.calculateSyncToken(lastUpdatedTimestamp, savedItems)

    // The token the push advertises as the server's state immediately BEFORE
    // this batch. A receiving device only fast-applies the pushed payloads if
    // its own current sync token equals it; otherwise it discards the push and
    // reconciles over HTTP. NOTE: this is derived from THIS request's start
    // time, which no other device can hold, so at present the gate never
    // passes (t90 D4) — fast-apply needs a persisted per-user change sequence
    // as the token before it can fire. The push is therefore off by default.
    const baseSyncToken = this.calculateSyncToken(lastUpdatedTimestamp, [])

    // Standard Red Notes: the items above are already durably persisted. Client
    // notification / realtime push is best-effort — if it throws (e.g. a Redis
    // publish blip) we must NOT turn a successful save into a failed request.
    // Swallow-and-log only the post-persist notification; other clients will pick
    // the change up on their next regular sync. (The actual persist errors above
    // are still surfaced as conflicts, not swallowed here.)
    try {
      await this.notifyOtherClientsOfTheUserThatItemsChanged(
        dto,
        savedItems,
        lastUpdatedTimestamp,
        syncToken,
        baseSyncToken,
      )
    } catch (error) {
      this.logger.error(
        `[${dto.userUuid}] Notifying other clients of changed items failed post-persist (items already saved).`,
        safeErrorLogMetadata(error),
      )
    }

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
      this.websocketSyncPushEnabled && savedItems.length > 0 && savedItems.length <= this.websocketSyncPushMaxItems

    if (!canPush) {
      return notification
    }

    const items = savedItems.map((item) => this.itemHttpMapper.toProjection(item))
    const serialisedBytes = Buffer.byteLength(JSON.stringify(items), 'utf8')
    if (serialisedBytes > this.websocketSyncPushMaxBytes) {
      this.logger.debug('Websocket sync push exceeds the byte cap; sending the plain notification instead.', {
        userId: dto.userUuid,
        itemCount: items.length,
        serialisedBytes,
        maxBytes: this.websocketSyncPushMaxBytes,
      })

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
        items,
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
      if (result.isFailed()) {
        this.logger.error('Sending items changed event to client failed.', {
          ...safeErrorLogMetadata(result.getError()),
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
      if (result.isFailed()) {
        this.logger.error('Sending items changed event to clients failed.', {
          ...safeErrorLogMetadata(result.getError()),
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

  /**
   * Standard Red Notes (t97): the udpatedItemOrError/newItemOrError `isFailed()`
   * branches above are UpdateExistingItem/SaveNewItem's OWN internal validation
   * rejecting the item's data -- a malformed content_type, an invalid
   * duplicate_of/session uuid, unparsable dates -- never an infrastructure fault (the
   * catch blocks handle that, unacknowledged/retried) and never a uuid collision
   * (OwnershipFilter, in the validator pass before either try block runs, already owns
   * that and still reports UuidConflict correctly when it fires). Unlike a transient
   * failure, a structural one will never succeed on retry: leaving it unacknowledged
   * forever, the catch blocks' treatment, would produce an item that never syncs and
   * never tells anyone -- a silent, permanent failure to inform. That is a real
   * product gap, tracked separately, not something to improvise here.
   *
   * What IS in scope: UuidConflict was still the wrong type for this case, for the
   * same client-side reason as the catch blocks -- it is a destructive instruction
   * (PayloadsByAlternatingUuid regenerates the item's uuid and discards the original)
   * triggered by nothing more than a malformed field, most of which the user never
   * touched directly. Silent-but-harmless beats silent-and-destructive: report the
   * most accurate of the conflict types this codebase already uses for "this item's
   * data is structurally invalid, give up" (both already resolve identically and
   * non-destructively on the client -- dirty:false, no identity change -- via
   * DeltaRemoteRejected.getResultForConflictWithOnlyUnsavedItem).
   *
   * `Result.fail()` does not preserve WHICH internal check failed, so this cannot
   * inspect UpdateExistingItem/SaveNewItem's own reasoning directly -- it re-derives
   * the one distinction that matters using the SAME check ContentTypeFilter already
   * runs earlier in the validator pass (ContentType.create on the item hash's own
   * content_type): ContentTypeError when that specifically is what is malformed,
   * ContentError (ContentFilter's role: "this item's data is malformed" more
   * generally) for every other structural failure.
   */
  private structuralFailureConflictType(itemHash: ItemHash): ConflictType {
    return ContentType.create(itemHash.props.content_type).isFailed()
      ? ConflictType.ContentTypeError
      : ConflictType.ContentError
  }
}
