import { ProtocolVersion } from '@standardnotes/common'
import { Result } from '@standardnotes/domain-core'
import { CreateNewRootKey } from '@standardnotes/encryption'
import { RootKeyInterface } from '@standardnotes/models'
import { UuidGenerator } from '@standardnotes/utils'

import { DisableAccountRecovery } from './DisableAccountRecovery'
import { EnableAccountRecovery } from './EnableAccountRecovery'
import { GetAccountRecoveryStatus } from './GetAccountRecoveryStatus'
import { RecoverAccount } from './RecoverAccount'
import {
  accountRecoveryAssociatedData,
  parseAccountRecoveryEnvelope,
  parseAccountRecoverySecret,
  parseRecoveryCode,
} from './AccountRecoveryEscrowTypes'

class TestCrypto {
  private counter = 0

  generateRandomKey(bits: number): string {
    this.counter += 1
    return String(this.counter % 10).repeat(bits / 4)
  }

  argon2(password: string, salt: string): string {
    return Buffer.from(`${password}:${salt}`).toString('hex').slice(0, 64).padEnd(64, '0')
  }

  xchacha20Encrypt(plaintext: string, nonce: string, key: string, assocData?: string): string {
    return Buffer.from(JSON.stringify({ plaintext, nonce, key, assocData })).toString('base64')
  }

  xchacha20Decrypt(ciphertext: string, nonce: string, key: string, assocData?: string): string | null {
    try {
      const decoded = JSON.parse(Buffer.from(ciphertext, 'base64').toString()) as Record<string, string>
      return decoded.nonce === nonce && decoded.key === key && decoded.assocData === assocData
        ? decoded.plaintext
        : null
    } catch {
      return null
    }
  }
}

const userUuid = '123e4567-e89b-42d3-a456-426614174000'
const identifier = 'person@example.com'
const workspaceIdentifier = 'team-a'
const keyParams = {
  version: ProtocolVersion.V004,
  identifier,
  pw_nonce: 'nonce',
  created: '1700000000',
  origination: 'registration',
}
const encryptionKeyPair = { publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64) }
const signingKeyPair = { publicKey: 'c'.repeat(64), privateKey: 'd'.repeat(64) }

const rootKey = {
  keyVersion: ProtocolVersion.V004,
  masterKey: 'master-key',
  serverPassword: 'server-password',
  dataAuthenticationKey: undefined,
  keyParams: { getPortableValue: () => keyParams },
  encryptionKeyPair,
  signingKeyPair,
}

