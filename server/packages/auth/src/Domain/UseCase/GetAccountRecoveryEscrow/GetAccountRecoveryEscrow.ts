import { Result, SettingName, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import { SettingCrypterInterface } from '../../Setting/SettingCrypterInterface'
import { SettingRepositoryInterface } from '../../Setting/SettingRepositoryInterface'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

const MAX_ESCROW_JSON_LENGTH = 64 * 1024
const MAX_CIPHERTEXT_LENGTH = 48 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HEX_32_PATTERN = /^[0-9a-f]{32}$/i
const HEX_48_PATTERN = /^[0-9a-f]{48}$/i
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/
const ENVELOPE_FIELDS = ['version', 'userUuid', 'salt', 'nonce', 'ciphertext'].sort()
const MAX_ACCOUNT_IDENTIFIER_LENGTH = 255

export interface AccountRecoveryEscrowLookup {
  escrow: string
  identifier: string
  workspaceIdentifier: string
}

/**
 * Retrieves only a strictly bounded v2 client-ciphertext escrow by its
 * high-entropy UUID locator. The recovery secret and wrapping key never cross
 * this boundary.
 */
export class GetAccountRecoveryEscrow implements UseCaseInterface<AccountRecoveryEscrowLookup> {
  constructor(
    private settingRepository: SettingRepositoryInterface,
    private settingCrypter: SettingCrypterInterface,
    private userRepository: UserRepositoryInterface,
  ) {}

  async execute(dto: { userUuid: string }): Promise<Result<AccountRecoveryEscrowLookup>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail('Account recovery is unavailable.')
    }
    const userUuid = userUuidOrError.getValue()

    try {
      const [user, setting] = await Promise.all([
        this.userRepository.findOneByUuid(userUuid),
        this.settingRepository.findLastByNameAndUserUuid(SettingName.NAMES.AccountRecoveryEscrow, userUuid.value),
      ])
      if (user === null || setting === null) {
        return Result.fail('Account recovery is unavailable.')
      }

      const decryptedValue = await this.settingCrypter.decryptSettingValue(setting, userUuid.value)
      if (!this.isRecoverableV2Escrow(decryptedValue, userUuid.value)) {
        return Result.fail('Account recovery is unavailable.')
      }
      if (!this.isBoundedIdentifier(user.email) || !this.isBoundedIdentifier(user.workspaceIdentifier)) {
        return Result.fail('Account recovery is unavailable.')
      }

      return Result.ok({
        escrow: decryptedValue,
        identifier: user.email,
        workspaceIdentifier: user.workspaceIdentifier,
      })
    } catch {
      return Result.fail('Account recovery is unavailable.')
    }
  }

  private isRecoverableV2Escrow(value: string | null, expectedUserUuid: string): value is string {
    if (value === null || value.length === 0 || value.length > MAX_ESCROW_JSON_LENGTH) {
      return false
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      return false
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false
    }

    const envelope = parsed as Record<string, unknown>
    if (JSON.stringify(Object.keys(envelope).sort()) !== JSON.stringify(ENVELOPE_FIELDS)) {
      return false
    }

    return (
      envelope.version === 2 &&
      typeof envelope.userUuid === 'string' &&
      envelope.userUuid === expectedUserUuid &&
      UUID_PATTERN.test(envelope.userUuid) &&
      typeof envelope.salt === 'string' &&
      HEX_32_PATTERN.test(envelope.salt) &&
      typeof envelope.nonce === 'string' &&
      HEX_48_PATTERN.test(envelope.nonce) &&
      typeof envelope.ciphertext === 'string' &&
      envelope.ciphertext.length > 0 &&
      envelope.ciphertext.length <= MAX_CIPHERTEXT_LENGTH &&
      envelope.ciphertext.length % 4 === 0 &&
      BASE64_PATTERN.test(envelope.ciphertext)
    )
  }

  private isBoundedIdentifier(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= MAX_ACCOUNT_IDENTIFIER_LENGTH &&
      value.trim() === value
    )
  }
}
