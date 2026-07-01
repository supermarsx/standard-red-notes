import { ControllerContainerInterface, MapperInterface, Validator } from '@standardnotes/domain-core'
import { BaseHttpController, results } from 'inversify-express-utils'
import { Request, Response } from 'express'
import { HttpStatusCode } from '@standardnotes/responses'

import { Item } from '../../../Domain/Item/Item'
import { SyncResponseFactoryResolverInterface } from '../../../Domain/Item/SyncResponse/SyncResponseFactoryResolverInterface'
import { CheckIntegrity } from '../../../Domain/UseCase/Syncing/CheckIntegrity/CheckIntegrity'
import { GetItem } from '../../../Domain/UseCase/Syncing/GetItem/GetItem'
import { AuthorizeCollaborationAccess } from '../../../Domain/UseCase/Syncing/AuthorizeCollaborationAccess/AuthorizeCollaborationAccess'
import { ApiVersion } from '../../../Domain/Api/ApiVersion'
import { SyncItems } from '../../../Domain/UseCase/Syncing/SyncItems/SyncItems'
import { ItemHttpRepresentation } from '../../../Mapping/Http/ItemHttpRepresentation'
import { ItemHash } from '../../../Domain/Item/ItemHash'
import { CheckForTrafficAbuse } from '../../../Domain/UseCase/Syncing/CheckForTrafficAbuse/CheckForTrafficAbuse'
import { Metric } from '../../../Domain/Metrics/Metric'
import { Logger } from 'winston'
import { ResponseLocals } from '../ResponseLocals'

