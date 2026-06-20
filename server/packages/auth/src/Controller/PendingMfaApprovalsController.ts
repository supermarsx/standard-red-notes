import { HttpResponse, HttpStatusCode } from '@standardnotes/responses'
import { MapperInterface } from '@standardnotes/domain-core'

import { PendingMfaApproval } from '../Domain/PendingMfaApproval/PendingMfaApproval'
import { ListPendingMfaApprovals } from '../Domain/UseCase/ListPendingMfaApprovals/ListPendingMfaApprovals'
import { ResolvePendingMfaApproval } from '../Domain/UseCase/ResolvePendingMfaApproval/ResolvePendingMfaApproval'
import { GetPendingMfaApprovalStatus } from '../Domain/UseCase/GetPendingMfaApprovalStatus/GetPendingMfaApprovalStatus'
import { PendingMfaApprovalHttpProjection } from '../Infra/Http/Projection/PendingMfaApprovalHttpProjection'

export class PendingMfaApprovalsController {
  constructor(
    private listPendingMfaApprovals: ListPendingMfaApprovals,
    private resolvePendingMfaApproval: ResolvePendingMfaApproval,
    private getPendingMfaApprovalStatus: GetPendingMfaApprovalStatus,
    private pendingMfaApprovalHttpMapper: MapperInterface<PendingMfaApproval, PendingMfaApprovalHttpProjection>,
  ) {}

  async list(params: { userUuid: string }): Promise<HttpResponse> {
    const result = await this.listPendingMfaApprovals.execute({ userUuid: params.userUuid })

    if (result.isFailed()) {
      return {
        status: HttpStatusCode.Unauthorized,
        data: { error: { message: result.getError() } },
      }
    }

    return {
      status: HttpStatusCode.Success,
      data: {
        pendingApprovals: result.getValue().map((approval) => this.pendingMfaApprovalHttpMapper.toProjection(approval)),
      },
    }
  }

  async resolve(params: { userUuid: string; challengeId: string; approve: boolean }): Promise<HttpResponse> {
    const result = await this.resolvePendingMfaApproval.execute({
      userUuid: params.userUuid,
      challengeId: params.challengeId,
      approve: params.approve,
    })

    if (result.isFailed()) {
      return {
        status: HttpStatusCode.BadRequest,
        data: { error: { message: result.getError() } },
      }
    }

    return {
      status: HttpStatusCode.Success,
      data: { status: result.getValue() },
    }
  }

  // Unauthenticated: the NEW device is not yet signed in. Gated only by the
  // high-entropy, single-use challenge id.
  async status(params: { challengeId: string }): Promise<HttpResponse> {
    const result = await this.getPendingMfaApprovalStatus.execute({ challengeId: params.challengeId })

    if (result.isFailed()) {
      return {
        status: HttpStatusCode.BadRequest,
        data: { error: { message: result.getError() } },
      }
    }

    return {
      status: HttpStatusCode.Success,
      data: { status: result.getValue().status },
    }
  }
}
