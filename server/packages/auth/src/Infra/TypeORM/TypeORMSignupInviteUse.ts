import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'signup_invite_uses' })
export class TypeORMSignupInviteUse {
  @PrimaryGeneratedColumn('uuid')
  declare uuid: string

  @Column({
    name: 'invite_link_uuid',
    type: 'varchar',
    length: 255,
  })
  @Index('index_signup_invite_uses_on_invite_link_uuid')
  declare inviteLinkUuid: string

  @Column({
    name: 'new_user_uuid',
    type: 'varchar',
    length: 255,
  })
  declare newUserUuid: string

  @Column({
    name: 'referrer_user_uuid',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  @Index('index_signup_invite_uses_on_referrer_user_uuid')
  declare referrerUserUuid: string | null

  @Column({
    name: 'created_at',
    type: 'datetime',
  })
  declare createdAt: Date
}
