import 'reflect-metadata'

import { SessionTokensCooldownRepositoryInterface } from '../../Session/SessionTokensCooldownRepositoryInterface'

import { CooldownSessionTokens } from './CooldownSessionTokens'

describe('CooldownSessionTokens', () => {
  let sessionTokensCooldownRepository: SessionTokensCooldownRepositoryInterface

  const createUseCase = (cooldownPeriodInSeconds: number) =>
    new CooldownSessionTokens(cooldownPeriodInSeconds, sessionTokensCooldownRepository)

  beforeEach(() => {
    sessionTokensCooldownRepository = {} as jest.Mocked<SessionTokensCooldownRepositoryInterface>
    sessionTokensCooldownRepository.setCooldown = jest.fn()
    sessionTokensCooldownRepository.getHashedTokens = jest.fn()
  })

  it('should pass the configured cooldown period (TTL) through to the repository', async () => {
    // Default value wired in the container is 120 seconds (COOLDOWN_SESSION_TOKENS_TTL).
    const result = await createUseCase(120).execute({
      sessionUuid: '00000000-0000-0000-0000-000000000000',
      hashedAccessToken: 'hashed-access',
      hashedRefreshToken: 'hashed-refresh',
    })

    expect(result.isFailed()).toBe(false)
    expect(sessionTokensCooldownRepository.setCooldown).toHaveBeenCalledWith(
      expect.objectContaining({ cooldownPeriodInSeconds: 120 }),
    )
  })

  it('should honor an operator-configured cooldown period instead of the default', async () => {
    await createUseCase(900).execute({
      sessionUuid: '00000000-0000-0000-0000-000000000000',
      hashedAccessToken: 'hashed-access',
      hashedRefreshToken: 'hashed-refresh',
    })

    expect(sessionTokensCooldownRepository.setCooldown).toHaveBeenCalledWith(
      expect.objectContaining({ cooldownPeriodInSeconds: 900 }),
    )
  })

  it('should fail for an invalid session uuid without touching the repository', async () => {
    const result = await createUseCase(120).execute({
      sessionUuid: 'not-a-uuid',
      hashedAccessToken: 'hashed-access',
      hashedRefreshToken: 'hashed-refresh',
    })

    expect(result.isFailed()).toBe(true)
    expect(sessionTokensCooldownRepository.setCooldown).not.toHaveBeenCalled()
  })
})
