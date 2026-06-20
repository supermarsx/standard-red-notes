import { MapperInterface, Uuid } from '@standardnotes/domain-core'
import { Repository } from 'typeorm'

import { PendingMfaApproval } from '../../Domain/PendingMfaApproval/PendingMfaApproval'
import { PendingMfaApprovalRepositoryInterface } from '../../Domain/PendingMfaApproval/PendingMfaApprovalRepositoryInterface'
import { TypeORMPendingMfaApproval } from './TypeORMPendingMfaApproval'

export class TypeORMPendingMfaApprovalRepository implements PendingMfaApprovalRepositoryInterface {
  constructor(
    private ormRepository: Repository<TypeORMPendingMfaApproval>,
    private mapper: MapperInterface<PendingMfaApproval, TypeORMPendingMfaApproval>,
  ) {}

  async findByChallengeId(challengeId: string): Promise<PendingMfaApproval | null> {
    const persistence = await this.ormRepository
      .createQueryBuilder('pending_mfa_approval')
      .where('pending_mfa_approval.challenge_id = :challengeId', { challengeId })
      .getOne()

    if (persistence === null) {
      return null
    }

    return this.mapper.toDomain(persistence)
  }

  async findPendingByUserUuid(userUuid: Uuid): Promise<PendingMfaApproval[]> {
    const persistence = await this.ormRepository
      .createQueryBuilder('pending_mfa_approval')
      .where('pending_mfa_approval.user_uuid = :userUuid', { userUuid: userUuid.value })
      .andWhere('pending_mfa_approval.status = :status', { status: 'pending' })
      .andWhere('pending_mfa_approval.consumed = :consumed', { consumed: false })
      .orderBy('pending_mfa_approval.created_at', 'DESC')
      .getMany()

    return persistence.map((approval) => this.mapper.toDomain(approval))
  }

  async save(approval: PendingMfaApproval): Promise<void> {
    await this.ormRepository.save(this.mapper.toProjection(approval))
  }

  async remove(approval: PendingMfaApproval): Promise<void> {
    await this.ormRepository.remove(this.mapper.toProjection(approval))
  }
}
