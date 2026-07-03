import { Permission } from './Permission'

/**
 * Standard Red Notes: read access to the seeded permission CATALOG (the
 * `permissions` table). The catalog is migration-managed — this interface is
 * deliberately read-only: the admin panel edits which catalog permissions a
 * role grants (role_permissions), it never invents new permission types.
 */
export interface PermissionRepositoryInterface {
  findAll(): Promise<Permission[]>
  findByNames(names: string[]): Promise<Permission[]>
}
