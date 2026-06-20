export interface GetMcpTokenKeysResult {
  wrappedKeys: string
  kdfSalt: string
  kdfParams: string
  scope: 'read' | 'write'
  scopeTagUuids: string[] | null
}
