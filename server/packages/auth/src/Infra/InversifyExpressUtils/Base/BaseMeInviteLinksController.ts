import { ControllerContainerInterface } from '@standardnotes/domain-core'
import { Request, Response } from 'express'
import { BaseHttpController, results } from 'inversify-express-utils'

import { CreateSignupInviteLink } from '../../../Domain/UseCase/CreateSignupInviteLink/CreateSignupInviteLink'
import { ListSignupInviteLinks } from '../../../Domain/UseCase/ListSignupInviteLinks/ListSignupInviteLinks'
import { RevokeSignupInviteLink } from '../../../Domain/UseCase/RevokeSignupInviteLink/RevokeSignupInviteLink'
import { SignupInviteLink } from '../../../Domain/SignupInvite/SignupInviteLink'
import { SignupInviteLinkRepositoryInterface } from '../../../Domain/SignupInvite/SignupInviteLinkRepositoryInterface'
import { SignupInviteUseRepositoryInterface } from '../../../Domain/SignupInvite/SignupInviteUseRepositoryInterface'
import { RegistrationConfigResolverInterface } from '../../../Domain/Registration/RegistrationConfigResolverInterface'
import { ResponseLocals } from '../ResponseLocals'

/**
 * Standard Red Notes: SELF-SERVE / referral invites (#14). Lets an authenticated
 * NON-admin user mint / list / revoke their OWN invite links within the
 * `invitesPerUser` quota, with each resulting signup attributed to them. Gated by
 * the cross-service token middleware (response.locals.user.uuid). A user link can
 * NEVER set a role override / domain lock and is forced auto_approve=false (the
 * privilege guard lives in CreateSignupInviteLink) — so a referral can never grant
 * privilege or bypass the approval queue.
 *
 * When the feature is DISABLED (invitesPerUser <= 0) every endpoint returns 403 so
 * the web pane can gate itself on a 200.
 */
export class BaseMeInviteLinksController extends BaseHttpController {
  constructor(
    protected registrationConfigResolver: RegistrationConfigResolverInterface,
    protected inviteLinkRepository: SignupInviteLinkRepositoryInterface,
    protected inviteUseRepository: SignupInviteUseRepositoryInterface,
    protected doCreateSignupInviteLink: CreateSignupInviteLink,
    protected doListSignupInviteLinks: ListSignupInviteLinks,
    protected doRevokeSignupInviteLink: RevokeSignupInviteLink,
    // Standard Red Notes: in SINGLE-CONTAINER (home-server / DirectCall) mode the
    // gateway invokes these self-serve endpoints by identifier string rather than
    // over HTTP, so — exactly like BaseAppPasswordsController — we register the
    // three `auth.meInviteLinks.*` DirectCall handlers here. Optional so the
    // HTTP-annotated construction (multi-container) keeps compiling without it;
    // that path resolves via the @httpX decorators and needs no registration.
    private controllerContainer?: ControllerContainerInterface,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('auth.meInviteLinks.create', this.createMyInviteLink.bind(this))
      this.controllerContainer.register('auth.meInviteLinks.list', this.listMyInviteLinks.bind(this))
      this.controllerContainer.register('auth.meInviteLinks.revoke', this.revokeMyInviteLink.bind(this))
    }
  }

  private userUuid(response: Response): string | undefined {
    return (response.locals as ResponseLocals)?.user?.uuid
  }

  private linkView(link: SignupInviteLink, now: Date): Record<string, unknown> {
    return {
      uuid: link.id.toString(),
      label: link.props.label,
      maxUses: link.props.maxUses,
      usedCount: link.props.usedCount,
      remainingUses: link.remainingUses(),
      expiresAt: link.props.expiresAt ? link.props.expiresAt.toISOString() : null,
      revoked: link.props.revoked,
      status: link.status(now),
      createdAt: link.props.createdAt.toISOString(),
    }
  }

  private async invitesPerUser(): Promise<number> {
    try {
      return (await this.registrationConfigResolver.resolve()).invitesPerUser
    } catch {
      return 0
    }
  }

  async listMyInviteLinks(_request: Request, response: Response): Promise<results.JsonResult> {
    const userUuid = this.userUuid(response)
    if (!userUuid) {
      return this.json({ error: { message: 'Authentication required.' } }, 401)
    }

    const quota = await this.invitesPerUser()
    if (quota <= 0) {
      return this.json({ error: { message: 'Self-serve invites are not enabled.' } }, 403)
    }

    const result = await this.doListSignupInviteLinks.execute({ creatorUserUuid: userUuid })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    const now = new Date()
    const links = result.getValue()
    const activeCount = links.filter((link) => link.isActive(now)).length
    const invitedCount = await this.inviteUseRepository.countByReferrer(userUuid)

    return this.json({
      inviteLinks: links.map((link) => this.linkView(link, now)),
      invitedCount,
      quota: { used: activeCount, total: quota },
    })
  }

  async createMyInviteLink(request: Request, response: Response): Promise<results.JsonResult> {
    const userUuid = this.userUuid(response)
    if (!userUuid) {
      return this.json({ error: { message: 'Authentication required.' } }, 401)
    }

    const quota = await this.invitesPerUser()
    if (quota <= 0) {
      return this.json({ error: { message: 'Self-serve invites are not enabled.' } }, 403)
    }

    // Per-user quota: refuse once the user already holds `quota` ACTIVE links. A
    // tiny TOCTOU could permit quota+1 under concurrent creates (low stakes — NOT
    // the criticality of the atomic slot consume).
    const activeCount = await this.inviteLinkRepository.countActiveByCreatorUser(userUuid, new Date())
    if (activeCount >= quota) {
      return this.json(
        { error: { message: `You have reached your invite limit (${quota}). Revoke one to create another.` } },
        400,
      )
    }

    const { maxUses, expiresInHours, label } = request.body as {
      maxUses?: number
      expiresInHours?: number | null
      label?: string | null
    }

    // creatorKind 'user' → the use case's privilege guard forces no role/domain
    // override and auto_approve=false regardless of any body fields.
    const result = await this.doCreateSignupInviteLink.execute({
      creatorKind: 'user',
      creatorUserUuid: userUuid,
      maxUses,
      expiresInHours,
      label,
    })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    const { link, token } = result.getValue()

    return this.json({
      inviteLink: {
        ...this.linkView(link, new Date()),
        token,
        path: `/?invite=${encodeURIComponent(token)}`,
      },
    })
  }

  async revokeMyInviteLink(request: Request, response: Response): Promise<results.JsonResult> {
    const userUuid = this.userUuid(response)
    if (!userUuid) {
      return this.json({ error: { message: 'Authentication required.' } }, 401)
    }

    const quota = await this.invitesPerUser()
    if (quota <= 0) {
      return this.json({ error: { message: 'Self-serve invites are not enabled.' } }, 403)
    }

    const { uuid } = request.params as Record<string, string>

    // Ownership is re-checked in the use case (requesterUserUuid): a user may only
    // revoke a link they created.
    const result = await this.doRevokeSignupInviteLink.execute({ uuid, requesterUserUuid: userUuid })
    if (result.isFailed()) {
      return this.json({ error: { message: result.getError() } }, 400)
    }

    return this.json({ success: true, uuid })
  }
}