export class BaseItemsController extends BaseHttpController {
  constructor(
    protected checkForTrafficAbuse: CheckForTrafficAbuse,
    protected syncItems: SyncItems,
    protected checkIntegrity: CheckIntegrity,
    protected getItem: GetItem,
    protected itemHttpMapper: MapperInterface<Item, ItemHttpRepresentation>,
    protected syncResponseFactoryResolver: SyncResponseFactoryResolverInterface,
    protected logger: Logger,
    protected strictAbuseProtection: boolean,
    protected itemOperationsAbuseTimeframeLengthInMinutes: number,
    protected itemOperationsAbuseThreshold: number,
    protected freeUsersItemOperationsAbuseThreshold: number,
    protected payloadSizeAbuseThreshold: number,
    protected freeUsersPayloadSizeAbuseThreshold: number,
    protected payloadSizeAbuseTimeframeLengthInMinutes: number,
    private controllerContainer?: ControllerContainerInterface,
    // Standard Red Notes: optional so existing constructions/specs keep their
    // arity; the collaboration-authorization endpoint requires it and fails
    // CLOSED (denies) when it is absent.
    protected authorizeCollaborationAccess?: AuthorizeCollaborationAccess,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('sync.items.sync', this.sync.bind(this))
      this.controllerContainer.register('sync.items.check_integrity', this.checkItemsIntegrity.bind(this))
      this.controllerContainer.register('sync.items.get_item', this.getSingleItem.bind(this))
      this.controllerContainer.register(
        'sync.items.authorize_collaboration',
        this.authorizeCollaboration.bind(this),
      )
    }
  }

  /**
   * Standard Red Notes: answer "may the authenticated user collaborate on this
   * note over the realtime relay?" Used by the api-gateway to decide whether to
   * mint a collaboration-room capability. Reuses AuthorizeCollaborationAccess
   * (owner OR shared-vault member). FAILS CLOSED: any missing dependency, invalid
   * input, use-case failure or thrown error resolves to `{ authorized: false }`.
   */
  async authorizeCollaboration(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    try {
      if (this.authorizeCollaborationAccess === undefined) {
        return this.json({ authorized: false }, HttpStatusCode.Success)
      }

      const itemUuid = (request.body as { itemUuid?: unknown })?.itemUuid
      if (typeof itemUuid !== 'string' || itemUuid.length === 0) {
        return this.json({ authorized: false }, HttpStatusCode.Success)
      }

      const result = await this.authorizeCollaborationAccess.execute({
        userUuid: locals.user.uuid,
        itemUuid,
      })

      if (result.isFailed()) {
        return this.json({ authorized: false }, HttpStatusCode.Success)
      }

      return this.json({ authorized: result.getValue() === true }, HttpStatusCode.Success)
    } catch (error) {
      this.logger.error(`Collaboration authorization check failed: ${(error as Error).message}`, {
        userId: locals.user?.uuid,
      })

      return this.json({ authorized: false }, HttpStatusCode.Success)
    }
  }

  async sync(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals
    const checkForItemOperationsAbuseResult = await this.checkForTrafficAbuse.execute({
      metricToCheck: Metric.NAMES.ItemOperation,
      userUuid: locals.user.uuid,
      threshold: locals.isFreeUser ? this.freeUsersItemOperationsAbuseThreshold : this.itemOperationsAbuseThreshold,
      timeframeLengthInMinutes: this.itemOperationsAbuseTimeframeLengthInMinutes,
    })
    if (checkForItemOperationsAbuseResult.isFailed()) {
      this.logger.warn(checkForItemOperationsAbuseResult.getError(), {
        userId: locals.user.uuid,
      })
      if (this.strictAbuseProtection) {
        return this.json(
          {
            error: {
              message:
                'You have exceeded the maximum bandwidth allotted to your account in a 5-minute period. Please wait to try again, or upgrade your account for increased limits.',
            },
          },
          429,
        )
      }
    }

    const checkForPayloadSizeAbuseResult = await this.checkForTrafficAbuse.execute({
      metricToCheck: Metric.NAMES.ContentSizeUtilized,
      userUuid: locals.user.uuid,
      threshold: locals.isFreeUser ? this.freeUsersPayloadSizeAbuseThreshold : this.payloadSizeAbuseThreshold,
      timeframeLengthInMinutes: this.payloadSizeAbuseTimeframeLengthInMinutes,
    })
    if (checkForPayloadSizeAbuseResult.isFailed()) {
      this.logger.warn(checkForPayloadSizeAbuseResult.getError(), {
        userId: locals.user.uuid,
      })

      if (this.strictAbuseProtection) {
        return this.json(
          {
            error: {
              message:
                'You have exceeded the maximum bandwidth allotted to your account in a 5-minute period. Please wait to try again, or upgrade your account for increased limits.',
            },
          },
          429,
        )
      }
    }

    const itemHashes: ItemHash[] = []
    if ('items' in request.body) {
      for (const itemHashInput of request.body.items) {
        const itemHashOrError = ItemHash.create({
          ...itemHashInput,
          user_uuid: locals.user.uuid,
          key_system_identifier: itemHashInput.key_system_identifier ?? null,
          shared_vault_uuid: itemHashInput.shared_vault_uuid ?? null,
        })

        if (itemHashOrError.isFailed()) {
          return this.json({ error: { message: itemHashOrError.getError() } }, HttpStatusCode.BadRequest)
        }

        itemHashes.push(itemHashOrError.getValue())
      }
    }

    let sharedVaultUuids: string[] | undefined = undefined
    if ('shared_vault_uuids' in request.body) {
      const sharedVaultUuidsValidation = Validator.isNotEmpty(request.body.shared_vault_uuids)
      if (!sharedVaultUuidsValidation.isFailed()) {
        sharedVaultUuids = request.body.shared_vault_uuids
      }
    }

    const syncResult = await this.syncItems.execute({
      userUuid: locals.user.uuid,
      itemHashes,
      computeIntegrityHash: request.body.compute_integrity === true,
      syncToken: request.body.sync_token,
      cursorToken: request.body.cursor_token,
      limit: request.body.limit,
      contentType: request.body.content_type,
      apiVersion: request.body.api ?? ApiVersion.v20161215,
      snjsVersion: request.headers['x-snjs-version'] as string,
      readOnlyAccess: locals.readOnlyAccess,
      sessionUuid: locals.session ? locals.session.uuid : null,
      sharedVaultUuids,
      isFreeUser: locals.isFreeUser,
      hasContentLimit: !!locals.hasContentLimit,
      // Standard Red Notes: per-user live-sync gating. Absent ⇒ enabled.
      liveSyncEnabled: locals.liveSyncEnabled !== false,
    })
    if (syncResult.isFailed()) {
      return this.json({ error: { message: syncResult.getError() } }, HttpStatusCode.BadRequest)
    }

    const syncResponse = await this.syncResponseFactoryResolver
      .resolveSyncResponseFactoryVersion(request.body.api)
      .createResponse(syncResult.getValue())

    return this.json(syncResponse)
  }

  async checkItemsIntegrity(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    let integrityPayloads = []
    if ('integrityPayloads' in request.body) {
      integrityPayloads = request.body.integrityPayloads
    }

    const result = await this.checkIntegrity.execute({
      userUuid: locals.user.uuid,
      integrityPayloads,
    })

    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, HttpStatusCode.BadRequest)
    }

    return this.json({
      mismatches: result.getValue(),
    })
  }

  async getSingleItem(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals

    const result = await this.getItem.execute({
      userUuid: locals.user.uuid,
      itemUuid: request.params.uuid as string,
    })

    if (result.isFailed()) {
      return this.json(
        {
          error: { message: 'Item not found' },
        },
        404,
      )
    }

    return this.json({ item: this.itemHttpMapper.toProjection(result.getValue()) })
  }
}
