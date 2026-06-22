import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

/**
 * Standard Red Notes: join table linking a user to an RBAC group. A composite
 * primary key on (group_uuid, user_uuid) guarantees a user can only be a member
 * of a group once.
 */
@Entity({ name: 'rbac_user_groups' })
export class TypeORMUserGroup {
  @PrimaryColumn({
    name: 'group_uuid',
    length: 36,
  })
  @Index('index_rbac_user_groups_on_group_uuid')
  declare groupUuid: string

  @PrimaryColumn({
    name: 'user_uuid',
    length: 36,
  })
  @Index('index_rbac_user_groups_on_user_uuid')
  declare userUuid: string

  @Column({
    name: 'created_at',
    type: 'bigint',
  })
  declare createdAt: number
}
