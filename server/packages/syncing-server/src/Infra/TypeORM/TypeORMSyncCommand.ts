import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

@Entity({ name: 'sync_commands' })
@Index('index_sync_commands_scope_command', ['userUuid', 'sessionUuid', 'commandId'], { unique: true })
@Index('index_sync_commands_expires_at', ['expiresAtTimestamp'])
export class TypeORMSyncCommand {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  declare uuid: string

  @Column({ name: 'user_uuid', type: 'varchar', length: 36 })
  declare userUuid: string

  @Column({ name: 'session_uuid', type: 'varchar', length: 36 })
  declare sessionUuid: string

  @Column({ name: 'command_id', type: 'varchar', length: 128 })
  declare commandId: string

  @Column({ name: 'request_digest', type: 'varchar', length: 64 })
  declare requestDigest: string

  @Column({ type: 'varchar', length: 16 })
  declare status: 'accepted' | 'committed'

  @Column({ name: 'response_json', type: 'text', nullable: true })
  declare responseJson: string | null

  @Column({ name: 'execution_token', type: 'varchar', length: 36, nullable: true })
  declare executionToken: string | null

  @Column({ name: 'created_at_timestamp', type: 'bigint' })
  declare createdAtTimestamp: number

  @Column({ name: 'updated_at_timestamp', type: 'bigint' })
  declare updatedAtTimestamp: number

  @Column({ name: 'expires_at_timestamp', type: 'bigint' })
  declare expiresAtTimestamp: number
}
