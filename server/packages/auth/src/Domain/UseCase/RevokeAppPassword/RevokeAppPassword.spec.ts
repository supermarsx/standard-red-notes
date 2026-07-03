import { UniqueEntityId } from '@standardnotes/domain-core'

import { AppPassword } from '../../AppPassword/AppPassword'
import { AppPasswordRepositoryInterface } from '../../AppPassword/AppPasswordRepositoryInterface'

import { RevokeAppPassword } from './RevokeAppPassword'

describe('RevokeAppPassword', () => {
  let appPasswordRepository: AppPasswordRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const appPasswordId = '11111111-1111-1111-1111-111111111111'

  const createUseCase = () => new RevokeAppPassword(appPasswordRepository)

  const createAppPassword = (overrides: { userUuid?: string; revokedAt?: Date | null } = {}): AppPassword =>
    AppPassword.create(
      {
        userUuid: overrides.userUuid ?? userUuid,
        label: 'MCP Bridge',
        hashedPassword: 'hashed',
        createdAt: new Date(),
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: overrides.revokedAt ?? null,
      },
      new UniqueEntityId(appPasswordId),
    ).getValue()

  beforeEach(() => {
    appPasswordRepository = {} as jest.Mocked<AppPasswordRepositoryInterface>
    appPasswordRepository.findById = jest.fn().mockResolvedValue(createAppPassword())
    appPasswordRepository.save = jest.fn().mockResolvedValue(undefined)
    appPasswordRepository.remove = jest.fn().mockResolvedValue(undefined)
  })

  it('should fail if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({ userUuid: 'invalid', appPasswordId })

    expect(result.isFailed()).toBe(true)
    expect(appPasswordRepository.save).not.toHaveBeenCalled()
  })

  it('should fail if the app password does not exist', async () => {
    appPasswordRepository.findById = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({ userUuid, appPasswordId })

    expect(result.isFailed()).toBe(true)
  })

  it('should fail (ownership) if the app password belongs to another user', async () => {
    appPasswordRepository.findById = jest
      .fn()
      .mockResolvedValue(createAppPassword({ userUuid: '99999999-9999-9999-9999-999999999999' }))

    const result = await createUseCase().execute({ userUuid, appPasswordId })

    expect(result.isFailed()).toBe(true)
    expect(appPasswordRepository.save).not.toHaveBeenCalled()
    // Ownership failure must never hard-delete either.
    expect(appPasswordRepository.remove).not.toHaveBeenCalled()
  })

  it('should soft-revoke by stamping revoked_at and saving (not hard-deleting)', async () => {
    const result = await createUseCase().execute({ userUuid, appPasswordId })

    expect(result.isFailed()).toBe(false)
    expect(appPasswordRepository.save).toHaveBeenCalledTimes(1)
    expect(appPasswordRepository.remove).not.toHaveBeenCalled()
    const saved = (appPasswordRepository.save as jest.Mock).mock.calls[0][0] as AppPassword
    expect(saved.isRevoked()).toBe(true)
    expect(saved.props.revokedAt).toBeInstanceOf(Date)
  })

  it('should be idempotent for an already-revoked app password', async () => {
    const alreadyRevoked = createAppPassword({ revokedAt: new Date(Date.now() - 60_000) })
    appPasswordRepository.findById = jest.fn().mockResolvedValue(alreadyRevoked)

    const result = await createUseCase().execute({ userUuid, appPasswordId })

    expect(result.isFailed()).toBe(false)
    expect(appPasswordRepository.save).not.toHaveBeenCalled()
  })
})
