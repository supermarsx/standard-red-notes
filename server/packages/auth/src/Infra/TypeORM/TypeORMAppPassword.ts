import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'app_passwords' })
export class TypeORMAppPassword {
  @PrimaryGeneratedColumn('uuid')
  declare uuid: string

  @Column({
    name: 'user_uuid',
    length: 36,
  })
  @Index('index_app_passwords_on_user_uuid')
  declare userUuid: string

  @Column({
    name: 'label',
    type: 'varchar',
    length: 255,
  })
  declare label: string

  @Column({
    name: 'hashed_password',
    type: 'varchar',
    length: 255,
  })
  declare hashedPassword: string

  @Column({
    name: 'created_at',
    type: 'datetime',
  })
  declare createdAt: Date

  @Column({
    name: 'last_used_at',
    type: 'datetime',
    nullable: true,
  })
  declare lastUsedAt: Date | null
}
