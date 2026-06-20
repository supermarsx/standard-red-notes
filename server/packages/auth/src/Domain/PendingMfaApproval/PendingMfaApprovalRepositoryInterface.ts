import { Uuid } from '@standardnotes/domain-core'

import { PendingMfaApproval } from './PendingMfaApproval'

export interface PendingMfaApprovalRepositoryInterface {
  findByChallengeId(challengeId: string): Promise<PendingMfaApproval | null>
  findPendingByUserUuid(userUuid: Uuid): Promise<PendingMfaApproval[]>
  save(approval: PendingMfaApproval): Promise<void>
  remove(approval: PendingMfaApproval): Promise<void>
}
