import { Request, Response } from 'express'
import {
  ISyncingClient,
  SyncCommandMetadata,
  SyncCommandStatusRequest,
  SyncCommandStatusResponse,
  SyncRequest,
  SyncResponse,
} from '@standardnotes/grpc'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { MapperInterface } from '@standardnotes/domain-core'
import { Metadata } from '@grpc/grpc-js'
import { Status } from '@grpc/grpc-js/build/src/constants'
import { Logger } from 'winston'
import { INTERNAL_GRPC_AUTH_METADATA, InternalGrpcAuthScope, InternalGrpcServiceAuth } from '@standardnotes/security'

import { SyncResponseHttpRepresentation } from '../../Mapping/Sync/Http/SyncResponseHttpRepresentation'
import { ResponseLocals } from '../../Controller/ResponseLocals'
import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'
import { safeErrorLogMetadata } from '../Logging/SafeLog'
import { computeSyncCommandDigest, logicalSyncCommandPayload, syncCommandDigestsEqual } from '../Sync/SyncCommandDigest'

export class GRPCSyncingServerServiceProxy {
  private readonly internalGrpcAuth: InternalGrpcServiceAuth

  constructor(
    private syncingClient: ISyncingClient,
    private syncRequestGRPCMapper: MapperInterface<Record<string, unknown>, SyncRequest>,
    private syncResponseGRPCMapper: MapperInterface<SyncResponse, SyncResponseHttpRepresentation>,
    private logger: Logger,
    private domainEventFactory: DomainEventFactoryInterface,
    private domainEventPublisher?: DomainEventPublisherInterface,
    internalGrpcAuthSecret = '',
  ) {
    this.internalGrpcAuth = new InternalGrpcServiceAuth(internalGrpcAuthSecret)
  }

  durableCommandAuthenticationReady(): boolean {
    return this.internalGrpcAuth.ready()
  }

