import { Result, UniqueEntityId, UseCaseInterface } from '@standardnotes/domain-core'
import { v4 as uuidv4 } from 'uuid'

import { SignupInviteLink } from '../../SignupInvite/SignupInviteLink'
import { SignupInviteLinkRepositoryInterface } from '../../SignupInvite/SignupInviteLinkRepositoryInterface'
import {
  generateRawSignupInviteToken,
  hashSignupInviteToken,
} from '../../SignupInvite/hashSignupInviteToken'
import { isAssignableDefaultRole } from '../../Role/CanonicalRoles'
import { normalizeDomainList } from '../../Registration/RegistrationConfig'

import { CreateSignupInviteLinkDTO } from './CreateSignupInviteLinkDTO'

export const SIGNUP_INVITE_MAX_USES_CEILING = 100000

/**
 * Standard Red Notes: mint a signup invite link. Returns the created domain
 * entity together with the RAW token (returned exactly ONCE — never stored or
 * re-listed; only its SHA-256 hash is persisted).
 *
 * PRIVILEGE GUARD (no escalation): only ADMIN links may set a per-link role
 * override or an email-domain lock, and only admin links may auto-approve.
 * Self-serve USER links always yield the instance-default role, carry no domain
 * lock, and are forced auto_approve = false — so a referral invite can never
 * grant privilege or bypass the approval queue.
 */
export class CreateSignupInviteLink implements UseCaseInterface<{ link: SignupInviteLink; token: string }> {
  constructor(private inviteLinkRepository: SignupInviteLinkRepositoryInterface) {}

  async execute(dto: CreateSignupInviteLinkDTO): Promise<Result<{ link: SignupInviteLink; token: string }>> {
    const isAdmin = dto.creatorKind === 'admin'

    const rawMaxUses = dto.maxUses === undefined || dto.maxUses === null ? 1 : Number(dto.maxUses)
    if (!Number.isInteger(rawMaxUses) || rawMaxUses < 1 || rawMaxUses > SIGNUP_INVITE_MAX_USES_CEILING) {
      return Result.fail(`maxUses must be an integer between 1 and ${SIGNUP_INVITE_MAX_USES_CEILING}.`)
    }

    let expiresAt: Date | null = null
    if (dto.expiresInHours !== undefined && dto.expiresInHours !== null) {
      const hours = Number(dto.expiresInHours)
      if (!Number.isFinite(hours) || hours <= 0) {
        return Result.fail('expiresInHours must be a positive number, or null for never-expires.')
      }
      expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000)
    }

    // Privilege guard: only admin links may set a role override / domain lock.
    let defaultRole: string | null = null
    let allowedDomain: string | null = null
    if (isAdmin) {
      if (dto.defaultRole !== undefined && dto.defaultRole !== null && dto.defaultRole !== '') {
        if (!isAssignableDefaultRole(dto.defaultRole)) {
          return Result.fail(`Invalid default role '${dto.defaultRole}' (must be a non-admin assignable role).`)
        }
        defaultRole = dto.defaultRole
      }
      if (dto.allowedDomain !== undefined && dto.allowedDomain !== null && dto.allowedDomain !== '') {
        const normalized = normalizeDomainList([dto.allowedDomain])
        if (normalized.length !== 1) {
          return Result.fail(`Invalid allowed domain '${dto.allowedDomain}'.`)
        }
        allowedDomain = normalized[0]
      }
    } else {
      if (dto.defaultRole !== undefined && dto.defaultRole !== null && dto.defaultRole !== '') {
        return Result.fail('Self-serve invite links cannot set a role override.')
      }
      if (dto.allowedDomain !== undefined && dto.allowedDomain !== null && dto.allowedDomain !== '') {
        return Result.fail('Self-serve invite links cannot set an email-domain lock.')
      }
    }

    // Auto-approve: admin links honor the flag (default true); user links forced false.
    const autoApprove = isAdmin ? dto.autoApprove ?? true : false

    const label =
      typeof dto.label === 'string' && dto.label.trim().length > 0 ? dto.label.trim().slice(0, 255) : null

    const rawToken = generateRawSignupInviteToken()
    const hashedToken = hashSignupInviteToken(rawToken)
    const now = new Date()

    const linkOrError = SignupInviteLink.create(
      {
        hashedToken,
        label,
        maxUses: rawMaxUses,
        usedCount: 0,
        expiresAt,
        revoked: false,
        defaultRole,
        allowedDomain,
        createdBy: isAdmin ? dto.adminUuid ?? null : null,
        createdByUserUuid: isAdmin ? null : dto.creatorUserUuid ?? null,
        createdByKind: dto.creatorKind,
        autoApprove,
        createdAt: now,
        updatedAt: now,
      },
      new UniqueEntityId(uuidv4()),
    )
    if (linkOrError.isFailed()) {
      return Result.fail(linkOrError.getError())
    }
    const link = linkOrError.getValue()

    await this.inviteLinkRepository.save(link)

    return Result.ok({ link, token: rawToken })
  }
}
