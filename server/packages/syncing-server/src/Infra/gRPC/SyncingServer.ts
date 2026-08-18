import * as grpc from '@grpc/grpc-js'
import { Status } from '@grpc/grpc-js/build/src/constants'
import { SyncCommandStatusRequest, SyncCommandStatusResponse, SyncRequest, SyncResponse } from '@standardnotes/grpc'
import { Logger } from 'winston'
import { safeErrorLogMetadata, MapperInterface } from '@standardnotes/domain-core'

import { ItemHash } from '../../Domain/Item/ItemHash'
import { SyncItems } from '../../Domain/UseCase/Syncing/SyncItems/SyncItems'
import { ApiVersion, usesModernSyncResponse } from '../../Domain/Api/ApiVersion'
import { SyncResponseFactoryResolverInterface } from '../../Domain/Item/SyncResponse/SyncResponseFactoryResolverInterface'
import { SyncResponse20200115 } from '../../Domain/Item/SyncResponse/SyncResponse20200115'
import { CheckForTrafficAbuse } from '../../Domain/UseCase/Syncing/CheckForTrafficAbuse/CheckForTrafficAbuse'
import { Metric } from '../../Domain/Metrics/Metric'
import { ExecuteSyncCommand } from '../../Domain/SyncCommand/ExecuteSyncCommand'
import { GetSyncCommandStatus } from '../../Domain/SyncCommand/GetSyncCommandStatus'
import { SyncCommandProtocolError } from '../../Domain/SyncCommand/SyncCommandTypes'
import { INTERNAL_GRPC_AUTH_METADATA, InternalGrpcAuthScope, InternalGrpcServiceAuth } from '@standardnotes/security'

export class SyncingServer {
  private readonly internalGrpcAuth: InternalGrpcServiceAuth

  constructor(
    private syncItemsUseCase: SyncItems,
    private syncResponseFactoryResolver: SyncResponseFactoryResolverInterface,
    private mapper: MapperInterface<SyncResponse20200115, SyncResponse>,
    protected checkForTrafficAbuse: CheckForTrafficAbuse,
    private strictAbuseProtection: boolean,
    private itemOperationsAbuseTimeframeLengthInMinutes: number,
    private itemOperationsAbuseThreshold: number,
    private freeUsersItemOperationsAbuseThreshold: number,
    private payloadSizeAbuseThreshold: number,
    private freeUsersPayloadSizeAbuseThreshold: number,
    private payloadSizeAbuseTimeframeLengthInMinutes: number,
    private logger: Logger,
    private executeSyncCommand?: ExecuteSyncCommand,
    private getSyncCommandStatusUseCase?: GetSyncCommandStatus,
    internalGrpcAuthSecret = '',
  ) {
    this.internalGrpcAuth = new InternalGrpcServiceAuth(internalGrpcAuthSecret)
  }

