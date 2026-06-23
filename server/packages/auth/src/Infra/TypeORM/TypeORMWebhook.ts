import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'webhooks' })
export class TypeORMWebhook {
  @PrimaryGeneratedColumn('uuid')
  declare uuid: string

  @Column({
    name: 'user_uuid',
    type: 'varchar',
    length: 36,
    nullable: true,
  })
  @Index('index_webhooks_on_user_uuid')
  declare userUuid: string | null

  @Column({
    name: 'target_url',
    type: 'varchar',
    length: 2048,
  })
  declare targetUrl: string

  // JSON-encoded array of subscribed event names.
  @Column({
    name: 'events',
    type: 'text',
  })
  declare events: string

  @Column({
    name: 'secret',
    type: 'varchar',
    length: 255,
  })
  declare secret: string

  @Column({
    name: 'enabled',
    type: 'boolean',
    default: true,
  })
  declare enabled: boolean

  @Column({
    name: 'created_at',
    type: 'bigint',
  })
  declare createdAt: number
}
