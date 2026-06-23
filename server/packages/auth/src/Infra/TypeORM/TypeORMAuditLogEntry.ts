import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'audit_log' })
export class TypeORMAuditLogEntry {
  @PrimaryGeneratedColumn('uuid')
  declare uuid: string

  @Column({
    name: 'actor_uuid',
    type: 'varchar',
    length: 36,
    nullable: true,
  })
  @Index('index_audit_log_on_actor_uuid')
  declare actorUuid: string | null

  @Column({
    name: 'action',
    type: 'varchar',
    length: 255,
  })
  @Index('index_audit_log_on_action')
  declare action: string

  @Column({
    name: 'target_type',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  declare targetType: string | null

  @Column({
    name: 'target_uuid',
    type: 'varchar',
    length: 36,
    nullable: true,
  })
  declare targetUuid: string | null

  @Column({
    name: 'ip',
    type: 'varchar',
    length: 45,
    nullable: true,
  })
  declare ip: string | null

  // JSON-encoded structured metadata.
  @Column({
    name: 'metadata',
    type: 'text',
    nullable: true,
  })
  declare metadata: string | null

  @Column({
    name: 'created_at',
    type: 'bigint',
  })
  @Index('index_audit_log_on_created_at')
  declare createdAt: number
}