describe('AccountRecovery v2', () => {
  let crypto: TestCrypto
  let storedEscrow: string | undefined
  let settings: {
    getAccountRecoveryEscrow: jest.Mock
    updateAccountRecoveryEscrow: jest.Mock
    deleteAccountRecoveryEscrow: jest.Mock
  }
  let encryption: { validateAccountPassword: jest.Mock }
  let sessions: { getSureUser: jest.Mock }

  const enable = () =>
    new EnableAccountRecovery(encryption as never, settings as never, crypto as never, sessions as never)

  beforeEach(() => {
    UuidGenerator.SetGenerator(() => 'recovered-root-key-uuid')
    crypto = new TestCrypto()
    storedEscrow = undefined
    settings = {
      getAccountRecoveryEscrow: jest.fn(async () => storedEscrow),
      updateAccountRecoveryEscrow: jest.fn(async (value: string) => {
        storedEscrow = value
      }),
      deleteAccountRecoveryEscrow: jest.fn(async () => {
        storedEscrow = undefined
      }),
    }
    encryption = {
      validateAccountPassword: jest.fn().mockResolvedValue({ valid: true, artifacts: { rootKey } }),
    }
    sessions = { getSureUser: jest.fn().mockReturnValue({ uuid: userUuid }) }
  })

  it('is off by default and distinguishes legacy ciphertext from valid v2 enrollment', async () => {
    await expect(new GetAccountRecoveryStatus(settings as never).execute()).resolves.toMatchObject({
      value: 'disabled',
    })

    storedEscrow = JSON.stringify({ version: 1, ciphertext: 'YQ==' })
    expect((await new GetAccountRecoveryStatus(settings as never).execute()).getValue()).toBe('legacy')

    const enrolled = await enable().execute({ password: 'correct password' })
    expect(enrolled.isFailed()).toBe(false)
    expect((await new GetAccountRecoveryStatus(settings as never).execute()).getValue()).toBe('enabled')
  })

  it('validates the active password before storing a full root-key v2 envelope', async () => {
    const result = await enable().execute({ password: 'correct password' })

    expect(encryption.validateAccountPassword).toHaveBeenCalledWith('correct password')
    expect(settings.updateAccountRecoveryEscrow).toHaveBeenCalledTimes(1)
    const code = parseRecoveryCode(result.getValue())
    expect(code).toEqual({ userUuid, secret: '1'.repeat(64) })

    const envelope = parseAccountRecoveryEnvelope(storedEscrow as string, userUuid)
    expect(envelope).toBeDefined()
    const wrappingKey = crypto.argon2(code!.secret, envelope!.salt)
    const plaintext = crypto.xchacha20Decrypt(
      envelope!.ciphertext,
      envelope!.nonce,
      wrappingKey,
      accountRecoveryAssociatedData(userUuid),
    )
    expect(parseAccountRecoverySecret(plaintext as string)).toEqual({
      version: ProtocolVersion.V004,
      masterKey: 'master-key',
      serverPassword: 'server-password',
      keyParams,
      encryptionKeyPair,
      signingKeyPair,
    })
  })

  it('never stores escrow when password validation fails', async () => {
    encryption.validateAccountPassword.mockResolvedValue({ valid: false })

    const result = await enable().execute({ password: 'wrong' })

    expect(result.isFailed()).toBe(true)
    expect(settings.updateAccountRecoveryEscrow).not.toHaveBeenCalled()
  })

  it('never validates or stores escrow when the password is missing', async () => {
    const result = await enable().execute({ password: '' })

    expect(result.isFailed()).toBe(true)
    expect(encryption.validateAccountPassword).not.toHaveBeenCalled()
    expect(settings.updateAccountRecoveryEscrow).not.toHaveBeenCalled()
  })

  it('binds ciphertext to v2 and the account UUID and rejects unknown fields before recovery', async () => {
    await enable().execute({ password: 'correct password' })
    const envelope = JSON.parse(storedEscrow as string)

    expect(parseAccountRecoveryEnvelope(JSON.stringify({ ...envelope, extra: true }), userUuid)).toBeUndefined()
    expect(
      parseAccountRecoveryEnvelope(
        JSON.stringify({ ...envelope, userUuid: '223e4567-e89b-42d3-a456-426614174000' }),
        userUuid,
      ),
    ).toBeUndefined()
    expect(parseRecoveryCode(`SRN-RECOVERY-V2.${userUuid}.${'z'.repeat(64)}`)).toBeUndefined()
  })

  it('deletes both legacy and v2 escrow explicitly', async () => {
    storedEscrow = JSON.stringify({ version: 1 })

    expect(
      (
        await new DisableAccountRecovery(settings as never, encryption as never).execute({
          password: 'correct password',
        })
      ).isFailed(),
    ).toBe(false)
    expect(settings.deleteAccountRecoveryEscrow).toHaveBeenCalledTimes(1)
    expect((await new GetAccountRecoveryStatus(settings as never).execute()).getValue()).toBe('disabled')
  })

  it.each([
    ['missing password', '', { valid: true }],
    ['wrong password', 'wrong password', { valid: false }],
  ])('does not delete escrow with a %s', async (_case, password, validation) => {
    storedEscrow = JSON.stringify({ version: 1 })
    encryption.validateAccountPassword.mockResolvedValue(validation)

    const result = await new DisableAccountRecovery(settings as never, encryption as never).execute({ password })

    expect(result.isFailed()).toBe(true)
    expect(settings.deleteAccountRecoveryEscrow).not.toHaveBeenCalled()
  })

  describe('logged-out orchestration', () => {
    const successfulSignIn = { status: 200, data: { session: {}, user: {} } }

    async function createRecoveryFixture() {
      const enrolled = await enable().execute({ password: 'correct password' })
      const parsedCode = parseRecoveryCode(enrolled.getValue())
      const parsedEnvelope = parseAccountRecoveryEnvelope(storedEscrow as string, userUuid)
      expect(parsedCode).toBeDefined()
      expect(parsedEnvelope).toBeDefined()
      const plaintext = crypto.xchacha20Decrypt(
        parsedEnvelope!.ciphertext,
        parsedEnvelope!.nonce,
        crypto.argon2(parsedCode!.secret, parsedEnvelope!.salt),
        accountRecoveryAssociatedData(userUuid),
      )
      const parsedSecret = parseAccountRecoverySecret(plaintext as string)
      expect(parsedSecret).toBeDefined()
      expect(CreateNewRootKey<RootKeyInterface>(parsedSecret!).keyParams.identifier).toBe(identifier)
      return { recoveryCode: enrolled.getValue(), escrow: storedEscrow as string }
    }

    it('uses the looked-up workspace, normal sign-in wrapper, shared rotation, and fresh enrollment', async () => {
      const fixture = await createRecoveryFixture()
      const auth = {
        accountRecoveryLookup: jest.fn().mockResolvedValue({ escrow: fixture.escrow, identifier, workspaceIdentifier }),
      }
      const users = {
        isSignedIn: jest.fn().mockReturnValue(false),
        signInWithRecoveryRootKey: jest.fn().mockResolvedValue(successfulSignIn),
        changeCredentialsUsingProvenRootKey: jest.fn().mockResolvedValue({}),
      }
      const freshEnrollment = { execute: jest.fn().mockResolvedValue(Result.ok('fresh-one-time-code')) }
      const recovery = new RecoverAccount(crypto as never, auth as never, users as never, freshEnrollment as never)

      const result = await recovery.execute({
        recoveryCode: fixture.recoveryCode,
        newPassword: 'strong new password',
        newPasswordConfirmation: 'strong new password',
        mergeLocal: false,
      })

      expect(result.getValue()).toEqual({
        signedIn: true,
        passwordReset: true,
        recoveryCode: 'fresh-one-time-code',
      })
      expect(users.signInWithRecoveryRootKey).toHaveBeenCalledWith(
        identifier,
        expect.objectContaining({ masterKey: 'master-key', serverPassword: 'server-password' }),
        workspaceIdentifier,
        false,
        true,
      )
      expect(users.changeCredentialsUsingProvenRootKey).toHaveBeenCalledWith({
        currentRootKey: expect.objectContaining({ masterKey: 'master-key' }),
        newPassword: 'strong new password',
      })
      expect(freshEnrollment.execute).toHaveBeenCalledWith({ password: 'strong new password' })
    })

    it('rejects invalid shape and weak/mismatched passwords before lookup or Argon2', async () => {
      const auth = { accountRecoveryLookup: jest.fn() }
      const users = { isSignedIn: jest.fn().mockReturnValue(false) }
      const recovery = new RecoverAccount(crypto as never, auth as never, users as never, {} as never)
      const argonSpy = jest.spyOn(crypto, 'argon2')

      expect(
        (
          await recovery.execute({
            recoveryCode: 'not-a-code',
            newPassword: 'short',
            newPasswordConfirmation: 'short',
            mergeLocal: true,
          })
        ).isFailed(),
      ).toBe(true)
      expect(
        (
          await recovery.execute({
            recoveryCode: 'not-a-code',
            newPassword: 'strong password',
            newPasswordConfirmation: 'different password',
            mergeLocal: true,
          })
        ).isFailed(),
      ).toBe(true)
      expect(auth.accountRecoveryLookup).not.toHaveBeenCalled()
      expect(argonSpy).not.toHaveBeenCalled()
    })

    it('reports signed-in/password-reset partial states without claiming full success', async () => {
      const fixture = await createRecoveryFixture()
      const auth = {
        accountRecoveryLookup: jest.fn().mockResolvedValue({ escrow: fixture.escrow, identifier, workspaceIdentifier }),
      }
      const users = {
        isSignedIn: jest.fn().mockReturnValue(false),
        signInWithRecoveryRootKey: jest.fn().mockResolvedValue(successfulSignIn),
        changeCredentialsUsingProvenRootKey: jest.fn().mockResolvedValue({ error: Error('rotation failed') }),
      }
      const freshEnrollment = { execute: jest.fn() }
      const recovery = new RecoverAccount(crypto as never, auth as never, users as never, freshEnrollment as never)

      const result = await recovery.execute({
        recoveryCode: fixture.recoveryCode,
        newPassword: 'strong new password',
        newPasswordConfirmation: 'strong new password',
        mergeLocal: true,
      })

      expect(result.getValue()).toEqual({
        signedIn: true,
        passwordReset: false,
        passwordResetError: 'rotation failed',
      })
      expect(freshEnrollment.execute).not.toHaveBeenCalled()

      users.changeCredentialsUsingProvenRootKey.mockResolvedValue({})
      freshEnrollment.execute.mockResolvedValue(Result.fail('reenrollment failed'))
      const reenrollment = await recovery.execute({
        recoveryCode: fixture.recoveryCode,
        newPassword: 'strong new password',
        newPasswordConfirmation: 'strong new password',
        mergeLocal: true,
      })
      expect(reenrollment.getValue()).toEqual({
        signedIn: true,
        passwordReset: true,
        reenrollmentError: 'reenrollment failed',
      })
    })

    it('fails before lookup when invoked from an existing signed-in account', async () => {
      const auth = { accountRecoveryLookup: jest.fn() }
      const users = { isSignedIn: jest.fn().mockReturnValue(true) }
      const recovery = new RecoverAccount(crypto as never, auth as never, users as never, {} as never)

      const result = await recovery.execute({
        recoveryCode: `SRN-RECOVERY-V2.${userUuid}.${'1'.repeat(64)}`,
        newPassword: 'strong new password',
        newPasswordConfirmation: 'strong new password',
        mergeLocal: true,
      })

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toMatch(/sign out/i)
      expect(auth.accountRecoveryLookup).not.toHaveBeenCalled()
    })

    it('turns transport and rotation exceptions into bounded outcomes', async () => {
      const fixture = await createRecoveryFixture()
      const auth = { accountRecoveryLookup: jest.fn().mockRejectedValue(new Error('internal details')) }
      const users = { isSignedIn: jest.fn().mockReturnValue(false) }
      const recovery = new RecoverAccount(crypto as never, auth as never, users as never, {} as never)
      const dto = {
        recoveryCode: fixture.recoveryCode,
        newPassword: 'strong new password',
        newPasswordConfirmation: 'strong new password',
        mergeLocal: true,
      }

      const lookupFailure = await recovery.execute(dto)
      expect(lookupFailure.getError()).toBe('Account recovery is unavailable.')

      auth.accountRecoveryLookup.mockResolvedValue({
        escrow: fixture.escrow,
        identifier,
        workspaceIdentifier,
      })
      Object.assign(users, {
        signInWithRecoveryRootKey: jest.fn().mockResolvedValue(successfulSignIn),
        changeCredentialsUsingProvenRootKey: jest.fn().mockRejectedValue(new Error('internal details')),
      })
      const rotationFailure = await recovery.execute(dto)
      expect(rotationFailure.getValue()).toEqual({
        signedIn: true,
        passwordReset: false,
        passwordResetError: 'The password change could not be completed.',
      })
    })
  })
})
