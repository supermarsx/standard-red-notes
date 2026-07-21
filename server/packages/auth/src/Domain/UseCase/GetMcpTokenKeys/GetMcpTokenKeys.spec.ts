import { McpToken } from '../../McpToken/McpToken'
import { McpTokenRepositoryInterface } from '../../McpToken/McpTokenRepositoryInterface'

import { GetMcpTokenKeys } from './GetMcpTokenKeys'

describe('GetMcpTokenKeys', () => {
  let mcpTokenRepository: McpTokenRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const otherUserUuid = '11111111-1111-1111-1111-111111111111'
  const mcpTokenId = 'mcp-token-1'

  const keyMaterial = {
    wrappedKeys: 'wrapped-ciphertext',
    kdfSalt: 'salt',
    kdfParams: { iterations: 100_000 },
    scope: 'tags',
    scopeTagUuids: ['tag-1'],
  }

  const mcpTokenOf = (owner: string) =>
    ({ props: { userUuid: owner, hashedToken: 'never-returned', ...keyMaterial } }) as unknown as jest.Mocked<McpToken>

  const createUseCase = () => new GetMcpTokenKeys(mcpTokenRepository)

  beforeEach(() => {
    mcpTokenRepository = {} as jest.Mocked<McpTokenRepositoryInterface>
    mcpTokenRepository.findById = jest.fn().mockResolvedValue(mcpTokenOf(userUuid))
  })

  it('should fail without touching the repository if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'invalid', mcpTokenId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('Could not get MCP token keys')
    expect(mcpTokenRepository.findById).not.toHaveBeenCalled()
  })

  it('should fail if the MCP token does not exist', async () => {
    mcpTokenRepository.findById = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ userUuid, mcpTokenId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('MCP token not found')
  })

  it("should refuse to return another user's wrapped key material", async () => {
    mcpTokenRepository.findById = jest.fn().mockResolvedValue(mcpTokenOf(otherUserUuid))

    const result = await createUseCase().execute({ userUuid, mcpTokenId })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('MCP token not found')
  })

  it('should return only the wrapped key material for a token the user owns', async () => {
    const result = await createUseCase().execute({ userUuid, mcpTokenId })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toEqual(keyMaterial)
    // The stored token hash must never leave the server.
    expect(Object.keys(result.getValue())).not.toContain('hashedToken')
  })
})
