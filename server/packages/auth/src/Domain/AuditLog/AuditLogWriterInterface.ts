export interface AuditLogWriteParams {
  actorUuid: string | null
  action: string
  targetType?: string | null
  targetUuid?: string | null
  ip?: string | null
  metadata?: Record<string, unknown> | null
}

/**
 * Standard Red Notes: best-effort audit-log writer. Call sites use this to
 * record security-relevant actions (login, logout, session revoke, role/ban
 * change, settings change, webhook create/delete). Writes never throw — a
 * failed audit write must not break the underlying action — so callers can
 * `await` it without guarding.
 */
export interface AuditLogWriterInterface {
  write(params: AuditLogWriteParams): Promise<void>
}
