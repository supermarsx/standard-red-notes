export interface QueryAuditLogDTO {
  actorUuid?: string
  action?: string
  // ISO-8601 date strings (inclusive). Parsed to epoch ms; invalid values are
  // ignored rather than rejected.
  from?: string
  to?: string
  limit?: number
  offset?: number
}
