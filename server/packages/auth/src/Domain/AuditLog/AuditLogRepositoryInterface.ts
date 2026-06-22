import { AuditLogEntry } from './AuditLogEntry'
import { AuditLogQuery } from './AuditLogQuery'

export interface AuditLogRepositoryInterface {
  save(entry: AuditLogEntry): Promise<void>
  // Returns the matching page of entries (newest first) plus the total count of
  // entries matching the same filters (ignoring limit/offset) for pagination.
  find(query: AuditLogQuery): Promise<{ entries: AuditLogEntry[]; total: number }>
}
