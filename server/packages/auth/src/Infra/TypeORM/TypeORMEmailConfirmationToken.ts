import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'email_confirmation_tokens' })
export class TypeORMEmailConfirmationToken {
  @PrimaryGeneratedColumn('uuid')
  declare uuid: string

  @Column({
    name: 'user_uuid',
    length: 255,
  })
  @Index('index_email_confirmation_tokens_on_user_uuid')
  declare userUuid: string

  @Column({
    name: 'email',
    type: 'varchar',
    length: 255,
  })
  declare email: string

  @Column({
    name: 'hashed_token',
    type: 'varchar',
    length: 255,
  })
  @Index('index_email_confirmation_tokens_on_hashed_token')
  declare hashedToken: string

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
