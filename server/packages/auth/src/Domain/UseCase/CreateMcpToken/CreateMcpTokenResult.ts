export interface CreateMcpTokenResult {
  uuid: string
  label: string
  scope: 'read' | 'write'
  scopeTagUuids: string[] | null
  /**
   * The plaintext MCP token. This is returned exactly ONCE at creation time and
   * never persisted in plaintext. Only its bcrypt hash is stored.
   *
   * Format is `<tokenUuid>.<secret>` so that AuthenticateWithMcpToken can split
   * on the first '.', load the row by uuid, then bcrypt.compare the secret.
   */
  token: string
  createdAt: Date
  expiresAt: Date | null
}
