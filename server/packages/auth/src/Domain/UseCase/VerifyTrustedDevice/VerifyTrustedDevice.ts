import * as bcrypt from 'bcryptjs'
import { Result, UseCaseInterface, Username, Uuid } from '@standardnotes/domain-core'

import { TrustedDeviceRepositoryInterface } from '../../TrustedDevice/TrustedDeviceRepositoryInterface'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { VerifyTrustedDeviceDTO } from './VerifyTrustedDeviceDTO'

/**
 * Standard Red Notes: verifies a trusted-device token presented during the
 * login-params (2FA-gate) request.
 *
 * SECURITY: This use case allows the interactive 2FA/MFA challenge to be
 * satisfied without an interactive TOTP/U2F/magic-link factor, BUT ONLY the
 * second factor — the account password is still verified later in SignIn, and
 * the e2e encryption key is still derived client-side from the real account
 * password. It MUST fail closed:
 *  - Returns Result.ok(true) ONLY when a presented token matches the bcrypt
 *    hash of one of THIS user's NON-EXPIRED trusted devices (constant-time
 *    compare via bcrypt.compare).
 *  - Any error, missing user, empty input, expired device, or non-match returns
 *    Result.ok(false), which the caller MUST treat as "no bypass" and fall
 *    through to the normal MFA enforcement. A wrong/expired/revoked token
 *    therefore behaves exactly like an absent second factor and never grants
 *    access on its own.
 *  - Expiry is enforced here (isExpired) in addition to being honoured at the
 *    repository level, so a stale token never bypasses the second factor.
 *  - Revocation (row removal) takes effect immediately because the lookup hits
 *    the database on every sign-in.
 */
export class VerifyTrustedDevice implements UseCaseInterface<boolean> {
  constructor(
    private trustedDeviceRepository: TrustedDeviceRepositoryInterface,
    private userRepository: UserRepositoryInterface,
  ) {}

  async execute(dto: VerifyTrustedDeviceDTO): Promise<Result<boolean>> {
    if (typeof dto.deviceToken !== 'string' || dto.deviceToken.length === 0) {
      return Result.ok(false)
    }

    const usernameOrError = Username.create(dto.email, { skipValidation: true })
    if (usernameOrError.isFailed()) {
      return Result.ok(false)
    }
    const username = usernameOrError.getValue()

    const user = await this.userRepository.findOneByUsernameOrEmail(username)
    if (user === null) {
      return Result.ok(false)
    }

    const userUuidOrError = Uuid.create(user.uuid)
    if (userUuidOrError.isFailed()) {
      return Result.ok(false)
    }
    const userUuid = userUuidOrError.getValue()

    const trustedDevices = await this.trustedDeviceRepository.findByUserUuid(userUuid)
    if (trustedDevices.length === 0) {
      return Result.ok(false)
    }

    const now = new Date()

    let matched = null
    for (const trustedDevice of trustedDevices) {
      if (trustedDevice.isExpired(now)) {
        continue
      }

      // bcrypt.compare is a constant-time comparison for a given hash.
      const matches = await bcrypt.compare(dto.deviceToken, trustedDevice.props.hashedToken)
      if (matches) {
        matched = trustedDevice
        break
      }
    }

    if (matched === null) {
      return Result.ok(false)
    }

    // Best-effort bookkeeping; never let it affect the auth decision.
    try {
      matched.props.lastUsedAt = now
      await this.trustedDeviceRepository.save(matched)
    } catch {
      // Intentionally ignored: failing to record last-used time must not block sign-in.
    }

    return Result.ok(true)
  }
}
