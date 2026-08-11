import { KeySystemKeyManagerInterface } from '../KeySystem/KeySystemKeyManagerInterface'
import { VaultLockService } from './VaultLockService'

type TestVault = {
  uuid: string
  systemIdentifier: string
  isSharedVaultListing: () => boolean
}

const vault = (systemIdentifier: string, shared = true): TestVault => ({
  uuid: `listing-${systemIdentifier}`,
  systemIdentifier,
  isSharedVaultListing: () => shared,
})

describe('VaultLockService collaboration key boundary', () => {
  const createService = (rootKey: { systemIdentifier: string; key: string } | undefined) => {
    const keys = {
      getPrimaryKeySystemRootKey: jest.fn().mockReturnValue(rootKey),
    } as unknown as jest.Mocked<KeySystemKeyManagerInterface>
    const service = Object.create(VaultLockService.prototype) as VaultLockService
    ;(service as unknown as { keys: KeySystemKeyManagerInterface }).keys = keys
    jest.spyOn(service, 'isVaultLocked').mockReturnValue(false)
    return { service, keys }
  }

  it('returns the current root key for an unlocked private or shared vault', () => {
    const rootKey = { systemIdentifier: 'vault-a', key: 'client-only-secret' }
    const { service } = createService(rootKey)

    expect(service.getUnlockedVaultRootKey(vault('vault-a', false) as never)).toBe(rootKey)
    expect(service.getUnlockedVaultRootKey(vault('vault-a', true) as never)).toBe(rootKey)
    expect(service.getUnlockedSharedVaultRootKey(vault('vault-a') as never)).toBe(rootKey)
  })

  it('keeps the legacy shared-only boundary and fails closed for locked vaults', () => {
    const rootKey = { systemIdentifier: 'vault-a', key: 'client-only-secret' }
    const { service, keys } = createService(rootKey)

    expect(service.getUnlockedSharedVaultRootKey(vault('vault-a', false) as never)).toBeUndefined()
    expect(keys.getPrimaryKeySystemRootKey).not.toHaveBeenCalled()

    jest.mocked(service.isVaultLocked).mockReturnValue(true)
    expect(service.getUnlockedVaultRootKey(vault('vault-a') as never)).toBeUndefined()
  })

  it('rejects a root key returned for a different vault', () => {
    const { service } = createService({ systemIdentifier: 'vault-b', key: 'wrong-vault-secret' })

    expect(service.getUnlockedSharedVaultRootKey(vault('vault-a') as never)).toBeUndefined()
  })
})
