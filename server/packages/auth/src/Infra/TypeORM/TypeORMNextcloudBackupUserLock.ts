import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from 'typeorm'
import { User } from '../../Domain/User/User'

@Entity({ name: 'nextcloud_backup_user_locks' })
export class TypeORMNextcloudBackupUserLock {
  @PrimaryColumn({ name: 'user_uuid', length: 36 })
  declare userUuid: string

  @Column({ name: 'updated_at', type: 'bigint' })
  declare updatedAt: number

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_uuid',
    referencedColumnName: 'uuid',
    foreignKeyConstraintName: 'FK_nextcloud_backup_user_locks_user_uuid',
  })
  declare user: User
}
