import { Entity, Index, PrimaryColumn } from 'typeorm'

/**
 * Standard Red Notes: join table mapping an RBAC group to a role NAME it
 * confers on its members. Roles are referenced by their canonical name (the
 * same value stored in the `roles` table) so the mapping stays decoupled from
 * role row uuids. Composite primary key on (group_uuid, role_name).
 */
@Entity({ name: 'rbac_group_roles' })
export class TypeORMGroupRole {
  @PrimaryColumn({
    name: 'group_uuid',
    length: 36,
  })
  @Index('index_rbac_group_roles_on_group_uuid')
  declare groupUuid: string

  @PrimaryColumn({
    name: 'role_name',
    length: 255,
  })
  declare roleName: string
}
