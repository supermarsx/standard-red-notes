import { Column, ColumnOptions, ColumnType, Entity, Index, PrimaryColumn } from 'typeorm'

/**
 * The `event_json` column is `longtext` in the MySQL migration
 * (`migrations/mysql/1787000000000-add-sync-command-journal.ts`) because a
 * durable SYNC_ITEMS_PUSHED event carries up to 50 encrypted item payloads,
 * well past MySQL's 64 KiB `text` limit. SQLite has no `longtext` type and
 * TypeORM rejects unsupported column types at DataSource initialisation, so
 * the entity resolves the type per driver. It is a getter rather than a value
 * because decorators run at import time, before `DB_TYPE` has been loaded
 * from the environment; TypeORM only reads `type` when it builds the entity
 * metadata inside `DataSource.initialize()`, which runs after `env.load()`.
 */
export const resolveEventJsonColumnType = (dbType: string | undefined = process.env.DB_TYPE): ColumnType => {
  return dbType === 'mysql' ? 'longtext' : 'text'
}

export const eventJsonColumnOptions: ColumnOptions = {
  name: 'event_json',
  get type(): ColumnType {
    return resolveEventJsonColumnType()
  },
}

export type SyncCommandOutboxStatus = 'pending' | 'dispatching' | 'published' | 'dead'

@Entity({ name: 'sync_command_outbox' })
@Index('index_sync_command_outbox_dispatch', ['status', 'availableAtTimestamp'])
@Index('index_sync_command_outbox_published_at', ['publishedAtTimestamp'])
export class TypeORMSyncCommandOutbox {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  declare uuid: string

  @Column(eventJsonColumnOptions)
  declare eventJson: string

  @Column({ type: 'varchar', length: 16 })
  declare status: SyncCommandOutboxStatus

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
