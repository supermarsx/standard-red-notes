import { HttpResponse, HttpStatusCode } from '@standardnotes/responses'
import { MapperInterface, Uuid } from '@standardnotes/domain-core'

import { McpToken } from '../Domain/McpToken/McpToken'
import { CreateMcpToken } from '../Domain/UseCase/CreateMcpToken/CreateMcpToken'
import { ListMcpTokens } from '../Domain/UseCase/ListMcpTokens/ListMcpTokens'
import { DeleteMcpToken } from '../Domain/UseCase/DeleteMcpToken/DeleteMcpToken'
import { AuthenticateWithMcpToken } from '../Domain/UseCase/AuthenticateWithMcpToken/AuthenticateWithMcpToken'
import { GetMcpTokenKeys } from '../Domain/UseCase/GetMcpTokenKeys/GetMcpTokenKeys'
import { McpTokenHttpProjection } from '../Infra/Http/Projection/McpTokenHttpProjection'
import { AuthResponseFactoryResolverInterface } from '../Domain/Auth/AuthResponseFactoryResolverInterface'
import { UserRepositoryInterface } from '../Domain/User/UserRepositoryInterface'
import { SessionRepositoryInterface } from '../Domain/Session/SessionRepositoryInterface'
import { ApiVersion } from '../Domain/Api/ApiVersion'

export class McpTokensController {
  constructor(
    private createMcpToken: CreateMcpToken,
    private listMcpTokens: ListMcpTokens,
    private deleteMcpToken: DeleteMcpToken,
    private authenticateWithMcpToken: AuthenticateWithMcpToken,
    private getMcpTokenKeys: GetMcpTokenKeys,
    private mcpTokenHttpMapper: MapperInterface<McpToken, McpTokenHttpProjection>,
    private authResponseFactoryResolver: AuthResponseFactoryResolverInterface,
    private userRepository: UserRepositoryInterface,
    private sessionRepository: SessionRepositoryInterface,
  ) {}

  async list(params: { userUuid: string }): Promise<HttpResponse> {
    const result = await this.listMcpTokens.execute({
      userUuid: params.userUuid,
    })

    if (result.isFailed()) {
      return {
        status: HttpStatusCode.Unauthorized,
        data: {
          error: {
            message: result.getError(),
          },
        },
      }
    }

    return {
      status: HttpStatusCode.Success,
      data: {
        mcpTokens: result.getValue().map((mcpToken) => this.mcpTokenHttpMapper.toProjection(mcpToken)),
      },
    }
  }

  async create(params: {
    userUuid: string
    label: string
    scope: string
    scopeTagUuids?: string[]
    wrappedKeys: string
    kdfSalt: string
    kdfParams: string
  }): Promise<HttpResponse> {
    const result = await this.createMcpToken.execute({
      userUuid: params.userUuid,
      label: params.label,
      scope: params.scope,
      scopeTagUuids: params.scopeTagUuids,
      wrappedKeys: params.wrappedKeys,
      kdfSalt: params.kdfSalt,
      kdfParams: params.kdfParams,
    })

    if (result.isFailed()) {
      return {
        status: HttpStatusCode.BadRequest,
        data: {
          error: {
            message: result.getError(),
          },
        },
      }
    }

    const created = result.getValue()

    return {
      status: HttpStatusCode.Success,
      data: {
        mcpToken: {
          uuid: created.uuid,
          label: created.label,
          scope: created.scope,
          scopeTagUuids: created.scopeTagUuids,
          createdAt: created.createdAt.toISOString(),
          expiresAt: created.expiresAt ? created.expiresAt.toISOString() : null,
        },
        // Plaintext token returned exactly once, in `<uuid>.<secret>` format. The
        // client must surface and store it now; it is never retrievable again.
        token: created.token,
      },
    }
  }

  async delete(params: { userUuid: string; mcpTokenId: string }): Promise<HttpResponse> {
    const result = await this.deleteMcpToken.execute({
      userUuid: params.userUuid,
      mcpTokenId: params.mcpTokenId,
    })

    if (result.isFailed()) {
      return {
        status: HttpStatusCode.Unauthorized,
        data: {
          error: {
            message: result.getError(),
          },
        },
      }
    }

    return {
      status: HttpStatusCode.Success,
      data: {
        message: result.getValue(),
      },
    }
  }

