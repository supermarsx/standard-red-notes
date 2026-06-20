import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'shares' })
export class TypeORMShare {
  @PrimaryGeneratedColumn('uuid')
  declare uuid: string

  @Column({
    name: 'user_uuid',
    length: 36,
  })
  @Index('index_shares_on_user_uuid')
  declare userUuid: string

  @Column({
    name: 'type',
    type: 'varchar',
    length: 20,
  })
  declare type: string

  @Column({
    name: 'encrypted_payload',
    type: 'text',
  })
  declare encryptedPayload: string

  @Column({
    name: 'nickname',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  declare nickname: string | null

  @Column({
    name: 'created_at',
    type: 'bigint',
  })
  declare createdAt: number

  @Column({
    name: 'revoked',
    type: 'boolean',
    default: false,
  })
  declare revoked: boolean

  @Column({
    name: 'one_time_view',
    type: 'boolean',
    default: false,
  })
  declare oneTimeView: boolean

  @Column({
    name: 'view_expires_minutes',
    type: 'integer',
    nullable: true,
  })
  declare viewExpiresMinutes: number | null

  @Column({
    name: 'first_opened_at',
    type: 'bigint',
    nullable: true,
  })
  declare firstOpenedAt: number | null
}
