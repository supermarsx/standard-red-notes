import { MapperInterface } from '@standardnotes/domain-core'
import { Repository } from 'typeorm'

import { AuditLogEntry } from '../../Domain/AuditLog/AuditLogEntry'
import { AuditLogQuery } from '../../Domain/AuditLog/AuditLogQuery'
import { AuditLogRepositoryInterface } from '../../Domain/AuditLog/AuditLogRepositoryInterface'
import { TypeORMAuditLogEntry } from './TypeORMAuditLogEntry'

export class TypeORMAuditLogRepository implements AuditLogRepositoryInterface {
  constructor(
    private ormRepository: Repository<TypeORMAuditLogEntry>,
    private mapper: MapperInterface<AuditLogEntry, TypeORMAuditLogEntry>,
  ) {}

  async save(entry: AuditLogEntry): Promise<void> {
    const persistence = this.mapper.toProjection(entry)

    await this.ormRepository.save(persistence)
  }

  async find(query: AuditLogQuery): Promise<{ entries: AuditLogEntry[]; total: number }> {
    const queryBuilder = this.ormRepository.createQueryBuilder('audit_log')

    if (query.actorUuid !== undefined) {
      queryBuilder.andWhere('audit_log.actor_uuid = :actorUuid', { actorUuid: query.actorUuid })
    }

    if (query.action !== undefined) {
      queryBuilder.andWhere('audit_log.action = :action', { action: query.action })
    }

    if (query.createdAfter !== undefined) {
      queryBuilder.andWhere('audit_log.created_at >= :createdAfter', { createdAfter: query.createdAfter })
    }

    if (query.createdBefore !== undefined) {
      queryBuilder.andWhere('audit_log.created_at <= :createdBefore', { createdBefore: query.createdBefore })
    }

    const total = await queryBuilder.getCount()

    const persistence = await queryBuilder
      .orderBy('audit_log.created_at', 'DESC')
      .take(query.limit)
      .skip(query.offset)
      .getMany()

    return {
      entries: persistence.map((entry) => this.mapper.toDomain(entry)),
      total,
    }
  }
}