  async sync(
    request: Request,
    response: Response,
    payload?: Record<string, unknown> | string,
  ): Promise<{ status: number; data: unknown; replayed?: boolean }> {
    const locals = response.locals as ResponseLocals

    const commandMetadata = this.resolveCommandMetadata(request, payload)
    if ('error' in commandMetadata) {
      return { status: 400, data: { error: commandMetadata.error } }
    }

    let canonicalDigest: string | undefined
    if (commandMetadata.value) {
      const validationError = this.validateCommandMetadata(commandMetadata.value)
      if (validationError) {
        return { status: 400, data: { error: validationError } }
      }
      if (!payload || typeof payload === 'string') {
        return {
          status: 400,
          data: {
            error: {
              code: 'invalid_sync_command_metadata',
              message: 'Durable sync commands require a JSON sync request body.',
              retryable: false,
            },
          },
        }
      }

      canonicalDigest = computeSyncCommandDigest(logicalSyncCommandPayload(payload))
      if (!syncCommandDigestsEqual(commandMetadata.value.digest, canonicalDigest)) {
        return {
          status: 409,
          data: {
            error: {
              code: 'sync_command_digest_mismatch',
              message: 'Sync command digest does not match the logical sync request body.',
              retryable: false,
            },
          },
        }
      }

      if (!this.durableCommandAuthenticationReady()) {
        return this.durableAuthenticationUnavailable()
      }
    }

    return new Promise((resolve, reject) => {
      try {
        const syncRequest = this.syncRequestGRPCMapper.toProjection(payload as Record<string, unknown>)
        if (commandMetadata.value) {
          const command = new SyncCommandMetadata()
          command.setId(commandMetadata.value.id)
          command.setDigest(commandMetadata.value.digest)
          syncRequest.setCommand(command)
        }

        const metadata = new Metadata()
        metadata.set('x-user-uuid', locals.user.uuid)
        metadata.set('x-snjs-version', request.headers['x-snjs-version'] as string)
        metadata.set('x-read-only-access', locals.readOnlyAccess ? 'true' : 'false')
        if (locals.readOnlyAccess) {
          this.logger.debug('Syncing with read-only access', {
            codeTag: 'GRPCSyncingServerServiceProxy',
            userId: locals.user.uuid,
          })
        }
        if (locals.session) {
          metadata.set('x-session-uuid', locals.session.uuid)
        }
        metadata.set('x-is-free-user', locals.isFreeUser ? 'true' : 'false')
        metadata.set('x-has-content-limit', locals.hasContentLimit ? 'true' : 'false')
        metadata.set('x-live-sync-enabled', locals.liveSyncEnabled === false ? 'false' : 'true')
        metadata.set('x-shadow-banned', locals.shadowBanned === true ? 'true' : 'false')
        if (canonicalDigest) {
          metadata.set('x-sync-canonical-digest', canonicalDigest)
        }
        if (commandMetadata.value && canonicalDigest) {
          this.signDurableMetadata(metadata, {
            method: 'syncItems',
            userUuid: locals.user.uuid,
            sessionUuid: locals.session?.uuid,
            commandId: commandMetadata.value.id,
            commandDigest: commandMetadata.value.digest,
            bodyDigest: canonicalDigest,
          })
        }

        this.syncingClient.syncItems(syncRequest, metadata, (error, syncResponse) => {
          if (error) {
            const responseCode = error.metadata.get('x-sync-error-response-code').pop()
            if (responseCode) {
              return resolve({
                status: +responseCode,
                data: {
                  error: {
                    message: error.metadata.get('x-sync-error-message').pop(),
                    code: error.metadata.get('x-sync-error-code').pop() || undefined,
                    retryable: error.metadata.get('x-sync-error-retryable').pop() === 'true',
                  },
                },
              })
            }

            if (error.code === Status.INTERNAL) {
              this.logger.error('Internal gRPC error.', {
                codeTag: 'GRPCSyncingServerServiceProxy',
                userId: locals.user.uuid,
                ...safeErrorLogMetadata(error),
              })
            }

            if (error.code === Status.RESOURCE_EXHAUSTED && this.domainEventPublisher !== undefined) {
              void this.domainEventPublisher.publish(
                this.domainEventFactory.createContentSizesFixRequestedEvent({ userUuid: locals.user.uuid }),
              )
            }

            return reject(error)
          }

          return resolve({
            status: 200,
            data: this.syncResponseGRPCMapper.toProjection(syncResponse),
            replayed: syncResponse.hasCommand() ? syncResponse.getCommand()?.getReplayed() === true : undefined,
          })
        })
      } catch (error) {
        const safeError = safeErrorLogMetadata(error)
        if (safeError.errorCode === Status.INTERNAL) {
          this.logger.error('Internal gRPC error.', {
            codeTag: 'GRPCSyncingServerServiceProxy.catch',
            userId: locals.user.uuid,
            ...safeError,
          })
        }

        reject(error)
      }
    })
  }

  async getSyncCommandStatus(
    _request: Request,
    response: Response,
    commandId: string,
    digest?: string,
  ): Promise<{
    status: number
    data: {
      command?: { id: string; status: 'accepted' | 'committed' | 'unknown'; digest?: string }
      result?: Record<string, unknown>
      error?: { code?: string; message: unknown; retryable: boolean }
    }
  }> {
    const locals = response.locals as ResponseLocals
    if (!this.durableCommandAuthenticationReady()) {
      return this.durableAuthenticationUnavailable()
    }
    const commandRequest = new SyncCommandStatusRequest()
    commandRequest.setId(commandId)
    if (digest) {
      commandRequest.setDigest(digest)
    }

    const metadata = new Metadata()
    metadata.set('x-user-uuid', locals.user.uuid)
    if (locals.session) {
      metadata.set('x-session-uuid', locals.session.uuid)
    }
    this.signDurableMetadata(metadata, {
      method: 'getSyncCommandStatus',
      userUuid: locals.user.uuid,
      sessionUuid: locals.session?.uuid,
      commandId,
      commandDigest: digest,
    })

    return new Promise((resolve, reject) => {
      this.syncingClient.getSyncCommandStatus(
        commandRequest,
        metadata,
        (error: import('@grpc/grpc-js').ServiceError | null, statusResponse: SyncCommandStatusResponse) => {
          if (error) {
            const responseCode = error.metadata.get('x-sync-error-response-code').pop()
            if (responseCode) {
              return resolve({
                status: +responseCode,
                data: {
                  error: {
                    message: error.metadata.get('x-sync-error-message').pop(),
                    code: (error.metadata.get('x-sync-error-code').pop() as string | undefined) || undefined,
                    retryable: error.metadata.get('x-sync-error-retryable').pop() === 'true',
                  },
                },
              })
            }
            return reject(error)
          }

          const resultJson = statusResponse.hasResultJson() ? statusResponse.getResultJson() : undefined
          return resolve({
            status: 200,
            data: {
              command: {
                id: statusResponse.getId(),
                status: statusResponse.getStatus() as 'accepted' | 'committed' | 'unknown',
                digest: statusResponse.hasDigest() ? statusResponse.getDigest() : undefined,
              },
              result: resultJson ? (JSON.parse(resultJson) as Record<string, unknown>) : undefined,
            },
          })
        },
      )
    })
  }

