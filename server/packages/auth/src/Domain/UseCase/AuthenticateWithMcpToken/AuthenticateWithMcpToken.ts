import * as bcrypt from 'bcryptjs'
import { Result, UniqueEntityId, UseCaseInterface } from '@standardnotes/domain-core'

import { McpTokenRepositoryInterface } from '../../McpToken/McpTokenRepositoryInterface'

import { AuthenticateWithMcpTokenDTO } from './AuthenticateWithMcpTokenDTO'
import { AuthenticateWithMcpTokenResult } from './AuthenticateWithMcpTokenResult'

/**
 * Standard Red Notes: authenticates a headless MCP bridge using a revocable,
 * scoped MCP token INSTEAD of email+password.
 *
 * The plaintext token has the form `<tokenUuid>.<secret>`. We split on the first
 * '.', load the row by uuid, then bcrypt.compare the secret against the stored
 * hash. This avoids scanning all rows: the uuid prefix tells us exactly which
 * row to verify against.
 *
 * SECURITY: fails closed. Any malformed token, missing row, non-match, or
 * expired token returns Result.fail and grants no access.
 */
export class AuthenticateWithMcpToken implements UseCaseInterface<AuthenticateWithMcpTokenResult> {
  constructor(private mcpTokenRepository: McpTokenRepositoryInterface) {}

  async execute(dto: AuthenticateWithMcpTokenDTO): Promise<Result<AuthenticateWithMcpTokenResult>> {
    if (typeof dto.token !== 'string' || dto.token.length === 0) {
      return Result.fail('Invalid MCP token')
    }

    const separatorIndex = dto.token.indexOf('.')
    if (separatorIndex <= 0 || separatorIndex >= dto.token.length - 1) {
      return Result.fail('Invalid MCP token')
    }

    const tokenUuid = dto.token.substring(0, separatorIndex)
    const secret = dto.token.substring(separatorIndex + 1)

    const mcpToken = await this.mcpTokenRepository.findById(new UniqueEntityId(tokenUuid))
    if (mcpToken === null) {
      return Result.fail('Invalid MCP token')
    }

    const matches = await bcrypt.compare(secret, mcpToken.props.hashedToken)
    if (!matches) {
      return Result.fail('Invalid MCP token')
    }

    if (mcpToken.props.expiresAt !== null && mcpToken.props.expiresAt.getTime() <= Date.now()) {
      return Result.fail('MCP token has expired')
    }

    // Best-effort bookkeeping; never let it affect the auth decision.
    try {
      await this.mcpTokenRepository.updateLastUsedAt(mcpToken.id, new Date())
    } catch {
      // Intentionally ignored: failing to record last-used time must not block auth.
    }

    return Result.ok({
      userUuid: mcpToken.props.userUuid,
      scope: mcpToken.props.scope,
      scopeTagUuids: mcpToken.props.scopeTagUuids,
    })
  }
}
