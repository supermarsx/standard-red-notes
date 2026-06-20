import * as bcrypt from 'bcryptjs'

import { McpToken } from '../../McpToken/McpToken'
import { McpTokenRepositoryInterface } from '../../McpToken/McpTokenRepositoryInterface'

import { AuthenticateWithMcpToken } from './AuthenticateWithMcpToken'

describe('AuthenticateWithMcpToken', () => {
  let mcpTokenRepository: McpTokenRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const tokenUuid = '11111111-1111-1111-1111-111111111111'
  const secret = 'super-secret-value'

  const createUseCase = () => new AuthenticateWithMcpToken(mcpTokenRepository)

  const buildToken = async (overrides: Partial<McpToken['props']> = {}): Promise<McpToken> => {
    const hashedToken = await bcrypt.hash(secret, 4)
    return McpToken.create(
      {
        userUuid,
        label: 'MCP',
        hashedToken,
        scope: 'read',
        scopeTagUuids: null,
        wrappedKeys: 'blob',
        kdfSalt: 'salt',
        kdfParams: '{}',
        createdAt: new Date(),
        lastUsedAt: null,
        expiresAt: null,
        ...overrides,
      },
      { toString: () => tokenUuid } as never,
    ).getValue()
  }

  beforeEach(() => {
    mcpTokenRepository = {} as jest.Mocked<McpTokenRepositoryInterface>
    mcpTokenRepository.updateLastUsedAt = jest.fn().mockResolvedValue(undefined)
  })

  it('should fail for an empty token', async () => {
    mcpTokenRepository.findById = jest.fn()
    const result = await createUseCase().execute({ token: '' })
    expect(result.isFailed()).toBe(true)
  })

  it('should fail for a token without a separator', async () => {
    mcpTokenRepository.findById = jest.fn()
    const result = await createUseCase().execute({ token: 'no-separator-here' })
    expect(result.isFailed()).toBe(true)
  })

  it('should fail when the row is not found', async () => {
    mcpTokenRepository.findById = jest.fn().mockResolvedValue(null)
    const result = await createUseCase().execute({ token: `${tokenUuid}.${secret}` })
    expect(result.isFailed()).toBe(true)
  })

  it('should fail when the secret does not match', async () => {
    mcpTokenRepository.findById = jest.fn().mockResolvedValue(await buildToken())
    const result = await createUseCase().execute({ token: `${tokenUuid}.wrong-secret` })
    expect(result.isFailed()).toBe(true)
  })

  it('should fail when the token is expired', async () => {
    mcpTokenRepository.findById = jest
      .fn()
      .mockResolvedValue(await buildToken({ expiresAt: new Date(Date.now() - 1000) }))
    const result = await createUseCase().execute({ token: `${tokenUuid}.${secret}` })
    expect(result.isFailed()).toBe(true)
  })

  it('should succeed and return scope info on a valid token', async () => {
    mcpTokenRepository.findById = jest
      .fn()
      .mockResolvedValue(await buildToken({ scope: 'write', scopeTagUuids: ['tag-1'] }))
    const result = await createUseCase().execute({ token: `${tokenUuid}.${secret}` })

    expect(result.isFailed()).toBe(false)
    const value = result.getValue()
    expect(value.userUuid).toEqual(userUuid)
    expect(value.scope).toEqual('write')
    expect(value.scopeTagUuids).toEqual(['tag-1'])
    expect(mcpTokenRepository.updateLastUsedAt).toHaveBeenCalledTimes(1)
  })
})
