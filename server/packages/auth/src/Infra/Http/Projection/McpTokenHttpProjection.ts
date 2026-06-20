export interface McpTokenHttpProjection {
  uuid: string
  label: string
  scope: 'read' | 'write'
  scopeTagUuids: string[] | null
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}
