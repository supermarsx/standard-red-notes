import { Result, UseCaseInterface } from '@standardnotes/domain-core'
import { CreateNewRootKey } from '@standardnotes/encryption'
import { RootKeyInterface } from '@standardnotes/models'
import { getErrorFromErrorResponse, isErrorResponse } from '@standardnotes/responses'
import { PureCryptoInterface } from '@standardnotes/sncrypto-common'
import { AuthClientInterface, UserServiceInterface } from '@standardnotes/services'

import {
  RECOVERY_ARGON_ITERATIONS,
  RECOVERY_ARGON_MEMORY_BYTES,
  RECOVERY_ARGON_OUTPUT_BYTES,
  accountRecoveryAssociatedData,
  parseAccountRecoveryEnvelope,
  parseAccountRecoverySecret,
  parseRecoveryCode,
} from './AccountRecoveryEscrowTypes'
import { EnableAccountRecovery } from './EnableAccountRecovery'

export interface RecoverAccountResult {
  signedIn: boolean
  passwordReset: boolean
  recoveryCode?: string
  passwordResetError?: string
  reenrollmentError?: string
}

/**
 * Completes recovery through the ordinary authenticated session and crash-safe
 * credential-rotation paths. There is deliberately no password-reset bypass.
 */
export class RecoverAccount implements UseCaseInterface<RecoverAccountResult> {
  private readonly MINIMUM_PASSWORD_LENGTH = 8

  constructor(
    private crypto: PureCryptoInterface,
    private auth: AuthClientInterface,
    private users: UserServiceInterface,
    private enableAccountRecovery: EnableAccountRecovery,
  ) {}

  async execute(dto: {
    recoveryCode: string
    newPassword: string
    newPasswordConfirmation: string
    mergeLocal: boolean
  }): Promise<Result<RecoverAccountResult>> {
    if (this.users.isSignedIn()) {
      return Result.fail('Sign out before starting account recovery.')
    }
    if (dto.newPassword !== dto.newPasswordConfirmation) {
      return Result.fail('The new password and confirmation do not match.')
    }
    if (dto.newPassword.length < this.MINIMUM_PASSWORD_LENGTH) {
      return Result.fail(`The new password must contain at least ${this.MINIMUM_PASSWORD_LENGTH} characters.`)
    }

    const parsedCode = parseRecoveryCode(dto.recoveryCode.trim())
    if (!parsedCode) {
      return Result.fail('The account recovery code is invalid.')
    }

    let lookup
    try {
      lookup = await this.auth.accountRecoveryLookup({ userUuid: parsedCode.userUuid })
    } catch {
      return Result.fail('Account recovery is unavailable.')
    }
    if (!lookup) {
      return Result.fail('Account recovery is unavailable.')
    }
    const envelope = parseAccountRecoveryEnvelope(lookup.escrow, parsedCode.userUuid)
    if (!envelope) {
      return Result.fail('Account recovery is unavailable.')
    }

    let decrypted: string | null
    try {
      const wrappingKey = this.crypto.argon2(
        parsedCode.secret,
        envelope.salt,
        RECOVERY_ARGON_ITERATIONS,
        RECOVERY_ARGON_MEMORY_BYTES,
        RECOVERY_ARGON_OUTPUT_BYTES,
      )
      decrypted = this.crypto.xchacha20Decrypt(
        envelope.ciphertext,
        envelope.nonce,
        wrappingKey,
        accountRecoveryAssociatedData(parsedCode.userUuid),
      )
    } catch {
      return Result.fail('The account recovery code is invalid.')
    }
    if (decrypted === null) {
      return Result.fail('The account recovery code is invalid.')
    }

    const secret = parseAccountRecoverySecret(decrypted)
    if (!secret) {
      return Result.fail('Account recovery is unavailable.')
    }
    let recoveredRootKey: RootKeyInterface
    try {
      recoveredRootKey = CreateNewRootKey<RootKeyInterface>(secret)
    } catch {
      return Result.fail('Account recovery is unavailable.')
    }
    if (recoveredRootKey.keyParams.identifier !== lookup.identifier) {
      return Result.fail('Account recovery is unavailable.')
    }

    let signInResponse
    try {
      signInResponse = await this.users.signInWithRecoveryRootKey(
        lookup.identifier,
        recoveredRootKey,
        lookup.workspaceIdentifier,
        dto.mergeLocal,
        true,
      )
    } catch {
      if (this.users.isSignedIn()) {
        return Result.ok({
          signedIn: true,
          passwordReset: false,
          passwordResetError: 'Account recovery signed in, but local account setup did not finish.',
        })
      }
      return Result.fail('Account recovery sign-in could not be completed.')
    }
    if (isErrorResponse(signInResponse)) {
      return Result.fail(getErrorFromErrorResponse(signInResponse).message)
    }

    let rotation
    try {
      rotation = await this.users.changeCredentialsUsingProvenRootKey({
        currentRootKey: recoveredRootKey,
        newPassword: dto.newPassword,
      })
    } catch {
      return Result.ok({
        signedIn: true,
        passwordReset: false,
        passwordResetError: 'The password change could not be completed.',
      })
    }
    if (rotation.error) {
      return Result.ok({
        signedIn: true,
        passwordReset: false,
        passwordResetError: rotation.error.message,
      })
    }

    let reenrollment
    try {
      reenrollment = await this.enableAccountRecovery.execute({ password: dto.newPassword })
    } catch {
      return Result.ok({
        signedIn: true,
        passwordReset: true,
        reenrollmentError: 'The password changed, but a fresh recovery code could not be created.',
      })
    }
    if (reenrollment.isFailed()) {
      return Result.ok({
        signedIn: true,
        passwordReset: true,
        reenrollmentError: reenrollment.getError(),
      })
    }

    return Result.ok({
      signedIn: true,
      passwordReset: true,
      recoveryCode: reenrollment.getValue(),
    })
  }
}
