import { PureCryptoInterface } from '@standardnotes/sncrypto-common'
import { EncryptionProviderInterface } from '@standardnotes/services'

import { SettingsClientInterface } from '@Lib/Services/Settings/SettingsClientInterface'
import { EnableAccountRecovery } from './EnableAccountRecovery'
import { DisableAccountRecovery } from './DisableAccountRecovery'
import { GetAccountRecoveryStatus } from './GetAccountRecoveryStatus'
import { RecoverAccount } from './RecoverAccount'

/**
 * A minimal, deterministic crypto fake. argon2 maps (password,salt) -> a stable
 * "key" string; xchacha20Encrypt prepends that key + nonce so decryption only
 * succeeds when the SAME derived key and nonce are presented. This lets us prove
 * the escrow round-trip works AND that a wrong recovery code fails to decrypt.
 */
class FakeCrypto implements Partial<PureCryptoInterface> {
  private counter = 0

  generateRandomKey(bits: number): string {
    this.counter += 1
    return `rnd-${bits}-${this.counter}`
  }

  argon2(password: string, salt: string, _i: number, _m: number, _l: number): string {
    return `argon(${password}|${salt})`
  }

  xchacha20Encrypt(plaintext: string, nonce: string, key: string): string {
    // Base64-encode so the ciphertext is opaque (no plaintext substrings),
    // mirroring the real AEAD's confidentiality property.
    return Buffer.from(JSON.stringify({ key, nonce, plaintext })).toString('base64')
  }

  xchacha20Decrypt(ciphertext: string, nonce: string, key: string): string | null {
    let parsed: { key: string; nonce: string; plaintext: string }
    try {
      parsed = JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf8'))
    } catch (_error) {
      return null
    }
    if (parsed.key !== key || parsed.nonce !== nonce) {
      return null
    }
    return parsed.plaintext
  }
}

const makeKeyParams = () => ({
  identifier: 'user@example.com',
  content004: { identifier: 'user@example.com' },
  getPortableValue: () => ({ identifier: 'user@example.com', pw_nonce: 'nonce', version: '004' }),
})

describe('AccountRecovery (Standard Red Notes opt-in escrow)', () => {
  let crypto: PureCryptoInterface
  let encryption: EncryptionProviderInterface
  let settings: SettingsClientInterface
  let store: Record<string, string | undefined>

  beforeEach(() => {
    crypto = new FakeCrypto() as unknown as PureCryptoInterface

    encryption = {} as jest.Mocked<EncryptionProviderInterface>
    encryption.getRootKeyParams = jest.fn().mockReturnValue(makeKeyParams())
    encryption.computeRootKey = jest.fn().mockResolvedValue({ masterKey: 'the-master-key' })

    store = {}
    settings = {} as jest.Mocked<SettingsClientInterface>
    settings.updateAccountRecoveryEscrow = jest.fn().mockImplementation(async (value: string) => {
      store.escrow = value
    })
    settings.getAccountRecoveryEscrow = jest.fn().mockImplementation(async () => store.escrow)
    settings.deleteAccountRecoveryEscrow = jest.fn().mockImplementation(async () => {
      delete store.escrow
    })
  })

  describe('default-off behavior', () => {
    it('reports recovery as DISABLED when no escrow exists (the default)', async () => {
      const status = await new GetAccountRecoveryStatus(settings).execute()
      expect(status.getValue()).toBe(false)
    })

    it('never touches the server / creates an escrow unless explicitly enabled', async () => {
      await new GetAccountRecoveryStatus(settings).execute()
      expect(settings.updateAccountRecoveryEscrow).not.toHaveBeenCalled()
    })
  })

  describe('enable', () => {
    it('requires the account password', async () => {
      const result = await new EnableAccountRecovery(encryption, settings, crypto).execute({ password: '' })
      expect(result.isFailed()).toBe(true)
      expect(settings.updateAccountRecoveryEscrow).not.toHaveBeenCalled()
    })

    it('returns a recovery code and escrows only ciphertext (no plaintext master key)', async () => {
      const result = await new EnableAccountRecovery(encryption, settings, crypto).execute({ password: 'pw' })

      expect(result.isFailed()).toBe(false)
      const recoveryCode = result.getValue()
      expect(recoveryCode.length).toBeGreaterThan(0)

      expect(settings.updateAccountRecoveryEscrow).toHaveBeenCalledTimes(1)
      // The stored blob must NOT contain the plaintext master key.
      expect(store.escrow).toBeDefined()
      expect(store.escrow).not.toContain('the-master-key')
    })

    it('marks recovery as enabled afterwards', async () => {
      await new EnableAccountRecovery(encryption, settings, crypto).execute({ password: 'pw' })
      const status = await new GetAccountRecoveryStatus(settings).execute()
      expect(status.getValue()).toBe(true)
    })
  })

  describe('recover (round-trip)', () => {
    it('recovers the master key with the correct recovery code', async () => {
      const enableResult = await new EnableAccountRecovery(encryption, settings, crypto).execute({ password: 'pw' })
      const recoveryCode = enableResult.getValue()

      const recovered = new RecoverAccount(crypto).decryptEscrow(store.escrow as string, recoveryCode)
      expect(recovered.isFailed()).toBe(false)
      expect(recovered.getValue().masterKey).toBe('the-master-key')
    })

    it('fails with an incorrect recovery code (server alone cannot decrypt)', async () => {
      await new EnableAccountRecovery(encryption, settings, crypto).execute({ password: 'pw' })

      const recovered = new RecoverAccount(crypto).decryptEscrow(store.escrow as string, 'wrong-code')
      expect(recovered.isFailed()).toBe(true)
    })

    it('fails on a malformed escrow blob', async () => {
      const recovered = new RecoverAccount(crypto).decryptEscrow('not-json', 'any')
      expect(recovered.isFailed()).toBe(true)
    })
  })

  describe('disable', () => {
    it('deletes the escrow and returns recovery to disabled', async () => {
      await new EnableAccountRecovery(encryption, settings, crypto).execute({ password: 'pw' })
      expect((await new GetAccountRecoveryStatus(settings).execute()).getValue()).toBe(true)

      const disableResult = await new DisableAccountRecovery(settings).execute()
      expect(disableResult.isFailed()).toBe(false)
      expect(settings.deleteAccountRecoveryEscrow).toHaveBeenCalledTimes(1)

      expect((await new GetAccountRecoveryStatus(settings).execute()).getValue()).toBe(false)
    })
  })
})
