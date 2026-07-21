import { Uuid } from '@standardnotes/domain-core'

import { McpToken } from '../../McpToken/McpToken'
import { McpTokenRepositoryInterface } from '../../McpToken/McpTokenRepositoryInterface'

import { ListMcpTokens } from './ListMcpTokens'

describe('ListMcpTokens', () => {
  let mcpTokenRepository: McpTokenRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const mcpTokens = [{ props: { label: 'Bridge' } }] as jest.Mocked<McpToken[]>

  const createUseCase = () => new ListMcpTokens(mcpTokenRepository)

  beforeEach(() => {
    mcpTokenRepository = {} as jest.Mocked<McpTokenRepositoryInterface>
    mcpTokenRepository.findByUserUuid = jest.fn().mockResolvedValue(mcpTokens)
  })

  it('should fail without querying the repository if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'invalid' })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('Could not list MCP tokens')
    expect(mcpTokenRepository.findByUserUuid).not.toHaveBeenCalled()
  })

  it('should return the MCP tokens scoped to the requesting user', async () => {
    const result = await createUseCase().execute({ userUuid })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toEqual(mcpTokens)

    expect(mcpTokenRepository.findByUserUuid).toHaveBeenCalledTimes(1)
    const queriedUuid = (mcpTokenRepository.findByUserUuid as jest.Mock).mock.calls[0][0] as Uuid
    expect(queriedUuid.value).toEqual(userUuid)
  })
})
