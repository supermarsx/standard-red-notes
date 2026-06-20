export interface McpTokenProps {
  userUuid: string
  label: string
  hashedToken: string
  scope: 'read' | 'write'
  scopeTagUuids: string[] | null
  wrappedKeys: string
  kdfSalt: string
  kdfParams: string
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date | null
}
