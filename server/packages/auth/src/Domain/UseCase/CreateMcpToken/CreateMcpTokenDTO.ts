export interface CreateMcpTokenDTO {
  userUuid: string
  label: string
  scope: string
  scopeTagUuids?: string[]
  wrappedKeys: string
  kdfSalt: string
  kdfParams: string
}