  async getKeys(params: { userUuid: string; mcpTokenId: string }): Promise<HttpResponse> {
    const result = await this.getMcpTokenKeys.execute({
      userUuid: params.userUuid,
      mcpTokenId: params.mcpTokenId,
    })

    if (result.isFailed()) {
      return {
        status: HttpStatusCode.Unauthorized,
        data: {
          error: {
            message: result.getError(),
          },
        },
      }
    }

    const keys = result.getValue()

    return {
      status: HttpStatusCode.Success,
      data: {
        wrappedKeys: keys.wrappedKeys,
        kdfSalt: keys.kdfSalt,
        kdfParams: keys.kdfParams,
        scope: keys.scope,
        scopeTagUuids: keys.scopeTagUuids,
      },
    }
  }

  /**
   * UNAUTHENTICATED: the MCP token IS the credential. Authenticates the token,
   * mints a real auth session for that user (bypassing SRP), and returns the same
   * session payload a normal sign-in returns PLUS the wrapped key material so the
   * bridge gets everything in one round-trip.
   */
  async authenticate(params: { token: string; apiVersion?: string; userAgent: string }): Promise<HttpResponse> {
    const authResult = await this.authenticateWithMcpToken.execute({ token: params.token })
    if (authResult.isFailed()) {
      return {
        status: HttpStatusCode.Unauthorized,
        data: {
          error: {
            message: 'Invalid MCP token',
          },
        },
      }
    }
    const auth = authResult.getValue()

    const apiVersionOrError = ApiVersion.create(params.apiVersion ?? ApiVersion.VERSIONS.v20200115)
    if (apiVersionOrError.isFailed()) {
      return {
        status: HttpStatusCode.BadRequest,
        data: {
          error: {
            message: apiVersionOrError.getError(),
          },
        },
      }
    }
    const apiVersion = apiVersionOrError.getValue()

    const userUuidOrError = Uuid.create(auth.userUuid)
    if (userUuidOrError.isFailed()) {
      return {
        status: HttpStatusCode.Unauthorized,
        data: {
          error: {
            message: 'Invalid MCP token',
          },
        },
      }
    }

    const user = await this.userRepository.findOneByUuid(userUuidOrError.getValue())
    if (user === null) {
      return {
        status: HttpStatusCode.Unauthorized,
        data: {
          error: {
            message: 'Invalid MCP token',
          },
        },
      }
    }

    const authResponseFactory = this.authResponseFactoryResolver.resolveAuthResponseFactoryVersion(apiVersion)

    const creationResult = await authResponseFactory.createResponse({
      user,
      apiVersion,
      userAgent: params.userAgent,
      ephemeralSession: false,
      // scope=read is enforced server-side by reusing the session's readonly flag.
      readonlyAccess: auth.scope === 'read',
      snjs: undefined,
      application: undefined,
    })

    if (creationResult.response === undefined || creationResult.session === undefined) {
      return {
        status: HttpStatusCode.BadRequest,
        data: {
          error: {
            message: 'Could not create session for MCP token',
          },
        },
      }
    }

    // Carry the optional tag-scope on the session so CreateCrossServiceToken can
    // thread it into the cross-service token's mcp_scope (enforced client-side).
    if (auth.scopeTagUuids !== null && auth.scopeTagUuids.length > 0) {
      creationResult.session.mcpScopeTagUuids = JSON.stringify(auth.scopeTagUuids)
      try {
        await this.sessionRepository.update(creationResult.session)
      } catch {
        // best-effort; read/write enforcement does not depend on tag scope.
      }
    }

    const keysResult = await this.getMcpTokenKeys.execute({
      userUuid: auth.userUuid,
      mcpTokenId: params.token.substring(0, params.token.indexOf('.')),
    })

    const keyMaterial = keysResult.isFailed()
      ? null
      : {
          wrappedKeys: keysResult.getValue().wrappedKeys,
          kdfSalt: keysResult.getValue().kdfSalt,
          kdfParams: keysResult.getValue().kdfParams,
        }

    return {
      status: HttpStatusCode.Success,
      data: {
        session: creationResult.response.sessionBody,
        key_params: creationResult.response.keyParams,
        user: creationResult.response.user,
        mcp_scope: {
          access: auth.scope,
          tagUuids: auth.scopeTagUuids ?? undefined,
        },
        mcp_key_material: keyMaterial,
      },
    }
  }
}
