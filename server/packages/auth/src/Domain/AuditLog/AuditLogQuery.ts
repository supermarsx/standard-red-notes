export interface AuditLogQuery {
  actorUuid?: string
  action?: string
  // Inclusive lower/upper bounds (epoch milliseconds) on created_at.
  createdAfter?: number
  createdBefore?: number
  limit: number
  offset: number
}
