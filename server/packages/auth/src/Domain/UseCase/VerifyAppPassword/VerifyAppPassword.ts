import * as bcrypt from 'bcryptjs'
import { Result, UseCaseInterface, Username, Uuid } from '@standardnotes/domain-core'

import { AppPasswordRepositoryInterface } from '../../AppPassword/AppPasswordRepositoryInterface'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { VerifyAppPasswordDTO } from './VerifyAppPasswordDTO'

/**
 * Standard Red Notes: verifies an app-specific password presented during sign-in.
 *
 * SECURITY: This use case is the ONLY thing that allows the interactive 2FA/MFA
 * challenge to be satisfied without a TOTP/U2F/magic-link factor. It MUST fail
 * closed:
 *  - It only ever returns Result.ok(true) when a presented secret matches the
 *    bcrypt hash of one of the user's stored app passwords (constant-time
 *    compare via bcrypt.compare).
 *  - Any error, missing user, empty input, or non-match returns Result.ok(false)
 *    (or Result.fail), which the caller MUST treat as "no bypass" and fall
 *    through to the normal MFA enforcement. A wrong app password therefore
 *    behaves exactly like a failed/absent MFA factor and never grants access on
 *    its own.
 *
 * NOTE: An app password only affects server-side authentication / the 2FA gate.
 * It does NOT derive or grant the account's end-to-end encryption key, which is
 * derived client-side from the real account password.
 */
export class VerifyAppPassword implements UseCaseInterface<boolean> {
  constructor(
    private appPasswordRepository: AppPasswordRepositoryInterface,
    private userRepository: UserRepositoryInterface,
  ) {}

  async execute(dto: VerifyAppPasswordDTO): Promise<Result<boolean>> {
    if (typeof dto.appPassword !== 'string' || dto.appPassword.length === 0) {
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

    const appPasswords = await this.appPasswordRepository.findByUserUuid(userUuid)
    if (appPasswords.length === 0) {
      return Result.ok(false)
    }

    let matchedId: string | null = null
    for (const appPassword of appPasswords) {
      // bcrypt.compare is a constant-time comparison for a given hash.
      const matches = await bcrypt.compare(dto.appPassword, appPassword.props.hashedPassword)
      if (matches) {
        matchedId = appPassword.id.toString()
        break
      }
    }

    if (matchedId === null) {
      return Result.ok(false)
    }

    // Best-effort bookkeeping; never let it affect the auth decision.
    try {
      const matched = appPasswords.find((appPassword) => appPassword.id.toString() === matchedId)
      if (matched) {
        await this.appPasswordRepository.updateLastUsedAt(matched.id, new Date())
      }
    } catch {
      // Intentionally ignored: failing to record last-used time must not block sign-in.
    }

    return Result.ok(true)
  }
}
