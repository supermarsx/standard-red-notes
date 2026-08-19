import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { AuthInviteAffectedUserResolver } from './AuthInviteAffectedUserResolver'

describe('AuthInviteAffectedUserResolver', () => {
  it('fans an identifier out to every matching workspace account and deduplicates known users', async () => {
    const userRepository = {
      findAllByUsernameOrEmail: jest
        .fn()
        .mockResolvedValue([
          { uuid: '00000000-0000-4000-8000-000000000001' },
          { uuid: '00000000-0000-4000-8000-000000000002' },
        ]),
    } as unknown as jest.Mocked<UserRepositoryInterface>
    const resolver = new AuthInviteAffectedUserResolver(userRepository)

    await expect(
      resolver.resolve(['00000000-0000-4000-8000-000000000001'], ['member@example.com', 'not a valid identifier']),
    ).resolves.toEqual(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'])
    expect(userRepository.findAllByUsernameOrEmail).toHaveBeenCalledTimes(1)
  })
})