  async syncItems(
    call: grpc.ServerUnaryCall<SyncRequest, SyncResponse>,
    callback: grpc.sendUnaryData<SyncResponse>,
  ): Promise<void> {
    try {
      const userUuid = this.singleMetadata(call.metadata, 'x-user-uuid') ?? ''
      const sessionUuid = this.singleMetadata(call.metadata, 'x-session-uuid') ?? null
      const isFreeUser = call.metadata.get('x-is-free-user').pop() === 'true'
      const hasContentLimit = call.metadata.get('x-has-content-limit').pop() === 'true'
      const command = call.request.hasCommand() ? call.request.getCommand() : undefined
      const canonicalDigest = this.singleMetadata(call.metadata, 'x-sync-canonical-digest')
      if (command) {
        this.assertDurableGrpcAuthentication(call.metadata, {
          method: 'syncItems',
          userUuid,
          sessionUuid,
          commandId: command.getId(),
          commandDigest: command.getDigest(),
          bodyDigest: canonicalDigest,
        })
      }

      const itemHashesRPC = call.request.getItemsList()
      const itemHashes: ItemHash[] = []
      for (const itemHash of itemHashesRPC) {
        const itemHashOrError = ItemHash.create({
          uuid: itemHash.getUuid(),
          content: itemHash.hasContent() ? itemHash.getContent() : undefined,
          content_type: itemHash.hasContentType() ? (itemHash.getContentType() as string) : null,
          deleted: itemHash.hasDeleted() ? itemHash.getDeleted() : undefined,
          duplicate_of: itemHash.hasDuplicateOf() ? itemHash.getDuplicateOf() : undefined,
          auth_hash: itemHash.hasAuthHash() ? itemHash.getAuthHash() : undefined,
          enc_item_key: itemHash.hasEncItemKey() ? itemHash.getEncItemKey() : undefined,
          items_key_id: itemHash.hasItemsKeyId() ? itemHash.getItemsKeyId() : undefined,
          created_at: itemHash.hasCreatedAt() ? itemHash.getCreatedAt() : undefined,
          created_at_timestamp: itemHash.hasCreatedAtTimestamp() ? itemHash.getCreatedAtTimestamp() : undefined,
          updated_at: itemHash.hasUpdatedAt() ? itemHash.getUpdatedAt() : undefined,
          updated_at_timestamp: itemHash.hasUpdatedAtTimestamp() ? itemHash.getUpdatedAtTimestamp() : undefined,
          user_uuid: userUuid,
          key_system_identifier: itemHash.hasKeySystemIdentifier()
            ? (itemHash.getKeySystemIdentifier() as string)
            : null,
          shared_vault_uuid: itemHash.hasSharedVaultUuid() ? (itemHash.getSharedVaultUuid() as string) : null,
        })

        if (itemHashOrError.isFailed()) {
          const metadata = new grpc.Metadata()
          metadata.set('x-sync-error-message', itemHashOrError.getError())
          metadata.set('x-sync-error-response-code', '400')

          return callback(
            {
              code: Status.INVALID_ARGUMENT,
              message: itemHashOrError.getError(),
              name: 'INVALID_ARGUMENT',
              metadata,
            },
            null,
          )
        }

        itemHashes.push(itemHashOrError.getValue())
      }

      let sharedVaultUuids: string[] | undefined = undefined
      const sharedVaultUuidsList = call.request.getSharedVaultUuidsList()
      if (sharedVaultUuidsList.length > 0) {
        sharedVaultUuids = sharedVaultUuidsList
      }

      const apiVersion = call.request.hasApiVersion() ? (call.request.getApiVersion() as string) : ApiVersion.v20161215
      const readOnlyAccess = call.metadata.get('x-read-only-access').pop() === 'true'
      // Standard Red Notes: per-user live-sync gating over gRPC. Opt-in disable:
      // enabled unless the metadata header explicitly carries 'false'.
      const liveSyncEnabled = call.metadata.get('x-live-sync-enabled').pop() !== 'false'
      // Standard Red Notes: shadow bans silently reduce sync throughput and
      // disable real-time push. Absent metadata remains not shadow-banned for
      // backwards compatibility with older trusted gateway versions.
      const shadowBanned = call.metadata.get('x-shadow-banned').pop() === 'true'
      if (readOnlyAccess) {
        this.logger.debug('Syncing with read-only access', {
          codeTag: 'SyncingServer',
          userId: userUuid,
        })
      }

      const syncDto = {
        userUuid,
        itemHashes,
        computeIntegrityHash: call.request.hasComputeIntegrity() ? call.request.getComputeIntegrity() === true : false,
        syncToken: call.request.hasSyncToken() ? call.request.getSyncToken() : undefined,
        cursorToken: call.request.getCursorToken() ? call.request.getCursorToken() : undefined,
        limit: call.request.hasLimit() ? call.request.getLimit() : undefined,
        contentType: call.request.hasContentType() ? call.request.getContentType() : undefined,
        apiVersion,
        snjsVersion: call.metadata.get('x-snjs-version').pop() as string,
        readOnlyAccess,
        sessionUuid,
        sharedVaultUuids,
        isFreeUser,
        hasContentLimit,
        liveSyncEnabled,
        shadowBanned,
      }
      const execute = async (): Promise<SyncResponse20200115> => {
        const syncResult = await this.syncItemsUseCase.execute(syncDto)
        if (syncResult.isFailed()) {
          throw new SyncCommandProtocolError('sync_command_rejected', syncResult.getError(), 400)
        }

        return (await this.syncResponseFactoryResolver
          .resolveSyncResponseFactoryVersion(apiVersion)
          .createResponse(syncResult.getValue())) as SyncResponse20200115
      }

      let syncResponse: SyncResponse20200115
      let replayed: boolean | undefined
      if (call.request.hasCommand()) {
        if (!this.executeSyncCommand) {
          throw new Error('Durable sync command execution is not configured.')
        }
        if (!usesModernSyncResponse(apiVersion)) {
          throw new SyncCommandProtocolError(
            'invalid_sync_command_metadata',
            'Durable sync commands require a supported modern sync API version.',
          )
        }

        const result = await this.executeSyncCommand.execute({
          userUuid,
          sessionUuid: syncDto.sessionUuid,
          metadata: {
            id: command?.getId() ?? '',
            digest: command?.getDigest() ?? '',
          },
          canonicalPayload: this.createCanonicalPayload(call.request),
          canonicalDigest: canonicalDigest ?? undefined,
          beforeExecute: () => this.checkTrafficAbuse(userUuid, isFreeUser),
          execute,
        })
        syncResponse = result.response
        replayed = result.replayed
      } else {
        try {
          await this.checkTrafficAbuse(userUuid, isFreeUser)
          syncResponse = await execute()
        } catch (error) {
          if (error instanceof SyncCommandProtocolError && error.code === 'sync_command_rejected') {
            return this.failWithProtocolError(callback, error)
          }
          throw error
        }
      }

      const projection = this.mapper.toProjection(syncResponse)
      if (projection.hasCommand()) {
        projection.getCommand()?.setReplayed(replayed === true)
      }

      callback(null, projection)
    } catch (error) {
      if (error instanceof SyncCommandProtocolError) {
        return this.failWithProtocolError(callback, error)
      }
      this.logger.error('[SyncingServer] Error syncing items via gRPC.', safeErrorLogMetadata(error))

      if (call.request.hasCommand()) {
        return this.failWithProtocolError(
          callback,
          new SyncCommandProtocolError(
            'sync_command_execution_failed',
            'Durable sync command execution failed. It is safe to retry with the same command metadata.',
            503,
          ),
        )
      }

      return callback(
        {
          code: Status.UNKNOWN,
          message: 'An error occurred while syncing items',
          name: 'UNKNOWN',
        },
        null,
      )
    }
  }

