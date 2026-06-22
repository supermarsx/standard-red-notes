import { AuditLogEntry } from '../../AuditLog/AuditLogEntry'

export interface QueryAuditLogResult {
  entries: AuditLogEntry[]
  total: number
  limit: number
  offset: number
}
