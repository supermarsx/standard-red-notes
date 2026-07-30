import { SettingName, Timestamps, Uuid } from '@standardnotes/domain-core'

import { Setting } from '../../Setting/Setting'
import { SettingCrypterInterface } from '../../Setting/SettingCrypterInterface'
import { SettingRepositoryInterface } from '../../Setting/SettingRepositoryInterface'
import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { GetAccountRecoveryEscrow } from './GetAccountRecoveryEscrow'

const userUuid = '123e4567-e89b-42d3-a456-426614174000'
const envelope = JSON.stringify({
  version: 2,
  userUuid,
  salt: 'a'.repeat(32),
  nonce: 'b'.repeat(48),
  ciphertext: 'Y2lwaGVydGV4dA==',
})

describe('GetAccountRecoveryEscrow', () => {
  let settingRepository: jest.Mocked<SettingRepositoryInterface>
  let settingCrypter: jest.Mocked<SettingCrypterInterface>
  let userRepository: jest.Mocked<UserRepositoryInterface>
  let setting: Setting
  let user: User

  const createUseCase = () => new GetAccountRecoveryEscrow(settingRepository, settingCrypter, userRepository)

  beforeEach(() => {
    setting = Setting.create({
      name: SettingName.NAMES.AccountRecoveryEscrow,
      value: 'encrypted-at-rest',
      serverEncryptionVersion: 1,
      userUuid: Uuid.create(userUuid).getValue(),
      sensitive: false,
      timestamps: Timestamps.create(1, 1).getValue(),
    }).getValue()
    user = {
      uuid: userUuid,
      email: 'person@example.com',
      workspaceIdentifier: 'team-a',
    } as User

    settingRepository = {
      findLastByNameAndUserUuid: jest.fn().mockResolvedValue(setting),
    } as unknown as jest.Mocked<SettingRepositoryInterface>
    settingCrypter = {
      decryptSettingValue: jest.fn().mockResolvedValue(envelope),
    } as unknown as jest.Mocked<SettingCrypterInterface>
    userRepository = {
      findOneByUuid: jest.fn().mockResolvedValue(user),
    } as unknown as jest.Mocked<UserRepositoryInterface>
  })

  it('returns the opaque v2 envelope and account routing identifiers', async () => {
    const result = await createUseCase().execute({ userUuid })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toEqual({
      escrow: envelope,
      identifier: 'person@example.com',
      workspaceIdentifier: 'team-a',
    })
    expect(settingRepository.findLastByNameAndUserUuid).toHaveBeenCalledWith(
      SettingName.NAMES.AccountRecoveryEscrow,
      userUuid,
    )
    expect(settingCrypter.decryptSettingValue).toHaveBeenCalledWith(setting, userUuid)
  })

  it.each([
    ['invalid UUID', 'not-a-uuid', envelope],
    ['missing escrow', userUuid, null],
    ['legacy v1 escrow', userUuid, JSON.stringify({ version: 1, ciphertext: 'YQ==' })],
    ['unknown version', userUuid, JSON.stringify({ ...JSON.parse(envelope), version: 3 })],
    ['unknown field', userUuid, JSON.stringify({ ...JSON.parse(envelope), extra: true })],
    ['wrong salt type', userUuid, JSON.stringify({ ...JSON.parse(envelope), salt: 1 })],
    ['wrong nonce length', userUuid, JSON.stringify({ ...JSON.parse(envelope), nonce: 'b'.repeat(46) })],
    ['invalid base64', userUuid, JSON.stringify({ ...JSON.parse(envelope), ciphertext: '*'.repeat(4) })],
    [
      'swapped UUID',
      userUuid,
      JSON.stringify({ ...JSON.parse(envelope), userUuid: '223e4567-e89b-42d3-a456-426614174000' }),
    ],
    ['malformed JSON', userUuid, '{'],
    ['oversized JSON', userUuid, 'x'.repeat(64 * 1024 + 1)],
    [
      'oversized ciphertext',
      userUuid,
      JSON.stringify({ ...JSON.parse(envelope), ciphertext: 'YWFh'.repeat(12 * 1024 + 1) }),
    ],
  ])('returns the same generic failure for %s', async (_case, locator, storedEnvelope) => {
    settingCrypter.decryptSettingValue.mockResolvedValue(storedEnvelope)

    const result = await createUseCase().execute({ userUuid: locator })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Account recovery is unavailable.')
  })

  it('uses the same generic failure for an absent user or setting and decryption errors', async () => {
    userRepository.findOneByUuid.mockResolvedValueOnce(null)
    expect((await createUseCase().execute({ userUuid })).getError()).toBe('Account recovery is unavailable.')

    userRepository.findOneByUuid.mockResolvedValueOnce(user)
    settingRepository.findLastByNameAndUserUuid.mockResolvedValueOnce(null)
    expect((await createUseCase().execute({ userUuid })).getError()).toBe('Account recovery is unavailable.')

    settingCrypter.decryptSettingValue.mockRejectedValueOnce(new Error('at-rest decryption failed'))
    expect((await createUseCase().execute({ userUuid })).getError()).toBe('Account recovery is unavailable.')
  })

  it.each([
    ['empty workspace', 'workspaceIdentifier', ''],
    ['oversized workspace', 'workspaceIdentifier', 'w'.repeat(256)],
    ['padded workspace', 'workspaceIdentifier', ' team-a '],
    ['empty account identifier', 'email', ''],
    ['oversized account identifier', 'email', 'e'.repeat(256)],
  ])('fails generically for an invalid %s', async (_case, field, value) => {
    user = { ...user, [field]: value } as User
    userRepository.findOneByUuid.mockResolvedValue(user)

    const result = await createUseCase().execute({ userUuid })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Account recovery is unavailable.')
  })
})
