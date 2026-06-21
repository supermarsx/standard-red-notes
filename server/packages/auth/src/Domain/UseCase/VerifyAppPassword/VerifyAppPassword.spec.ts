import * as bcrypt from 'bcryptjs'
import { UniqueEntityId } from '@standardnotes/domain-core'

import { AppPassword } from '../../AppPassword/AppPassword'
import { AppPasswordRepositoryInterface } from '../../AppPassword/AppPasswordRepositoryInterface'
import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { VerifyAppPassword } from './VerifyAppPassword'

describe('VerifyAppPassword', () => {
  let appPasswordRepository: AppPasswordRepositoryInterface
  let userRepository: UserRepositoryInterface
  let user: User

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const plaintext = 'a-very-high-entropy-secret-value'

  const createUseCase = () => new VerifyAppPassword(appPasswordRepository, userRepository)

  const createAppPasswordWithHash = async (secret: string): Promise<AppPassword> => {
    const hashedPassword = await bcrypt.hash(secret, User.PASSWORD_HASH_COST)

    return AppPassword.create(
      {
        userUuid,
        label: 'MCP Bridge',
        hashedPassword,
        createdAt: new Date(),
        lastUsedAt: null,
      },
      new UniqueEntityId('11111111-1111-1111-1111-111111111111'),
    ).getValue()
  }

  beforeEach(() => {
    user = { uuid: userUuid } as jest.Mocked<User>

    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(user)

    appPasswordRepository = {} as jest.Mocked<AppPasswordRepositoryInterface>
    appPasswordRepository.findByUserUuid = jest.fn().mockResolvedValue([])
    appPasswordRepository.updateLastUsedAt = jest.fn().mockResolvedValue(undefined)
  })

  it('should return true and record last-used when the app password matches a stored hash', async () => {
    const appPassword = await createAppPasswordWithHash(plaintext)
    appPasswordRepository.findByUserUuid = jest.fn().mockResolvedValue([appPassword])

    const result = await createUseCase().execute({ email: 'user@example.com', appPassword: plaintext })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(true)
    expect(appPasswordRepository.updateLastUsedAt).toHaveBeenCalledTimes(1)
    const [idArg] = (appPasswordRepository.updateLastUsedAt as jest.Mock).mock.calls[0]
    expect((idArg as UniqueEntityId).toString()).toBe('11111111-1111-1111-1111-111111111111')
  })

  it('should fail closed (return false) when the app password does not match', async () => {
    const appPassword = await createAppPasswordWithHash(plaintext)
    appPasswordRepository.findByUserUuid = jest.fn().mockResolvedValue([appPassword])

    const result = await createUseCase().execute({ email: 'user@example.com', appPassword: 'wrong-secret' })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe(false)
    expect(appPasswordRepository.updateLastUsedAt).not.toHaveBeenCalled()
  })

  it('should return false when the user has no app passwords', async () => {
    appPasswordRepository.findByUserUuid = jest.fn().mockResolvedValue([])

    const result = await createUseCase().execute({ email: 'user@example.com', appPassword: plaintext })

    expect(result.getValue()).toBe(false)
  })

  it('should return false when the app password is an empty string', async () => {
    const result = await createUseCase().execute({ email: 'user@example.com', appPassword: '' })

    expect(result.getValue()).toBe(false)
    expect(userRepository.findOneByUsernameOrEmail).not.toHaveBeenCalled()
  })

  it('should return false when the user does not exist', async () => {
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ email: 'user@example.com', appPassword: plaintext })

    expect(result.getValue()).toBe(false)
  })

  it('should still return true even if recording last-used fails', async () => {
    const appPassword = await createAppPasswordWithHash(plaintext)
    appPasswordRepository.findByUserUuid = jest.fn().mockResolvedValue([appPassword])
    appPasswordRepository.updateLastUsedAt = jest.fn().mockRejectedValue(new Error('db down'))

    const result = await createUseCase().execute({ email: 'user@example.com', appPassword: plaintext })

    expect(result.getValue()).toBe(true)
  })

  it('should match the correct password among several stored app passwords', async () => {
    const other = await createAppPasswordWithHash('some-other-secret')
    const target = await createAppPasswordWithHash(plaintext)
    appPasswordRepository.findByUserUuid = jest.fn().mockResolvedValue([other, target])

    const result = await createUseCase().execute({ email: 'user@example.com', appPassword: plaintext })

    expect(result.getValue()).toBe(true)
  })
})