  async getSyncCommandStatus(
    call: grpc.ServerUnaryCall<SyncCommandStatusRequest, SyncCommandStatusResponse>,
    callback: grpc.sendUnaryData<SyncCommandStatusResponse>,
  ): Promise<void> {
    try {
      if (!this.getSyncCommandStatusUseCase) {
        throw new Error('Sync command status lookup is not configured.')
      }

      const userUuid = this.singleMetadata(call.metadata, 'x-user-uuid') ?? ''
      const sessionUuid = this.singleMetadata(call.metadata, 'x-session-uuid') ?? null
      this.assertDurableGrpcAuthentication(call.metadata, {
        method: 'getSyncCommandStatus',
        userUuid,
        sessionUuid,
        commandId: call.request.getId(),
        commandDigest: call.request.hasDigest() ? call.request.getDigest() : undefined,
      })

      const result = await this.getSyncCommandStatusUseCase.execute({
        userUuid,
        sessionUuid,
        commandId: call.request.getId(),
        requestDigest: call.request.hasDigest() ? call.request.getDigest() : undefined,
      })
      const response = new SyncCommandStatusResponse()
      response.setId(result.command.id)
      response.setStatus(result.command.status)
      if ('digest' in result.command) {
        response.setDigest(result.command.digest)
      }
      if ('result' in result && result.result) {
        response.setResultJson(JSON.stringify(result.result))
      }

      callback(null, response)
    } catch (error) {
      if (error instanceof SyncCommandProtocolError) {
        return this.failWithProtocolError(callback, error)
      }
      this.logger.error('[SyncingServer] Error reading sync command status.', safeErrorLogMetadata(error))
      return this.failWithProtocolError(
        callback,
        new SyncCommandProtocolError(
          'sync_command_execution_failed',
          'Sync command status is temporarily unavailable.',
          503,
        ),
      )
    }
  }

  private async checkTrafficAbuse(userUuid: string, isFreeUser: boolean): Promise<void> {
    const checks = [
      {
        metricToCheck: Metric.NAMES.ItemOperation,
        threshold: isFreeUser ? this.freeUsersItemOperationsAbuseThreshold : this.itemOperationsAbuseThreshold,
        timeframeLengthInMinutes: this.itemOperationsAbuseTimeframeLengthInMinutes,
      },
      {
        metricToCheck: Metric.NAMES.ContentSizeUtilized,
        threshold: isFreeUser ? this.freeUsersPayloadSizeAbuseThreshold : this.payloadSizeAbuseThreshold,
        timeframeLengthInMinutes: this.payloadSizeAbuseTimeframeLengthInMinutes,
      },
    ]

    for (const check of checks) {
      const result = await this.checkForTrafficAbuse.execute({ ...check, userUuid })
      if (!result.isFailed()) {
        continue
      }

      this.logger.warn('Operation failed.', {
        ...safeErrorLogMetadata(result.getError()),
        userId: userUuid,
      })
      if (this.strictAbuseProtection) {
        throw new SyncCommandProtocolError(
          'sync_command_rate_limited',
          'You have exceeded the maximum bandwidth allotted to your account in a 5-minute period. Please wait to try again, or upgrade your account for increased limits.',
          429,
        )
      }
    }
  }

