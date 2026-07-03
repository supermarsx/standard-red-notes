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
   * assignments (the role_permissions join table) from the admin panel, and to
   * INSERT an admin-created CUSTOM role row (name + description + permissions).
   * Built-in role identity (name/version) is migration-managed and never mutated
   * here.
   */
  save(role: Role): Promise<void>
  /**
   * Standard Red Notes: delete a role row. Only ever used to remove an
   * admin-created CUSTOM role that is not in use; the use case guards that a
   * built-in (enum) role can never be removed.
   */
  remove(role: Role): Promise<void>
}
