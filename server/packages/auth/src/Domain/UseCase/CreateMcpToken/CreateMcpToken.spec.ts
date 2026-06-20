import * as bcrypt from 'bcryptjs'

import { McpToken } from '../../McpToken/McpToken'
import { McpTokenRepositoryInterface } from '../../McpToken/McpTokenRepositoryInterface'
import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { CreateMcpToken } from './CreateMcpToken'

describe('CreateMcpToken', () => {
  let mcpTokenRepository: McpTokenRepositoryInterface
  let userRepository: UserRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'

  const validDto = {
    userUuid,
    label: 'MCP Bridge',
    scope: 'read',
    wrappedKeys: 'wrapped-cipher-blob',
    kdfSalt: 'salt',
    kdfParams: '{"iterations":100000}',
  }

  const createUseCase = () => new CreateMcpToken(mcpTokenRepository, userRepository)

  beforeEach(() => {
    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUuid = jest.fn().mockResolvedValue({ uuid: userUuid } as jest.Mocked<User>)

    mcpTokenRepository = {} as jest.Mocked<McpTokenRepositoryInterface>
    mcpTokenRepository.save = jest.fn().mockResolvedValue(undefined)
  })

  it('should fail if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ ...validDto, userUuid: 'invalid' })

    expect(result.isFailed()).toBe(true)
  })

  it('should fail if the user is not found', async () => {
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute(validDto)

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Could not create MCP token: user not found.')
  })

  it('should fail if the label is empty', async () => {
    const result = await createUseCase().execute({ ...validDto, label: '   ' })

    expect(result.isFailed()).toBe(true)
    expect(mcpTokenRepository.save).not.toHaveBeenCalled()
  })

  it('should fail if the scope is invalid', async () => {
    const result = await createUseCase().execute({ ...validDto, scope: 'admin' })

    expect(result.isFailed()).toBe(true)
    expect(mcpTokenRepository.save).not.toHaveBeenCalled()
  })

  it('should fail if wrapped key material is missing', async () => {
    const result = await createUseCase().execute({ ...validDto, wrappedKeys: '' })

    expect(result.isFailed()).toBe(true)
    expect(mcpTokenRepository.save).not.toHaveBeenCalled()
  })

  it('should return a uuid-prefixed token whose secret verifies against the stored hash', async () => {
    const result = await createUseCase().execute(validDto)

    expect(result.isFailed()).toBe(false)
    const created = result.getValue()

    expect(mcpTokenRepository.save).toHaveBeenCalledTimes(1)
    const saved = (mcpTokenRepository.save as jest.Mock).mock.calls[0][0] as McpToken

    const [uuidPrefix, secret] = created.token.split('.')
    expect(uuidPrefix).toEqual(saved.id.toString())
    expect(uuidPrefix).toEqual(created.uuid)
    expect(secret.length).toBeGreaterThan(20)

    // The persisted hash must verify against the one-time secret part.
    expect(saved.props.hashedToken).not.toEqual(secret)
    await expect(bcrypt.compare(secret, saved.props.hashedToken)).resolves.toBe(true)
    expect(saved.props.userUuid).toEqual(userUuid)
    expect(saved.props.scope).toEqual('read')
    expect(saved.props.lastUsedAt).toBeNull()
    expect(saved.props.wrappedKeys).toEqual('wrapped-cipher-blob')
  })

  it('should persist scope tag uuids when provided', async () => {
    const result = await createUseCase().execute({
      ...validDto,
      scope: 'write',
      scopeTagUuids: ['tag-1', 'tag-2'],
    })

    expect(result.isFailed()).toBe(false)
    const saved = (mcpTokenRepository.save as jest.Mock).mock.calls[0][0] as McpToken
    expect(saved.props.scopeTagUuids).toEqual(['tag-1', 'tag-2'])
    expect(saved.props.scope).toEqual('write')
  })

  it('should generate distinct secrets on each invocation', async () => {
    const first = (await createUseCase().execute(validDto)).getValue()
    const second = (await createUseCase().execute(validDto)).getValue()

    expect(first.token).not.toEqual(second.token)
  })
})