  private assertDurableGrpcAuthentication(metadata: grpc.Metadata, scope: InternalGrpcAuthScope): void {
    const verification = this.internalGrpcAuth.verify(scope, {
      version: this.singleMetadata(metadata, INTERNAL_GRPC_AUTH_METADATA.version),
      timestamp: this.singleMetadata(metadata, INTERNAL_GRPC_AUTH_METADATA.timestamp),
      signature: this.singleMetadata(metadata, INTERNAL_GRPC_AUTH_METADATA.signature),
    })
    if (verification === 'valid') {
      return
    }

    throw new SyncCommandProtocolError(
      'sync_command_authentication_failed',
      'Durable sync command service authentication failed.',
      verification === 'unconfigured' ? 503 : 401,
    )
  }

  private singleMetadata(metadata: grpc.Metadata, key: string): string | undefined {
    const values = metadata.get(key)
    if (values.length !== 1 || typeof values[0] !== 'string') {
      return undefined
    }

    return values[0]
  }

  private createCanonicalPayload(request: SyncRequest): Record<string, unknown> {
    const items = request.getItemsList().map((item) => {
      const value: Record<string, unknown> = { uuid: item.getUuid() }
      if (item.hasContent()) {
        value.content = item.getContent()
      }
      if (item.hasContentType()) {
        value.content_type = item.getContentType()
      }
      if (item.hasDeleted()) {
        value.deleted = item.getDeleted()
      }
      if (item.hasDuplicateOf()) {
        value.duplicate_of = item.getDuplicateOf()
      }
      if (item.hasAuthHash()) {
        value.auth_hash = item.getAuthHash()
      }
      if (item.hasEncItemKey()) {
        value.enc_item_key = item.getEncItemKey()
      }
      if (item.hasItemsKeyId()) {
        value.items_key_id = item.getItemsKeyId()
      }
      if (item.hasKeySystemIdentifier()) {
        value.key_system_identifier = item.getKeySystemIdentifier()
      }
      if (item.hasSharedVaultUuid()) {
        value.shared_vault_uuid = item.getSharedVaultUuid()
      }
      if (item.hasCreatedAt()) {
        value.created_at = item.getCreatedAt()
      }
      if (item.hasCreatedAtTimestamp()) {
        value.created_at_timestamp = item.getCreatedAtTimestamp()
      }
      if (item.hasUpdatedAt()) {
        value.updated_at = item.getUpdatedAt()
      }
      if (item.hasUpdatedAtTimestamp()) {
        value.updated_at_timestamp = item.getUpdatedAtTimestamp()
      }
      return value
    })
    const payload: Record<string, unknown> = { items }
    if (request.getSharedVaultUuidsList().length > 0) {
      payload.shared_vault_uuids = request.getSharedVaultUuidsList()
    }
    if (request.hasComputeIntegrity()) {
      payload.compute_integrity = request.getComputeIntegrity()
    }
    if (request.hasSyncToken()) {
      payload.sync_token = request.getSyncToken()
    }
    if (request.hasCursorToken()) {
      payload.cursor_token = request.getCursorToken()
    }
    if (request.hasLimit()) {
      payload.limit = request.getLimit()
    }
    if (request.hasContentType()) {
      payload.content_type = request.getContentType()
    }
    if (request.hasApiVersion()) {
      payload.api = request.getApiVersion()
    }

    return payload
  }

  private failWithProtocolError<ResponseType>(
    callback: grpc.sendUnaryData<ResponseType>,
    error: SyncCommandProtocolError,
  ): void {
    const metadata = new grpc.Metadata()
    metadata.set('x-sync-error-message', error.message)
    metadata.set('x-sync-error-code', error.code)
    metadata.set('x-sync-error-response-code', String(error.httpStatus))
    metadata.set(
      'x-sync-error-retryable',
      error.code === 'sync_command_pending' || error.code === 'sync_command_execution_failed' ? 'true' : 'false',
    )

    callback(
      {
        code: error.httpStatus >= 500 ? Status.UNAVAILABLE : Status.INVALID_ARGUMENT,
        message: error.message,
        name: error.httpStatus >= 500 ? 'UNAVAILABLE' : 'INVALID_ARGUMENT',
        metadata,
      },
      null,
    )
  }
}
