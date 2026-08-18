import { Request, Response } from 'express'
import { verify } from 'jsonwebtoken'
import { CrossServiceTokenData } from '@standardnotes/security'
import { RoleName } from '@standardnotes/domain-core'
import type {
  JsonObject,
  SyncAuthorizationDecision,
  SyncAuthorizationInput,
  SyncBackendCommandInput,
  SyncBackendCommit,
  SyncBackendStatus,
  SyncCommandBackendAdapter,
  SyncLiveAuthorizationAdapter,
  SyncTicketIdentity,
} from '@standard-red-notes/websocket-gateway'

import { ResponseLocals } from '../../Controller/ResponseLocals'
import { ServiceProxyInterface } from '../Proxy/ServiceProxyInterface'

export interface DurableSyncCommandPort {
  durableCommandAuthenticationReady(): boolean
  sync(
    request: Request,
    response: Response,
    payload: Record<string, unknown>,
  ): Promise<{ status: number; data: unknown; replayed?: boolean }>
  getSyncCommandStatus(
    request: Request,
    response: Response,
    commandId: string,
    digest?: string,
  ): Promise<{
    status: number
    data: {
      command: { id: string; status: 'accepted' | 'committed' | 'unknown'; digest?: string }
      result?: Record<string, unknown>
    }
  }>
}

type ValidatedSession = {
  locals: ResponseLocals
  token: CrossServiceTokenData
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error('Sync command aborted.'))
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error('Sync command aborted.'))
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/**
 * Revalidates the original session token for every WS COMMAND/STATUS and then
 * delegates durable execution/idempotency to Lane 1's gRPC adapter. It never
 * implements a second executor or repository.
 */
export class SyncWebSocketCommandAdapter implements SyncLiveAuthorizationAdapter, SyncCommandBackendAdapter {
  constructor(
    private readonly serviceProxy: ServiceProxyInterface,
    private readonly durableSync: DurableSyncCommandPort,
    private readonly authJwtSecret: string,
  ) {}

  ready(): boolean {
    return (
      this.authJwtSecret.length > 0 &&
      this.durableSync.durableCommandAuthenticationReady() &&
      typeof this.durableSync.sync === 'function' &&
      typeof this.durableSync.getSyncCommandStatus === 'function'
    )
  }

  async authorize(input: SyncAuthorizationInput, signal: AbortSignal): Promise<SyncAuthorizationDecision> {
    let validated: ValidatedSession
    try {
      validated = await this.validate(input.identity, signal)
    } catch {
      return { authorized: false, code: 'SESSION_REVOKED' }
    }

    if (input.operation === 'STATUS') {
      return { authorized: true }
    }
    if (validated.locals.readOnlyAccess) {
      return { authorized: false, code: 'READ_ONLY' }
    }
    if (validated.locals.hasContentLimit) {
      return { authorized: false, code: 'CONTENT_LIMIT' }
    }
    if (validated.locals.shadowBanned || validated.locals.liveSyncEnabled === false) {
      return { authorized: false, code: 'SHADOW_BANNED' }
    }
    if (input.payload && !this.hasSharedVaultAccess(input.payload, validated.token)) {
      return { authorized: false, code: 'SHARED_VAULT_FORBIDDEN' }
    }
    return { authorized: true }
  }

  async execute(input: SyncBackendCommandInput, signal: AbortSignal): Promise<SyncBackendCommit> {
    const validated = await this.validate(input.identity, signal)
    const body = this.commandBody(input.payload)
    const { request, response } = this.httpContext(validated.locals, body)
    const result = await abortable(
      this.durableSync.sync(request, response, {
        ...body,
        command: { id: input.commandId, digest: input.digest },
      }),
      signal,
    )
    if (result.status < 200 || result.status >= 300 || !this.isJsonObject(result.data)) {
      throw new Error('Durable sync command failed.')
    }
    const command = result.data.command
    const digest =
      this.isJsonObject(command) && typeof command.digest === 'string' ? command.digest.toLowerCase() : input.digest
    return { digest, payload: result.data }
  }

