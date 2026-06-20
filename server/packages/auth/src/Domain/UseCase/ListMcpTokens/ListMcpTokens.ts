import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { McpToken } from '../../McpToken/McpToken'
import { McpTokenRepositoryInterface } from '../../McpToken/McpTokenRepositoryInterface'

import { ListMcpTokensDTO } from './ListMcpTokensDTO'

export class ListMcpTokens implements UseCaseInterface<McpToken[]> {
  constructor(private mcpTokenRepository: McpTokenRepositoryInterface) {}

  async execute(dto: ListMcpTokensDTO): Promise<Result<McpToken[]>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not list MCP tokens: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const mcpTokens = await this.mcpTokenRepository.findByUserUuid(userUuid)

    return Result.ok(mcpTokens)
  }
}
