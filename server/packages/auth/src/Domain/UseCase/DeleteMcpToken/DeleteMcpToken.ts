import { Result, UniqueEntityId, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { McpTokenRepositoryInterface } from '../../McpToken/McpTokenRepositoryInterface'

import { DeleteMcpTokenDTO } from './DeleteMcpTokenDTO'

export class DeleteMcpToken implements UseCaseInterface<string> {
  constructor(private mcpTokenRepository: McpTokenRepositoryInterface) {}

  async execute(dto: DeleteMcpTokenDTO): Promise<Result<string>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not delete MCP token: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const mcpToken = await this.mcpTokenRepository.findById(new UniqueEntityId(dto.mcpTokenId))
    // Ownership check: never allow deleting another user's MCP token.
    if (!mcpToken || mcpToken.props.userUuid !== userUuid.value) {
      return Result.fail('MCP token not found')
    }

    await this.mcpTokenRepository.remove(mcpToken)

    return Result.ok('MCP token deleted')
  }
}
