import { Request, Response } from 'express'
import { controller, httpGet, httpPost, results } from 'inversify-express-utils'
import TYPES from '../../Bootstrap/Types'
import { PendingMfaApprovalsController } from '../../Controller/PendingMfaApprovalsController'
import { inject } from 'inversify'
import { BasePendingMfaApprovalsController } from './Base/BasePendingMfaApprovalsController'

@controller('/pending-mfa-approvals')
export class AnnotatedPendingMfaApprovalsController extends BasePendingMfaApprovalsController {
  constructor(
    @inject(TYPES.Auth_PendingMfaApprovalsController)
    override pendingMfaApprovalsController: PendingMfaApprovalsController,
  ) {
    super(pendingMfaApprovalsController)
  }

  @httpGet('/', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async list(_request: Request, response: Response): Promise<results.JsonResult> {
    return super.list(_request, response)
  }

  @httpPost('/:challengeId/resolve', TYPES.Auth_RequiredCrossServiceTokenMiddleware)
  override async resolve(request: Request, response: Response): Promise<results.JsonResult> {
    return super.resolve(request, response)
  }

  // Unauthenticated: gated only by the high-entropy, single-use challenge id.
  @httpGet('/:challengeId/status')
  override async status(request: Request): Promise<results.JsonResult> {
    return super.status(request)
  }
}
