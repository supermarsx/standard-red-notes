import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'signup_invite_links' })
export class TypeORMSignupInviteLink {
  @PrimaryGeneratedColumn('uuid')
  declare uuid: string

  @Column({
    name: 'hashed_token',
    type: 'varchar',
    length: 255,
  })
  @Index('index_signup_invite_links_on_hashed_token')
  declare hashedToken: string

  @Column({
    name: 'label',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  declare label: string | null

  @Column({
    name: 'max_uses',
    type: 'int',
    default: 1,
  })
  declare maxUses: number

  @Column({
    name: 'used_count',
    type: 'int',
    default: 0,
  })
  declare usedCount: number

  @Column({
    name: 'expires_at',
    type: 'datetime',
    nullable: true,
  })
  declare expiresAt: Date | null

  @Column({
    name: 'revoked',
    type: 'boolean',
    default: false,
  })
  declare revoked: boolean

  @Column({
    name: 'default_role',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  declare defaultRole: string | null

  @Column({
    name: 'allowed_domain',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  declare allowedDomain: string | null

  @Column({
    name: 'created_by',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  declare createdBy: string | null

  @Column({
    name: 'created_by_user_uuid',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  @Index('index_signup_invite_links_on_created_by_user_uuid')
  declare createdByUserUuid: string | null

  @Column({
    name: 'created_by_kind',
    type: 'varchar',
    length: 255,
    default: 'admin',
  })
  declare createdByKind: string

  @Column({
    name: 'auto_approve',
    type: 'boolean',
    default: true,
  })
  declare autoApprove: boolean

  @Column({
    name: 'created_at',
    type: 'datetime',
  })
  declare createdAt: Date

  @Column({
    name: 'updated_at',
    type: 'datetime',
  })
  declare updatedAt: Date
}
