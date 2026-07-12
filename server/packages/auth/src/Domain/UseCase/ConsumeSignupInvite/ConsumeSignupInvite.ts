import { UniqueEntityId } from '@standardnotes/domain-core'
import { v4 as uuidv4 } from 'uuid'

import { UseCaseInterface } from '../UseCaseInterface'
import { SignupInviteLinkRepositoryInterface } from '../../SignupInvite/SignupInviteLinkRepositoryInterface'
import { SignupInviteUseRepositoryInterface } from '../../SignupInvite/SignupInviteUseRepositoryInterface'
import { SignupInviteUse } from '../../SignupInvite/SignupInviteUse'
import { hashSignupInviteToken } from '../../SignupInvite/hashSignupInviteToken'
import { domainMatchesList, emailDomain } from '../../Registration/RegistrationConfig'

import { ConsumeSignupInviteDTO } from './ConsumeSignupInviteDTO'
import { ConsumeSignupInviteResponse } from './ConsumeSignupInviteResponse'

/**
 * Standard Red Notes: consumes ONE signup-invite slot atomically, applying the
 * link's per-link policy (role override, email-domain lock, auto-approve,
 * referrer attribution). The atomic slot take lives in the repository's
 * conditional UPDATE (see consumeSlot); this use case adds the metadata read used
 * to (a) enforce the per-link allowed_domain BEFORE spending a slot and (b) return
 * the role/approve/referrer to Register. The metadata SELECT is never the
 * authority on slot availability — the UPDATE re-checks every condition.
 */
export class ConsumeSignupInvite implements UseCaseInterface {
  constructor(
    private inviteLinkRepository: SignupInviteLinkRepositoryInterface,
    // Standard Red Notes: ATTRIBUTION / usage-audit sink (#14). Trailing-optional
    // so existing call sites / specs keep compiling; when wired, one row is
    // written per consumed slot (best-effort — a write failure never fails the
    // consume, since the slot is already atomically spent).
    private inviteUseRepository?: SignupInviteUseRepositoryInterface,
  ) {}

  async execute(dto: ConsumeSignupInviteDTO): Promise<ConsumeSignupInviteResponse> {
    const token = typeof dto.token === 'string' ? dto.token.trim() : ''
    if (token.length === 0) {
      return { outcome: 'invalid' }
    }

    try {
      const hashedToken = hashSignupInviteToken(token)

      // Metadata pre-read: apply the per-link email-domain lock BEFORE spending a
      // slot so a domain mismatch never wastes a use. Also short-circuits an
      // obviously-bad token. The link's domain/role/kind are immutable, so this
      // read staying slightly stale on used_count is harmless — the UPDATE below
      // is the authority on availability.
      const link = await this.inviteLinkRepository.findByHashedToken(hashedToken)
      if (link === null) {
        return { outcome: 'invalid' }
      }

      if (link.props.allowedDomain !== null && link.props.allowedDomain.length > 0) {
        const candidate = emailDomain(dto.email)
        // A listed domain also matches its subdomains (domainMatchesList) — the
        // per-link lock only NARROWS; it composes with the instance domain policy
        // enforced separately in Register.
        if (!domainMatchesList(candidate, [link.props.allowedDomain])) {
          return { outcome: 'invalid' }
        }
      }

      const consumed = await this.inviteLinkRepository.consumeSlot(hashedToken, dto.now)
      if (!consumed) {
        return { outcome: 'invalid' }
      }

      // Attribution row (best-effort): the slot is already spent, so a write
      // failure here must never turn a successful consume into a refusal.
      if (this.inviteUseRepository !== undefined) {
        try {
          const use = SignupInviteUse.create(
            {
              inviteLinkUuid: link.id.toString(),
              newUserUuid: dto.newUserUuid,
              referrerUserUuid: link.props.createdByUserUuid,
              createdAt: dto.now,
            },
            new UniqueEntityId(uuidv4()),
          ).getValue()
          await this.inviteUseRepository.save(use)
        } catch {
          // swallow — attribution is a reporting nicety, not part of the gate
        }
      }

      return {
        outcome: 'consumed',
        inviteLinkUuid: link.id.toString(),
        defaultRole: link.props.defaultRole,
        allowedDomain: link.props.allowedDomain,
        autoApprove: link.props.autoApprove,
        referrerUserUuid: link.props.createdByUserUuid,
      }
    } catch {
      return { outcome: 'error' }
    }
  }
}