  async status(input: Omit<SyncBackendCommandInput, 'payload'>, signal: AbortSignal): Promise<SyncBackendStatus> {
    const validated = await this.validate(input.identity, signal)
    const { request, response } = this.httpContext(validated.locals, {})
    const result = await abortable(
      this.durableSync.getSyncCommandStatus(request, response, input.commandId, input.digest),
      signal,
    )
    if (result.status < 200 || result.status >= 300) {
      throw new Error('Durable sync command status failed.')
    }
    const command = result.data.command
    if (command.status === 'unknown') {
      return { status: 'UNKNOWN', digest: command.digest }
    }
    const digest = command.digest ?? input.digest
    if (command.status === 'accepted') {
      return { status: 'ACCEPTED', digest }
    }
    return { status: 'COMMITTED', digest, payload: result.data.result }
  }

  private async validate(identity: SyncTicketIdentity, signal: AbortSignal): Promise<ValidatedSession> {
    if (!identity.authorization || !this.ready()) {
      throw new Error('Live sync authorization is unavailable.')
    }
    const authorization = identity.authorization.replace(/^Bearer\s+/i, '')
    const authResponse = await abortable(
      this.serviceProxy.validateSession({
        headers: { authorization },
        requestMetadata: { url: '/sockets/sync', method: 'POST' },
      }),
      signal,
    )
    if (authResponse.status !== 200 || !this.isJsonObject(authResponse.data)) {
      throw new Error('Sync session is no longer authorized.')
    }
    const authToken = authResponse.data.authToken
    if (typeof authToken !== 'string') {
      throw new Error('Sync session validation returned no token.')
    }
    const token = verify(authToken, this.authJwtSecret, { algorithms: ['HS256'] }) as CrossServiceTokenData
    const session = token.session
    if (token.user.uuid !== identity.userUuid || session?.uuid !== identity.sessionUuid) {
      throw new Error('Sync session identity changed.')
    }
    const readOnlyAccess = session.readonly_access || token.mcp_scope?.access === 'read'
    const locals = {
      authToken,
      user: token.user,
      roles: token.roles,
      session,
      readOnlyAccess,
      mcpScope: token.mcp_scope,
      isFreeUser: token.roles.length === 1 && token.roles[0]?.name === RoleName.NAMES.CoreUser,
      belongsToSharedVaults: token.belongs_to_shared_vaults ?? [],
      sharedVaultOwnerContext: token.shared_vault_owner_context,
      hasContentLimit: token.hasContentLimit === true,
      collaborationEnabled: token.collaboration_enabled !== false,
      liveSyncEnabled: token.live_sync_enabled !== false,
      authTokenVersion: token.version,
      shadowBanned: token.shadow_banned === true,
    } satisfies ResponseLocals
    return { locals, token }
  }

  private hasSharedVaultAccess(payload: JsonObject, token: CrossServiceTokenData): boolean {
    const body = this.commandBody(payload)
    const requested = new Set<string>()
    if (Array.isArray(body.shared_vault_uuids)) {
      for (const uuid of body.shared_vault_uuids) {
        if (typeof uuid === 'string') {
          requested.add(uuid)
        }
      }
    }
    if (Array.isArray(body.items)) {
      for (const item of body.items) {
        if (this.isJsonObject(item) && typeof item.shared_vault_uuid === 'string') {
          requested.add(item.shared_vault_uuid)
        }
      }
    }
    if (requested.size === 0) {
      return true
    }
    const allowed = new Set((token.belongs_to_shared_vaults ?? []).map((vault) => vault.shared_vault_uuid))
    return [...requested].every((uuid) => allowed.has(uuid))
  }

  private commandBody(payload: JsonObject): JsonObject {
    if (payload.command !== 'SYNC_ITEMS' || !this.isJsonObject(payload.body)) {
      throw new Error('Invalid sync command payload.')
    }
    return payload.body
  }

  private httpContext(locals: ResponseLocals, body: JsonObject): { request: Request; response: Response } {
    const api = typeof body.api === 'string' ? body.api : undefined
    return {
      request: { headers: { 'x-snjs-version': api } } as unknown as Request,
      response: { locals } as unknown as Response,
    }
  }

  private isJsonObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }
}
