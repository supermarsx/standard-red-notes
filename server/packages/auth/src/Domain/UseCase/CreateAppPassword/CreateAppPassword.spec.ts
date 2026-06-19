import * as bcrypt from 'bcryptjs'

import { AppPassword } from '../../AppPassword/AppPassword'
import { AppPasswordRepositoryInterface } from '../../AppPassword/AppPasswordRepositoryInterface'
import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { CreateAppPassword } from './CreateAppPassword'

describe('CreateAppPassword', () => {
  let appPasswordRepository: AppPasswordRepositoryInterface
  let userRepository: UserRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'

  const createUseCase = () => new CreateAppPassword(appPasswordRepository, userRepository)

  beforeEach(() => {
    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUuid = jest.fn().mockResolvedValue({ uuid: userUuid } as jest.Mocked<User>)

    appPasswordRepository = {} as jest.Mocked<AppPasswordRepositoryInterface>
    appPasswordRepository.save = jest.fn().mockResolvedValue(undefined)
  })

  it('should fail if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'invalid', label: 'MCP' })

    expect(result.isFailed()).toBe(true)
  })

  it('should fail if the user is not found', async () => {
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ userUuid, label: 'MCP' })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Could not create app password: user not found.')
  })

  it('should fail if the label is empty', async () => {
    const result = await createUseCase().execute({ userUuid, label: '   ' })

    expect(result.isFailed()).toBe(true)
    expect(appPasswordRepository.save).not.toHaveBeenCalled()
  })

  it('should store only a bcrypt hash that verifies against the returned plaintext secret', async () => {
    const result = await createUseCase().execute({ userUuid, label: 'MCP Bridge' })

    expect(result.isFailed()).toBe(false)
    const created = result.getValue()

    expect(created.password.length).toBeGreaterThan(20)

    expect(appPasswordRepository.save).toHaveBeenCalledTimes(1)
    const saved = (appPasswordRepository.save as jest.Mock).mock.calls[0][0] as AppPassword

    // The persisted value must NOT be the plaintext secret.
    expect(saved.props.hashedPassword).not.toEqual(created.password)
    // The persisted hash must verify against the one-time plaintext secret.
    await expect(bcrypt.compare(created.password, saved.props.hashedPassword)).resolves.toBe(true)
    expect(saved.props.userUuid).toEqual(userUuid)
    expect(saved.props.lastUsedAt).toBeNull()
  })

  it('should generate distinct secrets on each invocation', async () => {
    const first = (await createUseCase().execute({ userUuid, label: 'a' })).getValue()
    const second = (await createUseCase().execute({ userUuid, label: 'b' })).getValue()

    expect(first.password).not.toEqual(second.password)
  })
})
