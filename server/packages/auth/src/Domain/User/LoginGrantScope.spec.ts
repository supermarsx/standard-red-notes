import { LoginGrantScope } from './LoginGrantScope'
import { SettingName, Uuid } from '@standardnotes/domain-core'
import { User } from './User'
import { SettingRepositoryInterface } from '../Setting/SettingRepositoryInterface'
import { AuthenticatorRepositoryInterface } from '../Authenticator/AuthenticatorRepositoryInterface'
import { Setting } from '../Setting/Setting'
import { Authenticator } from '../Authenticator/Authenticator'

describe('verified login grant scope', () => {
  const user = {
    uuid: '11111111-1111-4111-8111-111111111111',
    workspaceIdentifier: 'default',
    encryptedPassword: 'password-hash',
  } as User
  let factor: string | null
  let counter: number
  const settings = {
    findLastByNameAndUserUuid: jest.fn(async (name: string) =>
      name === SettingName.NAMES.MfaSecret && factor ? ({ props: { value: factor } } as Setting) : null,
    ),
  } as unknown as SettingRepositoryInterface
  const authenticators = {
    findByUserUuid: jest.fn(async () => [
      {
        props: { credentialId: new Uint8Array([1]), credentialPublicKey: new Uint8Array([2]), counter },
      } as Authenticator,
    ]),
  } as unknown as AuthenticatorRepositoryInterface
  const scope = new LoginGrantScope(settings, authenticators)
  beforeEach(() => {
    factor = null
    counter = 0
    jest.clearAllMocks()
  })
  it('binds grants to exact account, workspace, password and login flow', async () => {
    const original = await scope.key('challenge', user, 'login')
    for (const changed of [
      { ...user, uuid: '22222222-2222-4222-8222-222222222222' },
      { ...user, workspaceIdentifier: 'other' },
      { ...user, encryptedPassword: 'changed-hash' },
    ]) {
      expect(await scope.key('challenge', changed as User, 'login')).not.toBe(original)
    }
    expect(await scope.key('challenge', user, 'recovery')).not.toBe(original)
    expect(authenticators.findByUserUuid).toHaveBeenCalledWith(Uuid.create(user.uuid).getValue())
  })
  it('invalidates both verified login and recovery grants after a full reset even if factor policy was empty', async () => {
    for (const flow of ['login', 'recovery'] as const) {
      expect(await scope.key('challenge', { ...user, authGeneration: 1 } as User, flow)).not.toBe(
        await scope.key('challenge', { ...user, authGeneration: 0 } as User, flow),
      )
    }
  })

  it('invalidates an earlier grant when TOTP is enabled or its secret changes', async () => {
    const before = await scope.key('challenge', user, 'login')
    factor = 'encrypted-totp-secret-1'
    const enabled = await scope.key('challenge', user, 'login')
    expect(enabled).not.toBe(before)
    factor = 'encrypted-totp-secret-2'
    expect(await scope.key('challenge', user, 'login')).not.toBe(enabled)
    expect(enabled).not.toContain('encrypted-totp-secret')
  })
  it('does not invalidate the policy just because a hardware factor counter advances', async () => {
    const before = await scope.key('challenge', user, 'login')
    counter++
    expect(await scope.key('challenge', user, 'login')).toBe(before)
  })
  it('fails closed if current factor state cannot be read', async () => {
    jest.spyOn(settings, 'findLastByNameAndUserUuid').mockRejectedValueOnce(new Error('database unavailable'))
    await expect(scope.key('challenge', user, 'login')).rejects.toThrow('database unavailable')
  })

  it('rejects invalid subjects and treats the absent workspace as the default workspace', async () => {
    await expect(scope.key('challenge', { ...user, uuid: 'invalid' } as User, 'login')).rejects.toThrow(
      'Invalid login grant account',
    )
    expect(await scope.key('challenge', { ...user, workspaceIdentifier: undefined } as unknown as User, 'login')).toBe(
      await scope.key('challenge', user, 'login'),
    )
  })

  it('invalidates grants when hardware factors are removed', async () => {
    const before = await scope.key('challenge', user, 'login')
    ;(authenticators.findByUserUuid as jest.Mock).mockResolvedValueOnce([])
    expect(await scope.key('challenge', user, 'login')).not.toBe(before)
  })

  it('normalizes hardware factor ordering so repository ordering cannot break a valid grant', async () => {
    const devices = [
      { props: { credentialId: new Uint8Array([1]), credentialPublicKey: new Uint8Array([2]) } },
      { props: { credentialId: new Uint8Array([3]), credentialPublicKey: new Uint8Array([4]) } },
    ] as Authenticator[]
    ;(authenticators.findByUserUuid as jest.Mock)
      .mockResolvedValueOnce(devices)
      .mockResolvedValueOnce([...devices].reverse())
    expect(await scope.key('challenge', user, 'login')).toBe(await scope.key('challenge', user, 'login'))
  })
})
