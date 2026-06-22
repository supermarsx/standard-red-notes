import { Entity, Result, UniqueEntityId } from '@standardnotes/domain-core'

import { AuditLogEntryProps } from './AuditLogEntryProps'

export class AuditLogEntry extends Entity<AuditLogEntryProps> {
  private constructor(props: AuditLogEntryProps, id?: UniqueEntityId) {
    super(props, id)
  }

  static create(props: AuditLogEntryProps, id?: UniqueEntityId): Result<AuditLogEntry> {
    if (props.action.length === 0) {
      return Result.fail<AuditLogEntry>('Audit log action cannot be empty')
    }

    if (props.action.length > 255) {
      return Result.fail<AuditLogEntry>('Audit log action cannot be longer than 255 characters')
    }

    return Result.ok<AuditLogEntry>(new AuditLogEntry(props, id))
  }
}
