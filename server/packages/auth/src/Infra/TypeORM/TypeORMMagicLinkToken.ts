import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'magic_link_tokens' })
export class TypeORMMagicLinkToken {
  @PrimaryGeneratedColumn('uuid')
  declare uuid: string

  @Column({
    name: 'user_identifier',
    length: 255,
  })
  @Index('index_magic_link_tokens_on_user_identifier')
  declare userIdentifier: string

  @Column({
    name: 'code',
    type: 'varchar',
    length: 255,
  })
  declare code: string

  @Column({
    name: 'expires_at',
    type: 'datetime',
  })
  declare expiresAt: Date

  @Column({
    name: 'consumed',
    type: 'boolean',
    default: false,
  })
  declare consumed: boolean

  @Column({
    name: 'created_at',
    type: 'datetime',
  })
  declare createdAt: Date
}
