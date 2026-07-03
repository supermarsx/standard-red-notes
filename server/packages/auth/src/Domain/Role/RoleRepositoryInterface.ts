import { Role } from './Role'

export interface RoleRepositoryInterface {
  findOneByName(name: string): Promise<Role | null>
  /**
   * Standard Red Notes: every role row (all names and all versions). The admin
   * roles view dedupes to the highest-version row per name (the "active" role
   * that findOneByName resolves).
   */
  findAll(): Promise<Role[]>
  findOneByUuid(uuid: string): Promise<Role | null>
  /**
   * Standard Red Notes: persist a role — used to replace a role's permission
   * assignments (the role_permissions join table) from the admin panel. Role
   * identity (name/version) is migration-managed and never mutated here.
   */
  save(role: Role): Promise<void>
}
