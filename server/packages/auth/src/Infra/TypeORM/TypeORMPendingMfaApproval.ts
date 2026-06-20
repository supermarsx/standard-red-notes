import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm'

@Entity({ name: 'pending_mfa_approvals' })
export class TypeORMPendingMfaApproval {
  @PrimaryGeneratedColumn('uuid')
  declare uuid: string

  @Column({
    name: 'user_uuid',
    length: 36,
  })
  @Index('index_pending_mfa_approvals_on_user_uuid')
  declare userUuid: string

  @Column({
    name: 'challenge_id',
    type: 'varchar',
    length: 255,
  })
  @Index('index_pending_mfa_approvals_on_challenge_id')
  declare challengeId: string

  @Column({
    name: 'status',
    type: 'varchar',
    length: 16,
    default: 'pending',
  })
  declare status: string

  @Column({
    name: 'requesting_user_agent',
    type: 'text',
    nullable: true,
  })
  declare requestingUserAgent: string | null

  @Column({
    name: 'requesting_ip_address',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  declare requestingIpAddress: string | null

  @Column({
    name: 'created_at',
    type: 'bigint',
  })
  declare createdAt: number

  @Column({
    name: 'expires_at',
    type: 'bigint',
  })
  declare expiresAt: number

  @Column({
    name: 'consumed',
    type: 'boolean',
    default: false,
  })
  declare consumed: boolean
}
