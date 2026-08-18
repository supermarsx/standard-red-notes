import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

@Entity({ name: 'sync_command_outbox' })
@Index('index_sync_command_outbox_dispatch', ['status', 'availableAtTimestamp'])
@Index('index_sync_command_outbox_published_at', ['publishedAtTimestamp'])
export class TypeORMSyncCommandOutbox {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  declare uuid: string

  @Column({ name: 'event_json', type: 'text' })
  declare eventJson: string

  @Column({ type: 'varchar', length: 16 })
  declare status: 'pending' | 'dispatching' | 'published'

  @Column({ type: 'int', default: 0 })
  declare attempts: number

  @Column({ name: 'available_at_timestamp', type: 'bigint' })
  declare availableAtTimestamp: number

  @Column({ name: 'locked_at_timestamp', type: 'bigint', nullable: true })
  declare lockedAtTimestamp: number | null

  @Column({ name: 'lock_token', type: 'varchar', length: 36, nullable: true })
  declare lockToken: string | null

  @Column({ name: 'created_at_timestamp', type: 'bigint' })
  declare createdAtTimestamp: number

  @Column({ name: 'updated_at_timestamp', type: 'bigint' })
  declare updatedAtTimestamp: number

  @Column({ name: 'published_at_timestamp', type: 'bigint', nullable: true })
  declare publishedAtTimestamp: number | null
}
