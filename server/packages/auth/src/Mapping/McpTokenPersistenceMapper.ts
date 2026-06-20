import { MapperInterface, UniqueEntityId } from '@standardnotes/domain-core'

import { McpToken } from '../Domain/McpToken/McpToken'
import { TypeORMMcpToken } from '../Infra/TypeORM/TypeORMMcpToken'

export class McpTokenPersistenceMapper implements MapperInterface<McpToken, TypeORMMcpToken> {
  toDomain(projection: TypeORMMcpToken): McpToken {
    let scopeTagUuids: string[] | null = null
    if (projection.scopeTagUuids !== null && projection.scopeTagUuids !== undefined) {
      try {
        const parsed = JSON.parse(projection.scopeTagUuids)
        scopeTagUuids = Array.isArray(parsed) ? (parsed as string[]) : null
      } catch {
        scopeTagUuids = null
      }
    }

    const mcpTokenOrError = McpToken.create(
      {
        userUuid: projection.userUuid,
        label: projection.label,
        hashedToken: projection.hashedToken,
        scope: projection.scope === 'write' ? 'write' : 'read',
        scopeTagUuids,
        wrappedKeys: projection.wrappedKeys,
        kdfSalt: projection.kdfSalt,
        kdfParams: projection.kdfParams,
        createdAt: new Date(Number(projection.createdAt)),
        lastUsedAt:
          projection.lastUsedAt !== null && projection.lastUsedAt !== undefined
            ? new Date(Number(projection.lastUsedAt))
            : null,
        expiresAt:
          projection.expiresAt !== null && projection.expiresAt !== undefined
            ? new Date(Number(projection.expiresAt))
            : null,
      },
      new UniqueEntityId(projection.uuid),
    )
    if (mcpTokenOrError.isFailed()) {
      throw new Error(`Failed to create MCP token from projection: ${mcpTokenOrError.getError()}`)
    }

    return mcpTokenOrError.getValue()
  }

  toProjection(domain: McpToken): TypeORMMcpToken {
    const typeorm = new TypeORMMcpToken()

    typeorm.uuid = domain.id.toString()
    typeorm.userUuid = domain.props.userUuid
    typeorm.label = domain.props.label
    typeorm.hashedToken = domain.props.hashedToken
    typeorm.scope = domain.props.scope
    typeorm.scopeTagUuids =
      domain.props.scopeTagUuids !== null ? JSON.stringify(domain.props.scopeTagUuids) : null
    typeorm.wrappedKeys = domain.props.wrappedKeys
    typeorm.kdfSalt = domain.props.kdfSalt
    typeorm.kdfParams = domain.props.kdfParams
    typeorm.createdAt = domain.props.createdAt.getTime()
    typeorm.lastUsedAt = domain.props.lastUsedAt !== null ? domain.props.lastUsedAt.getTime() : null
    typeorm.expiresAt = domain.props.expiresAt !== null ? domain.props.expiresAt.getTime() : null

    return typeorm
  }
}
