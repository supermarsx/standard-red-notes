export interface CreateCustomRoleDTO {
  name: string
  description?: string | null
  permissionNames?: string[]
}
