import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'rbac_groups' })
export class TypeORMGroup {
  @PrimaryGeneratedColumn('uuid')
  declare uuid: string

  @Column({
    name: 'name',
    type: 'varchar',
    length: 255,
  })
  @Index('index_rbac_groups_on_name', { unique: true })
  declare name: string

  @Column({
    name: 'description',
    type: 'varchar',
    length: 1024,
    nullable: true,
  })
  declare description: string | null

  @Column({
    name: 'created_at',
    type: 'bigint',
  })
  declare createdAt: number

  @Column({
    name: 'updated_at',
    type: 'bigint',
  })
  declare updatedAt: number
}
