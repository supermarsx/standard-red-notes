import { Result, UseCaseInterface } from '@standardnotes/domain-core'

import { SignupInviteLink } from '../../SignupInvite/SignupInviteLink'
import { SignupInviteLinkRepositoryInterface } from '../../SignupInvite/SignupInviteLinkRepositoryInterface'

/**
 * Standard Red Notes: list signup invite links. With `creatorUserUuid` set it
 * returns only that user's own links (the self-serve pane); without it, every
 * link (the admin panel). Never returns the raw token — that is shown only once
 * at creation.
 */
export class ListSignupInviteLinks implements UseCaseInterface<SignupInviteLink[]> {
  constructor(private inviteLinkRepository: SignupInviteLinkRepositoryInterface) {}

  async execute(dto: { creatorUserUuid?: string }): Promise<Result<SignupInviteLink[]>> {
    const links =
      dto.creatorUserUuid !== undefined && dto.creatorUserUuid !== null
        ? await this.inviteLinkRepository.listByCreatorUser(dto.creatorUserUuid)
        : await this.inviteLinkRepository.listAll()

    return Result.ok(links)
  }
}
