export interface AuditLogEntryHttpProjection {
  uuid: string
  actorUuid: string | null
  action: string
  targetType: string | null
  targetUuid: string | null
  ip: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}
