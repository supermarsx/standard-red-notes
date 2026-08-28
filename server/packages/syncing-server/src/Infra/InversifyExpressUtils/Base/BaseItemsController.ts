import {
  safeErrorLogMetadata,
  ControllerContainerInterface,
  MapperInterface,
  Validator,
} from '@standardnotes/domain-core'
import { BaseHttpController, results } from 'inversify-express-utils'
import { Request, Response } from 'express'
import { HttpStatusCode } from '@standardnotes/responses'

import { Item } from '../../../Domain/Item/Item'
import { SyncResponseFactoryResolverInterface } from '../../../Domain/Item/SyncResponse/SyncResponseFactoryResolverInterface'
import { CheckIntegrity } from '../../../Domain/UseCase/Syncing/CheckIntegrity/CheckIntegrity'
import { GetItem } from '../../../Domain/UseCase/Syncing/GetItem/GetItem'
import { AuthorizeCollaborationAccess } from '../../../Domain/UseCase/Syncing/AuthorizeCollaborationAccess/AuthorizeCollaborationAccess'
import { ApiVersion } from '../../../Domain/Api/ApiVersion'
import { usesModernSyncResponse } from '../../../Domain/Api/ModernSyncResponse'
import { SyncItems } from '../../../Domain/UseCase/Syncing/SyncItems/SyncItems'
import { ItemHttpRepresentation } from '../../../Mapping/Http/ItemHttpRepresentation'
import { ItemHash } from '../../../Domain/Item/ItemHash'
import { CheckForTrafficAbuse } from '../../../Domain/UseCase/Syncing/CheckForTrafficAbuse/CheckForTrafficAbuse'
import { Metric } from '../../../Domain/Metrics/Metric'
import { Logger } from 'winston'
import { ResponseLocals } from '../ResponseLocals'
import { ExecuteSyncCommand } from '../../../Domain/SyncCommand/ExecuteSyncCommand'
import { GetSyncCommandStatus } from '../../../Domain/SyncCommand/GetSyncCommandStatus'
import { SyncCommandMetadata, SyncCommandProtocolError } from '../../../Domain/SyncCommand/SyncCommandTypes'
import { SyncResponse20200115 } from '../../../Domain/Item/SyncResponse/SyncResponse20200115'

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
    protected executeSyncCommand?: ExecuteSyncCommand,
    protected getSyncCommandStatusUseCase?: GetSyncCommandStatus,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('sync.items.sync', this.sync.bind(this))
      this.controllerContainer.register('sync.items.check_integrity', this.checkItemsIntegrity.bind(this))
      this.controllerContainer.register('sync.items.get_item', this.getSingleItem.bind(this))
      this.controllerContainer.register('sync.items.sync_command_status', this.getSyncCommandStatus.bind(this))
      this.controllerContainer.register('sync.items.authorize_collaboration', this.authorizeCollaboration.bind(this))
    }
  }

  /**
   * Standard Red Notes: answer "may the authenticated user collaborate on this
   * note over the realtime relay?" Used by the api-gateway to decide whether to
   * mint a collaboration-room capability. Reuses AuthorizeCollaborationAccess
   * (write-capable owner or shared-vault editor). FAILS CLOSED: any missing
   * dependency, invalid input, read-only session, use-case failure or thrown
   * error resolves to `{ authorized: false }`. An allow includes the canonical
   * encrypted item's server updated-at revision used by the bootstrap freshness
   * barrier; denial never exposes it.
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
        readOnlyAccess: locals.readOnlyAccess === true,
      })

      if (result.isFailed()) {
        return this.json({ authorized: false }, HttpStatusCode.Success)
      }

      return this.json(result.getValue(), HttpStatusCode.Success)
    } catch (error) {
      this.logger.error('Collaboration authorization check failed.', {
        ...safeErrorLogMetadata(error),
        userId: locals.user?.uuid,
      })

      return this.json({ authorized: false }, HttpStatusCode.Success)
    }
  }

  async sync(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals
    const commandMetadata = this.resolveSyncCommandMetadata(request)
    if (commandMetadata instanceof SyncCommandProtocolError) {
      return this.syncCommandError(response, commandMetadata)
    }
    if (commandMetadata === undefined) {
      const abuseError = await this.trafficAbuseError(locals)
      if (abuseError) {
        return this.json({ error: { message: abuseError.message } }, abuseError.httpStatus)
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

    const syncDto = {
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
      // Standard Red Notes: SHADOW-BAN — silently degrade this user's sync.
      shadowBanned: locals.shadowBanned === true,
    }

    if (commandMetadata !== undefined) {
      if (!this.executeSyncCommand) {
        return this.syncCommandError(
          response,
          new SyncCommandProtocolError(
            'sync_command_execution_failed',
            'Durable sync command execution is temporarily unavailable.',
            503,
          ),
        )
      }
      if (!usesModernSyncResponse(request.body.api)) {
        return this.syncCommandError(
          response,
          new SyncCommandProtocolError(
            'invalid_sync_command_metadata',
            'Durable sync commands require a supported modern sync API version.',
          ),
        )
      }

      try {
        const result = await this.executeSyncCommand.execute<SyncResponse20200115>({
          userUuid: locals.user.uuid,
          sessionUuid: locals.session ? locals.session.uuid : null,
          metadata: commandMetadata,
          canonicalPayload: this.logicalSyncPayload(request.body as Record<string, unknown>),
          beforeExecute: async () => {
            const abuseError = await this.trafficAbuseError(locals)
            if (abuseError) {
              throw abuseError
            }
          },
          execute: async () => {
            const syncResult = await this.syncItems.execute(syncDto)
            if (syncResult.isFailed()) {
              throw new SyncCommandProtocolError('sync_command_rejected', syncResult.getError(), 400)
            }

            return (await this.syncResponseFactoryResolver
              .resolveSyncResponseFactoryVersion(request.body.api)
              .createResponse(syncResult.getValue())) as SyncResponse20200115
          },
        })

        response.setHeader('X-Sync-Command-Status', 'committed')
        response.setHeader('X-Sync-Command-Replayed', result.replayed ? 'true' : 'false')

        return this.json(result.response)
      } catch (error) {
        if (error instanceof SyncCommandProtocolError) {
          return this.syncCommandError(response, error)
        }

        this.logger.error('Durable sync command execution failed.', {
          ...safeErrorLogMetadata(error),
          userId: locals.user.uuid,
        })
        return this.syncCommandError(
          response,
          new SyncCommandProtocolError(
            'sync_command_execution_failed',
            'Durable sync command execution failed. It is safe to retry with the same command metadata.',
            503,
          ),
        )
      }
    }

    const syncResult = await this.syncItems.execute(syncDto)
    if (syncResult.isFailed()) {
      return this.json({ error: { message: syncResult.getError() } }, HttpStatusCode.BadRequest)
    }

    const syncResponse = await this.syncResponseFactoryResolver
      .resolveSyncResponseFactoryVersion(request.body.api)
      .createResponse(syncResult.getValue())

    return this.json(syncResponse)
  }

  async getSyncCommandStatus(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals
    if (!this.getSyncCommandStatusUseCase) {
      return this.syncCommandError(
        response,
        new SyncCommandProtocolError(
          'sync_command_execution_failed',
          'Sync command status is temporarily unavailable.',
          503,
        ),
      )
    }

    try {
      const digest = this.singleHeader(request.headers['x-sync-command-digest'], 'digest')
      const result = await this.getSyncCommandStatusUseCase.execute({
        userUuid: locals.user.uuid,
        sessionUuid: locals.session ? locals.session.uuid : null,
        commandId: request.params.commandId as string,
        requestDigest: digest,
      })

      return this.json(result)
    } catch (error) {
      if (error instanceof SyncCommandProtocolError) {
        return this.syncCommandError(response, error)
      }

      this.logger.error('Sync command status lookup failed.', {
        ...safeErrorLogMetadata(error),
        userId: locals.user.uuid,
      })
      return this.syncCommandError(
        response,
        new SyncCommandProtocolError(
          'sync_command_execution_failed',
          'Sync command status is temporarily unavailable.',
          503,
        ),
      )
    }
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

  private resolveSyncCommandMetadata(request: Request): SyncCommandMetadata | SyncCommandProtocolError | undefined {
    try {
      const headerId = this.singleHeader(request.headers['x-sync-command-id'], 'id')
      const headerDigest = this.singleHeader(request.headers['x-sync-command-digest'], 'digest')
      const body = request.body as Record<string, unknown>
      const command =
        body.command && typeof body.command === 'object' ? (body.command as Record<string, unknown>) : undefined
      const bodyId = typeof command?.id === 'string' ? command.id : undefined
      const bodyDigest = typeof command?.digest === 'string' ? command.digest : undefined
      const hasHeaders = headerId !== undefined || headerDigest !== undefined
      const hasBody = command !== undefined

      if (!hasHeaders && !hasBody) {
        return undefined
      }
      if ((hasHeaders && (!headerId || !headerDigest)) || (hasBody && (!bodyId || !bodyDigest))) {
        return new SyncCommandProtocolError(
          'invalid_sync_command_metadata',
          'Sync command id and digest must be supplied together.',
        )
      }
      if (hasHeaders && hasBody && (headerId !== bodyId || headerDigest?.toLowerCase() !== bodyDigest?.toLowerCase())) {
        return new SyncCommandProtocolError(
          'invalid_sync_command_metadata',
          'Sync command headers and body metadata disagree.',
        )
      }

      return { id: (headerId ?? bodyId) as string, digest: (headerDigest ?? bodyDigest) as string }
    } catch (error) {
      return error instanceof SyncCommandProtocolError
        ? error
        : new SyncCommandProtocolError('invalid_sync_command_metadata', 'Sync command metadata is invalid.')
    }
  }

  private async trafficAbuseError(locals: ResponseLocals): Promise<SyncCommandProtocolError | undefined> {
    const checks = [
      {
        metricToCheck: Metric.NAMES.ItemOperation,
        threshold: locals.isFreeUser ? this.freeUsersItemOperationsAbuseThreshold : this.itemOperationsAbuseThreshold,
        timeframeLengthInMinutes: this.itemOperationsAbuseTimeframeLengthInMinutes,
      },
      {
        metricToCheck: Metric.NAMES.ContentSizeUtilized,
        threshold: locals.isFreeUser ? this.freeUsersPayloadSizeAbuseThreshold : this.payloadSizeAbuseThreshold,
        timeframeLengthInMinutes: this.payloadSizeAbuseTimeframeLengthInMinutes,
      },
    ]

    for (const check of checks) {
      const result = await this.checkForTrafficAbuse.execute({
        ...check,
        userUuid: locals.user.uuid,
      })
      if (!result.isFailed()) {
        continue
      }

      this.logger.warn('Operation failed.', {
        ...safeErrorLogMetadata(result.getError()),
        userId: locals.user.uuid,
      })
      if (this.strictAbuseProtection) {
        return new SyncCommandProtocolError(
          'sync_command_rate_limited',
          'You have exceeded the maximum bandwidth allotted to your account in a 5-minute period. Please wait to try again, or upgrade your account for increased limits.',
          429,
        )
      }
    }

    return undefined
  }

  private singleHeader(value: string | string[] | undefined, name: string): string | undefined {
    if (Array.isArray(value)) {
      if (value.length !== 1) {
        throw new SyncCommandProtocolError(
          'invalid_sync_command_metadata',
          `Sync command ${name} header must have exactly one value.`,
        )
      }
      return value[0]
    }

    return value
  }

  private logicalSyncPayload(body: Record<string, unknown>): Record<string, unknown> {
    const { command: _command, ...payload } = body
    return payload
  }

  private syncCommandError(response: Response, error: SyncCommandProtocolError): results.JsonResult {
    if (error.code === 'sync_command_pending') {
      response.setHeader('Retry-After', '1')
    }

    return this.json(
      {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.code === 'sync_command_pending' || error.code === 'sync_command_execution_failed',
        },
      },
      error.httpStatus,
    )
  }
}