  private resolveCommandMetadata(
    request: Request,
    payload?: Record<string, unknown> | string,
  ):
    | { value?: { id: string; digest: string } }
    | { error: { code: 'invalid_sync_command_metadata'; message: string; retryable: false } } {
    const headerId = this.singleHeader(request.headers['x-sync-command-id'])
    const headerDigest = this.singleHeader(request.headers['x-sync-command-digest'])
    if (headerId === null || headerDigest === null) {
      return {
        error: {
          code: 'invalid_sync_command_metadata',
          message: 'Sync command headers must each have exactly one value.',
          retryable: false,
        },
      }
    }
    const hasCommandProperty =
      payload !== undefined && typeof payload !== 'string' && Object.prototype.hasOwnProperty.call(payload, 'command')
    const commandBody =
      payload && typeof payload !== 'string' && payload.command && typeof payload.command === 'object'
        ? (payload.command as Record<string, unknown>)
        : undefined
    const bodyId = typeof commandBody?.id === 'string' ? commandBody.id : undefined
    const bodyDigest = typeof commandBody?.digest === 'string' ? commandBody.digest : undefined

    const hasHeaders = headerId !== undefined || headerDigest !== undefined
    const hasBody = hasCommandProperty
    if (!hasHeaders && !hasBody) {
      return {}
    }

    if ((hasHeaders && (!headerId || !headerDigest)) || (hasBody && (!bodyId || !bodyDigest))) {
      return {
        error: {
          code: 'invalid_sync_command_metadata',
          message: 'Sync command id and digest must be supplied together.',
          retryable: false,
        },
      }
    }

    if (hasHeaders && hasBody && (headerId !== bodyId || headerDigest?.toLowerCase() !== bodyDigest?.toLowerCase())) {
      return {
        error: {
          code: 'invalid_sync_command_metadata',
          message: 'Sync command headers and body metadata disagree.',
          retryable: false,
        },
      }
    }

    return { value: { id: (headerId ?? bodyId) as string, digest: (headerDigest ?? bodyDigest) as string } }
  }

  private singleHeader(value: string | string[] | undefined): string | undefined | null {
    return Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value
  }

  private validateCommandMetadata(metadata: { id: string; digest: string }):
    | {
        code: 'invalid_sync_command_id' | 'invalid_sync_command_digest'
        message: string
        retryable: false
      }
    | undefined {
    if (
      Buffer.byteLength(metadata.id, 'utf8') === 0 ||
      Buffer.byteLength(metadata.id, 'utf8') > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(metadata.id)
    ) {
      return {
        code: 'invalid_sync_command_id',
        message: 'Sync command id must be 1-128 bytes of URL-safe opaque text.',
        retryable: false,
      }
    }
    if (!/^[a-f0-9]{64}$/i.test(metadata.digest)) {
      return {
        code: 'invalid_sync_command_digest',
        message: 'Sync command digest must be a hexadecimal SHA-256 digest.',
        retryable: false,
      }
    }

    return undefined
  }

  private signDurableMetadata(metadata: Metadata, scope: InternalGrpcAuthScope): void {
    const proof = this.internalGrpcAuth.sign(scope)
    metadata.set(INTERNAL_GRPC_AUTH_METADATA.version, proof.version)
    metadata.set(INTERNAL_GRPC_AUTH_METADATA.timestamp, proof.timestamp)
    metadata.set(INTERNAL_GRPC_AUTH_METADATA.signature, proof.signature)
  }

  private durableAuthenticationUnavailable(): {
    status: number
    data: {
      error: {
        code: string
        message: string
        retryable: boolean
      }
    }
  } {
    return {
      status: 503,
      data: {
        error: {
          code: 'sync_command_authentication_unavailable',
          message: 'Durable sync command authentication is unavailable.',
          retryable: true,
        },
      },
    }
  }
}
