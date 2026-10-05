import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

/**
 * The composite unique index mirrors
 * `migrations/{mysql,sqlite}/1787100000000-add-unique-shared-vault-membership.ts`. It is the backstop
 * for the existing-member check in `AddUserToSharedVault`: removal reads a single membership row and
 * deletes it, so a duplicate row would leave a revoked user inside the vault.
 */
@Entity({ name: 'shared_vault_users' })
@Index('unique_membership_on_shared_vault_users', ['sharedVaultUuid', 'userUuid'], { unique: true })
export class TypeORMSharedVaultUser {
  @PrimaryGeneratedColumn('uuid')
  declare uuid: string

  @Column({
    name: 'shared_vault_uuid',
    length: 36,
  })
  @Index('shared_vault_uuid_on_shared_vault_users')
  declare sharedVaultUuid: string

  @Column({
    name: 'user_uuid',
    length: 36,
  })
  @Index('user_uuid_on_shared_vault_users')
  declare userUuid: string

  @Column({
    name: 'permission',
    type: 'varchar',
    length: 24,
  })
  declare permission: string

  @Column({
    name: 'is_designated_survivor',
    type: 'boolean',
    default: false,
  })
  declare isDesignatedSurvivor: boolean

  @Column({
    name: 'created_at_timestamp',
    type: 'bigint',
  })
  declare createdAtTimestamp: number

  @Column({
    name: 'updated_at_timestamp',
    type: 'bigint',
  })
  declare updatedAtTimestamp: number
}
