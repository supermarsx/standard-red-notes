import * as crypto from 'crypto'
import * as bcrypt from 'bcryptjs'
import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { McpToken } from '../../McpToken/McpToken'
import { McpTokenRepositoryInterface } from '../../McpToken/McpTokenRepositoryInterface'
import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { CreateMcpTokenDTO } from './CreateMcpTokenDTO'
import { CreateMcpTokenResult } from './CreateMcpTokenResult'

export class CreateMcpToken implements UseCaseInterface<CreateMcpTokenResult> {
  /**
   * Number of random bytes for the generated secret. 32 bytes (256 bits) of
   * entropy, base64url-encoded into a ~43 character secret.
   */
  private readonly MCP_TOKEN_BYTE_LENGTH = 32

  constructor(
    private mcpTokenRepository: McpTokenRepositoryInterface,
    private userRepository: UserRepositoryInterface,
  ) {}

  async execute(dto: CreateMcpTokenDTO): Promise<Result<CreateMcpTokenResult>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not create MCP token: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const user = await this.userRepository.findOneByUuid(userUuid)
    if (user === null) {
      return Result.fail('Could not create MCP token: user not found.')
    }

    const label = (dto.label ?? '').trim()
    if (label.length === 0) {
      return Result.fail('Could not create MCP token: a label is required.')
    }

    if (dto.scope !== 'read' && dto.scope !== 'write') {
      return Result.fail('Could not create MCP token: scope must be either read or write.')
    }
    const scope = dto.scope as 'read' | 'write'

    if (typeof dto.wrappedKeys !== 'string' || dto.wrappedKeys.length === 0) {
      return Result.fail('Could not create MCP token: wrapped key material is required.')
    }

    if (typeof dto.kdfSalt !== 'string' || dto.kdfSalt.length === 0) {
      return Result.fail('Could not create MCP token: kdf salt is required.')
    }

    if (typeof dto.kdfParams !== 'string' || dto.kdfParams.length === 0) {
      return Result.fail('Could not create MCP token: kdf params are required.')
    }

    const scopeTagUuids =
      dto.scopeTagUuids !== undefined && dto.scopeTagUuids !== null && dto.scopeTagUuids.length > 0
        ? dto.scopeTagUuids
        : null

    // High-entropy, server-generated secret. Stored only as a bcrypt hash; the
    // plaintext is returned to the caller exactly once below.
    const secret = crypto.randomBytes(this.MCP_TOKEN_BYTE_LENGTH).toString('base64url')

    const hashedToken = await bcrypt.hash(secret, User.PASSWORD_HASH_COST)

    const createdAt = new Date()

    const mcpTokenOrError = McpToken.create({
      userUuid: userUuid.value,
      label,
      hashedToken,
      scope,
      scopeTagUuids,
      wrappedKeys: dto.wrappedKeys,
      kdfSalt: dto.kdfSalt,
      kdfParams: dto.kdfParams,
      createdAt,
      lastUsedAt: null,
      expiresAt: null,
    })
    if (mcpTokenOrError.isFailed()) {
      return Result.fail(`Could not create MCP token: ${mcpTokenOrError.getError()}`)
    }
    const mcpToken = mcpTokenOrError.getValue()

    await this.mcpTokenRepository.save(mcpToken)

    // Uuid-prefixed plaintext token: `<tokenUuid>.<secret>`. The bridge stores
    // this and presents it to /mcp-tokens/authenticate, which splits on the
    // first '.', loads the row by uuid, then bcrypt.compares the secret.
    const token = `${mcpToken.id.toString()}.${secret}`

    return Result.ok({
      uuid: mcpToken.id.toString(),
      label,
      scope,
      scopeTagUuids,
      token,
      createdAt,
      expiresAt: null,
    })
  }
}
