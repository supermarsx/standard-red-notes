import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'trusted_devices' })
export class TypeORMTrustedDevice {
  @PrimaryGeneratedColumn('uuid')
  declare uuid: string

  @Column({
    name: 'user_uuid',
    length: 36,
  })
  @Index('index_trusted_devices_on_user_uuid')
  declare userUuid: string

  @Column({
    name: 'hashed_token',
    type: 'varchar',
    length: 255,
  })
  @Index('index_trusted_devices_on_hashed_token')
  declare hashedToken: string

  @Column({
    name: 'label',
    type: 'varchar',
    length: 255,
  })
  declare label: string

  @Column({
    name: 'created_at',
    type: 'bigint',
  })
  declare createdAt: number

  @Column({
    name: 'last_used_at',
    type: 'bigint',
    nullable: true,
  })
  declare lastUsedAt: number | null

  @Column({
    name: 'expires_at',
    type: 'bigint',
  })
  declare expiresAt: number
}
