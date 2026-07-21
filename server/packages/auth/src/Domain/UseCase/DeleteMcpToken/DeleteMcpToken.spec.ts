import { UniqueEntityId } from '@standardnotes/domain-core'

import { McpToken } from '../../McpToken/McpToken'
import { McpTokenRepositoryInterface } from '../../McpToken/McpTokenRepositoryInterface'

import { DeleteMcpToken } from './DeleteMcpToken'

describe('DeleteMcpToken', () => {
  let mcpTokenRepository: McpTokenRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const otherUserUuid = '11111111-1111-1111-1111-111111111111'
  const mcpTokenId = 'mcp-token-1'

  const mcpTokenOf = (owner: string) => ({ props: { userUuid: owner } }) as jest.Mocked<McpToken>

  const createUseCase = () => new DeleteMcpToken(mcpTokenRepository)

  beforeEach(() => {
    mcpTokenRepository = {} as jest.Mocked<McpTokenRepositoryInterface>
    mcpTokenRepository.findById = jest.fn().mockResolvedValue(mcpTokenOf(userUuid))
    mcpTokenRepository.remove = jest.fn().mockResolvedValue(undefined)
  })

  it('should fail without touching the repository if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'invalid', mcpTokenId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('Could not delete MCP token')
    expect(mcpTokenRepository.findById).not.toHaveBeenCalled()
    expect(mcpTokenRepository.remove).not.toHaveBeenCalled()
  })

  it('should fail if the MCP token does not exist', async () => {
    mcpTokenRepository.findById = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ userUuid, mcpTokenId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('MCP token not found')
    expect(mcpTokenRepository.remove).not.toHaveBeenCalled()
  })

  it('should refuse to delete an MCP token belonging to another user', async () => {
    mcpTokenRepository.findById = jest.fn().mockResolvedValue(mcpTokenOf(otherUserUuid))

    const result = await createUseCase().execute({ userUuid, mcpTokenId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('MCP token not found')
    expect(mcpTokenRepository.remove).not.toHaveBeenCalled()
  })

  it('should delete the MCP token owned by the requesting user', async () => {
    const owned = mcpTokenOf(userUuid)
    mcpTokenRepository.findById = jest.fn().mockResolvedValue(owned)

    const result = await createUseCase().execute({ userUuid, mcpTokenId })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toEqual('MCP token deleted')

    const lookupId = (mcpTokenRepository.findById as jest.Mock).mock.calls[0][0] as UniqueEntityId
    expect(lookupId.toString()).toEqual(mcpTokenId)
    expect(mcpTokenRepository.remove).toHaveBeenCalledWith(owned)
  })
})
