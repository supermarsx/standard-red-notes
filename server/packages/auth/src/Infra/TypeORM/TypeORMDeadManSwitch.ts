import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'dead_man_switches' })
export class TypeORMDeadManSwitch {
  @PrimaryGeneratedColumn('uuid')
  declare uuid: string

  @Column({
    name: 'user_uuid',
    length: 36,
  })
  @Index('index_dead_man_switches_on_user_uuid')
  declare userUuid: string

  @Column({
    name: 'recipient_email',
    type: 'varchar',
    length: 255,
  })
  declare recipientEmail: string

  @Column({
    name: 'share_url',
    type: 'text',
  })
  declare shareUrl: string

  @Column({
    name: 'message',
    type: 'text',
    nullable: true,
  })
  declare message: string | null

  @Column({
    name: 'interval_days',
    type: 'int',
  })
  declare intervalDays: number

  @Column({
    name: 'deadline',
    type: 'bigint',
  })
  declare deadline: number

  @Column({
    name: 'triggered',
    type: 'boolean',
    default: false,
  })
  declare triggered: boolean

  @Column({
    name: 'last_check_in_at',
    type: 'bigint',
    nullable: true,
  })
  declare lastCheckInAt: number | null

  @Column({
    name: 'created_at',
    type: 'bigint',
  })
  declare createdAt: number
}
