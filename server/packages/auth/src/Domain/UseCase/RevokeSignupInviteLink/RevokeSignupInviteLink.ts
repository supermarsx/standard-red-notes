import { Result, UseCaseInterface } from '@standardnotes/domain-core'

import { SignupInviteLinkRepositoryInterface } from '../../SignupInvite/SignupInviteLinkRepositoryInterface'

/**
 * Standard Red Notes: soft-revoke a signup invite link by uuid (never hard-delete
 * — history/audit survives). When `requesterUserUuid` is set (the self-serve
 * path) ownership is re-checked so a user can only revoke their OWN links; the
 * admin path passes no requester and may revoke any link.
 */
export class RevokeSignupInviteLink implements UseCaseInterface<{ uuid: string }> {
  constructor(private inviteLinkRepository: SignupInviteLinkRepositoryInterface) {}

  async execute(dto: { uuid: string; requesterUserUuid?: string }): Promise<Result<{ uuid: string }>> {
    if (typeof dto.uuid !== 'string' || dto.uuid.trim().length === 0) {
      return Result.fail('A link uuid is required.')
    }
    const uuid = dto.uuid.trim()

    const link = await this.inviteLinkRepository.findByUuid(uuid)
    if (link === null) {
      return Result.fail(`No invite link with uuid '${uuid}'.`)
    }

    // Self-serve ownership guard: a user may only revoke a link they created.
    if (dto.requesterUserUuid !== undefined && dto.requesterUserUuid !== null) {
      if (link.props.createdByUserUuid !== dto.requesterUserUuid) {
        return Result.fail('You can only revoke your own invite links.')
      }
    }

    await this.inviteLinkRepository.revokeByUuid(uuid)

    return Result.ok({ uuid })
  }
}
