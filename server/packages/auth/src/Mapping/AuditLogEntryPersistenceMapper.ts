import { MapperInterface, UniqueEntityId } from '@standardnotes/domain-core'

import { AuditLogEntry } from '../Domain/AuditLog/AuditLogEntry'
import { TypeORMAuditLogEntry } from '../Infra/TypeORM/TypeORMAuditLogEntry'

export class AuditLogEntryPersistenceMapper implements MapperInterface<AuditLogEntry, TypeORMAuditLogEntry> {
  toDomain(projection: TypeORMAuditLogEntry): AuditLogEntry {
    let metadata: Record<string, unknown> | null = null
    if (projection.metadata !== null && projection.metadata !== undefined) {
      try {
        const parsed = JSON.parse(projection.metadata)
        metadata = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
      } catch {
        metadata = null
      }
    }

    const entryOrError = AuditLogEntry.create(
      {
        actorUuid: projection.actorUuid ?? null,
        action: projection.action,
        targetType: projection.targetType ?? null,
        targetUuid: projection.targetUuid ?? null,
        ip: projection.ip ?? null,
        metadata,
        createdAt: new Date(Number(projection.createdAt)),
      },
      new UniqueEntityId(projection.uuid),
    )
    if (entryOrError.isFailed()) {
      throw new Error(`Failed to create audit log entry from projection: ${entryOrError.getError()}`)
    }

    return entryOrError.getValue()
  }

  toProjection(domain: AuditLogEntry): TypeORMAuditLogEntry {
    const typeorm = new TypeORMAuditLogEntry()

    typeorm.uuid = domain.id.toString()
    typeorm.actorUuid = domain.props.actorUuid
    typeorm.action = domain.props.action
    typeorm.targetType = domain.props.targetType
    typeorm.targetUuid = domain.props.targetUuid
    typeorm.ip = domain.props.ip
    typeorm.metadata = domain.props.metadata !== null ? JSON.stringify(domain.props.metadata) : null
    typeorm.createdAt = domain.props.createdAt.getTime()

    return typeorm
  }
}
