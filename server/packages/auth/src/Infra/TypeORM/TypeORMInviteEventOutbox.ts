import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

export type InviteEventOutboxStatus = 'pending' | 'dispatching' | 'published' | 'failed'

@Entity({ name: 'invite_event_outbox' })
@Index('index_invite_event_outbox_dispatch', ['status', 'availableAtTimestamp'])
@Index('index_invite_event_outbox_stale_lease', ['status', 'lockedAtTimestamp'])
@Index('index_invite_event_outbox_published_at', ['publishedAtTimestamp'])
@Index('index_invite_event_outbox_fanout_hash', ['fanoutHash'])
export class TypeORMInviteEventOutbox {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  declare uuid: string

  @Column({ name: 'event_json', type: 'text' })
  declare eventJson: string

  @Column({ name: 'affected_user_uuids_json', type: 'text' })
  declare affectedUserUuidsJson: string

  @Column({ name: 'fanout_hash', type: 'varchar', length: 64 })
  declare fanoutHash: string

  @Column({ type: 'varchar', length: 16 })
  declare status: InviteEventOutboxStatus

  @Column({ type: 'int', default: 0 })
  declare attempts: number

  @Column({ name: 'available_at_timestamp', type: 'bigint' })
  declare availableAtTimestamp: number

  @Column({ name: 'locked_at_timestamp', type: 'bigint', nullable: true })
  declare lockedAtTimestamp: number | null

  @Column({ name: 'lock_token', type: 'varchar', length: 36, nullable: true })
  declare lockToken: string | null

  @Column({ name: 'last_attempt_at_timestamp', type: 'bigint', nullable: true })
  declare lastAttemptAtTimestamp: number | null

  @Column({ name: 'last_error_code', type: 'varchar', length: 64, nullable: true })
  declare lastErrorCode: string | null

  @Column({ name: 'created_at_timestamp', type: 'bigint' })
  declare createdAtTimestamp: number

  @Column({ name: 'updated_at_timestamp', type: 'bigint' })
  declare updatedAtTimestamp: number

  @Column({ name: 'published_at_timestamp', type: 'bigint', nullable: true })
  declare publishedAtTimestamp: number | null
}
