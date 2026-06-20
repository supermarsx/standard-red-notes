import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'email_reminders' })
export class TypeORMEmailReminder {
  @PrimaryGeneratedColumn('uuid')
  declare uuid: string

  @Column({
    name: 'user_uuid',
    length: 36,
  })
  @Index('index_email_reminders_on_user_uuid')
  declare userUuid: string

  @Column({
    name: 'due_at',
    type: 'bigint',
  })
  declare dueAt: number

  @Column({
    name: 'message',
    type: 'text',
  })
  declare message: string

  @Column({
    name: 'sent',
    type: 'boolean',
    default: false,
  })
  declare sent: boolean

  @Column({
    name: 'created_at',
    type: 'bigint',
  })
  declare createdAt: number
}
