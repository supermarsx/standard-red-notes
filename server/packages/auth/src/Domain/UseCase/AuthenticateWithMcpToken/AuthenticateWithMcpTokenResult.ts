export interface AuthenticateWithMcpTokenResult {
  userUuid: string
  scope: 'read' | 'write'
  scopeTagUuids: string[] | null
}
