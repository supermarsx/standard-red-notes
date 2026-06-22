export interface AuditLogEntryProps {
  // The acting principal. May be null for an unauthenticated/failed login where
  // no user could be resolved.
  actorUuid: string | null
  action: string
  // Type of the object acted on, e.g. 'user', 'session', 'setting', 'webhook'.
  targetType: string | null
  targetUuid: string | null
  ip: string | null
  // Structured, non-sensitive metadata. MUST NOT contain decrypted content,
  // passwords, secrets or HMAC keys.
  metadata: Record<string, unknown> | null
  createdAt: Date
}
