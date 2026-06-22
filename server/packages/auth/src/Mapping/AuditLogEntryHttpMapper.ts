import { MapperInterface } from '@standardnotes/domain-core'

import { AuditLogEntry } from '../Domain/AuditLog/AuditLogEntry'
import { AuditLogEntryHttpProjection } from '../Infra/Http/Projection/AuditLogEntryHttpProjection'

export class AuditLogEntryHttpMapper implements MapperInterface<AuditLogEntry, AuditLogEntryHttpProjection> {
  toDomain(_projection: AuditLogEntryHttpProjection): AuditLogEntry {
    throw new Error('Not implemented yet.')
  }

  toProjection(domain: AuditLogEntry): AuditLogEntryHttpProjection {
    return {
      uuid: domain.id.toString(),
      actorUuid: domain.props.actorUuid,
      action: domain.props.action,
      targetType: domain.props.targetType,
      targetUuid: domain.props.targetUuid,
      ip: domain.props.ip,
      metadata: domain.props.metadata,
      createdAt: domain.props.createdAt.toISOString(),
    }
  }
}
