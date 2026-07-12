import { Request, Response } from 'express'
import { inject } from 'inversify'
import { controller, httpDelete, httpGet, httpPost, results } from 'inversify-express-utils'

import TYPES from '../../Bootstrap/Types'
import { BaseMeInviteLinksController } from './Base/BaseMeInviteLinksController'
import { RegistrationConfigResolverInterface } from '../../Domain/Registration/RegistrationConfigResolverInterface'
import { SignupInviteLinkRepositoryInterface } from '../../Domain/SignupInvite/SignupInviteLinkRepositoryInterface'
import { SignupInviteUseRepositoryInterface } from '../../Domain/SignupInvite/SignupInviteUseRepositoryInterface'
import { CreateSignupInviteLink } from '../../Domain/UseCase/CreateSignupInviteLink/CreateSignupInviteLink'
import { ListSignupInviteLinks } from '../../Domain/UseCase/ListSignupInviteLinks/ListSignupInviteLinks'
import { RevokeSignupInviteLink } from '../../Domain/UseCase/RevokeSignupInviteLink/RevokeSignupInviteLink'

/**
 * Standard Red Notes: the authenticated SELF-SERVE invite surface. Distinct from
 * the admin invite-links routes (those are ADMIN_USER-gated). These are gated by
 * the cross-service token middleware and operate ONLY on the caller's own links
 * (response.locals.user.uuid). Routes are '/users/me/invite-links*' — the literal
 * 'me' segment never collides with the ':userUuid' routes on AnnotatedUsersController.
 */
@controller('/users')
export class AnnotatedMeInviteLinksController extends BaseMeInviteLinksController {
  constructor(
    @inject(TYPES.Auth_RegistrationConfigResolver) override registrationConfigResolver: RegistrationConfigResolverInterface,
    @inject(TYPES.Auth_SignupInviteLinkRepository) override inviteLinkRepository: SignupInviteLinkRepositoryInterface,
    @inject(TYPES.Auth_SignupInviteUseRepository) override inviteUseRepository: SignupInviteUseRepositoryInterface,
    @inject(TYPES.Auth_CreateSignupInviteLink) override doCreateSignupInviteLink: CreateSignupInviteLink,
    @inject(TYPES.Auth_ListSignupInviteLinks) override doListSignupInviteLinks: ListSignupInviteLinks,
    @inject(TYPES.Auth_RevokeSignupInviteLink) override doRevokeSignupInviteLink: RevokeSignupInviteLink,
  ) {
    super(
      registrationConfigResolver,
      inviteLinkRepository,
      inviteUseRepository,
      doCreateSignupInviteLink,
      doListSignupInviteLinks,
      doRevokeSignupInviteLink,
    )
  }

  @httpGet('/me/invite-links', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async listMyInviteLinks(request: Request, response: Response): Promise<results.JsonResult> {
    return super.listMyInviteLinks(request, response)
  }

  @httpPost('/me/invite-links', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async createMyInviteLink(request: Request, response: Response): Promise<results.JsonResult> {
    return super.createMyInviteLink(request, response)
  }

  @httpDelete('/me/invite-links/:uuid', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async revokeMyInviteLink(request: Request, response: Response): Promise<results.JsonResult> {
    return super.revokeMyInviteLink(request, response)
  }
}
