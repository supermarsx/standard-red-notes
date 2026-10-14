import { Request, Response } from 'express'
import { inject } from 'inversify'
import { controller, httpGet, httpPost, results } from 'inversify-express-utils'

import TYPES from '../../Bootstrap/Types'
import { AuthenticateRequest } from '../../Domain/UseCase/AuthenticateRequest'
import { CreateCrossServiceToken } from '../../Domain/UseCase/CreateCrossServiceToken/CreateCrossServiceToken'
import { GetActiveSessionsForUser } from '../../Domain/UseCase/GetActiveSessionsForUser'
import { CustomProjectorInterface } from '../../Projection/ProjectorInterface'
import { Session } from '../../Domain/Session/Session'
import { AdminMfaService } from '../../Domain/Session/AdminMfaService'
import { SessionActivityService } from '../../Domain/Session/SessionActivityService'
import { BaseSessionsController } from './Base/BaseSessionsController'

@controller('/admin/users')
export class AnnotatedAdminSessionsController extends BaseSessionsController {
  constructor(
    @inject(TYPES.Auth_GetActiveSessionsForUser) override getActiveSessionsForUser: GetActiveSessionsForUser,
    @inject(TYPES.Auth_AuthenticateRequest) override authenticateRequest: AuthenticateRequest,
    @inject(TYPES.Auth_SessionProjector) override sessionProjector: CustomProjectorInterface<Session>,
    @inject(TYPES.Auth_CreateCrossServiceToken) override createCrossServiceToken: CreateCrossServiceToken,
    @inject(SessionActivityService) activity: SessionActivityService,
    @inject(AdminMfaService) adminMfa: AdminMfaService,
  ) {
    super(
      getActiveSessionsForUser,
      authenticateRequest,
      sessionProjector,
      createCrossServiceToken,
      undefined,
      activity,
      adminMfa,
    )
  }

  @httpGet('/:userUuid/mfa/status', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async getUserMfaStatus(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getUserMfaStatus(request, response)
  }
  @httpPost('/:userUuid/mfa/reset', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async resetUserMfa(request: Request, response: Response): Promise<results.JsonResult> {
    return super.resetUserMfa(request, response)
  }

  @httpGet('/:userUuid/sessions', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async getUserSessions(request: Request, response: Response): Promise<results.JsonResult> {
    return super.getUserSessions(request, response)
  }
}
