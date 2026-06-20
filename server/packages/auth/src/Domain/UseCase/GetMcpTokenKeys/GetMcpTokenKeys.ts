import { Result, UniqueEntityId, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { McpTokenRepositoryInterface } from '../../McpToken/McpTokenRepositoryInterface'

import { GetMcpTokenKeysDTO } from './GetMcpTokenKeysDTO'
import { GetMcpTokenKeysResult } from './GetMcpTokenKeysResult'

/**
 * Returns the opaque, client-wrapped key material for an MCP token so the bridge
 * can unwrap the account's encryption keys locally. The server stores and
 * returns ciphertext only; it never performs crypto. Scoped to the requesting
 * user so one user can never read another user's wrapped keys.
 */
export class GetMcpTokenKeys implements UseCaseInterface<GetMcpTokenKeysResult> {
  constructor(private mcpTokenRepository: McpTokenRepositoryInterface) {}

  async execute(dto: GetMcpTokenKeysDTO): Promise<Result<GetMcpTokenKeysResult>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not get MCP token keys: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const mcpToken = await this.mcpTokenRepository.findById(new UniqueEntityId(dto.mcpTokenId))
    if (!mcpToken || mcpToken.props.userUuid !== userUuid.value) {
      return Result.fail('MCP token not found')
    }

    return Result.ok({
      wrappedKeys: mcpToken.props.wrappedKeys,
      kdfSalt: mcpToken.props.kdfSalt,
      kdfParams: mcpToken.props.kdfParams,
      scope: mcpToken.props.scope,
      scopeTagUuids: mcpToken.props.scopeTagUuids,
    })
  }
}
